/**
 * control.json: the one file the agents read before every new entry
 * (see agent-snippet/supervisorControl.ts for the reading side).
 *
 *   { "updated": "...", "agents": { "spx-0dte": { "mode": "paused", "reason": "...", "date": "2026-11-17", "by": "supervisor" } } }
 *
 * - "date" set   = paused for that NY date only (automatic pauses).
 * - "date" unset = paused until resumed (manual pauses).
 * - A manual resume on a day the supervisor auto-paused records
 *   "resumedOn": today, so the next 5-minute pass doesn't re-pause it.
 */

import fs from "fs";
import { AGENTS, AgentId } from "./config";

export interface ControlEntry {
  mode: "run" | "paused";
  reason?: string;
  date?: string;
  by?: "supervisor" | "manual";
  resumedOn?: string;
}

export interface Control {
  updated: string;
  agents: Record<string, ControlEntry>;
  /** Phase 3 off switch: false = never auto-close 0DTE options. Missing = on. */
  autoClose0dte?: boolean;
  autoCloseNote?: string;
}

export function autoCloseEnabled(c: Control): boolean {
  return c.autoClose0dte !== false;
}

export function setAutoClose(c: Control, on: boolean, note?: string): void {
  c.autoClose0dte = on;
  c.autoCloseNote = note;
}

export const CONTROL_FILE = "control.json";

export function loadControl(): Control {
  try {
    const c = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8")) as Control;
    if (c && typeof c.agents === "object") return c;
  } catch {
    // missing or corrupt: start from "everything runs"
  }
  return { updated: new Date(0).toISOString(), agents: Object.fromEntries(AGENTS.map((a) => [a.id, { mode: "run" }])) };
}

export function saveControl(c: Control, now: Date): void {
  c.updated = now.toISOString();
  fs.writeFileSync(CONTROL_FILE, JSON.stringify(c, null, 2) + "\n");
}

export function isPaused(c: Control, id: string, today: string): boolean {
  const e = c.agents[id];
  return e?.mode === "paused" && (!e.date || e.date === today);
}

/** Automatic pause for today. Returns true when this call changed something. */
export function autoPause(c: Control, id: AgentId, today: string, reason: string): boolean {
  const e = c.agents[id];
  if (isPaused(c, id, today)) return false; // already paused (manual or automatic)
  if (e?.resumedOn === today) return false; // J resumed it by hand today: respect that
  c.agents[id] = { mode: "paused", reason, date: today, by: "supervisor" };
  return true;
}

export function manualPause(c: Control, ids: string[], reason: string): void {
  for (const id of ids) c.agents[id] = { mode: "paused", reason, by: "manual" };
}

export function manualResume(c: Control, ids: string[], today: string): void {
  for (const id of ids) c.agents[id] = { mode: "run", resumedOn: today };
}

/** "all" or a comma list of agent ids -> validated ids. */
export function parseTargets(arg: string): string[] {
  const valid = AGENTS.map((a) => a.id as string);
  if (arg.trim() === "all") return valid;
  const ids = arg.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((i) => !valid.includes(i));
  if (bad.length) throw new Error(`unknown agent id(s): ${bad.join(", ")} (valid: ${valid.join(", ")}, or "all")`);
  return ids;
}
