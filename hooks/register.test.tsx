import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The test runner has timers; the hooks module's own lib does not declare them.
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

import { buildSegments, cacheSegment, nextBackoff, parseUsage, pressMessage, timeLeft, track, wholePercent } from './register'
import type { Segment } from './register'

const LIVE_REPLY = JSON.stringify({
  five_hour: { utilization: 38.0, resets_at: '2026-11-06T13:52:00Z' },
  seven_day: { utilization: 15.4, resets_at: '2026-11-09T16:00:00Z' },
  seven_day_opus: null,
})

test('the usage service reply is read into 5H and 7D', () => {
  expect(parseUsage(LIVE_REPLY)).toEqual([
    { kind: 'five_hour', percentUsed: 38, resetsAt: '2026-11-06T13:52:00Z' },
    { kind: 'seven_day', percentUsed: 15.4, resetsAt: '2026-11-09T16:00:00Z' },
  ])
  expect(parseUsage('not json')).toBe(null)
  expect(parseUsage('{"other":1}')).toBe(null)
})

test('percentages round up to whole numbers, like the usage card', () => {
  const s = buildSegments({ rateLimits: [{ kind: 'seven_day', percentUsed: 15.4 }], usd: null, at: 0 }, null, 0)
  expect(s.map(x => x.text).join('')).toBe('5H – | 7D ●●········ 16% used')
  expect(wholePercent(18.04)).toBe(19)
  expect(wholePercent(18.6)).toBe(19)
  expect(wholePercent(19)).toBe(19)
  expect(wholePercent(19.000000001)).toBe(19)
  expect(wholePercent(0)).toBe(0)
})

