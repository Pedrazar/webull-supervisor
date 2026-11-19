# Call or put: analyst direction reads (shadow mode)

For each 0DTE trade slot the analyst records whether it would buy a call, a put, or nothing: morning at ~10:15am ET, midday at ~12:15pm ET (a fresh read that may flip the morning). The agents still buy calls only; nothing here reaches them.

0 days graded.

## Ready to switch on?

- **SPY 0DTE (paper)**: not yet: 0/20 graded days, 0/8 put reads, 0/8 call reads, side edge +$0 not positive, 0/5 midday flips
- **SPX 0DTE**: not yet: 0/20 graded days, 0/8 put reads, 0/8 call reads, side edge +$0 not positive, 0/5 midday flips

Bar (design doc): 20+ graded days, 8+ call and 8+ put reads, each side right 55%+ of the time, positive side edge, 5+ midday flips with at least half right.

## Totals

| Agent | Slot | Reads (call / put / none) | Calls right | Puts right | Midday flips right | Picked side, hold to close | Side edge vs always-call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spy-0dte | morning | 0 / 0 / 0 | - | - | n/a | $0 | $0 |
| spy-0dte | midday | 0 / 0 / 0 | - | - | - | $0 | $0 |
| spy-0dte | all | 0 / 0 / 0 | - | - | - | $0 | $0 |
| spx-0dte | morning | 0 / 0 / 0 | - | - | n/a | $0 | $0 |
| spx-0dte | midday | 0 / 0 / 0 | - | - | - | $0 | $0 |
| spx-0dte | all | 0 / 0 / 0 | - | - | - | $0 | $0 |

Hold to close: one SPY contract $1 in the money, bought at the ask at the read, valued at intrinsic at the 4pm close. The agents really use stops, trails and an earlier exit, so this grades the side choice, not the P&L the agent would have made. SPX is graded on the same SPY read and prices (about 10x the dollars).

## Day by day (newest first)

| Date | SPY close | Slot | SPY read | Pick (SPY / SPX) | Call / put hold P&L | Put vs call spread at read | Agent did |
| --- | --- | --- | --- | --- | --- | --- | --- |

Not graded yet: 2026-11-19.

Reads: [analyst/direction.jsonl](direction.jsonl). Grades: [analyst/direction-scores.jsonl](direction-scores.jsonl). Rules: [analystDirection.ts](../analystDirection.ts).
