# usage-line

A Claude Code mod that puts one strip above the prompt box:

```
5H ●●●●······ 38% (1h 52m) | 7D ●●········ 15% (3d 4h) | ⏱ 42m 05s | $1.84        ↻
```

- **5H**: how much of your 5-hour limit is used, and the time until it resets.
- **7D**: how much of your weekly limit is used, and the time until it resets.
- **⏱**: how long until the prompt cache goes cold. It counts down 60m 00s, second by second, from Claude's last reply. Once it's cold, your next message re-sends the whole conversation at full price.
- **$**: what this session has cost so far.
- **↻** (at the right end): fetches the latest usage right away instead of waiting for the next one-minute fetch. It turns bright while fetching, and a short message says whether it worked.

Colors: the meters are green under 50%, yellow from 50%, and red from 80%. The cache timer is green, then yellow under 15 minutes, then red under 5 minutes and when cold.

**Expensive-session warning:** when a session costs more than $20, a red ⚠ appears right before the cost, and the cost turns red: `… | ⏱ 59m 21s | ⚠ $21.91`. The ⚠ and ↻ are drawn a size larger than the rest of the strip.

The 5H and 7D figures are fetched from your account's usage once a minute, so they match the usage card in the app. They need a Claude subscription login; with an API key they show `–`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-line --marketplace syvrc/usage-line
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```bash
claude plugin install usage-line --marketplace syvrc/usage-line
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `syvrc/usage-line`, then **Add plugin**.

## Update

Already installed? Get the latest version from a shell:

```bash
claude plugin marketplace update usage-line
claude plugin update usage-line@usage-line
```

Then type `/reload-plugins` in any open session, or restart it. `claude plugin list` shows the version you have.

## Change the limits

The thresholds are at the top of `hooks/register.tsx`: `MAX_SESSION_USD` (20), the meter colors (`YELLOW_AT`, `RED_AT`) and the cache length (`CACHE_TTL_MS`, 60 minutes).

## Notes

- The usage service it reads is the one behind the app's usage card. It isn't a documented public API, so it may change. If a fetch fails, the strip falls back to the figures Claude's replies report.
- Each open session fetches on its own, once a minute. If the usage service refuses (it does when asked too often), automatic fetches wait 2 minutes, then 4, then 5 at most, until it answers again.
- `.status/last-fetch.json` in the mod's folder records whether the last fetch worked (`ok`, `http 401`, and so on). It holds no usage numbers or login details.