test('the live fetch replaces the figures a reply reported', async ($, on) => {
  const fetched: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-11-06T12:00:00Z') }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: LIVE_REPLY } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 37, resetsAt: '2026-11-06T13:52:00Z' },
        { kind: 'seven_day', percentUsed: 14, resetsAt: '2026-11-09T16:00:00Z' },
      ],
      cost: { usd: 2 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The first fetch runs beside session start; give it a moment to land.
  for (let i = 0; i < 50 && fetched.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  await new Promise(r => setTimeout(r, 20))

  const ui = await $.ui.mount({
    plugin: 'usage-line',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(fetched).toEqual(['https://api.anthropic.com/api/oauth/usage'])
  expect((await ui.find({ type: 'Text', text: /5H/ }))?.text).toBe(
    '5H ●●●●······ 38% used (1h 52m) | 7D ●●········ 16% used (3d 4h) | $2.00',
  )
  await ui.unmount()
})

const NOW = Date.parse('2026-11-06T12:00:00Z')
const IN_1H52 = '2026-11-06T13:52:00Z'
const IN_3D4H = '2026-11-09T16:00:00Z'
const MIN = 60_000

const text = (s: Segment[]) => s.map(x => x.text).join('')
const toneOf = (s: Segment[], needle: string) => s.find(x => x.text.includes(needle))?.tone

test('cache countdown: green, yellow under 15m, red under 5m, then cold', () => {
  const at = (minsAgo: number) => cacheSegment({ isWorking: false, lastReplyAt: NOW - minsAgo * MIN }, NOW)
  expect(at(18)).toEqual({ text: '⏱ 42m 00s', tone: 'success' })
  expect(at(48)).toEqual({ text: '⏱ 12m 00s', tone: 'warning' })
  expect(at(57)).toEqual({ text: '⏱ 3m 00s', tone: 'error' })
  expect(at(60)).toEqual({ text: '⏱ cold', tone: 'error' })
  expect(at(200)).toEqual({ text: '⏱ cold', tone: 'error' })
})

test('cache countdown shows seconds, padded to two digits', () => {
  const left = (ms: number) => cacheSegment({ isWorking: false, lastReplyAt: NOW - (60 * MIN - ms) }, NOW)?.text
  expect(left(42 * MIN + 5_000)).toBe('⏱ 42m 05s')
  expect(left(59_000)).toBe('⏱ 0m 59s')
  expect(left(1_500)).toBe('⏱ 0m 02s')
})

test('cache countdown is frozen at the full hour while replying, hidden before any reply', () => {
  expect(cacheSegment({ isWorking: true, lastReplyAt: NOW - 50 * MIN }, NOW)).toEqual({ text: '⏱ 60m 00s', tone: 'success' })
  expect(cacheSegment({ isWorking: false, lastReplyAt: null }, NOW)).toBe(null)
})

test('the cache timer goes second last, before the cost', () => {
  const s = buildSegments({ rateLimits: [], usd: 1.84, at: NOW }, null, NOW, { isWorking: false, lastReplyAt: NOW - 18 * MIN })
  expect(text(s)).toBe('5H – | 7D – | ⏱ 42m 00s | $1.84')
})

test('a finished reply starts the countdown in the band', async ($, on) => {
  let now = NOW
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1' })
  now = NOW + 18 * MIN

  const ui = await $.ui.mount({
    plugin: 'usage-line',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect((await ui.find({ type: 'Text', text: /⏱/ }))?.text).toBe('5H – | 7D – | ⏱ 42m 00s | $1.00')
  await ui.unmount()
})

const USAGE_AFTER_REPLY = (sevenDay: number) => ({
  value: {
    startedAt: 0,
    context: { window: 200000, tokens: 2 },
    rateLimits: [{ kind: 'seven_day', percentUsed: sevenDay }],
    cost: { usd: 1 },
  },
})

const mountBand = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({
    plugin: 'usage-line',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })

test('a reload after a reply starts the countdown without waiting for the next reply', async ($, on) => {
  let now = NOW
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => USAGE_AFTER_REPLY(14))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  now = NOW + 10 * MIN

  const ui = await mountBand($)
  expect((await ui.find({ type: 'Text', text: /⏱/ }))?.text).toBe('5H – | 7D ●········· 14% used | ⏱ 50m 00s | $1.00')
  await ui.unmount()
})

test('the 7D figure refreshes at the end of every reply', async ($, on) => {
  let sevenDay = 14
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.usage', () => USAGE_AFTER_REPLY(sevenDay))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  sevenDay = 15
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1' })

  const ui = await mountBand($)
  expect((await ui.find({ type: 'Text', text: /7D/ }))?.text).toContain('15% used')
  await ui.unmount()
})

test('time left reads like the screenshot', () => {
  expect(timeLeft(IN_1H52, NOW)).toBe('1h 52m')
  expect(timeLeft(IN_3D4H, NOW)).toBe('3d 4h')
  expect(timeLeft('2026-11-06T12:12:00Z', NOW)).toBe('12m')
})

test('5H comes first, then 7D, then the cost', () => {
  const f = {
    rateLimits: [
      { kind: 'seven_day', percentUsed: 38, resetsAt: IN_3D4H },
      { kind: 'five_hour', percentUsed: 59, resetsAt: IN_1H52 },
    ],
    usd: 1.84,
    at: NOW,
  }
  const s = buildSegments(f, track(null, f.rateLimits[1]!), NOW)
  expect(text(s)).toBe('5H ●●●●●●···· 59% used (1h 52m) | 7D ●●●●······ 38% used (3d 4h) | $1.84')
})

test('green under 50, yellow from 50, red from 80', () => {
  const f = {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85 },
      { kind: 'seven_day', percentUsed: 49 },
    ],
    usd: null,
    at: NOW,
  }
  const s = buildSegments(f, null, NOW)
  expect(toneOf(s, '85% used')).toBe('error')
  expect(toneOf(s, '49% used')).toBe('success')
  const y = buildSegments({ ...f, rateLimits: [{ kind: 'five_hour', percentUsed: 50 }] }, null, NOW)
  expect(toneOf(y, '50% used')).toBe('warning')
})

test('no readings yet shows dashes', () => {
  expect(text(buildSegments({ rateLimits: [], usd: 0, at: NOW }, null, NOW))).toBe('5H – | 7D – | $0.00')
})

test('passing $20 puts the warning first, no parentheses', () => {
  const s = buildSegments({ rateLimits: [], usd: 21.3, at: NOW }, null, NOW)
  expect(text(s).startsWith('⚠ over $20 | 5H')).toBe(true)
  expect(toneOf(s, '$21.30')).toBe('error')
})

test('30 points of the 5-hour limit used by this session warns', () => {
  let t = track(null, { kind: 'five_hour', percentUsed: 10 })
  t = track(t, { kind: 'five_hour', percentUsed: 39 })
  const f = (pct: number) => ({ rateLimits: [{ kind: 'five_hour', percentUsed: pct }], usd: 3, at: NOW })
  expect(text(buildSegments(f(39), t, NOW)).startsWith('5H')).toBe(true)
  t = track(t, { kind: 'five_hour', percentUsed: 40 })
  expect(text(buildSegments(f(40), t, NOW)).startsWith('⚠ used 30% of 5h | 5H')).toBe(true)
})

test('usage carries across a 5-hour reset', () => {
  let t = track(null, { kind: 'five_hour', percentUsed: 60, resetsAt: IN_1H52 })
  t = track(t, { kind: 'five_hour', percentUsed: 80, resetsAt: IN_1H52 })
  t = track(t, { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-11-06T18:52:00Z' })
  t = track(t, { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-11-06T18:52:00Z' })
  expect(t.carried + (t.last - t.baseline)).toBe(30)
})

test('both reasons show together', () => {
  let t = track(null, { kind: 'five_hour', percentUsed: 0 })
  t = track(t, { kind: 'five_hour', percentUsed: 35 })
  const s = buildSegments({ rateLimits: [{ kind: 'five_hour', percentUsed: 35 }], usd: 25, at: NOW }, t, NOW)
  expect(text(s).startsWith('⚠ over $20, used 35% of 5h | 5H')).toBe(true)
})

test('the band draws above the prompt after session start', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 59, resetsAt: IN_1H52 },
        { kind: 'seven_day', percentUsed: 38, resetsAt: IN_3D4H },
      ],
      cost: { usd: 1.84 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-line',
      component: 'AbovePrompt',
      surface,
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /59% used/ }))?.text).toBe(
      '5H ●●●●●●···· 59% used (1h 52m) | 7D ●●●●······ 38% used (3d 4h) | $1.84',
    )
    await ui.unmount()
  }
})

