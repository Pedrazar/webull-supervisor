/**
 * Phase 3: sell any long 0DTE option an agent is still holding after its
 * own end-of-day exit should have run (SPY 3:40pm, SPX 3:50pm ET on a normal
 * day). Paper account only (orders.ts refuses anything but the sandbox).
 * Off switch: control.json "autoClose0dte": false (workflow input
 * auto_close=off).
 *
 * Pricing copies the agents' exits: a LIMIT sell starting a little under the
 * bid and getting ~2x more aggressive each unfilled attempt (3%, 6%, 12%,
 * 24%, then 50%), each order cancelled after 10s if unfilled. The position
 * is re-read before every attempt, so if the agent sells first we just stop.
 */

import { AGENTS, AUTO_CLOSE_BUDGET_MIN } from "./config";
import { Position, getPositions, getOptionSnapshots } from "./broker";
import { optionOcc } from "./gather";
import { ownerOf, isZeroDte, describePosition } from "./checks";
import { makeOrderClient, placeSellToClose, settleOrder, sleep } from "./orders";
import { nyMinutesOf, marketCloseMinutes, todayNyDate } from "./marketHours";

export interface AutoCloseResult {
  agent: string;
  position: string; // human description
  occ: string;
  contracts: number;
  sold: number;
  avgPrice: number | null;
  ok: boolean; // broker shows the position gone
  detail: string;
}

/** Minute (NY) at which this position becomes due, or null if it is never auto-closed. */
export function dueAtMin(p: Position, closeMin: number): number | null {
  const owner = ownerOf(p);
  const cfg = AGENTS.find((a) => a.id === owner);
  if (!cfg?.autoCloseBeforeCloseMin) return null;
  return closeMin - cfg.autoCloseBeforeCloseMin;
}

/** Long 0DTE options that are due now. Short options, stock and the wheel are never touched. */
export function dueForAutoClose(positions: Position[], now: Date): Position[] {
  const today = todayNyDate(now);
  const nowMin = nyMinutesOf(now);
  const closeMin = marketCloseMinutes(now);
  return positions.filter((p) => {
    if (!isZeroDte(p, today)) return false;
    if (!(parseFloat(p.quantity) > 0)) return false;
    const due = dueAtMin(p, closeMin);
    return due !== null && nowMin >= due && nowMin < closeMin;
  });
}

/** SPXW ticks $0.05 under $3, $0.10 from $3; SPY options trade in pennies. Sells round down. */
export function closeLimit(underlying: string, bid: number, attempt: number): number {
  const discount = Math.min(0.5, 0.03 * 2 ** (attempt - 1));
  const raw = bid * (1 - discount);
  const tick = underlying === "SPXW" ? (raw < 3 ? 0.05 : 0.1) : 0.01;
  const snapped = Math.floor(raw / tick + 1e-9) * tick;
  return Math.round(Math.max(tick, snapped) * 100) / 100;
}

export async function autoCloseAll(due: Position[], now: Date, clock: () => Date = () => new Date()): Promise<AutoCloseResult[]> {
  if (due.length === 0) return [];
  const { client, accountId } = makeOrderClient();
  const closeMin = marketCloseMinutes(now);
  const stopAt = Date.now() + AUTO_CLOSE_BUDGET_MIN * 60_000;
  const results: AutoCloseResult[] = [];

  for (const p of due) {
    const occ = optionOcc(p);
    const leg = p.legs?.[0];
    const owner = ownerOf(p) ?? "unknown";
    const desc = describePosition(p);
    if (!occ || !leg?.option_type || !leg.option_expire_date || !leg.option_exercise_price) {
      results.push({ agent: owner, position: desc, occ: occ ?? "?", contracts: 0, sold: 0, avgPrice: null, ok: false, detail: "position is missing contract details, not touched" });
      continue;
    }
    const underlying = occ.startsWith("SPXW") ? "SPXW" : p.symbol;
    const start = parseFloat(p.quantity);
    let sold = 0;
    let proceeds = 0;
    let gone = false;
    let lastNote = "";

    for (let attempt = 1; Date.now() < stopAt && nyMinutesOf(clock()) < closeMin; attempt++) {
      try {
        const fresh = (await getPositions(client, accountId)).find((x) => optionOcc(x) === occ && parseFloat(x.quantity) > 0);
        if (!fresh) {
          gone = true;
          break;
        }
        const qty = parseFloat(fresh.quantity);
        const snap = (await getOptionSnapshots(client, [occ]))[0];
        const bid = snap?.bid ? parseFloat(snap.bid) : 0;
        // No bid: offer at one tick rather than not trying (a worthless call still exits cleanly).
        const limit = bid > 0 ? closeLimit(underlying, bid, attempt) : closeLimit(underlying, 0, 1);
        const id = await placeSellToClose(client, accountId, {
          underlying,
          optionType: leg.option_type,
          strike: parseFloat(leg.option_exercise_price),
          expiration: leg.option_expire_date,
          contracts: qty,
          limitPrice: limit,
        });
        const s = await settleOrder(client, accountId, id, 10_000);
        lastNote = `attempt ${attempt}: ${qty} @ $${limit} (bid ${bid || "none"}) -> ${s.status}, filled ${s.filledQuantity}`;
        console.log(`[auto-close] ${desc} ${lastNote}`);
        if (s.filledQuantity > 0) {
          sold += s.filledQuantity;
          proceeds += (s.filledPrice ?? limit) * s.filledQuantity;
        }
        if (s.status === "UNKNOWN") await sleep(10_000); // never stack a second order on an unsettled one
      } catch (err) {
        // Includes "rejected because the agent's own sell already closed it": the re-read decides.
        lastNote = `attempt ${attempt} error: ${String(err).slice(0, 160)}`;
        console.warn(`[auto-close] ${desc} ${lastNote}`);
        await sleep(5000);
      }
    }

    if (!gone) {
      try {
        gone = !(await getPositions(client, accountId)).some((x) => optionOcc(x) === occ && parseFloat(x.quantity) > 0);
      } catch {
        gone = false; // can't confirm: report as still open
      }
    }
    const avgPrice = sold > 0 ? Math.round((proceeds / sold) * 100) / 100 : null;
    results.push({
      agent: owner,
      position: desc,
      occ,
      contracts: start,
      sold,
      avgPrice,
      ok: gone,
      detail: gone
        ? sold > 0
          ? `Sold ${sold} at $${avgPrice} avg.`
          : "Position was already gone (the agent closed it)."
        : `Still open after retrying (${lastNote || "no attempt made"}). Close it by hand.`,
    });
  }
  return results;
}
