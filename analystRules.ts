/**
 * The analyst's rules, as pure functions: bars in, one call per agent out.
 * No language model and no randomness, so the same data always gives the
 * same call and the track record can be audited from the log alone.
 *
 * SHADOW MODE: nothing here reaches an agent. The calls are logged and
 * graded against what the agents actually did (analystScore.ts).
 *
 * Starting thresholds are deliberately simple and written down here so a
 * later tuning pass changes numbers, not structure. They are NOT fitted to
 * past data.
 */

import { AgentId } from "./config";

export type Call = "buy" | "short" | "sit_out";
export type Regime = "trend_up" | "trend_down" | "range" | "high_vol";

export interface Bar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Daily-bar features of one symbol, from COMPLETED days only (today's partial bar excluded). */
export interface DailyFeatures {
  prevClose: number;
  ma20: number;
  ma50: number;
  /** MA20 five completed days earlier, for its slope. */
  ma20Prev5: number;
  /** Return over the last 5 completed days, as a fraction. */
  ret5: number;
  /** 20-day realized volatility, annualized fraction (0.18 = 18%). */
  rv20: number;
  days: number;
}

/** Today's regular-session move up to the call, from 5-minute bars. */
export interface IntradayFeatures {
  open: number;
  last: number;
  lastBarTime: string;
  /** (last - open) / open */
  movePct: number;
  /** (open - prevClose) / prevClose */
  gapPct: number;
}

export interface SymbolFeatures {
  symbol: string;
  daily: DailyFeatures | null;
  intraday: IntradayFeatures | null;
}

export interface AgentCall {
  agent: AgentId;
  call: Call;
  /** -1 (bearish) to +1 (bullish): the number the call was made from. */
  bias: number;
  /** 0 to 1. */
  confidence: number;
  /** Symbol whose move grades this call (SPY or NVDA). */
  underlying: string;
  /** Underlying price at the time of the call; the grade compares the close with it. */
  priceAtCall: number | null;
  reasons: string[];
  /** What following the call would mean for this agent today. */
  meaning: string;
}

export interface DayCalls {
  date: string;
  ts: string;
  /** True when made after 10:30 ET, i.e. after the 0DTE agents' morning entry. */
  late: boolean;
  regime: Regime | null;
  features: SymbolFeatures[];
  calls: AgentCall[];
  dataNotes: string[];
}

// ---- thresholds (starting values, see header) ----
export const RULES = {
  /** SPY 20-day realized vol at or above this = high_vol. */
  highVolRv: 0.25,
  /** An opening gap at least this big (either way) = high_vol. */
  highVolGap: 0.015,
  /** A move from the open this big by call time counts as a full intraday signal. */
  fullIntradayMove: 0.004,
  /** |bias| needed to call buy/short for the 0DTE agents on a normal day. */
  zeroDteEdge: 0.35,
  /** ...on a high_vol day. SPX is stricter: one stop there is ~$900. */
  spyHighVolEdge: 0.6,
  spxHighVolEdge: 0.75,
  /** NVDA 20-day realized vol at or above this = treat NVDA as high vol. */
  nvdaHighVolRv: 0.6,
  /** Day close vs price at call: a move smaller than this is "flat". */
  flatMove: 0.001,
};

export function computeDaily(completedOldestFirst: Bar[]): DailyFeatures | null {
  const c = completedOldestFirst.map((b) => b.close).filter((x) => Number.isFinite(x) && x > 0);
  if (c.length < 26) return null; // need MA20 + 5 days of slope at the very least
  const n = c.length;
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma20 = avg(c.slice(n - 20));
  const ma50 = avg(c.slice(Math.max(0, n - 50)));
  const ma20Prev5 = avg(c.slice(n - 25, n - 5));
  const rets: number[] = [];
  for (let i = n - 20; i < n; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const m = avg(rets);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1));
  return { prevClose: c[n - 1], ma20, ma50, ma20Prev5, ret5: c[n - 1] / c[n - 6] - 1, rv20: sd * Math.sqrt(252), days: n };
}

