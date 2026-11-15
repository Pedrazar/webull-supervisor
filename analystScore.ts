/**
 * Grading the analyst's shadow calls against what really happened. Pure
 * functions over the call log, the agents' trade logs and the day's close.
 *
 * Two questions per agent per day:
 *  1. Direction: did the underlying move the way the call said, from the
 *     price at the call to the close? buy needs > +0.1%, short < -0.1%.
 *     A sit_out has no direction to grade; it is graded on money (2).
 *  2. Money: what would the agent have made if it had followed the call?
 *     The stock and 0DTE agents can only go long, so "follow" means: buy =
 *     trade as it did, sit_out or short = no trades today = $0. Value added
 *     = followed - actual. A sit_out on a day the agent lost $900 is +$900.
 *     The wheel holds positions for weeks, so it gets a direction grade only.
 *
 * Known limit: a short call is graded on direction only. Pricing the put it
 * would have bought needs option history the supervisor doesn't fetch.
 */

import { AGENTS, AgentId } from "./config";
import { Call, DayCalls, RULES } from "./analystRules";
import { LogEvent, eventsOn, round2 } from "./logs";

export interface AgentGrade {
  agent: AgentId;
  call: Call;
  confidence: number;
  underlying: string;
  priceAtCall: number | null;
  close: number | null;
  /** close / priceAtCall - 1 */
  movePct: number | null;
  /** true/false for buy and short; null for sit_out or missing prices. */
  directionHit: boolean | null;
  /** Entries the agent actually made today. */
  agentEntries: number;
  /** Realized P&L the agent logged for today. */
  actualPnl: number;
  /** P&L if it had followed the call; null for the wheel. */
  followedPnl: number | null;
  /** followedPnl - actualPnl; null for the wheel. */
  valueAdded: number | null;
}

export interface DayScore {
  date: string;
  scoredAt: string;
  late: boolean;
  regime: string | null;
  grades: AgentGrade[];
}

const ENTRY = /^(entry_filled|entry_placed|put_sold|call_sold)$/;

/** Long-only agents whose "follow a sit_out/short" means "no trades today". */
const LONG_ONLY: AgentId[] = ["webull-agent", "spy-0dte", "spx-0dte"];

export function gradeDay(calls: DayCalls, closes: Record<string, number | null>, logs: Partial<Record<AgentId, LogEvent[]>>, now: Date): DayScore {
  const grades: AgentGrade[] = calls.calls.map((c) => {
    const close = closes[c.underlying] ?? null;
    const movePct = close !== null && c.priceAtCall ? close / c.priceAtCall - 1 : null;
    let directionHit: boolean | null = null;
    if (movePct !== null && c.call !== "sit_out") {
      directionHit = c.call === "buy" ? movePct > RULES.flatMove : movePct < -RULES.flatMove;
    }
    const today = eventsOn(logs[c.agent] ?? [], calls.date);
    const agentEntries = today.filter((e) => ENTRY.test(e.event)).length;
    const actualPnl = round2(today.reduce((s, e) => s + (typeof e.realizedPnl === "number" && Number.isFinite(e.realizedPnl) ? e.realizedPnl : 0), 0));
    let followedPnl: number | null = null;
    if (LONG_ONLY.includes(c.agent)) followedPnl = c.call === "buy" ? actualPnl : 0;
    return {
      agent: c.agent,
      call: c.call,
      confidence: c.confidence,
      underlying: c.underlying,
      priceAtCall: c.priceAtCall,
      close,
      movePct: movePct === null ? null : Math.round(movePct * 1e5) / 1e5,
      directionHit,
      agentEntries,
      actualPnl,
      followedPnl,
      valueAdded: followedPnl === null ? null : round2(followedPnl - actualPnl),
    };
  });
  return { date: calls.date, scoredAt: now.toISOString(), late: calls.late, regime: calls.regime, grades };
}

