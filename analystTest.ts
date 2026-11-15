/**
 * Fixture tests for the analyst (no network). Run: npm test.
 * Synthetic bars exercise the rules and the bar handling; the agents' real
 * 2026-11-06 logs (fixtures/) check the grading money math.
 */

import assert from "assert";
import fs from "fs";
import { Bar, computeDaily, makeCalls, regimeOf, trendOf, DayCalls } from "./analystRules";
import { completedDays, featuresOf, oldestFirst, sessionBars, sessionClose } from "./analystData";
import { gradeDay, scorecardMarkdown, totals, callSummary } from "./analystScore";
import { parseLog } from "./logs";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

/** NY is UTC-5 in November 2026. */
const et = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();

/** n completed daily bars ending the day before `today`, drifting by `drift` a day with a small wiggle. */
function dailySeries(n: number, start: number, drift: number): Bar[] {
  const out: Bar[] = [];
  let p = start;
  const d0 = new Date("2026-08-01T05:00:00Z");
  for (let i = 0; i < n; i++) {
    const t = new Date(d0.getTime() + i * 864e5).toISOString();
    const o = p;
    p = p * (1 + drift + (i % 2 ? 0.002 : -0.002));
    out.push({ time: t, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p, volume: 1e6 });
  }
  return out;
}

function fiveMin(date: string, open: number, stepPct: number, untilHHMM: string, includePre = true): Bar[] {
  const out: Bar[] = [];
  if (includePre) out.push({ time: et(date, "09:00"), open: open * 0.99, high: open, low: open * 0.99, close: open * 0.995, volume: 10 });
  let p = open;
  const [uh, um] = untilHHMM.split(":").map(Number);
  for (let m = 9 * 60 + 30; m <= uh * 60 + um; m += 5) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const o = p;
    p = p * (1 + stepPct);
    out.push({ time: et(date, `${hh}:${mm}`), open: o, high: Math.max(o, p), low: Math.min(o, p), close: p, volume: 1000 });
  }
  return out;
}

const TODAY = "2026-11-16";
const lastClose = (b: Bar[]) => b[b.length - 1].close;

test("daily features: uptrend reads as trend_up, downtrend as trend_down", () => {
  const up = computeDaily(dailySeries(60, 600, 0.003))!;
  assert.ok(up && trendOf(up) === 1);
  assert.equal(regimeOf(up, null), "trend_up");
  const down = computeDaily(dailySeries(60, 600, -0.003))!;
  assert.equal(trendOf(down), -1);
  assert.equal(computeDaily(dailySeries(20, 600, 0.003)), null, "too few days gives no features");
});

test("bars: newest-first input without times is reversed; with times it is sorted", () => {
  const raw = [
    { time: "2026-11-13T15:05:00Z", open: "2", high: "2", low: "2", close: "2" },
    { time: "2026-11-13T15:00:00Z", open: "1", high: "1", low: "1", close: "1" },
  ];
  assert.deepEqual(oldestFirst(raw).map((b) => b.close), [1, 2]);
  const noTime = raw.map(({ time, ...r }) => r);
  assert.deepEqual(oldestFirst(noTime).map((b) => b.close), [1, 2]);
});

test("today's partial daily bar is dropped by matching today's first 5-minute open", () => {
  const daily = dailySeries(60, 600, 0.003);
  const intra = fiveMin(TODAY, 680, 0.0005, "10:15");
  const withToday = [...daily, { time: "2026-11-16T00:00:00Z", open: 680, high: 681, low: 679, close: 680.5, volume: 5 }];
  assert.equal(completedDays(withToday, TODAY, sessionBars(intra, TODAY)[0].open).length, 60);
  assert.equal(completedDays(daily, TODAY, 680).length, 60, "nothing dropped when the last bar is yesterday's");
});

test("session bars skip pre-market; close needs the last half hour", () => {
  const intra = fiveMin(TODAY, 680, 0.0005, "10:15");
  assert.equal(sessionBars(intra, TODAY)[0].open, 680);
  assert.equal(sessionClose(intra, TODAY), null, "a 10:15 snapshot is not a close");
  const full = fiveMin(TODAY, 680, 0.0001, "15:55");
  assert.ok(sessionClose(full, TODAY)! > 680);
});

test("rules: uptrend + rising morning = buy for SPY, SPX and stocks", () => {
  const sd = dailySeries(60, 600, 0.003);
  const nd = dailySeries(60, 150, 0.004);
  const spy = featuresOf("SPY", sd, fiveMin(TODAY, lastClose(sd), 0.0005, "10:15"), TODAY);
  const nvda = featuresOf("NVDA", nd, fiveMin(TODAY, lastClose(nd), 0.0004, "10:15"), TODAY);
  const day = makeCalls(TODAY, new Date(et(TODAY, "10:16")), false, spy, nvda, 180);
  assert.equal(day.regime, "trend_up");
  const by = Object.fromEntries(day.calls.map((c) => [c.agent, c]));
  assert.equal(by["spy-0dte"].call, "buy");
  assert.equal(by["spx-0dte"].call, "buy");
  assert.equal(by["webull-agent"].call, "buy");
  assert.equal(by["wheel"].call, "buy");
  assert.ok(by["spy-0dte"].priceAtCall! > lastClose(sd));
  assert.ok(by["wheel"].reasons.some((r) => r.includes("strike 180")));
  assert.match(callSummary(day), /SPY BUY/);
});

