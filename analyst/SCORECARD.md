# Analyst scorecard (shadow mode)

The analyst makes one call per agent each trading day around 10:15am ET and controls nothing. 4 days graded since 2026-11-16. Following its calls would have added **$4366** across the three long-only agents.

_A two-to-three-week record is a small sample: treat these numbers as a first read, not proof._

## Totals

| Agent | Days | Calls (buy / short / sit out) | Direction right | Agent actual | If followed | Value added | Agent P&L on buy days | on sit-out/short days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPY 0DTE calls (paper) | 4 | 0 / 4 / 0 | 4 of 4 | -$934 | $0 | +$934 | $0 | -$934 |
| SPX 0DTE calls | 4 | 0 / 4 / 0 | 4 of 4 | -$3570 | $0 | +$3570 | $0 | -$3570 |
| Stock day trader (webull-agent) | 4 | 0 / 4 / 0 | 4 of 4 | +$138 | $0 | -$138 | $0 | +$138 |
| NVDA wheel (webull-options-agent) | 4 | 0 / 4 / 0 | 3 of 4 | $0 | n/a | n/a | $0 | $0 |

Direction right: buy and short calls only, SPY (NVDA for the wheel) from the price at the call to the close. If followed: buy = the agent's real result, sit out or short = $0 (the agents can only buy). The wheel holds for weeks, so it gets a direction grade only.

## Day by day (newest first)

| Date | Regime | SPY after call | SPY 0DTE | SPX 0DTE | Stocks | Wheel (NVDA after call) |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 | trend_down | -2.49% | short ✓, actual -$379 (call saved $379) | short ✓, actual -$1040 (call saved $1040) | short ✓, actual +$96 (call missed $96) | short ✓ (-5.84%) |
| 2026-11-18 | trend_down | -0.30% | short ✓, actual -$296 (call saved $296) | short ✓, actual -$1540 (call saved $1540) | short ✓, actual $0 | short ✓ (-2.45%) |
| 2026-11-17 | trend_down | -0.66% | short ✓, actual -$291 (call saved $291) | short ✓, actual -$1400 (call saved $1400) | short ✓, actual $0 | short ✗ (+0.67%) |
| 2026-11-16 | trend_down | -0.68% | short ✓, actual +$32 (call missed $32) | short ✓, actual +$410 (call missed $410) | short ✓, actual +$42 (call missed $42) | short ✓ (-2.30%) |

Not graded yet: 2026-11-20 (waiting for the close or the agents' logs).

Calls and their reasons: [analyst/calls.jsonl](calls.jsonl). Grades: [analyst/scores.jsonl](scores.jsonl). Rules: [analystRules.ts](../analystRules.ts).
