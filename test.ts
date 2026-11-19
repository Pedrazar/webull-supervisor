/**
 * Fixture tests for the checks and the report: no network, no broker.
 * Run: npm test. Uses the agents' real trade logs from 2026-11-06 (copied
 * into fixtures/) so the P&L math is checked against real numbers.
 */

import assert from "assert";
import fs from "fs";
import { AGENTS } from "./config";
import { World, AgentData } from "./gather";
import { runChecks, riskRows, describePosition, optionUnrealized } from "./checks";
import { parseLog } from "./logs";
import { buildReport } from "./report";
import { newFindings, SupervisorState } from "./alerts";
import { Position } from "./broker";
import { Control, autoPause, isPaused, manualPause, manualResume, parseTargets, autoCloseEnabled, setAutoClose } from "./control";
import { dueForAutoClose, closeLimit, autoCloseAll } from "./autoClose";
import { assertSandbox } from "./orders";
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
const queue: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push([name, fn]);
}

const keys = (w: World, seen: Record<string, string> = {}) => runChecks(w, seen).map((f) => f.key);

test("real Nov 6 P&L: SPX -910, SPY -153, total -1063 stays inside the $1,350 combined cap", () => {
  const w = world(et("2026-11-06", "14:00"), { positions: [wheelPut] });
  const rows = riskRows(w);
  assert.equal(rows.find((r) => r.agent === "spx-0dte")!.realized, -910);
  assert.equal(rows.find((r) => r.agent === "spy-0dte")!.realized, -153);
  const k = keys(w);
  assert.ok(!k.includes("limit:spx-0dte"), "SPX -910 is inside its $1,000 limit");
  assert.ok(!k.includes("limit:spy-0dte"), "SPY -153 is inside its $200 limit");
  assert.ok(!k.includes("limit:combined"), "-$1,063 is inside the $1,350 combined cap");
  // Add a $300 open SPY loss on top and the combined cap trips.
  const spy: Position = { symbol: "SPY", instrument_type: "OPTION", quantity: "1", legs: [{ symbol: "SPY", option_type: "CALL", option_expire_date: "2026-11-06", option_exercise_price: "738", cost: "4.00" }] };
  const worse = world(et("2026-11-06", "14:00"), { positions: [wheelPut, spy], snapshots: [{ symbol: "SPY261106C00738000", bid: "0.95", ask: "1.05" }] });
  assert.ok(keys(worse).includes("limit:combined"));
});

test("session agent that never started is critical after its start-by time", () => {
  const w = world(et("2026-11-06", "10:30"), { runs: { "spy-0dte": [] }, positions: [wheelPut] });
  assert.ok(keys(w).includes("no-start:spy-0dte"));
  const early = world(et("2026-11-06", "10:20"), { runs: { "spy-0dte": [] }, positions: [wheelPut] });
  assert.ok(!keys(early).includes("no-start:spy-0dte"), "not before 10:25 ET");
});

test("failed runs alert once per agent per day, not once per run", () => {
  const w = world(et("2026-11-06", "12:00"), { runs: { "spx-0dte": [run(99, "2026-11-06T14:20:00Z", "failure")] }, positions: [wheelPut] });
  const state: SupervisorState = { date: "2026-11-06", alerted: {}, orderFirstSeen: {}, reportWritten: false };
  const first = newFindings(state, runChecks(w, {}), w.now).filter((f) => f.key === "run-failed:spx-0dte");
  const second = newFindings(state, runChecks(w, {}), w.now).filter((f) => f.key === "run-failed:spx-0dte");
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, "deduped on the next pass");
  // The wheel failing every 15 min (2026-11-17: 26 alerts) now pushes one alert.
  const wheelRuns = [run(103, "2026-11-06T15:15:00Z", "failure"), run(102, "2026-11-06T15:00:00Z", "failure"), run(101, "2026-11-06T14:45:00Z", "failure")];
  const ww = world(et("2026-11-06", "12:00"), { runs: { wheel: wheelRuns }, positions: [wheelPut] });
  const wheelKeys = keys(ww).filter((k) => k.startsWith("run-failed:"));
  assert.deepEqual(wheelKeys, ["run-failed:wheel"]);
  assert.ok(runChecks(ww, {}).find((f) => f.key === "run-failed:wheel")!.url!.endsWith("/101"), "links the first failure");
});