const BAND = (surface: 'terminal' | 'desktop') => ({
  plugin: 'usage-line',
  component: 'AbovePrompt' as const,
  surface,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
})

let toasts: string[] = []

function engine(on: Parameters<TestBody>[1], authorize: () => Promise<void> | void = () => {}) {
  toasts = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-11-06T12:00:00Z') }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.authorize', async () => {
    await authorize()
    return { value: null }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 44 }],
      cost: { usd: 2 },
    },
  }))
}

const settle = () => new Promise(r => setTimeout(r, 30))

test('the ↻ button sits at the right end of the strip, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount(BAND(surface))
    expect((await band.find({ type: 'Text', text: /5H/ }))?.text).toContain('44% used')
    expect((await band.find({ type: 'Button', key: 'usage-refresh' }))?.text).toBe('↻')
    await band.unmount()
  }
})

test('pressing ↻ fetches right away, brightens while it runs, then says how it went', async ($, on) => {
  let fetches = 0
  let release: () => void = () => {}
  let isGated = false
  engine(on, () => {
    fetches += 1
    if (isGated) return new Promise<void>(r => (release = r))
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  const before = fetches

  isGated = true
  const band = await $.ui.mount(BAND('desktop'))
  expect((await band.find({ type: 'Button', key: 'usage-refresh' }))?.props?.dimColor).toBe(true)
  const pressed = band.press({ key: 'usage-refresh' })
  await settle()
  expect(fetches).toBe(before + 1)
  // Mid-fetch: the same ↻ in the same place, only brighter.
  const mid = await band.find({ type: 'Button', key: 'usage-refresh' })
  expect(mid?.text).toBe('↻')
  expect(mid?.props?.dimColor).toBe(false)
  // A second press while the first fetch runs is ignored.
  await band.press({ key: 'usage-refresh' })
  await settle()
  expect(fetches).toBe(before + 1)

  release()
  await pressed
  await settle()
  const after = await band.find({ type: 'Button', key: 'usage-refresh' })
  expect(after?.text).toBe('↻')
  expect(after?.props?.dimColor).toBe(true)
  // This engine has no subscription login, so the toast says so.
  expect(toasts).toEqual(['Usage needs a Claude subscription login'])
  await band.unmount()
})

test('the toast text for each outcome', () => {
  expect(pressMessage('ok')).toBe('Usage updated')
  expect(pressMessage('http 429')).toBe('Usage service busy, try again soon')
  expect(pressMessage('http 500')).toBe("Couldn't fetch usage (http 500)")
})

test('after a refusal the wait grows 2, 4, then stays at 5 minutes', () => {
  expect(nextBackoff(0)).toBe(120_000)
  expect(nextBackoff(120_000)).toBe(240_000)
  expect(nextBackoff(240_000)).toBe(300_000)
  expect(nextBackoff(300_000)).toBe(300_000)
})

test('automatic fetches wait out a refusal, while ↻ still fetches at once', async ($, on) => {
  let now = Date.parse('2026-11-06T12:00:00Z')
  const urls: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    return { value: { status: 429, ok: false, headers: {}, text: '' } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } },
  }))
  const reply = () =>
    $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't' })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settle()
  expect(urls.length).toBe(1) // refused: the next automatic fetch waits 2 minutes

  now += 90_000
  await reply()
  await settle()
  expect(urls.length).toBe(1) // still inside the 2-minute wait

  const band = await $.ui.mount(BAND('desktop'))
  await band.press({ key: 'usage-refresh' })
  await settle()
  expect(urls.length).toBe(2) // ↻ does not wait
  await band.unmount()

  now += 125_000
  await reply()
  await settle()
  expect(urls.length).toBe(2) // second refusal: now a 4-minute wait

  now += 250_000
  await reply()
  await settle()
  expect(urls.length).toBe(3)
})

test('a brand-new session with no reply yet shows no cache timer', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-11-06T12:00:00Z') }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: null }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND('desktop'))
  expect((await band.find({ type: 'Text', text: /5H/ }))?.text).toBe('5H – | 7D – | $0.00')
  await band.unmount()
})
