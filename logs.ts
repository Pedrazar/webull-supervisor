/**
 * Parsing the agents' append-only trade logs. Every agent writes one JSON
 * object per line with at least `ts` (UTC ISO) and `event`; any event that
 * closes a trade carries a numeric `realizedPnl` (exit_filled for the stock
 * and 0DTE agents, put_closed_early / call_closed_early etc. for the wheel).
 */

import { todayNyDate } from "./marketHours";

export interface LogEvent {
  ts: string;
  event: string;
  realizedPnl?: number;
  [key: string]: unknown;
}

export function parseLog(text: string | null): LogEvent[] {
  if (!text) return [];
  const out: LogEvent[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as LogEvent;
      if (typeof e.ts === "string" && typeof e.event === "string") out.push(e);
    } catch {
      // A half-written line must never take the supervisor down; skip it.
    }
  }
  return out;
}

export function nyDateOfTs(ts: string): string {
  return todayNyDate(new Date(ts));
}

export function eventsOn(events: LogEvent[], nyDate: string): LogEvent[] {
  return events.filter((e) => nyDateOfTs(e.ts) === nyDate);
}

export function eventsBetween(events: LogEvent[], fromNyDate: string, toNyDate: string): LogEvent[] {
  return events.filter((e) => {
    const d = nyDateOfTs(e.ts);
    return d >= fromNyDate && d <= toNyDate;
  });
}

export interface PnlSummary {
  realized: number;
  closedTrades: number;
  wins: number;
}

export function summarize(events: LogEvent[]): PnlSummary {
  let realized = 0;
  let closedTrades = 0;
  let wins = 0;
  for (const e of events) {
    if (typeof e.realizedPnl === "number" && Number.isFinite(e.realizedPnl)) {
      realized += e.realizedPnl;
      closedTrades++;
      if (e.realizedPnl > 0) wins++;
    }
  }
  return { realized: round2(realized), closedTrades, wins };
}

/** Monday of the week containing nyDate (YYYY-MM-DD), as YYYY-MM-DD. */
export function mondayOf(nyDate: string): string {
  const d = new Date(`${nyDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
