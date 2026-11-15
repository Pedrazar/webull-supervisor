# Webull trading supervisor

Fifth sibling of `../webull-agent`, `../webull-options-agent`,
`../webull-spx-0dte-agent` and `../webull-spy-0dte-agent`. It watches all
four on the shared Webull OpenAPI **sandbox (paper)** account, tracks daily
loss limits, pushes alerts to J's phone through ntfy, and writes one
combined daily report. Design doc:
https://claude.ai/artifact/KmozfEpzmnQmT15VsfLNdn

## What it may do (phases 1-3)

- **Phase 1, read-only monitor.** Reads positions, open orders, option
  snapshots and the NVDA price (`broker.ts`, no order calls), and the
  agents' workflow runs and trade logs through the GitHub API. It never
  writes to an agent's repo.
- **Phase 2, pause switch (2026-11-15).** `control.json` in this repo. Each
  agent reads it (`agent-snippet/supervisorControl.ts`, copied into each
  agent) before opening a NEW position; exits are never blocked, and an
  unreadable file fails open. A limit breach pauses that agent (or all four,
  for the combined cap) for the rest of the NY day. J pauses/resumes by hand
  with the workflow's `pause` / `resume` inputs; a manual resume beats a
  same-day auto-pause.
- **Phase 3, 0DTE auto-close, paper only (J, 2026-11-15).** A long 0DTE
  option an agent still holds after its own EOD exit is sold:
  SPY at close-20 min (3:40pm; agent exits 3:30), SPX at close-10 min
  (3:50pm; agent exits 3:45). `orders.ts` is the ONLY order code: LIMIT
  SELL_TO_CLOSE plus cancelling its own unfilled order, and it refuses any
  `WEBULL_BASE_URL` that isn't `*.sandbox.webull.com`. Never add opening
  orders, stock orders, or production credentials. Off switch: workflow
  input `auto_close=off` (stored as `"autoClose0dte": false` in
  control.json); the "still open" alert then fires 5 min after the
  auto-close time.
- The live SPY account is out of scope (J, 2026-11-07); the live SPY
  workflow never reads control.json.

## Limits (J, 2026-11-07)

| Scope | Daily limit |
| --- | --- |
| webull-agent | $150 realized (matches its own in-process kill switch) |
| SPX 0DTE | $1,000 realized + open position marked to market |
| SPY 0DTE paper | $200 realized + open position marked to market |
| Wheel | none; alert on unrealized loss over $1,500 or NVDA within 3% of the short put |
| Paper account combined | $1,350 (the three limits added up) |

Against the real 2026-11-06 logs (SPX -$910, SPY -$153, total -$1,063)
the combined alert would NOT have fired; it fires only when the agents
together lose more than $1,350 in a day.

Known gap: webull-agent commits `trades.jsonl` only at the end of its
session, so its realized P&L reaches the supervisor after the close. Its
own $150 kill switch still runs in-process during the day.

## Files

- `main.ts`: one pass. `--dry-run` prints findings without pushing,
  saving or trading; `--report` writes the report now; `--pause=`,
  `--resume=`, `--auto-close=on|off`, `--reason=`.
- `control.ts` / `control.json`: pause switch and auto-close switch.
- `autoClose.ts` (which positions are due, pricing, retry loop) and
  `orders.ts` (sandbox-only sell-to-close).
- `config.ts`: the four agents, schedules, limits, thresholds.
- `gather.ts`: collects GitHub + broker data into one `World` object; an
  unreachable source is recorded as an error and reported as "unknown".
- `checks.ts`: pure checks over `World`. `report.ts`: the daily report.
- `alerts.ts`: ntfy push + per-day de-duplication in `supervisor-state.json`.
- `test.ts`: fixture tests against the agents' real logs (`npm test`).

## Setup (once)

1. Repo secrets: `WEBULL_APP_KEY`, `WEBULL_APP_SECRET`, `WEBULL_BASE_URL`,
   `WEBULL_SANDBOX_ACCOUNT_ID` (same values as the agents), and
   `NTFY_TOPIC` (a long random name, e.g. `jp-trading-7f3k9q2m`).
2. Install the ntfy app on the phone and subscribe to that topic.
3. A cron-job.org job: `POST https://api.github.com/repos/Pedrazar/webull-supervisor/actions/workflows/supervisor.yml/dispatches`,
   body `{"ref":"main"}`, headers `Authorization: Bearer <fine-grained PAT,
   this repo only, Actions: Read and write>`, `Accept: application/vnd.github+json`,
   `X-GitHub-Api-Version: 2022-11-28`. Schedule: every 5 minutes,
   6:25am-1:55pm `America/Los_Angeles`, Mon-Fri.

## Verified live 2026-11-07

First run with secrets (run 42413938125): GitHub runs/contents reads with
the Actions token, positions list, option snapshot pricing (NVDA 195 put
marked at -$4,907.50 unrealized, consistent with `cost` being per share),
and the NVDA stock-bars price all worked.

## Not yet verified live

Written and fixture-tested on 2026-11-07 (a Saturday), with no network path
to the Webull sandbox from the build environment. The first real run is
the test of: the
positions shape for an SPXW position (`optionOcc()` maps `SPX` to the
`SPXW` root), option `cost` per-share semantics in `optionUnrealized()`,
and the open-orders `order_type` field used to skip resting stops.

Phase 3 (written 2026-11-15, a Sunday) has only been run against a fake
broker in `test.ts`. Its first live use will be the first day an agent
still holds a 0DTE call at its auto-close time. The order body is the same
one the agents' own exits use (leg `symbol` = `SPY` / `SPXW`), so the open
question is only the supervisor's own run of it.
