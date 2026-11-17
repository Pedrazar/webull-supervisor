# Analyst scorecard (shadow mode)

The analyst makes one call per agent each trading day around 10:15am ET and controls nothing. 2 days graded since 2026-11-16. Following its calls would have added **$1207** across the three long-only agents.

_A two-to-three-week record is a small sample: treat these numbers as a first read, not proof._

## Totals

| Agent | Days | Calls (buy / short / sit out) | Direction right | Agent actual | If followed | Value added | Agent P&L on buy days | on sit-out/short days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPY 0DTE calls (paper) | 2 | 0 / 2 / 0 | 2 of 2 | -$259 | $0 | +$259 | $0 | -$259 |
| SPX 0DTE calls | 2 | 0 / 2 / 0 | 2 of 2 | -$990 | $0 | +$990 | $0 | -$990 |
| Stock day trader (webull-agent) | 2 | 0 / 2 / 0 | 2 of 2 | +$42 | $0 | -$42 | $0 | +$42 |
| NVDA wheel (webull-options-agent) | 2 | 0 / 2 / 0 | 1 of 2 | $0 | n/a | n/a | $0 | $0 |

Direction right: buy and short calls only, SPY (NVDA for the wheel) from the price at the call to the close. If followed: buy = the agent's real result, sit out or short = $0 (the agents can only buy). The wheel holds for weeks, so it gets a direction grade only.

## Day by day (newest first)

| Date | Regime | SPY after call | SPY 0DTE | SPX 0DTE | Stocks | Wheel (NVDA after call) |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-17 | trend_down | -0.66% | short ✓, actual -$291 (call saved $291) | short ✓, actual -$1400 (call saved $1400) | short ✓, actual $0 | short ✗ (+0.67%) |
| 2026-11-16 | trend_down | -0.68% | short ✓, actual +$32 (call missed $32) | short ✓, actual +$410 (call missed $410) | short ✓, actual +$42 (call missed $42) | short ✓ (-2.30%) |

Calls and their reasons: [analyst/calls.jsonl](calls.jsonl). Grades: [analyst/scores.jsonl](scores.jsonl). Rules: [analystRules.ts](../analystRules.ts).
