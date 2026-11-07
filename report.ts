/**
 * The combined daily report: plain code over the broker and the agents'
 * logs, no LLM, so it costs nothing to run. Written to reports/<date>.md.
 */

import { AGENTS, COMBINED_DAILY_LOSS_LIMIT } from "./config";
import { SupervisorState } from "./alerts";
import { World } from "./gather";
import { riskRows, describePosition, ownerOf, optionUnrealized } from "./checks";
import { eventsOn, eventsBetween, mondayOf, summarize, round2 } from "./logs";
import { todayNyDate } from "./marketHours";

const usd = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;

export interface Report {
  markdown: string;
  headline: string;
}

export function buildReport(world: World, state: SupervisorState): Report {
  const { today } = world;
  const rows = riskRows(world);
  const monday = mondayOf(today);

  const totalRealized = round2(rows.reduce((s, r) => s + (r.realized ?? 0), 0));
  const totalOpen = round2(rows.filter((r) => r.agent !== "wheel").reduce((s, r) => s + r.unrealized, 0));
  const fired = Object.entries(state.alerted);
  const critical = fired.filter(([, v]) => v.level === "critical").length;

  const lines: string[] = [];
  lines.push(`# Trading supervisor report, ${today}`);
  lines.push("");
  lines.push(
    `Paper account: **${usd(totalRealized)} realized**` +
      (totalOpen !== 0 ? `, ${usd(totalOpen)} open in 0DTE` : "") +
      `, ${pct(-(totalRealized + totalOpen), COMBINED_DAILY_LOSS_LIMIT)} of the $${COMBINED_DAILY_LOSS_LIMIT} combined limit used. ` +
      (fired.length === 0 ? "No alerts today." : `${fired.length} alert${fired.length === 1 ? "" : "s"} today (${critical} critical).`)
  );
  lines.push("");

  lines.push("## Agents");
  lines.push("");
  lines.push("| Agent | Today realized | Closed trades | Limit used | Runs today | Week to date | Week win rate |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const a of world.agents) {
    const r = rows.find((x) => x.agent === a.cfg.id)!;
    const todayS = a.events ? summarize(eventsOn(a.events, today)) : null;
    const weekS = a.events ? summarize(eventsBetween(a.events, monday, today)) : null;
    const runs = a.runs?.filter((x) => todayNyDate(new Date(x.created_at)) === today) ?? null;
    const failed = runs?.filter((x) => x.status === "completed" && x.conclusion && !["success", "skipped", "neutral"].includes(x.conclusion)).length ?? 0;
    lines.push(
      `| ${a.cfg.name} | ${todayS ? usd(todayS.realized) : "unknown"} | ${todayS ? todayS.closedTrades : "?"} | ${
        r.limit === null ? "no daily limit" : pct(-((r.realized ?? 0) + (a.cfg.id === "wheel" ? 0 : r.unrealized)), r.limit) + ` of $${r.limit}`
      } | ${runs === null ? "unknown" : `${runs.length}${failed ? ` (${failed} failed)` : ""}`} | ${weekS ? usd(weekS.realized) : "?"} | ${
        weekS && weekS.closedTrades ? `${Math.round((100 * weekS.wins) / weekS.closedTrades)}% of ${weekS.closedTrades}` : "-"
      } |`
    );
  }
  const notes = AGENTS.filter((a) => a.logNote).map((a) => `- ${a.name} ${a.logNote}.`);
  if (notes.length) {
    lines.push("");
    lines.push(...notes);
  }
  lines.push("");

  lines.push("## Open positions at the broker");
  lines.push("");
  if (world.positions === null) {
    lines.push(`Unknown: couldn't read the broker (${world.brokerError ?? "no detail"}).`);
  } else if (world.positions.length === 0) {
    lines.push("None.");
  } else {
    for (const p of world.positions) {
      const u = p.instrument_type === "OPTION" ? optionUnrealized(p, world) : null;
      lines.push(`- ${describePosition(p)}, owner ${ownerOf(p) ?? "**none**"}${u !== null ? `, ${usd(u)} unrealized` : ""}`);
    }
  }
  if (world.nvdaPrice) lines.push(`\nNVDA last: $${world.nvdaPrice.toFixed(2)}.`);
  lines.push("");

  lines.push("## Alerts today");
  lines.push("");
  if (fired.length === 0) {
    lines.push("None.");
  } else {
    for (const [, v] of fired.sort((x, y) => x[1].at.localeCompare(y[1].at))) {
      const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(v.at));
      lines.push(`- ${t} ET, **${v.level}**: ${v.title}. ${v.detail}${v.url ? ` [run](${v.url})` : ""}`);
    }
  }
  lines.push("");
  lines.push("_Phase 1: the supervisor only reads and alerts. Nothing was paused or traded._");

  const headline = `${usd(totalRealized)} today` + (fired.length ? `, ${fired.length} alert${fired.length === 1 ? "" : "s"}` : ", no alerts");
  return { markdown: lines.join("\n") + "\n", headline };
}

function pct(loss: number, limit: number): string {
  if (loss <= 0) return "0%";
  return `${Math.round((100 * loss) / limit)}%`;
}