/** +1 clean uptrend, -1 clean downtrend, 0 otherwise. */
export function trendOf(d: DailyFeatures): -1 | 0 | 1 {
  if (d.prevClose > d.ma20 && d.ma20 > d.ma50 && d.ma20 > d.ma20Prev5) return 1;
  if (d.prevClose < d.ma20 && d.ma20 < d.ma50 && d.ma20 < d.ma20Prev5) return -1;
  return 0;
}

export function regimeOf(d: DailyFeatures, i: IntradayFeatures | null): Regime {
  if (d.rv20 >= RULES.highVolRv || (i && Math.abs(i.gapPct) >= RULES.highVolGap)) return "high_vol";
  const t = trendOf(d);
  return t === 1 ? "trend_up" : t === -1 ? "trend_down" : "range";
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;

function directional(bias: number, edge: number): Call {
  if (bias >= edge) return "buy";
  if (bias <= -edge) return "short";
  return "sit_out";
}

/**
 * Makes the day's four calls. `spy` is required for any call; `nvda` only
 * for the wheel (missing NVDA data gives the wheel a sit_out at confidence 0).
 */
export function makeCalls(date: string, now: Date, late: boolean, spy: SymbolFeatures, nvda: SymbolFeatures | null, wheelPutStrike?: number | null): DayCalls {
  const notes: string[] = [];
  const features = [spy, ...(nvda ? [nvda] : [])];
  if (!spy.daily) {
    return { date, ts: now.toISOString(), late, regime: null, features, calls: [], dataNotes: ["no SPY daily bars: no calls made"] };
  }
  const d = spy.daily;
  const i = spy.intraday;
  if (!i) notes.push("no SPY intraday bars yet: calls use the daily trend only, confidence halved");
  const regime = regimeOf(d, i);
  const trend = trendOf(d);
  const intra = i ? clamp(i.movePct / RULES.fullIntradayMove) : 0;
  const bias = r2(i ? 0.5 * trend + 0.5 * intra : 0.5 * trend);
  const quality = i ? 1 : 0.5;
  const priceAtCall = i?.last ?? null;

  const common: string[] = [
    `SPY regime ${regime}: last close ${d.prevClose.toFixed(2)} vs MA20 ${d.ma20.toFixed(2)} / MA50 ${d.ma50.toFixed(2)}, 20-day vol ${(d.rv20 * 100).toFixed(1)}%`,
  ];
  if (i) common.push(`SPY gapped ${pct(i.gapPct)} and is ${pct(i.movePct)} from the open at call time`);

  const calls: AgentCall[] = [];

  // SPY 0DTE paper: buys one ~$1 ITM call at 10:30 (and 12:30).
  const spyEdge = regime === "high_vol" ? RULES.spyHighVolEdge : RULES.zeroDteEdge;
  const spyCall = directional(bias, spyEdge);
  calls.push({
    agent: "spy-0dte",
    call: spyCall,
    bias,
    confidence: confidenceOf(spyCall, bias, spyEdge, quality),
    underlying: "SPY",
    priceAtCall,
    reasons: [...common, `bias ${bias} vs ${spyEdge} needed${regime === "high_vol" ? " on a high-vol day" : ""}`],
    meaning: meaning0dte(spyCall),
  });

  // SPX 0DTE: same direction read, stricter on high-vol days.
  const spxEdge = regime === "high_vol" ? RULES.spxHighVolEdge : RULES.zeroDteEdge;
  const spxCall = directional(bias, spxEdge);
  calls.push({
    agent: "spx-0dte",
    call: spxCall,
    bias,
    confidence: confidenceOf(spxCall, bias, spxEdge, quality),
    underlying: "SPY",
    priceAtCall,
    reasons: [...common, `bias ${bias} vs ${spxEdge} needed${regime === "high_vol" ? " on a high-vol day (a stop costs ~$900)" : ""}`],
    meaning: meaning0dte(spxCall),
  });

  // Stock day trader: long-only gap-up momentum. A market tailwind helps it,
  // a falling or panicky tape hurts it.
  let stockCall: Call;
  if (bias <= -0.6) stockCall = "short";
  else if (bias >= -0.1 && !(regime === "high_vol" && bias < RULES.zeroDteEdge)) stockCall = "buy";
  else stockCall = "sit_out";
  calls.push({
    agent: "webull-agent",
    call: stockCall,
    bias,
    confidence: r2(clamp(Math.abs(bias + 0.1), 0, 1) * quality),
    underlying: "SPY",
    priceAtCall,
    reasons: [...common, "gap-up longs need a market that isn't falling: buy at bias >= -0.1 (>= 0.35 on high-vol days), short at <= -0.6"],
    meaning:
      stockCall === "buy"
        ? "take today's crossover entries as usual"
        : stockCall === "short"
          ? "market is falling hard; a short would need code the agent doesn't have, so following = no entries today"
          : "skip new entries today",
  });

  // NVDA wheel: is it a good day to be short NVDA puts (bullish/neutral)?
  const nv = nvda?.daily;
  if (!nv) {
    notes.push("no NVDA daily bars: wheel call is sit_out at confidence 0");
    calls.push({ agent: "wheel", call: "sit_out", bias: 0, confidence: 0, underlying: "NVDA", priceAtCall: nvda?.intraday?.last ?? null, reasons: ["no NVDA data"], meaning: "no view" });
  } else {
    const nTrend = trendOf(nv);
    const nBias = r2(0.4 * nTrend + 0.3 * clamp(nv.ret5 / 0.05) + 0.3 * trend);
    const nHighVol = nv.rv20 >= RULES.nvdaHighVolRv;
    const wCall: Call = nBias >= 0.2 && !nHighVol ? "buy" : nBias <= -0.4 ? "short" : "sit_out";
    const nPrice = nvda?.intraday?.last ?? nv.prevClose;
    const reasons = [
      `NVDA last close ${nv.prevClose.toFixed(2)} vs MA20 ${nv.ma20.toFixed(2)} / MA50 ${nv.ma50.toFixed(2)}, 5-day ${pct(nv.ret5, 1)}, 20-day vol ${(nv.rv20 * 100).toFixed(0)}%`,
      `NVDA bias ${nBias} (40% NVDA trend, 30% 5-day move, 30% SPY trend)${nHighVol ? "; NVDA vol is high" : ""}`,
    ];
    if (wheelPutStrike && nPrice) reasons.push(`open short put strike ${wheelPutStrike}, NVDA ${pct(nPrice / wheelPutStrike - 1, 1)} above it`);
    calls.push({
      agent: "wheel",
      call: wCall,
      bias: nBias,
      confidence: r2(clamp(Math.abs(nBias) / 0.4, 0, 1)),
      underlying: "NVDA",
      priceAtCall: nvda?.intraday?.last ?? null,
      reasons,
      meaning:
        wCall === "buy"
          ? "bullish NVDA: fine to sell or hold puts"
          : wCall === "short"
            ? "bearish NVDA: don't sell a new put; a covered call is fine"
            : "neutral: don't open a new put today, manage what's open",
    });
  }

  return { date, ts: now.toISOString(), late, regime, features, calls, dataNotes: notes };
}

/** buy/short: how strong the bias is; sit_out: how far it is from either edge. */
function confidenceOf(call: Call, bias: number, edge: number, quality: number): number {
  const raw = call === "sit_out" ? 1 - Math.abs(bias) / edge : Math.min(1, Math.abs(bias));
  return r2(clamp(raw, 0, 1) * quality);
}

function meaning0dte(c: Call): string {
  if (c === "buy") return "buy the call as usual";
  if (c === "short") return "bearish: the agent can only buy calls, so following = sit out (a put would be the trade once puts exist)";
  return "skip today's entries";
}