test("rules: downtrend + falling morning = short for 0DTE and stocks, wheel not bullish", () => {
  const sd = dailySeries(60, 700, -0.003);
  const nd = dailySeries(60, 220, -0.004);
  const spy = featuresOf("SPY", sd, fiveMin(TODAY, lastClose(sd), -0.0006, "10:15"), TODAY);
  const nvda = featuresOf("NVDA", nd, fiveMin(TODAY, lastClose(nd), -0.0004, "10:15"), TODAY);
  const day = makeCalls(TODAY, new Date(et(TODAY, "10:16")), false, spy, nvda);
  const by = Object.fromEntries(day.calls.map((c) => [c.agent, c]));
  assert.equal(by["spy-0dte"].call, "short");
  assert.equal(by["spx-0dte"].call, "short");
  assert.equal(by["webull-agent"].call, "short");
  assert.equal(by["wheel"].call, "short");
});

test("rules: uptrend but falling morning = mixed bias, 0DTE sits out", () => {
  const sd = dailySeries(60, 600, 0.003);
  const spy = featuresOf("SPY", sd, fiveMin(TODAY, lastClose(sd), -0.0004, "10:15"), TODAY);
  const day = makeCalls(TODAY, new Date(et(TODAY, "10:16")), false, spy, null);
  const by = Object.fromEntries(day.calls.map((c) => [c.agent, c]));
  assert.equal(by["spy-0dte"].call, "sit_out");
  assert.equal(by["wheel"].confidence, 0, "no NVDA data = no wheel view");
});

test("rules: no intraday bars halves confidence and notes it", () => {
  const spy = featuresOf("SPY", dailySeries(60, 600, 0.003), null, TODAY);
  const day = makeCalls(TODAY, new Date(et(TODAY, "10:16")), false, spy, null);
  assert.ok(day.dataNotes.some((n) => n.includes("daily trend only")));
  assert.ok(day.calls.every((c) => c.confidence <= 0.5));
});

// Real logs: on 2026-11-06 SPX lost $910 and SPY $153.
const logs = {
  "webull-agent": parseLog(fs.readFileSync("fixtures/trades.jsonl", "utf8")),
  wheel: parseLog(fs.readFileSync("fixtures/wheel-trades.jsonl", "utf8")),
  "spx-0dte": parseLog(fs.readFileSync("fixtures/spx-trades.jsonl", "utf8")),
  "spy-0dte": parseLog(fs.readFileSync("fixtures/spy-trades.jsonl", "utf8")),
};

function dayCalls(date: string, spyCall: "buy" | "short" | "sit_out", spxCall: "buy" | "short" | "sit_out"): DayCalls {
  const c = (agent: any, call: any, underlying = "SPY") => ({ agent, call, bias: 0, confidence: 0.5, underlying, priceAtCall: underlying === "SPY" ? 670 : 190, reasons: [], meaning: "" });
  return {
    date,
    ts: et(date, "10:16"),
    late: false,
    regime: "range",
    features: [],
    calls: [c("spy-0dte", spyCall), c("spx-0dte", spxCall), c("webull-agent", "buy"), c("wheel", "sit_out", "NVDA")],
    dataNotes: [],
  };
}

test("grading 2026-11-06 with the real logs: sit-outs save the 0DTE losses", () => {
  const s = gradeDay(dayCalls("2026-11-06", "sit_out", "short"), { SPY: 665, NVDA: 188 }, logs, new Date());
  const g = Object.fromEntries(s.grades.map((x) => [x.agent, x]));
  assert.equal(g["spx-0dte"].actualPnl, -910);
  assert.equal(g["spx-0dte"].followedPnl, 0);
  assert.equal(g["spx-0dte"].valueAdded, 910);
  assert.equal(g["spx-0dte"].directionHit, true, "short and SPY fell from 670 to 665");
  assert.equal(g["spy-0dte"].actualPnl, -153);
  assert.equal(g["spy-0dte"].valueAdded, 153);
  assert.equal(g["spy-0dte"].directionHit, null, "sit_out has no direction grade");
  assert.ok(g["spx-0dte"].agentEntries >= 1);
  assert.equal(g["webull-agent"].valueAdded, 0, "buy = same as the agent did");
  assert.equal(g["wheel"].followedPnl, null);
});

test("grading: a buy on a down day is a miss and adds nothing", () => {
  const s = gradeDay(dayCalls("2026-11-06", "buy", "buy"), { SPY: 665, NVDA: null }, logs, new Date());
  const spx = s.grades.find((x) => x.agent === "spx-0dte")!;
  assert.equal(spx.directionHit, false);
  assert.equal(spx.valueAdded, 0);
  assert.equal(s.grades.find((x) => x.agent === "wheel")!.movePct, null);
});

test("scorecard totals and markdown", () => {
  const a = gradeDay(dayCalls("2026-11-06", "sit_out", "short"), { SPY: 665, NVDA: 188 }, logs, new Date());
  const b = gradeDay(dayCalls("2026-11-05", "buy", "buy"), { SPY: 675, NVDA: 192 }, logs, new Date());
  const t = totals([a, b]);
  const spx = t.find((x) => x.agent === "spx-0dte")!;
  assert.equal(spx.days, 2);
  assert.equal(spx.valueAdded, 910);
  assert.equal(spx.pnlOnOtherDays, -910);
  const md = scorecardMarkdown([a, b], [dayCalls("2026-11-05", "buy", "buy"), dayCalls("2026-11-06", "sit_out", "short"), dayCalls("2026-11-09", "buy", "buy")], "2026-11-05");
  assert.match(md, /2 days graded since 2026-11-05/);
  assert.match(md, /Not graded yet: 2026-11-09/);
  assert.match(md, /\| 2026-11-06 \|/);
  fs.mkdirSync("fixtures/out", { recursive: true });
  fs.writeFileSync("fixtures/out/SCORECARD.md", md);
});

console.log(`\n${passed} analyst tests passed`);
