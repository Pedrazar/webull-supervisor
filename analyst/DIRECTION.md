# Call or put: analyst direction reads (shadow mode)

For each 0DTE trade slot the analyst records whether it would buy a call, a put, or nothing: morning at ~10:15am ET, midday at ~12:15pm ET (a fresh read that may flip the morning). The agents still buy calls only; nothing here reaches them.

4 days graded.

## Ready to switch on?

- **SPY 0DTE (paper)**: not yet: 4/20 graded days, 5/8 put reads, 1/8 call reads, call hit rate 0% < 55%, 0/5 midday flips
- **SPX 0DTE**: not yet: 4/20 graded days, 5/8 put reads, 0/8 call reads, 0/5 midday flips

Bar (design doc): 20+ graded days, 8+ call and 8+ put reads, each side right 55%+ of the time, positive side edge, 5+ midday flips with at least half right.

## Totals

| Agent | Slot | Reads (call / put / none) | Calls right | Puts right | Midday flips right | Picked side, hold to close | Side edge vs always-call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spy-0dte | morning | 0 / 3 / 1 | - | 2/3 | n/a | +$3366 | +$4787 |
| spy-0dte | midday | 1 / 2 / 1 | 0/1 | 2/2 | - | +$917 | +$2024 |
| spy-0dte | all | 1 / 5 / 2 | 0/1 | 4/5 | - | +$4283 | +$6811 |
| spx-0dte | morning | 0 / 3 / 1 | - | 2/3 | n/a | +$3366 | +$4787 |
| spx-0dte | midday | 0 / 2 / 2 | - | 2/2 | - | +$1023 | +$2130 |
| spx-0dte | all | 0 / 5 / 3 | - | 4/5 | - | +$4389 | +$6917 |

Hold to close: one SPY contract $1 in the money, bought at the ask at the read, valued at intrinsic at the 4pm close. The agents really use stops, trails and an earlier exit, so this grades the side choice, not the P&L the agent would have made. SPX is graded on the same SPY read and prices (about 10x the dollars).

## Day by day (newest first)

| Date | SPY close | Slot | SPY read | Pick (SPY / SPX) | Call / put hold P&L | Put vs call spread at read | Agent did |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-24 | 718.78 | morning | 719.58 | none / none | -$312 / -$213 | 0.5% vs 0.6% | SPY call +$83, SPX call -$810 |
| 2026-11-24 | 718.78 | midday | 718.20 | call ✗ / none | -$106 / -$250 | 0.4% vs 0.4% | SPY call -$152, SPX call -$720 |
| 2026-11-23 | 722.29 | morning | 722.55 | put ✗ / put ✗ | -$351 / -$276 | 0.7% vs 0.5% | SPY call -$228, SPX call -$1130 |
| 2026-11-23 | 722.29 | midday | 723.96 | none / none | -$303 / -$14 | 0.7% vs 0.3% | SPY call -$156, SPX no entry |
| 2026-11-20 | 689.81 | morning | 713.81 | put ✓ / put ✓ | -$409 / +$2113 | 0.3% vs 0.2% | SPY call -$210, SPX call -$1070 |
| 2026-11-20 | 689.81 | midday | 701.64 | put ✓ / put ✓ | -$340 / +$919 | 0.3% vs 0.9% | SPY call -$180, SPX no entry |
| 2026-11-19 | 715.87 | morning | 734.14 | put ✓ / put ✓ | -$349 / +$1529 | 0.5% vs 0.6% | SPY call -$179, SPX call -$1040 |
| 2026-11-19 | 715.87 | midday | 719.62 | put ✓ / put ✓ | -$358 / +$104 | 0.7% vs 0.6% | SPY call -$200, SPX no entry |

Not graded yet: 2026-11-25.

Reads: [analyst/direction.jsonl](direction.jsonl). Grades: [analyst/direction-scores.jsonl](direction-scores.jsonl). Rules: [analystDirection.ts](../analystDirection.ts).
