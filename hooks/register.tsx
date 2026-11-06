import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FiveHourTrack, UsageFigures, UsageWindow } from '../types'

/** A session counts as expensive past either of these, whichever comes first. */
export const MAX_SESSION_USD = 20
export const MAX_SESSION_FIVE_HOUR_POINTS = 30

/** Meter colors: green below YELLOW_AT, yellow below RED_AT, red from there. */
const YELLOW_AT = 50
const RED_AT = 80
const DOTS = 10

/** How long the prompt cache stays warm after a reply (this app uses 1 hour). */
export const CACHE_TTL_MS = 60 * 60 * 1000
/** Cache countdown colors: yellow under 15 minutes left, red under 5. */
const CACHE_YELLOW_MS = 15 * 60 * 1000
const CACHE_RED_MS = 5 * 60 * 1000

const fiveHour = atom({ plugin: 'usage-line', key: 'fiveHour' } as const, null)
const figures = atom({ plugin: 'usage-line', key: 'figures' } as const, null)
const lastReplyAt = atom({ plugin: 'usage-line', key: 'lastReplyAt' } as const, null)
const tick = atom({ plugin: 'usage-line', key: 'tick' } as const, 0)
const isFetching = atom({ plugin: 'usage-line', key: 'isFetching' } as const, false)

export type CacheState = { isWorking: boolean; lastReplyAt: number | null }

export type Tone = 'label' | 'dim' | 'success' | 'warning' | 'error'
export type Segment = { text: string; tone: Tone }

const toneFor = (pct: number): Tone => (pct >= RED_AT ? 'error' : pct >= YELLOW_AT ? 'warning' : 'success')

