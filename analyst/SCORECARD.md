# Analyst scorecard (shadow mode)

The analyst makes one call per agent each trading day around 10:15am ET and controls nothing. 9 days graded since 2026-11-16. Following its calls would have added **$5237** across the three long-only agents.

_A two-to-three-week record is a small sample: treat these numbers as a first read, not proof._

## Totals

| Agent | Days | Calls (buy / short / sit out) | Direction right | Agent actual | If followed | Value added | Agent P&L on buy days | on sit-out/short days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPY 0DTE calls (paper) | 9 | 0 / 8 / 1 | 5 of 8 | -$1299 | $0 | +$1299 | $0 | -$1299 |
| SPX 0DTE calls | 9 | 0 / 7 / 2 | 5 of 7 | -$4130 | $0 | +$4130 | $0 | -$4130 |
| Stock day trader (webull-agent) | 9 | 0 / 7 / 2 | 4 of 7 | +$192 | $0 | -$192 | $0 | +$192 |
| NVDA wheel (webull-options-agent) | 9 | 0 / 9 / 0 | 5 of 9 | $0 | n/a | n/a | $0 | $0 |

Direction right: buy and short calls only, SPY (NVDA for the wheel) from the price at the call to the close. If followed: buy = the agent's real result, sit out or short = $0 (the agents can only buy). The wheel holds for weeks, so it gets a direction grade only.

## Day by day (newest first)

| Date | Regime | SPY after call | SPY 0DTE | SPX 0DTE | Stocks | Wheel (NVDA after call) |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-27 | high_vol | +0.85% | short ✗, actual +$105 (call missed $105) | short ✗, actual +$1400 (call missed $1400) | short ✗, actual $0 | short ✗ (+2.23%) |
| 2026-11-25 | high_vol | +2.03% | short ✗, actual +$373 (call missed $373) | sit out, actual +$1770 (call missed $1770) | short ✗, actual +$93 (call missed $93) | short ✗ (+3.29%) |
| 2026-11-24 | high_vol | -0.11% | sit out, actual -$69 (call saved $69) | sit out, actual -$1530 (call saved $1530) | sit out, actual +$3 (call missed $3) | short ✗ (+0.01%) |
| 2026-11-23 | high_vol | -0.04% | short ✗, actual -$384 (call saved $384) | short ✗, actual -$1130 (call saved $1130) | short ✗, actual $0 | short ✓ (-0.87%) |
| 2026-11-20 | trend_down | -3.36% | short ✓, actual -$390 (call saved $390) | short ✓, actual -$1070 (call saved $1070) | sit out, actual -$42 (call saved $42) | short ✓ (-10.55%) |
| 2026-11-19 | trend_down | -2.49% | short ✓, actual -$379 (call saved $379) | short ✓, actual -$1040 (call saved $1040) | short ✓, actual +$96 (call missed $96) | short ✓ (-5.84%) |
| 2026-11-18 | trend_down | -0.30% | short ✓, actual -$296 (call saved $296) | short ✓, actual -$1540 (call saved $1540) | short ✓, actual $0 | short ✓ (-2.45%) |
| 2026-11-17 | trend_down | -0.66% | short ✓, actual -$291 (call saved $291) | short ✓, actual -$1400 (call saved $1400) | short ✓, actual $0 | short ✗ (+0.67%) |
| 2026-11-16 | trend_down | -0.68% | short ✓, actual +$32 (call missed $32) | short ✓, actual +$410 (call missed $410) | short ✓, actual +$42 (call missed $42) | short ✓ (-2.30%) |

Calls and their reasons: [analyst/calls.jsonl](calls.jsonl). Grades: [analyst/scores.jsonl](scores.jsonl). Rules: [analystRules.ts](../analystRules.ts).
