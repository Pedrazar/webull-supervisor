/**
 * Health and risk checks. Pure: World in, Finding[] out (plus the order
 * first-seen map, which needs memory across runs). main.ts turns limit
 * findings into pauses and runs the 0DTE auto-close.
 */

import {
  AGENTS,
  COMBINED_DAILY_LOSS_LIMIT,
  STALE_ORDER_MIN,
  ZERO_DTE_DEADLINE,
  AUTO_CLOSE_ALERT_AFTER_MIN,
  AgentId,
} from "./config";
import { Finding } from "./alerts";
import { World, optionOcc, optionLeg } from "./gather";
import { eventsOn, summarize, round2 } from "./logs";
import { isMarketHoliday, isMarketOpenNow, nyMinutesOf, todayNyDate, marketCloseMinutes } from "./marketHours";
import { midOf, Position } from "./broker";

export function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`;

/** Unrealized P&L of an option position in USD, or null when it can't be priced. */
export function optionUnrealized(p: Position, world: World): number | null {
  const occ = optionOcc(p);
  const snap = world.snapshots.find((s) => s.symbol === occ);
  const mid = midOf(snap);
  const leg = optionLeg(p);
  const multiLeg = (p.legs?.length ?? 0) > 1;
  // A multi-leg position's top-level quantity/cost_price describe the whole combo
  // (e.g. 500 shares + 5 short calls, blended cost), so only the leg's own fields count there.
  const qtyStr = (leg?.quantity as string | undefined) ?? (multiLeg ? undefined : p.quantity);
  const qty = qtyStr !== undefined ? parseFloat(String(qtyStr)) : NaN;
  const costStr = leg?.cost ?? (multiLeg ? undefined : p.cost_price);
  const cost = costStr ? Math.abs(parseFloat(costStr)) : NaN;
  if (mid === null || !Number.isFinite(qty) || !Number.isFinite(cost)) return null;
  return round2((mid - cost) * qty * 100);
}

export function ownerOf(p: Position): AgentId | null {
  return AGENTS.find((a) => a.owns(p))?.id ?? null;
}

export function isZeroDte(p: Position, today: string): boolean {
  return optionLeg(p)?.option_expire_date === today;
}

export interface RiskRow {
  agent: AgentId;
  realized: number | null; // null = log unreachable
  unrealized: number; // open 0DTE / wheel options marked to market (0 when none or unpriced)
  limit: number | null;
}

export function riskRows(world: World): RiskRow[] {
  return world.agents.map((a) => {
    const realized = a.events ? summarize(eventsOn(a.events, world.today)).realized : null;
    let unrealized = 0;
    for (const p of world.positions ?? []) {
      if (ownerOf(p) !== a.cfg.id || !optionLeg(p)) continue;
      const u = optionUnrealized(p, world);
      if (u !== null) unrealized += u;
    }
    return { agent: a.cfg.id, realized, unrealized: round2(unrealized), limit: a.cfg.dailyLossLimit };
  });
}

export function runChecks(world: World, orderFirstSeen: Record<string, string>): Finding[] {
  const f: Finding[] = [];
  const { now, today } = world;
  const nowMin = nyMinutesOf(now);
  const tradingDay = !isMarketHoliday(now);
  const marketOpen = isMarketOpenNow(now);
  const closeMin = marketCloseMinutes(now);

  // --- data sources ---------------------------------------------------------
  for (const a of world.agents) {
    if (a.error) {
      f.push({ key: `source:${a.cfg.id}`, level: "warn", agent: a.cfg.id, title: `${a.cfg.name}: status unknown`, detail: `Couldn't read GitHub for this agent: ${a.error.slice(0, 200)}` });
    }
  }
  if (world.brokerError) {
    f.push({ key: "source:broker", level: "warn", title: "Broker status unknown", detail: `Couldn't read Webull positions/orders: ${world.brokerError.slice(0, 200)}` });
  }

  // --- runs -----------------------------------------------------------------
  for (const a of world.agents) {
    if (!a.runs) continue;
    const todays = a.runs.filter((r) => todayNyDate(new Date(r.created_at)) === today);

    // One alert per agent per day, keyed by agent rather than run id: on 2026-11-17 the wheel
    // failed every 15 min and pushed 26 identical critical alerts. The first failure alerts;
    // the daily report still lists the total.
    const failedRuns = todays.filter((r) => r.status === "completed" && r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion));
    if (failedRuns.length > 0) {
      const r = failedRuns[failedRuns.length - 1]; // runs come newest first, so this is the first failure today
      f.push({ key: `run-failed:${a.cfg.id}`, level: "critical", agent: a.cfg.id, title: `${a.cfg.name}: run ${r.conclusion}`, detail: `A run that started ${clock(r.created_at)} ET ended "${r.conclusion}". Check whether a position or today's log was left behind. Further failures today won't alert again; the daily report counts them.`, url: r.html_url });
    }

    if (!tradingDay) continue;
    const s = a.cfg.schedule;
    if (s.kind === "session" && nowMin >= hhmm(s.startBy) && nowMin < closeMin && todays.length === 0) {
      f.push({ key: `no-start:${a.cfg.id}`, level: "critical", agent: a.cfg.id, title: `${a.cfg.name} didn't start`, detail: `No run today by ${s.startBy} ET. Dispatch it by hand if you still want today's session.`, url: `https://github.com/${a.cfg.owner}/${a.cfg.repo}/actions/workflows/${a.cfg.workflow}` });
    }
    if (s.kind === "ticker" && marketOpen && nowMin >= hhmm("10:00")) {
      const newest = a.runs[0];
      const ageMin = newest ? (now.getTime() - Date.parse(newest.created_at)) / 60000 : Infinity;
      if (ageMin > s.maxGapMin) {
        // Key by hour so a long outage re-alerts hourly rather than once.
        f.push({ key: `gap:${a.cfg.id}:${Math.floor(nowMin / 60)}`, level: "warn", agent: a.cfg.id, title: `${a.cfg.name} hasn't run`, detail: newest ? `Last run ${Math.round(ageMin)} min ago (${clock(newest.created_at)} ET); it should run every 15 min.` : "No run in the last 2 days.", url: `https://github.com/${a.cfg.owner}/${a.cfg.repo}/actions/workflows/${a.cfg.workflow}` });
      }
    }
  }

  // --- broker ---------------------------------------------------------------
  const positions = world.positions ?? [];
  for (const p of positions) {
    const owner = ownerOf(p);
    const desc = describePosition(p);
    if (!owner) {
      f.push({ key: `unowned:${desc}`, level: "warn", title: "Position no agent claims", detail: `${desc} is on the paper account but doesn't match any agent's symbols.` });
    }
    // Owned 0DTE with an auto-close time: alert only once the auto-close should
    // have finished (it failed, or J switched it off). Otherwise 3:35pm.
    const autoBefore = AGENTS.find((a) => a.id === owner)?.autoCloseBeforeCloseMin;
    const alertAt = autoBefore ? closeMin - autoBefore + AUTO_CLOSE_ALERT_AFTER_MIN : hhmm(ZERO_DTE_DEADLINE);
    if (isZeroDte(p, today) && nowMin >= alertAt && nowMin < closeMin) {
      f.push({ key: `0dte-open:${desc}`, level: "critical", agent: owner ?? undefined, title: "0DTE still open near the close", detail: `${desc} is still held at ${clock(now.toISOString())} ET${autoBefore ? " and the supervisor's auto-close didn't close it" : ""}. An ITM SPY call left at expiry is exercised into shares. Close it by hand now.` });
    }
  }

  // Wheel: broker vs. the agent's own state snapshot. (No assignment/cushion alerts: J, 2026-11-15, assignment is part of the strategy.)
  const wheelOpts = positions.filter((p) => ownerOf(p) === "wheel" && !!optionLeg(p));
  const ws = world.wheelState;
  if (world.positions && ws && marketOpen) {
    if (ws.openOption && wheelOpts.length === 0) {
      f.push({ key: "wheel-mismatch:missing", level: "warn", agent: "wheel", title: "Wheel position missing at broker", detail: `wheel-state.json says ${ws.openOption.optionSymbol} is open, but the broker shows no NVDA option. Assigned, expired, or closed without a log line?` });
    }
    if (!ws.openOption && wheelOpts.length > 0) {
      f.push({ key: "wheel-mismatch:extra", level: "warn", agent: "wheel", title: "Wheel holds an option it doesn't know about", detail: `Broker shows ${wheelOpts.map(describePosition).join(", ")}, but wheel-state.json has no open option.` });
    }
  }

  // Stale orders: remembered across runs by order id.
  const seenNow = new Set<string>();
  for (const o of world.openOrders ?? []) {
    const id = String(o.client_order_id ?? o.order_id ?? "");
    if (!id) continue;
    seenNow.add(id);
    // webull-agent's protective stops rest at the broker all day by design.
    if (/STOP/i.test(String(o.order_type ?? o.orderType ?? ""))) continue;
    const first = orderFirstSeen[id] ?? (orderFirstSeen[id] = now.toISOString());
    const ageMin = (now.getTime() - Date.parse(first)) / 60000;
    if (ageMin >= STALE_ORDER_MIN) {
      f.push({ key: `stale-order:${id}`, level: "warn", title: "Order working too long", detail: `Order ${id}${o.symbol ? ` (${o.symbol})` : ""} has been open at least ${Math.round(ageMin)} min. Agents normally settle or cancel their limit orders within seconds.` });
    }
  }
  if (world.openOrders) {
    for (const id of Object.keys(orderFirstSeen)) if (!seenNow.has(id)) delete orderFirstSeen[id];
  }

  // --- limits (a breach auto-pauses new entries, see main.ts) ---------------
  const rows = riskRows(world);
  let combined = 0;
  for (const r of rows) {
    const cfg = AGENTS.find((a) => a.id === r.agent)!;
    const total = (r.realized ?? 0) + (r.agent === "wheel" ? 0 : r.unrealized);
    combined += total;
    if (r.limit !== null && total <= -r.limit) {
      f.push({ key: `limit:${r.agent}`, level: "critical", agent: r.agent, title: `${cfg.name} hit its daily limit`, detail: `Today ${usd(total)} (realized ${usd(r.realized ?? 0)}, open ${usd(r.unrealized)}) vs limit -$${r.limit}. New entries for it are paused for the rest of today.` });
    }
  }
  if (combined <= -COMBINED_DAILY_LOSS_LIMIT) {
    f.push({ key: "limit:combined", level: "critical", title: "Paper account hit the combined daily limit", detail: `All agents today: ${usd(combined)} vs limit -$${COMBINED_DAILY_LOSS_LIMIT}. New entries for every paper agent are paused for the rest of today.` });
  }

  return f;
}

export function describePosition(p: Position): string {
  const legs = p.legs ?? [];
  if (legs.length > 1) {
    // e.g. the wheel's stock + covered call: "500 NVDA + -5x NVDA 2026-12-11 215 CALL"
    return legs
      .map((l) =>
        l.option_type
          ? `${l.quantity ?? "?"}x ${p.symbol} ${l.option_expire_date} ${l.option_exercise_price} ${l.option_type}`
          : `${l.quantity ?? "?"} ${p.symbol}`
      )
      .join(" + ");
  }
  const leg = optionLeg(p);
  if (leg) {
    return `${p.quantity}x ${p.symbol} ${leg.option_expire_date} ${leg.option_exercise_price} ${leg.option_type}`;
  }
  return `${p.quantity} ${p.symbol}`;
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
