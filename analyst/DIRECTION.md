# Call or put: analyst direction reads (shadow mode)

For each 0DTE trade slot the analyst records whether it would buy a call, a put, or nothing: morning at ~10:15am ET, midday at ~12:15pm ET (a fresh read that may flip the morning). The agents still buy calls only; nothing here reaches them.

1 day graded.

## Ready to switch on?

- **SPY 0DTE (paper)**: not yet: 1/20 graded days, 2/8 put reads, 0/8 call reads, 0/5 midday flips
- **SPX 0DTE**: not yet: 1/20 graded days, 2/8 put reads, 0/8 call reads, 0/5 midday flips

Bar (design doc): 20+ graded days, 8+ call and 8+ put reads, each side right 55%+ of the time, positive side edge, 5+ midday flips with at least half right.

## Totals

| Agent | Slot | Reads (call / put / none) | Calls right | Puts right | Midday flips right | Picked side, hold to close | Side edge vs always-call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spy-0dte | morning | 0 / 1 / 0 | - | 1/1 | n/a | +$1529 | +$1878 |
| spy-0dte | midday | 0 / 1 / 0 | - | 1/1 | - | +$104 | +$462 |
| spy-0dte | all | 0 / 2 / 0 | - | 2/2 | - | +$1633 | +$2340 |
| spx-0dte | morning | 0 / 1 / 0 | - | 1/1 | n/a | +$1529 | +$1878 |
| spx-0dte | midday | 0 / 1 / 0 | - | 1/1 | - | +$104 | +$462 |
| spx-0dte | all | 0 / 2 / 0 | - | 2/2 | - | +$1633 | +$2340 |

Hold to close: one SPY contract $1 in the money, bought at the ask at the read, valued at intrinsic at the 4pm close. The agents really use stops, trails and an earlier exit, so this grades the side choice, not the P&L the agent would have made. SPX is graded on the same SPY read and prices (about 10x the dollars).

## Day by day (newest first)

| Date | SPY close | Slot | SPY read | Pick (SPY / SPX) | Call / put hold P&L | Put vs call spread at read | Agent did |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 | 715.87 | morning | 734.14 | put ✓ / put ✓ | -$349 / +$1529 | 0.5% vs 0.6% | SPY call -$179, SPX call -$1040 |
| 2026-11-19 | 715.87 | midday | 719.62 | put ✓ / put ✓ | -$358 / +$104 | 0.7% vs 0.6% | SPY call -$200, SPX no entry |

Reads: [analyst/direction.jsonl](direction.jsonl). Grades: [analyst/direction-scores.jsonl](direction-scores.jsonl). Rules: [analystDirection.ts](../analystDirection.ts).
