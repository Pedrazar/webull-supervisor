/**
 * The financial analyst, SHADOW MODE. Runs as its own step after every
 * supervisor pass (same 5-minute cron-job.org dispatch) and does nothing
 * except at two moments:
 *
 *  - 10:15-11:00am ET, once a day: reads SPY and NVDA bars, makes a buy /
 *    short / sit-out call for each of the four agents (analystRules.ts),
 *    appends it to analyst/calls.jsonl and pushes a one-line summary.
 *    10:15 is before the 0DTE agents' 10:30 entry, so each day's call can be
 *    compared with what the agent then did. A call made after 10:30 is
 *    marked late.
 *  - From 4:30pm ET (and on any later run for a missed day): grades every
 *    ungraded call against the close and the agents' trade logs
 *    (analystScore.ts), appends to analyst/scores.jsonl, rewrites
 *    analyst/SCORECARD.md and pushes the day's grade.
 *
 * It never trades and never talks to an agent: no order call, no write to
 * control.json, no change to any agent repo. Its only outputs are files in
 * analyst/ and ntfy pushes.
 *
 * Flags: --dry-run (print, don't write or push), --force-call (call now,
 * whatever the time), --scorecard (rewrite SCORECARD.md from the logs).
 */

import fs from "fs";
import "dotenv/config";
import { AGENTS, AgentId } from "./config";
import { makeClient } from "./broker";
import { getFile } from "./github";
import { parseLog, LogEvent } from "./logs";
import { push } from "./alerts";
import { isMarketHoliday, nyMinutesOf, todayNyDate } from "./marketHours";
import { DayCalls, makeCalls } from "./analystRules";
import { dailyBars, fiveMinBars, featuresOf, sessionClose } from "./analystData";
import { DayScore, gradeDay, scorecardMarkdown, callSummary, scoreSummary } from "./analystScore";

const DIR = "analyst";
const CALLS = `${DIR}/calls.jsonl`;
const SCORES = `${DIR}/scores.jsonl`;
const SCORECARD = `${DIR}/SCORECARD.md`;
const STATE = `${DIR}/state.json`;

const CALL_FROM = 10 * 60 + 15;
const CALL_UNTIL = 11 * 60;
const ENTRY_TIME = 10 * 60 + 30;
const SCORE_FROM = 16 * 60 + 30;

interface AnalystState {
  /** NY date of the last data-error push, so a failing source alerts once a day. */
  errorPushedOn?: string;
}

function readJsonl<T>(path: string): T[] {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

function readState(): AnalystState {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8")) as AnalystState;
  } catch {
    return {};
  }
}

function repoLink(path: string): string | undefined {
  const repo = process.env.GITHUB_REPOSITORY;
  return repo ? `https://github.com/${repo}/blob/main/${path}` : undefined;
}