const usd = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(0)}`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const label = (c: Call) => (c === "sit_out" ? "sit out" : c);
const nameOf = (id: AgentId) => AGENTS.find((a) => a.id === id)?.name ?? id;

export interface AgentTotals {
  agent: AgentId;
  days: number;
  buys: number;
  shorts: number;
  sitOuts: number;
  directionGraded: number;
  directionHits: number;
  actual: number;
  followed: number | null;
  valueAdded: number | null;
  /** Agent P&L on days the analyst said buy, and on days it said sit out or short. */
  pnlOnBuyDays: number;
  pnlOnOtherDays: number;
}

export function totals(scores: DayScore[]): AgentTotals[] {
  const ids: AgentId[] = ["spy-0dte", "spx-0dte", "webull-agent", "wheel"];
  return ids.map((agent) => {
    const gs = scores.flatMap((s) => s.grades.filter((g) => g.agent === agent));
    const graded = gs.filter((g) => g.directionHit !== null);
    const longOnly = LONG_ONLY.includes(agent);
    return {
      agent,
      days: gs.length,
      buys: gs.filter((g) => g.call === "buy").length,
      shorts: gs.filter((g) => g.call === "short").length,
      sitOuts: gs.filter((g) => g.call === "sit_out").length,
      directionGraded: graded.length,
      directionHits: graded.filter((g) => g.directionHit).length,
      actual: round2(gs.reduce((s, g) => s + g.actualPnl, 0)),
      followed: longOnly ? round2(gs.reduce((s, g) => s + (g.followedPnl ?? 0), 0)) : null,
      valueAdded: longOnly ? round2(gs.reduce((s, g) => s + (g.valueAdded ?? 0), 0)) : null,
      pnlOnBuyDays: round2(gs.filter((g) => g.call === "buy").reduce((s, g) => s + g.actualPnl, 0)),
      pnlOnOtherDays: round2(gs.filter((g) => g.call !== "buy").reduce((s, g) => s + g.actualPnl, 0)),
    };
  });
}

export function scorecardMarkdown(scores: DayScore[], calls: DayCalls[], startDate: string): string {
  const sorted = [...scores].sort((a, b) => a.date.localeCompare(b.date));
  const t = totals(sorted);
  const added = round2(t.reduce((s, x) => s + (x.valueAdded ?? 0), 0));
  const L: string[] = [];
  L.push("# Analyst scorecard (shadow mode)");
  L.push("");
  L.push(
    `The analyst makes one call per agent each trading day around 10:15am ET and controls nothing. ` +
      `${sorted.length} day${sorted.length === 1 ? "" : "s"} graded since ${startDate}. ` +
      (sorted.length
        ? `Following its calls would have ${added >= 0 ? "added" : "cost"} **${usd(Math.abs(added)).replace(/^[+-]/, "")}** across the three long-only agents.`
        : "No graded days yet.")
  );
  L.push("");
  L.push(`_A two-to-three-week record is a small sample: ${sorted.length < 20 ? "treat these numbers as a first read, not proof" : "still check it against a longer backtest before trusting it"}._`);
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push("| Agent | Days | Calls (buy / short / sit out) | Direction right | Agent actual | If followed | Value added | Agent P&L on buy days | on sit-out/short days |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const x of t) {
    L.push(
      `| ${nameOf(x.agent)} | ${x.days} | ${x.buys} / ${x.shorts} / ${x.sitOuts} | ${x.directionGraded ? `${x.directionHits} of ${x.directionGraded}` : "-"} | ${usd(x.actual)} | ${
        x.followed === null ? "n/a" : usd(x.followed)
      } | ${x.valueAdded === null ? "n/a" : usd(x.valueAdded)} | ${usd(x.pnlOnBuyDays)} | ${usd(x.pnlOnOtherDays)} |`
    );
  }
  L.push("");
  L.push("Direction right: buy and short calls only, SPY (NVDA for the wheel) from the price at the call to the close. If followed: buy = the agent's real result, sit out or short = $0 (the agents can only buy). The wheel holds for weeks, so it gets a direction grade only.");
  L.push("");
  L.push("## Day by day (newest first)");
  L.push("");
  L.push("| Date | Regime | SPY after call | SPY 0DTE | SPX 0DTE | Stocks | Wheel (NVDA after call) |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of [...sorted].reverse().slice(0, 30)) {
    const g = (id: AgentId) => s.grades.find((x) => x.agent === id);
    const cell = (id: AgentId) => {
      const x = g(id);
      if (!x) return "-";
      const v = x.valueAdded === null ? "" : `, actual ${usd(x.actualPnl)}${x.valueAdded !== 0 ? ` (${x.valueAdded > 0 ? "call saved" : "call missed"} ${usd(Math.abs(x.valueAdded)).replace(/^[+-]/, "")})` : ""}`;
      return `${label(x.call)}${hitMark(x.directionHit)}${v}`;
    };
    const spyMove = g("spy-0dte")?.movePct;
    const w = g("wheel");
    L.push(
      `| ${s.date}${s.late ? " (late call)" : ""} | ${s.regime ?? "?"} | ${spyMove == null ? "?" : pct(spyMove)} | ${cell("spy-0dte")} | ${cell("spx-0dte")} | ${cell("webull-agent")} | ${
        w ? `${label(w.call)}${hitMark(w.directionHit)}${w.movePct == null ? "" : ` (${pct(w.movePct)})`}` : "-"
      } |`
    );
  }
  const pending = calls.filter((c) => !sorted.some((s) => s.date === c.date) && c.calls.length);
  if (pending.length) {
    L.push("");
    L.push(`Not graded yet: ${pending.map((c) => c.date).join(", ")} (waiting for the close or the agents' logs).`);
  }
  L.push("");
  L.push("Calls and their reasons: [analyst/calls.jsonl](calls.jsonl). Grades: [analyst/scores.jsonl](scores.jsonl). Rules: [analystRules.ts](../analystRules.ts).");
  return L.join("\n") + "\n";
}

