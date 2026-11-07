/**
 * One supervisor pass. Dispatched every 5 minutes on trading days by
 * cron-job.org (GitHub's own schedule is only a late backup, as in the
 * agents). Each pass: gather -> check -> push new alerts -> save state,
 * and after REPORT_AFTER ET, write the day's report once.
 *
 * Phase 1 is read-only: broker.ts has no order calls at all.
 */

import fs from "fs";
import "dotenv/config";
import { gather } from "./gather";
import { runChecks, hhmm } from "./checks";
import { loadState, saveState, newFindings, pushFinding, push } from "./alerts";
import { buildReport } from "./report";
import { REPORT_AFTER } from "./config";
import { isMarketHoliday, nyMinutesOf, todayNyDate } from "./marketHours";

async function main() {
  const now = new Date();
  const today = todayNyDate(now);
  const forceReport = process.argv.includes("--report");
  const dryRun = process.argv.includes("--dry-run"); // print, don't push or save

  if (isMarketHoliday(now) && !forceReport) {
    console.log(`[supervisor] ${today} is a weekend/holiday, nothing to check`);
    return;
  }

  const state = loadState(today);
  const world = await gather(now);
  const findings = runChecks(world, state.orderFirstSeen);
  const fresh = dryRun ? findings : newFindings(state, findings, now);

  console.log(`[supervisor] ${now.toISOString()} ${findings.length} finding(s), ${fresh.length} new`);
  for (const f of fresh) {
    console.log(`  [${f.level}] ${f.title}: ${f.detail}`);
    if (!dryRun) await pushFinding(f);
  }

  if (forceReport || (!state.reportWritten && nyMinutesOf(now) >= hhmm(REPORT_AFTER))) {
    const report = buildReport(world, state);
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
  if (!dryRun) saveState(state);
}

main().catch(async (err) => {
  console.error("[supervisor] crashed:", err);
  await push("Supervisor crashed", String(err).slice(0, 300), { priority: 4, tags: "warning" });
  process.exit(1);
});
