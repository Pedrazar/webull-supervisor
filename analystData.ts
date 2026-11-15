/**
 * Market data for the analyst: READ-ONLY bar reads, nothing else. Uses the
 * same two endpoints the agents already verified live:
 *   - POST /openapi/market-data/stock/batch-bars, timespan D (webull-agent's
 *     screener, for 10-day volume)
 *   - GET  /openapi/market-data/stock/bars, (webull-agent's seeding, M1;
 *     here M5). Confirmed most-recent-first; every number is a string.
 *
 * NOT yet verified live (the build environment has no route to Webull):
 * the timestamp convention of daily bars and the M5 timespan. The code is
 * written not to depend on either: bars are sorted by time when it parses,
 * today's partial daily bar is recognised by its open matching today's
 * first 5-minute bar, and the regular session is picked out of the 5-minute
 * bars by NY clock time, so a bar stamped at its start or end is at most
 * one bar off.
 */

import { WebullClient } from "./webullClient";
import { Bar, SymbolFeatures, computeDaily, IntradayFeatures } from "./analystRules";
import { marketCloseMinutes, nyMinutesOf, todayNyDate } from "./marketHours";

interface RawBar {
  time?: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

function toBar(b: RawBar): Bar {
  return {
    time: b.time ?? "",
    open: parseFloat(b.open),
    high: parseFloat(b.high),
    low: parseFloat(b.low),
    close: parseFloat(b.close),
    volume: b.volume ? parseFloat(b.volume) : 0,
  };
}

/** Oldest first. Sorts by time when every bar has one; otherwise trusts the confirmed newest-first order. */
export function oldestFirst(raw: RawBar[]): Bar[] {
  const bars = raw.map(toBar).filter((b) => [b.open, b.close].every(Number.isFinite));
  const ts = bars.map((b) => Date.parse(b.time));
  if (bars.length && ts.every(Number.isFinite)) return bars.map((b, i) => ({ b, t: ts[i] })).sort((x, y) => x.t - y.t).map((x) => x.b);
  return bars.reverse();
}

export async function dailyBars(client: WebullClient, symbols: string[], count = 60): Promise<Map<string, Bar[]>> {
  const res = await withRetry(() =>
    client.post<{ result?: Array<{ symbol: string; result?: RawBar[] }> }>("/openapi/market-data/stock/batch-bars", {
      symbols,
      category: "US_STOCK",
      timespan: "D",
      count: String(count),
    })
  );
  const out = new Map<string, Bar[]>();
  for (const e of res.result ?? []) out.set(e.symbol, oldestFirst(e.result ?? []));
  return out;
}

export async function fiveMinBars(client: WebullClient, symbol: string, count = 200): Promise<Bar[]> {
  const res = await withRetry(() =>
    client.get<RawBar[] | { result?: RawBar[] }>("/openapi/market-data/stock/bars", {
      symbol,
      category: "US_STOCK",
      timespan: "M5",
      count: String(count),
    })
  );
  return oldestFirst(Array.isArray(res) ? res : res.result ?? []);
}

/** Regular-session bars of one NY date (9:30 to 16:00, or 13:00 on a half day). */
export function sessionBars(bars: Bar[], nyDate: string): Bar[] {
  return bars.filter((b) => {
    const t = new Date(b.time);
    if (!Number.isFinite(t.getTime()) || todayNyDate(t) !== nyDate) return false;
    const m = nyMinutesOf(t);
    return m >= 9 * 60 + 30 && m < marketCloseMinutes(t);
  });
}

/**
 * Daily bars of completed days only. The newest daily bar is today's
 * (partial) bar when its open matches today's first 5-minute open, or when
 * its timestamp falls on today's NY date at or after 9:00.
 */
export function completedDays(daily: Bar[], today: string, todayOpen: number | null): Bar[] {
  if (daily.length === 0) return daily;
  const last = daily[daily.length - 1];
  const t = new Date(last.time);
  const stampedToday = Number.isFinite(t.getTime()) && todayNyDate(t) === today && nyMinutesOf(t) >= 9 * 60;
  const openMatches = todayOpen !== null && Math.abs(last.open - todayOpen) / todayOpen < 0.0005;
  return stampedToday || openMatches ? daily.slice(0, -1) : daily;
}

export function featuresOf(symbol: string, daily: Bar[] | undefined, fiveMin: Bar[] | null, today: string): SymbolFeatures {
  const sess = fiveMin ? sessionBars(fiveMin, today) : [];
  const todayOpen = sess.length ? sess[0].open : null;
  const done = daily ? completedDays(daily, today, todayOpen) : [];
  const d = computeDaily(done);
  let intraday: IntradayFeatures | null = null;
  if (sess.length && d) {
    const last = sess[sess.length - 1];
    intraday = {
      open: sess[0].open,
      last: last.close,
      lastBarTime: last.time,
      movePct: (last.close - sess[0].open) / sess[0].open,
      gapPct: (sess[0].open - d.prevClose) / d.prevClose,
    };
  }
  return { symbol, daily: d, intraday };
}

/** Regular-session close of `nyDate` from 5-minute bars, or null if the session isn't complete in them. */
export function sessionClose(fiveMin: Bar[], nyDate: string): number | null {
  const sess = sessionBars(fiveMin, nyDate);
  if (sess.length === 0) return null;
  const last = sess[sess.length - 1];
  const t = new Date(last.time);
  // Must reach the last half hour, or the day isn't over (or the data is cut short).
  return nyMinutesOf(t) >= marketCloseMinutes(t) - 30 ? last.close : null;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}