test("wheel stock + covered call combo is described and marked from its option leg", () => {
  const combo: Position = {
    symbol: "NVDA",
    instrument_type: "OPTION",
    quantity: "5",
    cost_price: "193.28",
    legs: [
      { symbol: "NVDA", instrument_type: "EQUITY", quantity: "500", cost: "193.84" },
      { symbol: "NVDA", instrument_type: "OPTION", quantity: "-5", cost: "0.56", option_type: "CALL", option_expire_date: "2026-12-11", option_exercise_price: "215" },
    ],
  };
  assert.equal(describePosition(combo), "500 NVDA + -5x NVDA 2026-12-11 215 CALL");
  const w = world(et("2026-11-17", "12:00"), { positions: [combo], snapshots: [{ symbol: "NVDA261211C00215000", bid: "0.20", ask: "0.30" }] });
  assert.equal(optionUnrealized(combo, w), 155, "short 5 calls sold at 0.56, now 0.25 mid = +$155");
  assert.ok(!keys(w).some((k) => k.startsWith("0dte-open")), "a Dec 11 call is not 0DTE");
  // Without a leg quantity the combo's top-level quantity/cost are NOT used: unpriced, not wrong.
  const noLegQty: Position = { ...combo, legs: [combo.legs![0], { ...combo.legs![1], quantity: undefined }] };
  assert.equal(optionUnrealized(noLegQty, w), null);
});

test("REAL 2026-11-18 COVERED_STOCK position: described and marked", () => {
  const real = JSON.parse(`{"currency":"USD","quantity":"5","cost":"96640.00","legs":[{"symbol":"NVDA","cost":"193.84","instrument_type":"EQUITY","last_price":"157.72","unrealized_profit_loss":"-18060.00"},{"symbol":"NVDA","cost":"0.56","instrument_type":"OPTION","last_price":"0.35","unrealized_profit_loss":"105.00","option_type":"CALL","option_expire_date":"2026-12-11","option_exercise_price":"215","option_contract_multiplier":"100","option_contract_deliverable":"100"}],"symbol":"NVDA","option_strategy":"COVERED_STOCK","instrument_type":"OPTION","cost_price":"193.28"}`) as Position;
  assert.equal(describePosition(real), "500 NVDA + -5x NVDA 2026-12-11 215 CALL");
  const priced = world(et("2026-11-18", "10:00"), { positions: [real], snapshots: [{ symbol: "NVDA261211C00215000", bid: "0.30", ask: "0.40" }] });
  assert.equal(optionUnrealized(real, priced), 105, "short 5 calls from 0.56 to 0.35 mid = +$105");
  const unpriced = world(et("2026-11-18", "10:00"), { positions: [real] });
  assert.equal(optionUnrealized(real, unpriced), 105, "falls back to the leg's own unrealized_profit_loss");
});

test("wheel ticker gap is flagged during market hours only", () => {
  const stale = world(et("2026-11-06", "13:00"), { runs: { wheel: [run(5, "2026-11-06T16:00:00Z")] }, positions: [wheelPut] }); // 11:00 ET, 2h old
  assert.ok(keys(stale).some((k) => k.startsWith("gap:wheel")));
  const fresh = world(et("2026-11-06", "13:00"), { runs: { wheel: [run(6, "2026-11-06T17:50:00Z")] }, positions: [wheelPut] });
  assert.ok(!keys(fresh).some((k) => k.startsWith("gap:wheel")));
});

const spy0: Position = { symbol: "SPY", instrument_type: "OPTION", quantity: "1", cost_price: "2.10", legs: [{ symbol: "SPY", option_type: "CALL", option_expire_date: "2026-11-09", option_exercise_price: "767", cost: "2.10" }] };
const spx0: Position = { symbol: "SPXW", instrument_type: "OPTION", quantity: "1", legs: [{ symbol: "SPXW", option_type: "CALL", option_expire_date: "2026-11-09", option_exercise_price: "6800", cost: "9.00" }] };

test("0DTE still open: priced into the limit, critical only after its auto-close window", () => {
  const snaps = [{ symbol: "SPY261109C00767000", bid: "0.80", ask: "0.90" }];
  const w = world(et("2026-11-09", "15:40"), { positions: [spy0, wheelPut], snapshots: snaps });
  assert.ok(!keys(w).some((x) => x.startsWith("0dte-open:")), "3:40pm is SPY's auto-close time, not yet an alert");
  const row = riskRows(w).find((r) => r.agent === "spy-0dte")!;
  assert.equal(row.unrealized, -125); // (0.85 - 2.10) * 1 * 100
  const late = world(et("2026-11-09", "15:45"), { positions: [spy0, wheelPut], snapshots: snaps });
  assert.ok(keys(late).some((x) => x.startsWith("0dte-open:")), "still open 5 min after auto-close: critical");
  const spxAt = (t: string) => keys(world(et("2026-11-09", t), { positions: [spx0, wheelPut] })).some((x) => x.startsWith("0dte-open:"));
  assert.ok(!spxAt("15:50") && spxAt("15:55"), "SPX alerts at 3:55pm, after its 3:50pm auto-close");
});

