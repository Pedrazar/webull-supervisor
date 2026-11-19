/**
 * Fixture tests for the call/put direction reads (no network). Run: npm test.
 */

import assert from "assert";
import fs from "fs";
import { Bar, DayCalls, computeDaily } from "./analystRules";
import { featuresOf, sessionBars } from "./analystData";
import { activationCheck, directionMarkdown, gradeDirection, middayRead, morningRead, sessionVwap, wouldBeStrikes, DirectionRead } from "./analystDirection";
import { LogEvent } from "./logs";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const et = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
const DAY = "2026-11-18";

function dailyDown(n = 60): Bar[] {
  const out: Bar[] = [];
  let p = 780;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 - 0.002 + (i % 2 ? 0.001 : -0.001));
    out.push({ time: new Date(Date.parse("2026-08-20T05:00:00Z") + i * 864e5).toISOString(), open: o, high: o, low: p, close: p, volume: 1e6 });
  }
  return out;
}

/** 5-minute session bars from 9:30 through `until`, following `path(minuteOfDay) -> price`. */
function bars(date: string, until: string, path: (m: number) => number): Bar[] {
  const out: Bar[] = [];
  const [uh, um] = until.split(":").map(Number);
  for (let m = 9 * 60 + 30; m <= uh * 60 + um; m += 5) {
    const o = path(m);
    const c = path(m + 5);
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    out.push({ time: et(date, `${hh}:${mm}`), open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 1000 });
  }
  return out;
}

const quotes = (price: number) => {
  const k = wouldBeStrikes(price);
  return {
    call: { symbol: "C", strike: k.call, bid: 2.9, ask: 3.0, spreadPct: 0.034 },
    put: { symbol: "P", strike: k.put, bid: 3.1, ask: 3.2, spreadPct: 0.032 },
  };
};

function dayCalls(call: "buy" | "short" | "sit_out", price: number): DayCalls {
  const c = (agent: any) => ({ agent, call, bias: call === "short" ? -0.7 : call === "buy" ? 0.7 : 0, confidence: 0.7, underlying: "SPY", priceAtCall: price, reasons: ["r"], meaning: "" });
  return {
    date: DAY,
    ts: et(DAY, "10:15"),
    late: false,
    regime: "trend_down",
    features: [{ symbol: "SPY", daily: null, intraday: { open: price, last: price, lastBarTime: et(DAY, "10:10"), movePct: 0, gapPct: 0 } }],
    calls: [c("spy-0dte"), c("spx-0dte"), c("webull-agent"), c("wheel")],
    dataNotes: [],
  };
}

test("strikes: $1 in the money on each side", () => {
  assert.deepEqual(wouldBeStrikes(732.37), { call: 731, put: 733 });
});

test("morning read maps short -> put, buy -> call, sit_out -> none", () => {
  assert.ok(morningRead(dayCalls("short", 732), quotes(732), false).reads.every((r) => r.side === "put"));
  assert.ok(morningRead(dayCalls("buy", 732), quotes(732), false).reads.every((r) => r.side === "call"));
  assert.ok(morningRead(dayCalls("sit_out", 732), quotes(732), false).reads.every((r) => r.side === "none"));
});

test("midday read: down morning then a strong rally above VWAP flips to call despite the downtrend", () => {
  const d = dailyDown();
  const path = (m: number) => (m <= 11 * 60 ? 733 - ((m - 570) / 90) * 4 : 729 + ((m - 660) / 75) * 7); // 733 -> 729 at 11:00 -> 736 at 12:15
  const spy5 = bars(DAY, "12:10", path);
  const f = featuresOf("SPY", d, spy5, DAY);
  assert.ok(f.daily && f.intraday);
  const sess = sessionBars(spy5, DAY);
  const r = middayRead(DAY, new Date(et(DAY, "12:16")), false, f.daily!, f.intraday!, sess, "trend_down", quotes(736));
  assert.equal(r.components!.trend, -1);
  assert.ok(r.components!.hour > 0.9 && r.components!.vwap > 0);
  assert.equal(r.reads.find((x) => x.agent === "spy-0dte")!.side, "call");
});

