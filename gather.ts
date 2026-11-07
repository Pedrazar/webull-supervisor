/**
 * Collects everything the checks need into one plain object, so the checks
 * themselves are pure functions that can be tested with fixture data.
 * A source that can't be reached is recorded as an error, never as "empty":
 * the checks report "unknown" for it instead of "healthy".
 */

import { AGENTS, AgentConfig } from "./config";
import { listRuns, getFile, WorkflowRun } from "./github";
import { parseLog, LogEvent } from "./logs";
import { makeClient, getPositions, getOpenOrders, getOptionSnapshots, getStockPrice, occSymbol, Position, OpenOrder, OptionSnapshot } from "./broker";
import { todayNyDate } from "./marketHours";

export interface AgentData {
  cfg: AgentConfig;
  runs: WorkflowRun[] | null; // runs created since yesterday, newest first
  events: LogEvent[] | null; // whole log
  error?: string;
}

export interface WheelState {
  stage?: string;
  openOption?: { optionSymbol: string; strike: number; expiration: string; optionType: "PUT" | "CALL"; contracts: number; creditPerContract?: number } | null;
  shares?: number;
}

export interface World {
  now: Date;
  today: string;
  agents: AgentData[];
  positions: Position[] | null;
  openOrders: OpenOrder[] | null;
  snapshots: OptionSnapshot[];
  nvdaPrice: number | null;
  wheelState: WheelState | null;
  brokerError?: string;
}

export async function gather(now = new Date()): Promise<World> {
  const today = todayNyDate(now);
  // "created>=" is in UTC; going back 2 days covers the whole NY day plus
  // yesterday's late runs, and the checks filter by NY date themselves.
  const since = new Date(now.getTime() - 2 * 864e5).toISOString().slice(0, 10);

  const agents = await Promise.all(
    AGENTS.map(async (cfg): Promise<AgentData> => {
      const errors: string[] = [];
      const runs = await listRuns(cfg.owner, cfg.repo, cfg.workflow, since).catch((e) => {
        errors.push(String(e));
        return null;
      });
      const events = await getFile(cfg.owner, cfg.repo, cfg.logPath)
        .then(parseLog)
        .catch((e) => {
          errors.push(String(e));
          return null;
        });
      return { cfg, runs, events, error: errors.length ? errors.join("; ") : undefined };
    })
  );

  const wheelCfg = AGENTS.find((a) => a.id === "wheel")!;
  const wheelState = await getFile(wheelCfg.owner, wheelCfg.repo, "wheel-state.json")
    .then((t) => (t ? (JSON.parse(t) as WheelState) : null))
    .catch(() => null);

  let positions: Position[] | null = null;
  let openOrders: OpenOrder[] | null = null;
  let snapshots: OptionSnapshot[] = [];
  let nvdaPrice: number | null = null;
  let brokerError: string | undefined;
  try {
    const { client, accountId } = makeClient();
    positions = await getPositions(client, accountId);
    openOrders = await getOpenOrders(client, accountId);
    const occ = positions.filter((p) => p.instrument_type === "OPTION").map(optionOcc).filter((s): s is string => !!s);
    snapshots = await getOptionSnapshots(client, occ).catch(() => []);
    nvdaPrice = await getStockPrice(client, "NVDA").catch(() => null);
  } catch (e) {
    brokerError = String(e);
  }

  return { now, today, agents, positions, openOrders, snapshots, nvdaPrice, wheelState, brokerError };
}

/** OCC symbol of an option position, rebuilt from legs[0] (the broker never returns it). */
export function optionOcc(p: Position): string | null {
  const leg = p.legs?.[0];
  if (!leg?.option_expire_date || !leg.option_type || !leg.option_exercise_price) return null;
  // Daily SPX contracts trade under the SPXW root; the positions shape for them is unverified,
  // so map either spelling to SPXW (the agent never trades the AM-settled SPX root).
  const root = p.symbol === "SPX" ? "SPXW" : p.symbol;
  return occSymbol(root, leg.option_expire_date, leg.option_type, parseFloat(leg.option_exercise_price));
}