test("auto-close: SPY due at 3:40pm, SPX at 3:50pm, never shorts/stock/wheel/after the close", () => {
  const stock: Position = { symbol: "SOFI", instrument_type: "EQUITY", quantity: "100" };
  const shortSpy: Position = { ...spy0, quantity: "-1" };
  const all = [spy0, spx0, wheelPut, stock, shortSpy];
  const due = (t: string) => dueForAutoClose(all, et("2026-11-09", t)).map((p) => p.symbol);
  assert.deepEqual(due("15:39"), []);
  assert.deepEqual(due("15:40"), ["SPY"]);
  assert.deepEqual(due("15:50"), ["SPY", "SPXW"]);
  assert.deepEqual(due("16:00"), [], "market closed");
  const tomorrow: Position = { ...spy0, legs: [{ ...spy0.legs![0], option_expire_date: "2026-11-10" }] };
  assert.deepEqual(dueForAutoClose([tomorrow], et("2026-11-09", "15:45")), [], "only options expiring today");
  const halfDay: Position = { ...spy0, legs: [{ ...spy0.legs![0], option_expire_date: "2026-11-27" }] };
  assert.equal(dueForAutoClose([halfDay], et("2026-11-27", "12:39")).length, 0);
  assert.equal(dueForAutoClose([halfDay], et("2026-11-27", "12:40")).length, 1, "half day (1pm close): due at 12:40pm");
});

test("auto-close pricing: escalates off the bid and snaps to each root's tick", () => {
  assert.equal(closeLimit("SPY", 1.0, 1), 0.97);
  assert.equal(closeLimit("SPY", 1.0, 3), 0.88);
  assert.equal(closeLimit("SPY", 1.0, 9), 0.5, "capped at 50% off");
  assert.equal(closeLimit("SPXW", 2.0, 1), 1.9, "SPXW under $3 ticks $0.05, rounded down");
  assert.equal(closeLimit("SPXW", 10.0, 1), 9.7);
  assert.equal(closeLimit("SPY", 0, 1), 0.01, "no bid: one tick");
  assert.equal(closeLimit("SPXW", 0, 1), 0.05);
});

test("orders refuse anything but the sandbox host", () => {
  assert.doesNotThrow(() => assertSandbox("https://api.sandbox.webull.com"));
  assert.throws(() => assertSandbox("https://api.webull.com"), /not the Webull sandbox/);
  assert.throws(() => assertSandbox("https://sandbox.webull.com.evil.io"), /not the Webull sandbox/);
  assert.throws(() => assertSandbox(undefined), /not the Webull sandbox/);
});

test("auto-close end to end against a fake broker: one SELL_TO_CLOSE, then position gone", async () => {
  const { WebullClient } = await import("./webullClient");
  const proto = WebullClient.prototype as unknown as Record<string, unknown>;
  const realGet = proto.get, realPost = proto.post;
  const env = { ...process.env };
  Object.assign(process.env, { WEBULL_BASE_URL: "https://api.sandbox.webull.com", WEBULL_APP_KEY: "k", WEBULL_APP_SECRET: "s", WEBULL_SANDBOX_ACCOUNT_ID: "acct" });
  let held = true;
  const placed: Array<Record<string, unknown>> = [];
  proto.get = async (path: string) => {
    if (path.includes("positions")) return held ? [spy0] : [];
    if (path.includes("snapshots")) return [{ symbol: "SPY261109C00767000", bid: "1.00", ask: "1.10" }];
    if (path.includes("order/detail")) return { orders: [{ status: "FILLED", filled_quantity: "1", filled_price: "0.97" }] };
    throw new Error("unexpected GET " + path);
  };
  proto.post = async (path: string, body: { new_orders?: Array<Record<string, unknown>> }) => {
    assert.ok(path.endsWith("/option/order/place"), path);
    placed.push(body.new_orders![0]);
    held = false;
    return {};
  };
  try {
    const res = await autoCloseAll([spy0], et("2026-11-09", "15:40"), () => et("2026-11-09", "15:41"));
    assert.equal(placed.length, 1);
    const o = placed[0] as { side: string; position_intent: string; order_type: string; limit_price: string; legs: Array<{ symbol: string }> };
    assert.equal(o.side, "SELL");
    assert.equal(o.position_intent, "SELL_TO_CLOSE");
    assert.equal(o.order_type, "LIMIT");
    assert.equal(o.limit_price, "0.97");
    assert.equal(o.legs[0].symbol, "SPY", "leg symbol is the underlying, not the OCC string");
    assert.equal(res[0].ok, true);
    assert.equal(res[0].sold, 1);
    assert.equal(res[0].avgPrice, 0.97);
    // Production host: refuses before any call.
    process.env.WEBULL_BASE_URL = "https://api.webull.com";
    await assert.rejects(() => autoCloseAll([spy0], et("2026-11-09", "15:40")), /not the Webull sandbox/);
    assert.equal(placed.length, 1);
  } finally {
    proto.get = realGet;
    proto.post = realPost;
    process.env = env;
  }
});

