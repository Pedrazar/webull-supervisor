/**
 * Call-or-put direction reads for the two 0DTE agents, SHADOW MODE.
 *
 * Today both 0DTE agents only buy calls. J wants the analyst, once active,
 * to pick call or put per trade: the morning trade from the pre-market and
 * opening read, and the midday trade from how the chart and sentiment have
 * gone since, even if that is the opposite of the morning. Before anything
 * is switched on, this module records what it WOULD have picked for each
 * slot and grades it, so the choice can be judged on a record.
 *
 *  - morning (10:15 ET, with the existing daily call): side = the existing
 *    buy/short/sit-out call mapped to call/put/none.
 *  - midday (12:15 ET, before the 12:30 entries): a fresh read from the
 *    session so far: daily trend, move from the open, last-hour momentum
 *    and price vs the session VWAP. It does not look at the morning read,
 *    so a flip is allowed and recorded as such.
 *
 * Each read also prices the SPY 0DTE contracts the agent would buy on each
 * side ($1 in the money: call strike = price - 1, put strike = price + 1),
 * so grading can compare picking a side against always buying the call.
 * The money grade is HOLD TO CLOSE (intrinsic at the 4pm close minus the
 * ask at the read). The real agents use stops and trails and exit at
 * 3:30/3:45, so this is a proxy for the side choice, not a P&L forecast.
 * SPX uses the same SPY read and prices (same underlying, ~10x dollars).
 *
 * Pure functions only; analyst.ts does the I/O.
 */

import { Bar, Call, DayCalls, IntradayFeatures, DailyFeatures, RULES as BASE, Regime, trendOf } from "./analystRules";
import { LogEvent, eventsOn, round2 } from "./logs";
import { nyMinutesOf } from "./marketHours";

export type Side = "call" | "put" | "none";
export type Slot = "morning" | "midday";
export type ZeroDteAgent = "spy-0dte" | "spx-0dte";

export const DIRECTION_RULES = {
  /** A move from the open this big counts as a full "day so far" signal. */
  fullDayMove: BASE.fullIntradayMove,
  /** A move over the last 60 minutes this big counts as full momentum. */
  fullHourMove: 0.002,
  /** Price this far from the session VWAP counts as a full signal. */
  fullVwapGap: 0.002,
  /** Midday bias weights (sum 1). Starting values, not fitted. */
  wTrend: 0.2,
  wDay: 0.25,
  wHour: 0.3,
  wVwap: 0.25,
  /** Same edges as the morning call. */
  edge: BASE.zeroDteEdge,
  spyHighVolEdge: BASE.spyHighVolEdge,
  spxHighVolEdge: BASE.spxHighVolEdge,
  /** How far in the money the would-be contracts are, in SPY dollars (the SPY agent's offset). */
  strikeOffset: 1,
};

export interface ContractQuote {
  symbol: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  /** (ask - bid) / mid, null without both sides. */
  spreadPct: number | null;
}

export interface SideRead {
  agent: ZeroDteAgent;
  side: Side;
  bias: number;
  confidence: number;
  edge: number;
}