async function main() {
  const now = new Date();
  const today = todayNyDate(now);
  const nyMin = nyMinutesOf(now);
  const dryRun = process.argv.includes("--dry-run");
  const forceCall = process.argv.includes("--force-call");
  const rewriteCard = process.argv.includes("--scorecard");

  const calls = readJsonl<DayCalls>(CALLS);
  const scores = readJsonl<DayScore>(SCORES);
  const state = readState();
  let changed = false;

  const tradingDay = !isMarketHoliday(now);
  const haveToday = calls.some((c) => c.date === today && c.calls.length > 0);

  // ---- 1. the morning call ----
  if (tradingDay && !haveToday && (forceCall || (nyMin >= CALL_FROM && nyMin < CALL_UNTIL))) {
    try {
      const day = await makeTodaysCalls(now, today, nyMin >= ENTRY_TIME);
      console.log(`[analyst] calls for ${today}:\n${JSON.stringify(day, null, 2)}`);
      if (!dryRun) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.appendFileSync(CALLS, JSON.stringify(day) + "\n");
        calls.push(day);
        changed = true;
        await push(`Analyst call ${today} (shadow)`, callSummary(day), { priority: 2, tags: "crystal_ball", click: repoLink(CALLS) });
      }
    } catch (err) {
      console.error("[analyst] couldn't make today's call:", err);
      if (!dryRun && state.errorPushedOn !== today) {
        state.errorPushedOn = today;
        changed = true;
        await push("Analyst: no call today yet", `Couldn't read market data: ${String(err).slice(0, 250)}. Retrying every pass until 11:00am ET.`, { priority: 3, tags: "warning" });
      }
    }
  }

  // ---- 2. grading ----
  const ungraded = calls.filter(
    (c) => c.calls.length > 0 && !scores.some((s) => s.date === c.date) && (c.date < today || (c.date === today && nyMin >= SCORE_FROM))
  );
  const fresh: DayScore[] = [];
  if (ungraded.length) {
    try {
      const { client } = makeClient();
      const [spy, nvda] = await Promise.all([fiveMinBars(client, "SPY"), fiveMinBars(client, "NVDA")]);
      const logs = await agentLogs();
      for (const c of ungraded) {
        const closes = { SPY: sessionClose(spy, c.date), NVDA: sessionClose(nvda, c.date) };
        if (closes.SPY === null) {
          console.log(`[analyst] ${c.date}: SPY close not in the 5-minute bars yet, grading later`);
          continue;
        }
        const s = gradeDay(c, closes, logs, now);
        console.log(`[analyst] graded ${c.date}: ${scoreSummary(s, [...scores, ...fresh, s])}`);
        fresh.push(s);
      }
    } catch (err) {
      console.error("[analyst] grading failed, will retry next pass:", err);
    }
  }
  if (fresh.length && !dryRun) {
    fs.mkdirSync(DIR, { recursive: true });
    for (const s of fresh) fs.appendFileSync(SCORES, JSON.stringify(s) + "\n");
    scores.push(...fresh);
    changed = true;
    const t = fresh.find((s) => s.date === today) ?? fresh[fresh.length - 1];
    await push(`Analyst scorecard ${t.date}`, scoreSummary(t, scores), { priority: 2, tags: "bar_chart", click: repoLink(SCORECARD) });
  }

  if ((changed || rewriteCard) && !dryRun) {
    const start = calls.find((c) => c.calls.length)?.date ?? today;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(SCORECARD, scorecardMarkdown(scores, calls, start));
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  }
  if (!changed && !rewriteCard) console.log(`[analyst] ${now.toISOString()} nothing to do`);
}

async function makeTodaysCalls(now: Date, today: string, late: boolean): Promise<DayCalls> {
  const { client } = makeClient();
  const daily = await dailyBars(client, ["SPY", "NVDA"]);
  const [spy5, nvda5] = await Promise.all([fiveMinBars(client, "SPY").catch(() => null), fiveMinBars(client, "NVDA").catch(() => null)]);
  const spy = featuresOf("SPY", daily.get("SPY"), spy5, today);
  const nvda = featuresOf("NVDA", daily.get("NVDA"), nvda5, today);
  if (!spy.daily) throw new Error(`SPY daily bars unusable (${daily.get("SPY")?.length ?? 0} bars)`);
  const wheelStrike = await wheelPutStrike();
  const day = makeCalls(today, now, late, spy, nvda, wheelStrike);
  if (!spy5) day.dataNotes.push("SPY 5-minute bars failed to load");
  return day;
}

async function wheelPutStrike(): Promise<number | null> {
  const w = AGENTS.find((a) => a.id === "wheel")!;
  try {
    const t = await getFile(w.owner, w.repo, "wheel-state.json");
    const s = t ? (JSON.parse(t) as { openOption?: { optionType?: string; strike?: number } | null }) : null;
    return s?.openOption?.optionType === "PUT" && typeof s.openOption.strike === "number" ? s.openOption.strike : null;
  } catch {
    return null;
  }
}

async function agentLogs(): Promise<Partial<Record<AgentId, LogEvent[]>>> {
  const out: Partial<Record<AgentId, LogEvent[]>> = {};
  await Promise.all(
    AGENTS.map(async (a) => {
      // A log that can't be read must not grade as "$0, no trades": throw, retry next pass.
      out[a.id] = parseLog(await getFile(a.owner, a.repo, a.logPath));
    })
  );
  return out;
}

main().catch(async (err) => {
  console.error("[analyst] crashed:", err);
  if (!process.argv.includes("--dry-run")) await push("Analyst crashed", String(err).slice(0, 300), { priority: 3, tags: "warning" });
  process.exit(1);
});
