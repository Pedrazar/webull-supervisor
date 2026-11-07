/**
 * Phone push alerts via ntfy.sh, de-duplicated per day so a problem that
 * persists across 5-minute runs alerts once, not every run.
 *
 * NTFY_TOPIC is a repo secret: anyone who knows the topic name can read it,
 * so it should be long and random (e.g. "jp-trading-7f3k9q2m").
 */

import fs from "fs";

export type Level = "critical" | "warn" | "info";

export interface Finding {
  /** Stable per-day identity: the same key alerts only once per NY date. */
  key: string;
  level: Level;
  agent?: string;
  title: string;
  detail: string;
  url?: string;
}

export interface SupervisorState {
  date: string; // NY date this state belongs to
  alerted: Record<string, { at: string; level: Level; title: string; detail: string; url?: string }>;
  orderFirstSeen: Record<string, string>;
  reportWritten: boolean;
  lastRun?: string;
}

const STATE_FILE = "supervisor-state.json";

export function loadState(today: string): SupervisorState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as SupervisorState;
    if (s.date === today) return s;
  } catch {
    // first run, or a corrupt file: start fresh
  }
  return { date: today, alerted: {}, orderFirstSeen: {}, reportWritten: false };
}

export function saveState(state: SupervisorState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

/** Returns only the findings that haven't been alerted yet today, and records them. */
export function newFindings(state: SupervisorState, findings: Finding[], now: Date): Finding[] {
  const fresh: Finding[] = [];
  for (const f of findings) {
    if (state.alerted[f.key]) continue;
    state.alerted[f.key] = { at: now.toISOString(), level: f.level, title: f.title, detail: f.detail, url: f.url };
    fresh.push(f);
  }
  return fresh;
}

export async function push(title: string, body: string, opts: { priority?: number; tags?: string; click?: string } = {}): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[ntfy] NTFY_TOPIC not set, would have sent: ${title} — ${body}`);
    return;
  }
  const headers: Record<string, string> = { Title: asciiHeader(title) };
  if (opts.priority) headers.Priority = String(opts.priority);
  if (opts.tags) headers.Tags = opts.tags;
  if (opts.click) headers.Click = opts.click;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", headers, body });
    if (!res.ok) console.error(`[ntfy] send failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    // An alert that can't be sent must not crash the checks; the run log still has it.
    console.error("[ntfy] send failed:", err);
  }
}

export async function pushFinding(f: Finding): Promise<void> {
  const priority = f.level === "critical" ? 5 : f.level === "warn" ? 3 : 2;
  const tags = f.level === "critical" ? "rotating_light" : f.level === "warn" ? "warning" : "information_source";
  await push(f.title, f.detail, { priority, tags, click: f.url });
}

/** HTTP header values must be Latin-1; strip anything else rather than throw. */
function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "-");
}
