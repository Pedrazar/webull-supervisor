/**
 * Fixture tests for the checks and the report: no network, no broker.
 * Run: npm test. Uses the agents' real trade logs from 2026-11-06 (copied
 * into fixtures/) so the P&L math is checked against real numbers.
 */

import assert from "assert";
import fs from "fs";
import { AGENTS } from "./config";
import { World, AgentData } from "./gather";
import { runChecks, riskRows } from "./checks";
import { parseLog } from "./logs";
import { buildReport } from "./report";
import { newFindings, SupervisorState } from "./alerts";
import { Position } from "./broker";
import { WorkflowRun } from "./github";

const LOGS: Record<string, string> = {
  "webull-agent": "fixtures/trades.jsonl",
  wheel: "fixtures/wheel-trades.jsonl",
  "spx-0dte": "fixtures/spx-trades.jsonl",
  "spy-0dte": "fixtures/spy-trades.jsonl",
};

function run(id: number, createdIso: string, conclusion: string | null = "success"): WorkflowRun {
  return { id, html_url: `https://github.com/x/y/actions/runs/${id}`, status: conclusion ? "completed" : "in_progress", conclusion, created_at: createdIso, updated_at: createdIso, event: "workflow_dispatch" };
}

/** NY is UTC-5 in November 2026 (EST). */
const et = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`);

function world(now: Date, over: Partial<World> & { runs?: Partial<Record<string, WorkflowRun[]>> } = {}): World {
  const today = now.toISOString().slice(0, 10);
  const agents: AgentData[] = AGENTS.map((cfg) => ({
    cfg,
    events: parseLog(fs.readFileSync(LOGS[cfg.id], "utf8")),
    runs: over.runs?.[cfg.id] ?? defaultRuns(cfg.id, today),
  }));
  return {
    now,
    today,
    agents,
    positions: [],
    openOrders: [],
    snapshots: [],
    nvdaPrice: 210,
    wheelState: { stage: "PUT", openOption: { optionSymbol: "NVDA261113P00195000", strike: 195, expiration: "2026-11-13", optionType: "PUT", contracts: 5, creditPerContract: 1.16 } },
    ...over,
  };
}

function defaultRuns(id: string, day: string): WorkflowRun[] {
  if (id === "wheel") return [run(4, `${day}T19:00:00Z`)];
  return [run(id === "webull-agent" ? 1 : id === "spx-0dte" ? 2 : 3, `${day}T14:30:00Z`, null)];
}

const wheelPut: Position = {
  symbol: "NVDA",
  instrument_type: "OPTION",
  quantity: "-5",
  cost_price: "1.16",
  legs: [{ symbol: "NVDA", cost: "1.16", option_type: "PUT", option_expire_date: "2026-11-13", option_exercise_price: "195" }],
};

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const keys = (w: World, seen: Record<string, string> = {}) => runChecks(w, seen).map((f) => f.key);

test("real Nov 6 P&L: SPX -910, SPY -153, combined limit hit", () => {
  const w = world(et("2026-11-06", "14:00"), { positions: [wheelPut] });
  const rows = riskRows(w);
  assert.equal(rows.find((r) => r.agent === "spx-0dte")!.realized, -910);
  assert.equal(rows.find((r) => r.agent === "spy-0dte")!.realized, -153);
  const k = keys(w);
  assert.ok(!k.includes("limit:spx-0dte"), "SPX -910 is inside its $1,000 limit");
  assert.ok(!k.includes("limit:spy-0dte"), "SPY -153 is inside its $200 limit");
  assert.ok(k.includes("limit:combined"), `combined should be past -$1,000, got ${k}`);
});

test("session agent that never started is critical after its start-by time", () => {
  const w = world(et("2026-11-06", "10:30"), { runs: { "spy-0dte": [] }, positions: [wheelPut] });
  assert.ok(keys(w).includes("no-start:spy-0dte"));
  const early = world(et("2026-11-06", "10:20"), { runs: { "spy-0dte": [] }, positions: [wheelPut] });
  assert.ok(!keys(early).includes("no-start:spy-0dte"), "not before 10:25 ET");
});

test("failed run alerts once per run id", () => {
  const w = world(et("2026-11-06", "12:00"), { runs: { "spx-0dte": [run(99, "2026-11-06T14:20:00Z", "failure")] }, positions: [wheelPut] });
  const state: SupervisorState = { date: "2026-11-06", alerted: {}, orderFirstSeen: {}, reportWritten: false };
  const first = newFindings(state, runChecks(w, {}), w.now).filter((f) => f.key === "run-failed:99");
  const second = newFindings(state, runChecks(w, {}), w.now).filter((f) => f.key === "run-failed:99");
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, "deduped on the next pass");
});

test("wheel ticker gap is flagged during market hours only", () => {
  const stale = world(et("2026-11-06", "13:00"), { runs: { wheel: [run(5, "2026-11-06T16:00:00Z")] }, positions: [wheelPut] }); // 11:00 ET, 2h old
  assert.ok(keys(stale).some((k) => k.startsWith("gap:wheel")));
  const fresh = world(et("2026-11-06", "13:00"), { runs: { wheel: [run(6, "2026-11-06T17:50:00Z")] }, positions: [wheelPut] });
  assert.ok(!keys(fresh).some((k) => k.startsWith("gap:wheel")));
});

test("0DTE still open at 3:40pm ET is critical, and priced into the limit", () => {
  const spy: Position = { symbol: "SPY", instrument_type: "OPTION", quantity: "1", cost_price: "2.10", legs: [{ symbol: "SPY", option_type: "CALL", option_expire_date: "2026-11-09", option_exercise_price: "767", cost: "2.10" }] };
  const w = world(et("2026-11-09", "15:40"), { positions: [spy, wheelPut], snapshots: [{ symbol: "SPY261109C00767000", bid: "0.80", ask: "0.90" }] });
  const k = keys(w);
  assert.ok(k.some((x) => x.startsWith("0dte-open:")));
  const row = riskRows(w).find((r) => r.agent === "spy-0dte")!;
  assert.equal(row.unrealized, -125); // (0.85 - 2.10) * 1 * 100
  const early = world(et("2026-11-09", "15:00"), { positions: [spy, wheelPut], snapshots: [] });
  assert.ok(!keys(early).some((x) => x.startsWith("0dte-open:")));
});

test("SPY open loss plus realized trips its $200 limit", () => {
  // Nov 9 has no SPY exits in the log, so realized is 0; open at -$230.
  const spy: Position = { symbol: "SPY", instrument_type: "OPTION", quantity: "1", legs: [{ symbol: "SPY", option_type: "CALL", option_expire_date: "2026-11-09", option_exercise_price: "767", cost: "4.00" }] };
  const w = world(et("2026-11-09", "12:00"), { positions: [spy, wheelPut], snapshots: [{ symbol: "SPY261109C00767000", bid: "1.65", ask: "1.75" }] });
  assert.ok(keys(w).includes("limit:spy-0dte"));
});

test("wheel cushion under 3% and wheel/broker mismatch", () => {
  const near = world(et("2026-11-09", "11:00"), { positions: [wheelPut], nvdaPrice: 199 });
  assert.ok(keys(near).includes("wheel-cushion:195"));
  const far = world(et("2026-11-09", "11:00"), { positions: [wheelPut], nvdaPrice: 215 });
  assert.ok(!keys(far).includes("wheel-cushion:195"));
  const missing = world(et("2026-11-09", "11:00"), { positions: [] });
  assert.ok(keys(missing).includes("wheel-mismatch:missing"));
});

test("unowned position and stale order (stops ignored)", () => {
  const stray: Position = { symbol: "TSLA", instrument_type: "OPTION", quantity: "1", legs: [{ symbol: "TSLA", option_type: "CALL", option_expire_date: "2026-11-20", option_exercise_price: "300" }] };
  const seen: Record<string, string> = {};
  const orders = [{ client_order_id: "abc", symbol: "SPY", order_type: "LIMIT" }, { client_order_id: "stop1", symbol: "RIOT", order_type: "STOP_LOSS" }];
  const t0 = world(et("2026-11-09", "11:00"), { positions: [stray, wheelPut], openOrders: orders });
  assert.ok(keys(t0, seen).includes("unowned:1x TSLA 2026-11-20 300 CALL"));
  assert.ok(!keys(t0, seen).includes("stale-order:abc"));
  const t1 = world(et("2026-11-09", "11:12"), { positions: [wheelPut], openOrders: orders });
  const k1 = keys(t1, seen);
  assert.ok(k1.includes("stale-order:abc"));
  assert.ok(!k1.includes("stale-order:stop1"));
});

test("unreachable broker is reported as unknown, not healthy", () => {
  const w = world(et("2026-11-09", "11:00"), { positions: null, openOrders: null, brokerError: "fetch failed" });
  assert.ok(keys(w).includes("source:broker"));
  assert.ok(!keys(w).includes("wheel-mismatch:missing"), "no mismatch claim without broker data");
});

test("report renders with real Nov 6 numbers", () => {
  const w = world(et("2026-11-06", "16:35"), { positions: [wheelPut] });
  const state: SupervisorState = { date: "2026-11-06", alerted: {}, orderFirstSeen: {}, reportWritten: false };
  newFindings(state, runChecks(w, {}), w.now);
  const r = buildReport(w, state);
  assert.ok(r.markdown.includes("SPX 0DTE calls | -$910.00"));
  assert.ok(r.markdown.includes("91% of $1000"));
  fs.mkdirSync("fixtures/out", { recursive: true });
  fs.writeFileSync("fixtures/out/sample-report.md", r.markdown);
  console.log(`   headline: ${r.headline}`);
});

console.log(`\n${passed} tests passed`);
