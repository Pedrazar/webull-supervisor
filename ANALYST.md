# Financial analyst, shadow mode (added 2026-11-15)

J asked for an analyst that says buy, short or sit out for each agent. It
runs in **shadow mode**: it makes and grades calls but controls nothing (no
order call, no control.json write, no agent change). Goal: a 2-3 week
record before J decides whether it steers the agents and whether the 0DTE
agents get puts (today they can only buy calls, so a "short" is recorded,
not traded). Design doc: https://claude.ai/artifact/PNA6EA1QCjveupzidVT6zX

- `analyst.ts`: its own workflow step after every supervisor pass
  (`continue-on-error`, so it can't turn the supervisor red). No-op except
  10:15-11:00am ET (one call per day, before the 0DTE agents' 10:30 entry;
  a call after 10:30 is marked late) and from 4:30pm ET (grades any
  ungraded day). Pushes one ntfy line for each.
- `analystRules.ts`: pure rules, no LLM. SPY regime from daily bars (MA20/
  MA50/slope, 20-day realized vol, gap), bias = 0.5 x trend + 0.5 x move
  from the open by call time. Thresholds in `RULES`; starting values, not
  fitted to past data.
- `analystData.ts`: read-only bars (batch-bars D, already verified by
  webull-agent; bars M5, not yet verified live). Built not to depend on the
  daily bar timestamp convention.
- `analystScore.ts`: direction grade (SPY/NVDA from the call price to the
  close) and money grade: following a sit-out or short = $0 for the
  long-only agents, so value added = followed - actual. Wheel: direction only.
- Outputs in `analyst/`: `calls.jsonl`, `scores.jsonl`, `SCORECARD.md`.
- First live call: the first trading day after merge, ~10:15am ET. That run
  is the test of the M5 bars and the daily-bar handling.