test("midday read: falling all day below VWAP = put", () => {
  const d = dailyDown();
  const spy5 = bars(DAY, "12:10", (m) => 733 - ((m - 570) / 165) * 5);
  const f = featuresOf("SPY", d, spy5, DAY);
  const r = middayRead(DAY, new Date(et(DAY, "12:16")), false, f.daily!, f.intraday!, sessionBars(spy5, DAY), "trend_down", quotes(728));
  assert.ok(r.reads.every((x) => x.side === "put"));
});

test("vwap ignores bars without volume", () => {
  assert.equal(sessionVwap([{ time: "", open: 1, high: 1, low: 1, close: 1, volume: 0 }]), null);
});

// Agent logs: morning call stopped out -$162, midday call -$134 (the real 2026-11-18 SPY day).
const spyLog: LogEvent[] = [
  { ts: "2026-11-18T15:30:20Z", event: "entry_filled", slot: "morning" },
  { ts: "2026-11-18T15:48:07Z", event: "exit_filled", slot: "morning", realizedPnl: -162 },
  { ts: "2026-11-18T17:30:27Z", event: "entry_filled", slot: "midday" },
  { ts: "2026-11-18T17:51:41Z", event: "exit_filled", slot: "midday", realizedPnl: -134 },
];

function sampleReads(middaySide: "call" | "put"): DirectionRead[] {
  const m = morningRead(dayCalls("short", 732), quotes(732), false);
  const mid: DirectionRead = { ...m, slot: "midday", ts: et(DAY, "12:15"), spyAtRead: 733, contracts: quotes(733), reads: m.reads.map((x) => ({ ...x, side: middaySide })) };
  return [m, mid];
}

test("grading: put pick on a down close beats always-call; flip and slot P&L recorded", () => {
  const s = gradeDirection(sampleReads("call"), 728, { "spy-0dte": spyLog }, new Date())!;
  const morning = s.grades.find((g) => g.agent === "spy-0dte" && g.slot === "morning")!;
  // put 733 strike, ask 3.20, intrinsic at 728 = 5 -> +$180; call 731, ask 3.00, intrinsic 0 -> -$300.
  assert.equal(morning.putHoldPnl, 180);
  assert.equal(morning.callHoldPnl, -300);
  assert.equal(morning.sideEdge, 480);
  assert.equal(morning.directionHit, true);
  assert.equal(morning.agentPnl, -162);
  const mid = s.grades.find((g) => g.agent === "spy-0dte" && g.slot === "midday")!;
  assert.equal(mid.flip, true);
  assert.equal(mid.directionHit, false, "flipped to call, SPY fell");
  assert.equal(mid.sideEdge, 0, "picking the call = always-call");
  assert.equal(mid.agentPnl, -134);
  const spx = s.grades.find((g) => g.agent === "spx-0dte" && g.slot === "morning")!;
  assert.equal(spx.agentEntered, false, "no SPX log passed");
});

test("activation: three days is nowhere near the bar, and the report says why", () => {
  const s = gradeDirection(sampleReads("put"), 728, { "spy-0dte": spyLog }, new Date())!;
  const a = activationCheck([s], "spy-0dte");
  assert.equal(a.ready, false);
  assert.ok(a.missing.some((m) => m.includes("graded days")));
  assert.ok(a.missing.some((m) => m.includes("call reads")), "no call reads in a downtrend-only sample");
  const md = directionMarkdown([s], [...sampleReads("put"), { ...sampleReads("put")[0], date: "2026-11-19" }]);
  assert.match(md, /not yet:/);
  assert.match(md, /Not graded yet: 2026-11-19/);
  fs.mkdirSync("fixtures/out", { recursive: true });
  fs.writeFileSync("fixtures/out/DIRECTION.md", md);
});

console.log(`\n${passed} direction tests passed`);
