# Webull trading supervisor

Fifth sibling of `../webull-agent`, `../webull-options-agent`,
`../webull-spx-0dte-agent` and `../webull-spy-0dte-agent`. It watches all
four on the shared Webull OpenAPI **sandbox (paper)** account, tracks daily
loss limits, pushes alerts to J's phone through ntfy, and writes one
combined daily report. Design doc:
https://claude.ai/artifact/KmozfEpzmnQmT15VsfLNdn

## Phase 1 (this code): read-only

- `broker.ts` contains **no order call at all** (no place, cancel or
  replace), so this process cannot trade. It reads positions, open orders,
  option snapshots and the NVDA price, using the same endpoints, versions
  and field names the agents already verified live.
- It never writes to an agent's repo. It reads their workflow runs and
  trade logs through the GitHub API.
- A limit breach only alerts ("phase 2 would pause ..."). Pausing comes in
  phase 2 via `control.json`; the 3:40pm 0DTE flatten in phase 3.
- The live SPY account is out of scope for now (J, 2026-11-07).

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

- `main.ts`: one pass. `--dry-run` prints findings without pushing or
  saving; `--report` writes the report now.
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