/** "1h 52m", "3d 4h", "12m" until the window resets. */
export function timeLeft(iso: string | undefined, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const mins = Math.max(0, Math.round((at - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const used = (t: FiveHourTrack) => Math.max(0, t.last - t.baseline)

/** Moves this session's 5-hour share forward with a new reading. */
export function track(prev: FiveHourTrack | null, w: UsageWindow): FiveHourTrack {
  const windowResetsAt = w.resetsAt ?? null
  if (!prev) return { windowResetsAt, baseline: w.percentUsed, last: w.percentUsed, carried: 0 }
  const isNewWindow =
    (windowResetsAt !== null && prev.windowResetsAt !== null && windowResetsAt !== prev.windowResetsAt) ||
    w.percentUsed < prev.last - 1
  if (isNewWindow) {
    // Bank what this session used in the old window; the new window's first
    // reading is the baseline, so other sessions' use in it isn't counted.
    return { windowResetsAt, baseline: w.percentUsed, last: w.percentUsed, carried: prev.carried + used(prev) }
  }
  return { ...prev, windowResetsAt: windowResetsAt ?? prev.windowResetsAt, last: w.percentUsed }
}

/** A whole percent rounded up, as the app's usage card shows it: 18.3 → 19, 18 → 18. */
export function wholePercent(percentUsed: number): number {
  // The small allowance keeps float noise (19.000000001) from tipping into 20.
  return Math.max(0, Math.ceil(percentUsed - 1e-6))
}

function meter(name: string, w: UsageWindow | undefined, now: number): Segment[] {
  if (!w) return [{ text: name, tone: 'label' }, { text: ' –', tone: 'dim' }]
  const pct = wholePercent(w.percentUsed)
  const tone = toneFor(pct)
  const filled = Math.min(DOTS, Math.max(0, Math.round(pct / (100 / DOTS))))
  const left = timeLeft(w.resetsAt, now)
  return [
    { text: `${name} `, tone: 'label' },
    { text: '●'.repeat(filled), tone },
    { text: '·'.repeat(DOTS - filled), tone: 'dim' },
    { text: ` ${pct}%`, tone },
    ...(left ? [{ text: ` (${left})`, tone: 'dim' as const }] : []),
  ]
}

/** "42m 05s" from milliseconds, seconds rounded up. */
function minSec(ms: number): string {
  const secs = Math.ceil(ms / 1000)
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
}

/** "⏱ 42m 05s" counting down from the last reply; frozen at the full hour mid-reply. */
export function cacheSegment(c: CacheState, now: number): Segment | null {
  if (c.isWorking) return { text: `⏱ ${minSec(CACHE_TTL_MS)}`, tone: 'success' }
  if (c.lastReplyAt === null) return null
  const left = CACHE_TTL_MS - (now - c.lastReplyAt)
  if (left <= 0) return { text: '⏱ cold', tone: 'error' }
  const tone: Tone = left < CACHE_RED_MS ? 'error' : left < CACHE_YELLOW_MS ? 'warning' : 'success'
  return { text: `⏱ ${minSec(left)}`, tone }
}

/** Why this session counts as expensive: "over $20", "used 31% of 5h"; empty when it doesn't. */
export function expensiveReasons(f: UsageFigures, t: FiveHourTrack | null): string[] {
  const points = t ? Math.round((t.carried + used(t)) * 10) / 10 : 0
  const reasons: string[] = []
  if (f.usd !== null && f.usd >= MAX_SESSION_USD) reasons.push(`over $${MAX_SESSION_USD}`)
  if (points >= MAX_SESSION_FIVE_HOUR_POINTS) reasons.push(`used ${points}% of 5h`)
  return reasons
}

/** The band's runs, left to right: warning, 5H, 7D, cache, cost. */
export function buildSegments(
  f: UsageFigures,
  t: FiveHourTrack | null,
  now: number,
  cache: CacheState = { isWorking: false, lastReplyAt: null },
): Segment[] {
  const five = f.rateLimits.find(r => r.kind === 'five_hour')
  const week = f.rateLimits.find(r => r.kind === 'seven_day')
  const reasons = expensiveReasons(f, t)

  const gap: Segment = { text: ' | ', tone: 'dim' }
  const out: Segment[] = []
  if (reasons.length) out.push({ text: `⚠ ${reasons.join(', ')}`, tone: 'error' }, gap)
  out.push(...meter('5H', five, now), gap, ...meter('7D', week, now))
  const c = cacheSegment(cache, now)
  if (c) out.push(gap, c)
  if (f.usd !== null) out.push(gap, { text: `$${f.usd.toFixed(2)}`, tone: reasons.length ? 'error' : 'dim' })
  return out
}

/** Cells the ↻ button and the gap before it take at the strip's right end. */
const BUTTON_CELLS = 4

/** How many cells the strip's text takes: ⏱ and ⚠ are drawn two cells wide. */
export function stripCells(segments: Segment[]): number {
  let cells = 0
  for (const s of segments) for (const ch of s.text) cells += ch === '⏱' || ch === '⚠' ? 2 : 1
  return cells
}

/** True when the strip at full size would not fit on one line beside the ↻. */
export function needsSmallText(segments: Segment[], bodyColumns: number): boolean {
  return stripCells(segments) > bodyColumns - BUTTON_CELLS
}

async function bumpTick($: EngineInterface) {
  const now = await $.clock.now()
  await update($, tick, () => now)
}

async function markReply($: EngineInterface) {
  const now = await $.clock.now()
  await update($, lastReplyAt, () => now)
}

/** A reload lands right as a reply ends: start the countdown if the session has had one. */
async function seedReply($: EngineInterface) {
  const now = await $.clock.now()
  await update($, lastReplyAt, prev => prev ?? now)
}

/** A live reading younger than this outranks the figures a reply reported. */
const LIVE_FRESH_MS = 90_000
/** Automatic fetches: one a minute at most, slower after the service refuses one. */
const POLL_MS = 60_000
const MIN_AUTO_GAP_MS = 55_000
const BACKOFF_FIRST_MS = 2 * 60_000
const BACKOFF_MAX_MS = 5 * 60_000
/** The ↻ stays bright at least this long, so a quick fetch still shows. */
const MIN_BRIGHT_MS = 600
/** The service behind the app's usage card. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** The wait after a refusal: 2 minutes, then doubling, at most 5. */
export function nextBackoff(prevMs: number): number {
  return prevMs === 0 ? BACKOFF_FIRST_MS : Math.min(prevMs * 2, BACKOFF_MAX_MS)
}

/** What the toast says after a ↻ press. */
export function pressMessage(outcome: string): string {
  if (outcome === 'ok') return 'Usage updated'
  if (outcome === 'http 429') return 'Usage service busy, try again soon'
  if (outcome === 'no subscription login') return 'Usage needs a Claude subscription login'
  return `Couldn't fetch usage (${outcome})`
}

/** Reads the usage service's reply into windows; null when it holds neither. */
export function parseUsage(text: string): UsageWindow[] | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const out: UsageWindow[] = []
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const w = (body as Record<string, unknown>)[kind]
    if (typeof w !== 'object' || w === null) continue
    const { utilization, resets_at } = w as { utilization?: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number') continue
    out.push({
      kind,
      // Kept unrounded: rounding happens once, at display time (wholePercent).
      percentUsed: utilization,
      ...(typeof resets_at === 'string' ? { resetsAt: resets_at } : {}),
    })
  }
  return out.length ? out : null
}

/** Figures a reply reported: the cost always, the limits unless a live reading is fresh. */
async function refresh($: EngineInterface, rateLimits: UsageWindow[], usd: number | null) {
  const at = await $.clock.now()
  const prev = await read($, figures)
  const liveAt = prev?.liveAt ?? null
  const isLiveFresh = liveAt !== null && at - liveAt < LIVE_FRESH_MS
  const limits = isLiveFresh && prev ? prev.rateLimits : rateLimits.map(r => ({ ...r }))
  const five = limits.find(r => r.kind === 'five_hour')
  if (five && !isLiveFresh) await update($, fiveHour, p => track(p, five))
  await update($, figures, () => ({ rateLimits: limits, usd, at, liveAt }))
}

/** Writes how the last fetch went beside the mod, only when that changes. */
let lastOutcome = ''
async function noteOutcome($: EngineInterface, outcome: string) {
  if (outcome === lastOutcome) return
  lastOutcome = outcome
  const at = new Date(await $.clock.now()).toISOString()
  await $.fs.write(`${$.plugin.root}/.status/last-fetch.json`, JSON.stringify({ at, outcome }, null, 2))
}

// Pacing for automatic fetches; a reload starts it over.
let lastAttemptAt = 0
let backoffMs = 0

/** Fetches the usage card's numbers for this account and says how it went. */
async function poll($: EngineInterface): Promise<string> {
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') return 'no subscription login'
  let res
  try {
    res = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
  } catch (err) {
    return `fetch failed: ${String(err).slice(0, 200)}`
  }
  if (!res.ok) return `http ${res.status}`
  const live = parseUsage(res.text)
  if (live === null) return 'reply had no five_hour or seven_day'

  const at = await $.clock.now()
  const five = live.find(r => r.kind === 'five_hour')
  if (five) await update($, fiveHour, p => track(p, five))
  await update($, figures, prev => ({ rateLimits: live, usd: prev?.usd ?? null, at, liveAt: at }))
  return 'ok'
}

/** Runs one fetch, records it, and adjusts the back-off; never throws. */
async function pollSafely($: EngineInterface): Promise<string> {
  let outcome: string
  try {
    lastAttemptAt = await $.clock.now()
    outcome = await poll($)
  } catch (err) {
    outcome = `error: ${String(err).slice(0, 200)}`
  }
  backoffMs = outcome === 'http 429' ? nextBackoff(backoffMs) : outcome === 'ok' ? 0 : backoffMs
  try {
    await noteOutcome($, outcome)
  } catch {
    // nothing more to do: the strip keeps its last figures
  }
  return outcome
}

/** A timer or reply fetch: skipped when one ran under a minute ago or a refusal's wait is running. */
async function autoPoll($: EngineInterface) {
  const now = await $.clock.now()
  const gap = Math.max(MIN_AUTO_GAP_MS, backoffMs)
  if (lastAttemptAt !== 0 && now - lastAttemptAt < gap) return
  await pollSafely($)
}

/** The ↻ button: fetch now, brighten while it runs, then say how it went. */
async function refreshNow($: EngineInterface) {
  if (await read($, isFetching)) return
  await update($, isFetching, () => true)
  try {
    const startedAt = await $.clock.now()
    const outcome = await pollSafely($)
    const rest = MIN_BRIGHT_MS - ((await $.clock.now()) - startedAt)
    if (rest > 0) await $.clock.sleep(rest)
    $.ui.toast(pressMessage(outcome))
  } finally {
    await update($, isFetching, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // The earlier version pinned a status line under the prompt; clear it.
    $.ui.status(undefined)
    // An earlier version kept a show/hide choice here; drop it.
    await $.store.delete('isHidden').catch(() => {})
    await update($, isFetching, () => false)
    const u = await $.session.usage()
    await refresh($, u.rateLimits, u.cost?.usd ?? null)
    // `tokens` is set once a reply has come back; a brand-new session has none.
    if (u.context.tokens !== undefined) await seedReply($)
    // Redraw the cache countdown every second.
    $.clock.every(1_000, () => void bumpTick($))
    // Fetch the usage card's numbers now and every minute.
    void autoPoll($)
    $.clock.every(POLL_MS, () => void autoPoll($))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await markReply($)
      // Re-read the limits every reply, not only when the engine pushes a measurement.
      const u = await $.session.usage()
      await refresh($, u.rateLimits, u.cost?.usd ?? null)
      void autoPoll($)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e.rateLimits, e.cost?.usd ?? null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, figures)
    if (e.props.hasSurvey || f === null) return next(e)

    const t = await read($, fiveHour)
    const last = await read($, lastReplyAt)
    await read($, tick) // subscribes this drawing to the countdown timer
    const fetching = await read($, isFetching)
    const { Box, Button, Text } = $.ui.resolve(e)
    const segments = buildSegments(f, t, await $.clock.now(), { isWorking: e.props.isWorking, lastReplyAt: last })
    const isSmall = needsSmallText(segments, e.props.bodyColumns)

    // Never two lines: smaller text when the strip would not fit, and a cut
    // with "…" as the last resort (the terminal has one text size).
    return (
      <Box flexDirection="row" width="100%" alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          <Text mono tabular wrap="truncate-end" {...(isSmall ? { size: 'footnote' as const } : {})}>
            {segments.map(s =>
              s.tone === 'label' ? (
                <Text weight="bold">{s.text}</Text>
              ) : s.tone === 'dim' ? (
                <Text dimColor>{s.text}</Text>
              ) : (
                <Text color={s.tone}>{s.text}</Text>
              ),
            )}
          </Text>
        </Box>
        {/* The same icon in the same place; it only turns bright while fetching. */}
        <Button key="usage-refresh" label="↻" plain dimColor={!fetching} onPress={() => refreshNow($)} />
      </Box>
    )
  })
}