function hitMark(h: boolean | null): string {
  return h === null ? "" : h ? " ✓" : " ✗";
}

/** The ntfy line for the morning call. */
export function callSummary(c: DayCalls): string {
  const by = (id: AgentId) => c.calls.find((x) => x.agent === id);
  const part = (id: AgentId, name: string) => {
    const x = by(id);
    return x ? `${name} ${label(x.call).toUpperCase()} (${Math.round(x.confidence * 100)}%)` : `${name} -`;
  };
  const spy = c.features.find((f) => f.symbol === "SPY")?.intraday;
  return (
    `${c.regime ?? "unknown regime"}${spy ? `, SPY ${pct(spy.movePct)} since open` : ""}. ` +
    [part("spy-0dte", "SPY"), part("spx-0dte", "SPX"), part("webull-agent", "Stocks"), part("wheel", "Wheel")].join(" | ") +
    `. Shadow only, agents unchanged.${c.late ? " Late: made after the 10:30 entries." : ""}`
  );
}

/** The ntfy line for the evening grade. */
export function scoreSummary(s: DayScore, all: DayScore[]): string {
  const parts = s.grades
    .filter((g) => g.agent !== "wheel")
    .map((g) => `${g.agent === "webull-agent" ? "Stocks" : g.agent === "spy-0dte" ? "SPY" : "SPX"} ${label(g.call)}${hitMark(g.directionHit)}: actual ${usd(g.actualPnl)}, followed ${usd(g.followedPnl ?? 0)}`);
  const todayAdded = round2(s.grades.reduce((x, g) => x + (g.valueAdded ?? 0), 0));
  const allAdded = round2(totals(all).reduce((x, t) => x + (t.valueAdded ?? 0), 0));
  return `${parts.join(". ")}. Today ${usd(todayAdded)} vs actual; ${usd(allAdded)} over ${all.length} day${all.length === 1 ? "" : "s"}.`;
}