export interface DirectionRead {
  date: string;
  slot: Slot;
  ts: string;
  /** Made after this slot's entry time (10:30 / 12:30 ET). */
  late: boolean;
  regime: Regime | null;
  spyAtRead: number | null;
  reads: SideRead[];
  /** Midday only: the bias components, so a flip can be explained from the log. */
  components?: { trend: number; day: number; hour: number; vwap: number; vwapPrice: number | null };
  /** The SPY 0DTE contracts each side would buy, quoted at the read. */
  contracts: { call: ContractQuote | null; put: ContractQuote | null };
  reasons: string[];
  notes: string[];
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;

export function sideOf(call: Call): Side {
  return call === "buy" ? "call" : call === "short" ? "put" : "none";
}

function sideFromBias(bias: number, edge: number): Side {
  if (bias >= edge) return "call";
  if (bias <= -edge) return "put";
  return "none";
}

function confidence(side: Side, bias: number, edge: number): number {
  return r2(clamp(side === "none" ? 1 - Math.abs(bias) / edge : Math.abs(bias), 0, 1));
}

function edgeFor(agent: ZeroDteAgent, regime: Regime | null): number {
  if (regime !== "high_vol") return DIRECTION_RULES.edge;
  return agent === "spy-0dte" ? DIRECTION_RULES.spyHighVolEdge : DIRECTION_RULES.spxHighVolEdge;
}

/** Strikes the SPY agent would buy on each side at this price ($1 strikes). */
export function wouldBeStrikes(price: number): { call: number; put: number } {
  return { call: Math.round(price - DIRECTION_RULES.strikeOffset), put: Math.round(price + DIRECTION_RULES.strikeOffset) };
}

/** The morning read: the existing daily call, mapped to a side. */
export function morningRead(day: DayCalls, contracts: DirectionRead["contracts"], late: boolean): DirectionRead {
  const reads: SideRead[] = [];
  for (const agent of ["spy-0dte", "spx-0dte"] as ZeroDteAgent[]) {
    const c = day.calls.find((x) => x.agent === agent);
    if (!c) continue;
    const edge = edgeFor(agent, day.regime);
    reads.push({ agent, side: sideOf(c.call), bias: c.bias, confidence: c.confidence, edge });
  }
  const spy = day.features.find((f) => f.symbol === "SPY")?.intraday ?? null;
  return {
    date: day.date,
    slot: "morning",
    ts: day.ts,
    late,
    regime: day.regime,
    spyAtRead: spy?.last ?? null,
    reads,
    contracts,
    reasons: day.calls.find((x) => x.agent === "spy-0dte")?.reasons ?? [],
    notes: [...day.dataNotes],
  };
}

/** Volume-weighted average of the bars' typical price; null without volume. */
export function sessionVwap(sess: Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of sess) {
    if (!(b.volume > 0)) continue;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

/**
 * The midday read, from the session's 5-minute bars up to now. Needs the
 * daily features (for the trend) and at least an hour of session bars.
 */
export function middayRead(
  date: string,
  now: Date,
  late: boolean,
  daily: DailyFeatures,
  intraday: IntradayFeatures,
  sess: Bar[],
  regime: Regime,
  contracts: DirectionRead["contracts"]
): DirectionRead {
  const R = DIRECTION_RULES;
  const notes: string[] = [];
  const last = sess[sess.length - 1];
  const lastMin = nyMinutesOf(new Date(last.time));
  const hourAgo = [...sess].reverse().find((b) => nyMinutesOf(new Date(b.time)) <= lastMin - 60);
  if (!hourAgo) notes.push("less than an hour of session bars: momentum counted as 0");
  const vwap = sessionVwap(sess);
  if (vwap === null) notes.push("no bar volume: VWAP counted as 0");

  const trend = trendOf(daily);
  const day = clamp(intraday.movePct / R.fullDayMove);
  const hour = hourAgo ? clamp((last.close / hourAgo.close - 1) / R.fullHourMove) : 0;
  const vw = vwap ? clamp((last.close / vwap - 1) / R.fullVwapGap) : 0;
  const bias = r2(R.wTrend * trend + R.wDay * day + R.wHour * hour + R.wVwap * vw);

  const reads: SideRead[] = (["spy-0dte", "spx-0dte"] as ZeroDteAgent[]).map((agent) => {
    const edge = edgeFor(agent, regime);
    const side = sideFromBias(bias, edge);
    return { agent, side, bias, confidence: confidence(side, bias, edge), edge };
  });

  const reasons = [
    `SPY ${pct(intraday.movePct)} from the open, ${hourAgo ? pct(last.close / hourAgo.close - 1) : "?"} over the last hour, ${vwap ? `${pct(last.close / vwap - 1)} vs VWAP ${vwap.toFixed(2)}` : "no VWAP"}`,
    `daily trend ${trend > 0 ? "up" : trend < 0 ? "down" : "flat"}, regime ${regime}`,
    `bias ${bias} = ${R.wTrend} trend + ${R.wDay} day + ${R.wHour} hour + ${R.wVwap} VWAP`,
  ];
  return {
    date,
    slot: "midday",
    ts: now.toISOString(),
    late,
    regime,
    spyAtRead: last.close,
    reads,
    components: { trend, day: r2(day), hour: r2(hour), vwap: r2(vw), vwapPrice: vwap === null ? null : r2(vwap) },
    contracts,
    reasons,
    notes,
  };
}

// ---- grading ----

export interface SideGrade {
  agent: ZeroDteAgent;
  slot: Slot;
  side: Side;
  /** SPY close / SPY at the read - 1. */
  movePct: number | null;
  /** call/put only: did SPY move the picked way by more than the flat band. */
  directionHit: boolean | null;
  /** Hold-to-close P&L of one SPY contract on each side, per contract in dollars (ask at read -> intrinsic at close). */
  callHoldPnl: number | null;
  putHoldPnl: number | null;
  /** P&L of the side picked (none = 0). */
  pickedHoldPnl: number | null;
  /** pickedHoldPnl - callHoldPnl: what picking a side added over always buying the call. */
  sideEdge: number | null;
  /** Midday only: picked side differs from the morning's picked side (both not none). */
  flip: boolean;
  /** What the agent really did in this slot (calls only today). */
  agentEntered: boolean;
  agentPnl: number;
}

export interface DirectionScore {
  date: string;
  scoredAt: string;
  spyClose: number;
  grades: SideGrade[];
}

function holdPnl(q: ContractQuote | null, type: "call" | "put", close: number): number | null {
  if (!q || q.ask === null || !(q.ask > 0)) return null;
  const intrinsic = type === "call" ? Math.max(0, close - q.strike) : Math.max(0, q.strike - close);
  return round2((intrinsic - q.ask) * 100);
}

function slotOf(e: LogEvent): Slot {
  return e.slot === "midday" ? "midday" : "morning";
}

export function gradeDirection(reads: DirectionRead[], spyClose: number, logs: Partial<Record<ZeroDteAgent, LogEvent[]>>, now: Date): DirectionScore | null {
  if (reads.length === 0) return null;
  const date = reads[0].date;
  const morning = reads.find((r) => r.slot === "morning");
  const grades: SideGrade[] = [];
  for (const r of reads) {
    const callHoldPnl = holdPnl(r.contracts.call, "call", spyClose);
    const putHoldPnl = holdPnl(r.contracts.put, "put", spyClose);
    const movePct = r.spyAtRead ? spyClose / r.spyAtRead - 1 : null;
    for (const s of r.reads) {
      const directionHit = movePct === null || s.side === "none" ? null : s.side === "call" ? movePct > BASE.flatMove : movePct < -BASE.flatMove;
      const picked = s.side === "none" ? 0 : s.side === "call" ? callHoldPnl : putHoldPnl;
      const mSide = morning?.reads.find((x) => x.agent === s.agent)?.side;
      const today = eventsOn(logs[s.agent] ?? [], date).filter((e) => slotOf(e) === r.slot);
      grades.push({
        agent: s.agent,
        slot: r.slot,
        side: s.side,
        movePct: movePct === null ? null : Math.round(movePct * 1e5) / 1e5,
        directionHit,
        callHoldPnl,
        putHoldPnl,
        pickedHoldPnl: picked,
        sideEdge: picked === null || callHoldPnl === null ? null : round2(picked - callHoldPnl),
        flip: r.slot === "midday" && !!mSide && mSide !== "none" && s.side !== "none" && mSide !== s.side,
        agentEntered: today.some((e) => e.event === "entry_filled"),
        agentPnl: round2(today.reduce((x, e) => x + (typeof e.realizedPnl === "number" && Number.isFinite(e.realizedPnl) ? e.realizedPnl : 0), 0)),
      });
    }
  }
  return { date, scoredAt: now.toISOString(), spyClose, grades };
}

// ---- report ----

export interface DirectionTotals {
  agent: ZeroDteAgent;
  slot: Slot | "all";
  reads: number;
  calls: number;
  puts: number;
  nones: number;
  callHits: number;
  callGraded: number;
  putHits: number;
  putGraded: number;
  flips: number;
  flipHits: number;
  sideEdge: number;
  pickedHold: number;
}

export function directionTotals(scores: DirectionScore[], agent: ZeroDteAgent, slot: Slot | "all"): DirectionTotals {
  const gs = scores.flatMap((s) => s.grades).filter((g) => g.agent === agent && (slot === "all" || g.slot === slot));
  const graded = (side: Side) => gs.filter((g) => g.side === side && g.directionHit !== null);
  return {
    agent,
    slot,
    reads: gs.length,
    calls: gs.filter((g) => g.side === "call").length,
    puts: gs.filter((g) => g.side === "put").length,
    nones: gs.filter((g) => g.side === "none").length,
    callHits: graded("call").filter((g) => g.directionHit).length,
    callGraded: graded("call").length,
    putHits: graded("put").filter((g) => g.directionHit).length,
    putGraded: graded("put").length,
    flips: gs.filter((g) => g.flip).length,
    flipHits: gs.filter((g) => g.flip && g.directionHit).length,
    sideEdge: round2(gs.reduce((x, g) => x + (g.sideEdge ?? 0), 0)),
    pickedHold: round2(gs.reduce((x, g) => x + (g.pickedHoldPnl ?? 0), 0)),
  };
}

/**
 * The activation bar from the design doc, checked mechanically so the
 * report says plainly whether the record is there yet. Per agent, all slots.
 */
export const ACTIVATION_BAR = {
  minGradedDays: 20,
  minPutReads: 8,
  minCallReads: 8,
  minHitRate: 0.55,
  minFlips: 5,
};

export function activationCheck(scores: DirectionScore[], agent: ZeroDteAgent): { ready: boolean; missing: string[] } {
  const t = directionTotals(scores, agent, "all");
  const days = scores.filter((s) => s.grades.some((g) => g.agent === agent)).length;
  const missing: string[] = [];
  const B = ACTIVATION_BAR;
  if (days < B.minGradedDays) missing.push(`${days}/${B.minGradedDays} graded days`);
  if (t.puts < B.minPutReads) missing.push(`${t.puts}/${B.minPutReads} put reads`);
  if (t.calls < B.minCallReads) missing.push(`${t.calls}/${B.minCallReads} call reads`);
  const rate = (h: number, n: number) => (n ? h / n : 0);
  if (t.putGraded && rate(t.putHits, t.putGraded) < B.minHitRate) missing.push(`put hit rate ${(rate(t.putHits, t.putGraded) * 100).toFixed(0)}% < ${Math.round(B.minHitRate * 100)}%`);
  if (t.callGraded && rate(t.callHits, t.callGraded) < B.minHitRate) missing.push(`call hit rate ${(rate(t.callHits, t.callGraded) * 100).toFixed(0)}% < ${Math.round(B.minHitRate * 100)}%`);
  if (t.sideEdge <= 0) missing.push(`side edge ${t.sideEdge >= 0 ? "+" : "-"}$${Math.abs(t.sideEdge).toFixed(0)} not positive`);
  if (t.flips < B.minFlips) missing.push(`${t.flips}/${B.minFlips} midday flips`);
  else if (rate(t.flipHits, t.flips) < 0.5) missing.push(`midday flips right ${t.flipHits}/${t.flips}`);
  return { ready: missing.length === 0, missing };
}

const usd = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(0)}`;
const ratio = (h: number, n: number) => (n ? `${h}/${n}` : "-");

export function directionMarkdown(scores: DirectionScore[], reads: DirectionRead[]): string {
  const sorted = [...scores].sort((a, b) => a.date.localeCompare(b.date));
  const L: string[] = [];
  L.push("# Call or put: analyst direction reads (shadow mode)");
  L.push("");
  L.push(
    "For each 0DTE trade slot the analyst records whether it would buy a call, a put, or nothing: morning at ~10:15am ET, midday at ~12:15pm ET (a fresh read that may flip the morning). " +
      "The agents still buy calls only; nothing here reaches them."
  );
  L.push("");
  L.push(`${sorted.length} day${sorted.length === 1 ? "" : "s"} graded.`);
  L.push("");
  L.push("## Ready to switch on?");
  L.push("");
  for (const agent of ["spy-0dte", "spx-0dte"] as ZeroDteAgent[]) {
    const a = activationCheck(sorted, agent);
    L.push(`- **${agent === "spy-0dte" ? "SPY 0DTE (paper)" : "SPX 0DTE"}**: ${a.ready ? "the record meets the bar; J decides" : `not yet: ${a.missing.join(", ")}`}`);
  }
  L.push("");
  L.push(`Bar (design doc): ${ACTIVATION_BAR.minGradedDays}+ graded days, ${ACTIVATION_BAR.minCallReads}+ call and ${ACTIVATION_BAR.minPutReads}+ put reads, each side right ${Math.round(ACTIVATION_BAR.minHitRate * 100)}%+ of the time, positive side edge, ${ACTIVATION_BAR.minFlips}+ midday flips with at least half right.`);
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push("| Agent | Slot | Reads (call / put / none) | Calls right | Puts right | Midday flips right | Picked side, hold to close | Side edge vs always-call |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const agent of ["spy-0dte", "spx-0dte"] as ZeroDteAgent[]) {
    for (const slot of ["morning", "midday", "all"] as const) {
      const t = directionTotals(sorted, agent, slot);
      L.push(
        `| ${agent} | ${slot} | ${t.calls} / ${t.puts} / ${t.nones} | ${ratio(t.callHits, t.callGraded)} | ${ratio(t.putHits, t.putGraded)} | ${slot === "morning" ? "n/a" : ratio(t.flipHits, t.flips)} | ${usd(t.pickedHold)} | ${usd(t.sideEdge)} |`
      );
    }
  }
  L.push("");
  L.push(
    "Hold to close: one SPY contract $1 in the money, bought at the ask at the read, valued at intrinsic at the 4pm close. The agents really use stops, trails and an earlier exit, so this grades the side choice, not the P&L the agent would have made. SPX is graded on the same SPY read and prices (about 10x the dollars)."
  );
  L.push("");
  L.push("## Day by day (newest first)");
  L.push("");
  L.push("| Date | SPY close | Slot | SPY read | Pick (SPY / SPX) | Call / put hold P&L | Put vs call spread at read | Agent did |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of [...sorted].reverse().slice(0, 30)) {
    for (const slot of ["morning", "midday"] as Slot[]) {
      const spy = s.grades.find((g) => g.agent === "spy-0dte" && g.slot === slot);
      const spx = s.grades.find((g) => g.agent === "spx-0dte" && g.slot === slot);
      if (!spy && !spx) continue;
      const r = reads.find((x) => x.date === s.date && x.slot === slot);
      const mark = (g?: SideGrade) => (g ? `${g.side}${g.directionHit === null ? "" : g.directionHit ? " ✓" : " ✗"}${g.flip ? " (flip)" : ""}` : "-");
      const sp = (q: ContractQuote | null | undefined) => (q?.spreadPct == null ? "?" : `${(q.spreadPct * 100).toFixed(1)}%`);
      const did = (g?: SideGrade) => (g ? (g.agentEntered ? `call ${usd(g.agentPnl)}` : "no entry") : "-");
      L.push(
        `| ${s.date} | ${s.spyClose.toFixed(2)} | ${slot}${r?.late ? " (late)" : ""} | ${r?.spyAtRead?.toFixed(2) ?? "?"} | ${mark(spy)} / ${mark(spx)} | ${spy?.callHoldPnl == null ? "?" : usd(spy.callHoldPnl)} / ${
          spy?.putHoldPnl == null ? "?" : usd(spy.putHoldPnl)
        } | ${sp(r?.contracts.put)} vs ${sp(r?.contracts.call)} | SPY ${did(spy)}, SPX ${did(spx)} |`
      );
    }
  }
  const pending = [...new Set(reads.map((r) => r.date))].filter((d) => !sorted.some((s) => s.date === d));
  if (pending.length) {
    L.push("");
    L.push(`Not graded yet: ${pending.join(", ")}.`);
  }
  L.push("");
  L.push("Reads: [analyst/direction.jsonl](direction.jsonl). Grades: [analyst/direction-scores.jsonl](direction-scores.jsonl). Rules: [analystDirection.ts](../analystDirection.ts).");
  return L.join("\n") + "\n";
}

/** The ntfy line for a read. */
export function readSummary(r: DirectionRead): string {
  const p = (a: ZeroDteAgent) => {
    const x = r.reads.find((s) => s.agent === a);
    return x ? `${a === "spy-0dte" ? "SPY" : "SPX"} ${x.side.toUpperCase()} (${Math.round(x.confidence * 100)}%)` : "";
  };
  return `${r.slot} read: ${[p("spy-0dte"), p("spx-0dte")].filter(Boolean).join(" | ")}. ${r.reasons[0] ?? ""}. Shadow only, agents still buy calls.${r.late ? " Late: after the entry time." : ""}`;
}
