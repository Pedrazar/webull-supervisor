/**
 * Everything the supervisor knows about the four agents, in one place.
 * Limits were set by J on 2026-11-07 (see the design doc). Phase 1 only
 * ALERTS on a breach; nothing here pauses an agent yet.
 */

export type AgentId = "webull-agent" | "wheel" | "spx-0dte" | "spy-0dte";

export interface AgentConfig {
  id: AgentId;
  name: string;
  owner: string;
  repo: string;
  /** Workflow file name under .github/workflows/ in the agent's repo. */
  workflow: string;
  /** Append-only JSONL trade log, as committed to the agent's main branch. */
  logPath: string;
  /** Daily realized loss limit in USD (positive number), or null for none. */
  dailyLossLimit: number | null;
  /**
   * How the agent is scheduled:
   *  - "session": one long job per day that must have STARTED by `startBy`
   *    (NY time, "HH:MM").
   *  - "ticker": a short job every few minutes; alert when the newest run is
   *    older than `maxGapMin` during market hours.
   */
  schedule:
    | { kind: "session"; startBy: string }
    | { kind: "ticker"; maxGapMin: number };
  /** True when a broker position belongs to this agent. */
  owns: (p: { symbol: string; instrument_type: string }) => boolean;
  /** Note shown in the report about how fresh the log on GitHub is. */
  logNote?: string;
}

const OWNER = "Pedrazar";

export const AGENTS: AgentConfig[] = [
  {
    id: "webull-agent",
    name: "Stock day trader (webull-agent)",
    owner: OWNER,
    repo: "webull-agent",
    workflow: "agent.yml",
    logPath: "trades.jsonl",
    dailyLossLimit: 150,
    schedule: { kind: "session", startBy: "09:40" },
    // Screener trades $1-$20 stocks; NVDA shares (if ever assigned) belong to the wheel.
    owns: (p) => p.instrument_type === "EQUITY" && p.symbol !== "NVDA",
    logNote: "commits its log once, at the end of the day, so intraday P&L for it is only known after the close (its own $150 kill switch still runs in-process)",
  },
  {
    id: "wheel",
    name: "NVDA wheel (webull-options-agent)",
    owner: OWNER,
    repo: "webull-options-agent",
    workflow: "wheel-agent.yml",
    logPath: "wheel-trades.jsonl",
    dailyLossLimit: null,
    schedule: { kind: "ticker", maxGapMin: 30 },
    owns: (p) => p.symbol === "NVDA",
  },
  {
    id: "spx-0dte",
    name: "SPX 0DTE calls",
    owner: OWNER,
    repo: "webull-spx-0dte-agent",
    workflow: "spx-0dte.yml",
    logPath: "spx-trades.jsonl",
    dailyLossLimit: 1000,
    schedule: { kind: "session", startBy: "10:25" },
    owns: (p) => p.instrument_type === "OPTION" && (p.symbol === "SPX" || p.symbol === "SPXW"),
  },
  {
    id: "spy-0dte",
    name: "SPY 0DTE calls (paper)",
    owner: OWNER,
    repo: "webull-spy-0dte-agent",
    workflow: "spy-0dte.yml",
    logPath: "spy-trades.jsonl",
    dailyLossLimit: 200,
    schedule: { kind: "session", startBy: "10:25" },
    owns: (p) => p.instrument_type === "OPTION" && p.symbol === "SPY",
  },
];

/** Combined daily cap across the paper account, realized + open 0DTE marked to market. */
export const COMBINED_DAILY_LOSS_LIMIT = 1000;

/** Unrealized loss on the wheel's open position that triggers an alert. */
export const WHEEL_UNREALIZED_ALERT_USD = 1500;

/** Wheel: alert when NVDA is within this fraction above the short put strike. */
export const WHEEL_CUSHION_ALERT_PCT = 0.03;

/** Any 0DTE option still held at or after this NY time is an emergency. */
export const ZERO_DTE_DEADLINE = "15:35";

/** An order seen open across supervisor runs for longer than this gets flagged. */
export const STALE_ORDER_MIN = 10;

/** The daily report is written on the first run at or after this NY time. */
export const REPORT_AFTER = "16:30";
