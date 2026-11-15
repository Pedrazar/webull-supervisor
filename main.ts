/**
 * One supervisor pass. Dispatched every 5 minutes on trading days by
 * cron-job.org (GitHub's own schedule is only a late backup, as in the
 * agents). Each pass: gather -> check -> auto-pause on a limit breach ->
 * push new alerts -> save state, and after REPORT_AFTER ET, write the day's
 * report once.
 *
 * Phase 2: the supervisor still never trades (broker.ts has no order calls).
 * Its only lever is control.json, which the agents read before each NEW
 * entry. Manual control: `--pause=<ids|all>` / `--resume=<ids|all>`
 * (the workflow's "pause" / "resume" inputs).
 */

import fs from "fs";
import "dotenv/config";
import { gather } from "./gather";
import { runChecks, hhmm } from "./checks";
import { loadState, saveState, newFindings, pushFinding, push } from "./alerts";
import { buildReport } from "./report";
import { AGENTS, AgentId, REPORT_AFTER } from "./config";
import { loadControl, saveControl, autoPause, manualPause, manualResume, parseTargets } from "./control";
import { isMarketHoliday, nyMinutesOf, todayNyDate } from "./marketHours";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit?.slice(name.length + 3).trim();
  return v ? v : undefined;
}

async function main() {
  const now = new Date();
  const today = todayNyDate(now);
  const forceReport = process.argv.includes("--report");
  const dryRun = process.argv.includes("--dry-run"); // print, don't push or save
  const pauseArg = arg("pause");
  const resumeArg = arg("resume");

  // Manual pause/resume first, whatever the day: J may pause over a weekend.
  const control = loadControl();
  let controlChanged = false;
  if (pauseArg) {
    const ids = parseTargets(pauseArg);
    manualPause(control, ids, arg("reason") ?? "paused by J");
    controlChanged = true;
    console.log(`[control] paused: ${ids.join(", ")}`);
    if (!dryRun) await push("Agents paused", `New entries paused until resumed: ${ids.join(", ")}`, { priority: 3, tags: "pause_button" });
  }
  if (resumeArg) {
    const ids = parseTargets(resumeArg);
    manualResume(control, ids, today);
    controlChanged = true;
    console.log(`[control] resumed: ${ids.join(", ")}`);
    if (!dryRun) await push("Agents resumed", `New entries allowed again: ${ids.join(", ")}`, { priority: 3, tags: "arrow_forward" });
  }

  if (isMarketHoliday(now) && !forceReport) {
    console.log(`[supervisor] ${today} is a weekend/holiday, nothing to check`);
    if (controlChanged && !dryRun) saveControl(control, now);
    return;
  }

  const state = loadState(today);
  const world = await gather(now);
  const findings = runChecks(world, state.orderFirstSeen);

  // Automatic pauses: a limit finding pauses that agent (or all, for the
  // combined cap) for the rest of today. A manual resume today wins.
  const paperIds = AGENTS.map((a) => a.id);
  for (const f of findings) {
    if (!f.key.startsWith("limit:")) continue;
    const target = f.key.slice("limit:".length);
    const ids: AgentId[] = target === "combined" ? paperIds : [target as AgentId];
    for (const id of ids) {
      if (autoPause(control, id, today, f.title)) {
        controlChanged = true;
        console.log(`[control] auto-paused ${id} for ${today}: ${f.title}`);
      }
    }
  }

  const fresh = dryRun ? findings : newFindings(state, findings, now);
  console.log(`[supervisor] ${now.toISOString()} ${findings.length} finding(s), ${fresh.length} new`);
  for (const f of fresh) {
    console.log(`  [${f.level}] ${f.title}: ${f.detail}`);
    if (!dryRun) await pushFinding(f);
  }

  if (forceReport || (!state.reportWritten && nyMinutesOf(now) >= hhmm(REPORT_AFTER))) {
    const report = buildReport(world, state, control);
    if (dryRun) {
      console.log(report.markdown);
    } else {
      fs.mkdirSync("reports", { recursive: true });
      fs.writeFileSync(`reports/${today}.md`, report.markdown);
      state.reportWritten = true;
      const repo = process.env.GITHUB_REPOSITORY;
      await push(`Daily report ${today}`, report.headline, {
        priority: 3,
        tags: "bar_chart",
        click: repo ? `https://github.com/${repo}/blob/main/reports/${today}.md` : undefined,
      });
    }
  }

  state.lastRun = now.toISOString();
  if (!dryRun) {
    saveState(state);
    if (controlChanged) saveControl(control, now);
  }
}

main().catch(async (err) => {
  console.error("[supervisor] crashed:", err);
  await push("Supervisor crashed", String(err).slice(0, 300), { priority: 4, tags: "warning" });
  process.exit(1);
});
