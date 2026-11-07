/**
 * READ-ONLY Webull wrappers. Deliberately contains no order placement,
 * cancel or replace call, so phase 1 of the supervisor is structurally
 * incapable of trading. Paths, versions and response shapes are copied
 * from the agents' own live-verified optionsClient.ts / main.ts.
 */

import { WebullClient } from "./webullClient";

const V3 = { version: "v3" };

export function makeClient(): { client: WebullClient; accountId: string } {
  const baseUrl = need("WEBULL_BASE_URL");
  const client = new WebullClient({
    appKey: need("WEBULL_APP_KEY"),
    appSecret: need("WEBULL_APP_SECRET"),
    baseUrl,
    host: new URL(baseUrl).host,
  });
  return { client, accountId: need("WEBULL_SANDBOX_ACCOUNT_ID") };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

export interface PositionLeg {
  symbol: string;
  cost?: string;
  option_type?: "PUT" | "CALL";
  option_expire_date?: string;
  option_exercise_price?: string;
  [key: string]: unknown;
}

export interface Position {
  symbol: string; // underlying ticker for equity AND option positions
  instrument_type: string; // "EQUITY" | "OPTION"
  quantity: string; // negative for short options
  cost_price?: string;
  legs?: PositionLeg[];
  [key: string]: unknown;
}

export async function getPositions(client: WebullClient, accountId: string): Promise<Position[]> {
  const res = await withRetry(() =>
    client.get<{ data?: Position[] } | Position[]>("/trading/assets/positions/list", { account_id: accountId }, V3)
  );
  return Array.isArray(res) ? res : res.data ?? [];
}

export interface OpenOrder {
  status?: string;
  client_order_id?: string;
  order_id?: string;
  symbol?: string;
  [key: string]: unknown;
}

export async function getOpenOrders(client: WebullClient, accountId: string): Promise<OpenOrder[]> {
  const res = await withRetry(() =>
    client.get<{ orders?: OpenOrder[] } | OpenOrder[]>("/openapi/trade/order/open", { account_id: accountId })
  );
  return Array.isArray(res) ? res : res.orders ?? [];
}

export interface OptionSnapshot {
  symbol: string;
  bid?: string;
  ask?: string;
  price?: string;
  [key: string]: unknown;
}

export async function getOptionSnapshots(client: WebullClient, symbols: string[]): Promise<OptionSnapshot[]> {
  if (symbols.length === 0) return [];
  const res = await withRetry(() =>
    client.get<{ data?: OptionSnapshot[] } | OptionSnapshot[]>(
      "/market-data/options/snapshots/list",
      { symbols: symbols.slice(0, 20).join(","), category: "US_OPTION" },
      V3
    )
  );
  return Array.isArray(res) ? res : res.data ?? [];
}

export async function getStockPrice(client: WebullClient, symbol: string): Promise<number | null> {
  const bars = await withRetry(() =>
    client.get<Array<{ close: string }>>("/openapi/market-data/stock/bars", {
      symbol,
      category: "US_STOCK",
      timespan: "M1",
      count: "1",
    })
  );
  return bars?.[0]?.close ? parseFloat(bars[0].close) : null;
}

/** Same OCC format the agents build (positions never return it directly). */
export function occSymbol(root: string, expirationDate: string, optionType: "PUT" | "CALL", strike: number): string {
  const [y, m, d] = expirationDate.split("-");
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${root}${y.slice(2)}${m}${d}${optionType === "PUT" ? "P" : "C"}${strikeCode}`;
}

export function midOf(s: OptionSnapshot | undefined): number | null {
  if (!s) return null;
  const bid = s.bid ? parseFloat(s.bid) : NaN;
  const ask = s.ask ? parseFloat(s.ask) : NaN;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = s.price ? parseFloat(s.price) : NaN;
  return Number.isFinite(last) ? last : null;
}

/** The sandbox rate-limits positions/list (429s crashed the SPY agent on 2026-10-19). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}
