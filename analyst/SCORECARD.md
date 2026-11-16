# Analyst scorecard (shadow mode)

The analyst makes one call per agent each trading day around 10:15am ET and controls nothing. 0 days graded since 2026-11-16. No graded days yet.

_A two-to-three-week record is a small sample: treat these numbers as a first read, not proof._

## Totals

| Agent | Days | Calls (buy / short / sit out) | Direction right | Agent actual | If followed | Value added | Agent P&L on buy days | on sit-out/short days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPY 0DTE calls (paper) | 0 | 0 / 0 / 0 | - | $0 | $0 | $0 | $0 | $0 |
| SPX 0DTE calls | 0 | 0 / 0 / 0 | - | $0 | $0 | $0 | $0 | $0 |
| Stock day trader (webull-agent) | 0 | 0 / 0 / 0 | - | $0 | $0 | $0 | $0 | $0 |
| NVDA wheel (webull-options-agent) | 0 | 0 / 0 / 0 | - | $0 | n/a | n/a | $0 | $0 |

Direction right: buy and short calls only, SPY (NVDA for the wheel) from the price at the call to the close. If followed: buy = the agent's real result, sit out or short = $0 (the agents can only buy). The wheel holds for weeks, so it gets a direction grade only.

## Day by day (newest first)

| Date | Regime | SPY after call | SPY 0DTE | SPX 0DTE | Stocks | Wheel (NVDA after call) |
| --- | --- | --- | --- | --- | --- | --- |

Not graded yet: 2026-11-16 (waiting for the close or the agents' logs).

Calls and their reasons: [analyst/calls.jsonl](calls.jsonl). Grades: [analyst/scores.jsonl](scores.jsonl). Rules: [analystRules.ts](../analystRules.ts).