test("auto-close off switch defaults on and can be turned off", () => {
  const c: Control = { updated: "", agents: {} };
  assert.equal(autoCloseEnabled(c), true);
  setAutoClose(c, false, "testing");
  assert.equal(autoCloseEnabled(c), false);
});

test("SPY open loss plus realized trips its $200 limit", () => {
  // Nov 9 has no SPY exits in the log, so realized is 0; open at -$230.
  const spy: Position = { symbol: "SPY", instrument_type: "OPTION", quantity: "1", legs: [{ symbol: "SPY", option_type: "CALL", option_expire_date: "2026-11-09", option_exercise_price: "767", cost: "4.00" }] };
  const w = world(et("2026-11-09", "12:00"), { positions: [spy, wheelPut], snapshots: [{ symbol: "SPY261109C00767000", bid: "1.65", ask: "1.75" }] });
  assert.ok(keys(w).includes("limit:spy-0dte"));
});

test("no wheel assignment alerts (J, Nov 15), but wheel/broker mismatch still flagged", () => {
  const itm = world(et("2026-11-09", "11:00"), { positions: [wheelPut], nvdaPrice: 180, snapshots: [{ symbol: "NVDA261113P00195000", bid: "15", ask: "15.2" }] });
  assert.ok(!keys(itm).some((k) => k.startsWith("wheel-cushion") || k.startsWith("wheel-unrealized")));
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
  assert.ok(r.markdown.includes("79% of the $1350 combined limit"));
  fs.mkdirSync("fixtures/out", { recursive: true });
  fs.writeFileSync("fixtures/out/sample-report.md", r.markdown);
  console.log(`   headline: ${r.headline}`);
});

test("control: auto-pause for today, manual resume wins, manual pause until resumed", () => {
  const c: Control = { updated: "", agents: { "spx-0dte": { mode: "run" } } };
  assert.equal(autoPause(c, "spx-0dte", "2026-11-17", "SPX hit its daily limit"), true);
  assert.equal(isPaused(c, "spx-0dte", "2026-11-17"), true);
  assert.equal(isPaused(c, "spx-0dte", "2026-11-18"), false, "an automatic pause expires with the day");
  assert.equal(autoPause(c, "spx-0dte", "2026-11-17", "again"), false, "idempotent");
  manualResume(c, ["spx-0dte"], "2026-11-17");
  assert.equal(isPaused(c, "spx-0dte", "2026-11-17"), false);
  assert.equal(autoPause(c, "spx-0dte", "2026-11-17", "still breached"), false, "J's resume holds for the rest of the day");
  assert.equal(autoPause(c, "spx-0dte", "2026-11-18", "new day"), true, "but not the next day");
  manualPause(c, parseTargets("all"), "vacation");
  assert.equal(isPaused(c, "wheel", "2026-12-01"), true, "manual pause has no end date");
  assert.throws(() => parseTargets("spx"), /unknown agent/);
});

test("agent snippet: reads control.json, fails open, keeps last mode on error", async () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  let mode: "ok" | "fail" = "fail";
  globalThis.fetch = (async () => {
    if (mode === "fail") throw new Error("network down");
    return new Response(JSON.stringify({ agents: { "spx-0dte": { mode: "paused", reason: "limit", date: today } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const snip = await import("./agent-snippet/supervisorControl");
    assert.deepEqual(await snip.supervisorPause("spx-0dte"), { paused: false, source: "default" }, "unreachable on first read = not paused");
    mode = "ok";
    const p = await snip.supervisorPause("spx-0dte");
    assert.equal(p.paused, true);
    assert.equal(p.source, "control");
    mode = "fail";
    const later = await snip.supervisorPause("spx-0dte");
    assert.equal(later.paused, true, "a failed read never unpauses");
  } finally {
    globalThis.fetch = realFetch;
  }
});

(async () => {
  for (const [name, fn] of queue) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  }
  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
