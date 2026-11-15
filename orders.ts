/**
 * The supervisor's ONLY order code (phase 3, J 2026-11-15: "paper only").
 * It can do exactly one thing: SELL_TO_CLOSE a long option position, and
 * cancel its own unfilled close order. No opening orders, no stock orders.
 *
 * Paper only, enforced twice: makeOrderClient() refuses any base URL that
 * isn't the Webull sandbox host, and it only ever reads
 * WEBULL_SANDBOX_ACCOUNT_ID (the workflow has no production secrets).
 *
 * Request shapes are copied from the SPX/SPY agents' live-verified
 * optionsClient.ts: leg `symbol` is the UNDERLYING (SPY / SPXW), never the
 * OCC string; LIMIT + DAY only; category header US_OPTION; v3.
 */

import crypto from "crypto";
import { WebullClient } from "./webullClient";

const V3 = { version: "v3" };
const OPTION_ORDER_HEADERS = { headers: { category: "US_OPTION" }, ...V3 };
const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "FAILED", "EXPIRED"]);

export function assertSandbox(baseUrl: string | undefined): void {
  let host = "";
  try {
    host = new URL(baseUrl ?? "").host;
  } catch {
    // fall through to the refusal below
  }
  if (!/(^|\.)sandbox\.webull\.com$/.test(host)) {
    throw new Error(`refusing to place orders: WEBULL_BASE_URL host "${host || "(unset)"}" is not the Webull sandbox`);
  }
}

export function makeOrderClient(): { client: WebullClient; accountId: string } {
  const baseUrl = process.env.WEBULL_BASE_URL;
  assertSandbox(baseUrl);
  const appKey = process.env.WEBULL_APP_KEY;
  const appSecret = process.env.WEBULL_APP_SECRET;
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID;
  if (!appKey || !appSecret || !accountId) throw new Error("missing Webull sandbox credentials");
  return { client: new WebullClient({ appKey, appSecret, baseUrl: baseUrl!, host: new URL(baseUrl!).host }), accountId };
}

export interface CloseOrder {
  underlying: string; // "SPY" or "SPXW"
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string; // YYYY-MM-DD
  contracts: number;
  limitPrice: number;
}

/** SELL_TO_CLOSE only. Returns the client order id. */
export async function placeSellToClose(client: WebullClient, accountId: string, o: CloseOrder): Promise<string> {
  const clientOrderId = crypto.randomUUID().replace(/-/g, ""); // same 32-hex format the agents use
  const qty = String(o.contracts);
  await client.post(
    "/openapi/trade/option/order/place",
    {
      account_id: accountId,
      new_orders: [
        {
          client_order_id: clientOrderId,
          combo_type: "NORMAL",
          order_type: "LIMIT",
          quantity: qty,
          option_strategy: "SINGLE",
          side: "SELL",
          time_in_force: "DAY",
          entrust_type: "QTY",
          limit_price: String(o.limitPrice),
          position_intent: "SELL_TO_CLOSE",
          legs: [
            {
              side: "SELL",
              quantity: qty,
              symbol: o.underlying,
              strike_price: String(o.strike),
              option_expire_date: o.expiration,
              instrument_type: "OPTION",
              option_type: o.optionType,
              market: "US",
            },
          ],
        },
      ],
    },
    OPTION_ORDER_HEADERS
  );
  return clientOrderId;
}

export interface Settled {
  status: string; // a terminal status, or "UNKNOWN"
  filledQuantity: number;
  filledPrice: number | null;
}

async function orderStatus(client: WebullClient, accountId: string, clientOrderId: string): Promise<Settled> {
  let o: { status?: string; filled_quantity?: string; filled_price?: string } | undefined;
  try {
    const res = await client.get<{ orders?: Array<typeof o> }>("/openapi/trade/order/detail", {
      account_id: accountId,
      client_order_id: clientOrderId,
    });
    o = res.orders?.[0];
  } catch (err) {
    console.warn(`[order] status of ${clientOrderId} failed transiently:`, err);
  }
  return {
    status: o?.status ?? "UNKNOWN",
    filledQuantity: parseFloat(o?.filled_quantity ?? "0"),
    filledPrice: o?.filled_price ? parseFloat(o.filled_price) : null,
  };
}

/** Waits up to waitMs for a terminal state, else cancels and waits for the
 * cancel to be confirmed, the same pattern as the agents' settleOrder(). */
export async function settleOrder(client: WebullClient, accountId: string, clientOrderId: string, waitMs = 10_000): Promise<Settled> {
  const deadline = Date.now() + waitMs;
  let s = await orderStatus(client, accountId, clientOrderId);
  while (!TERMINAL.has(s.status) && Date.now() < deadline) {
    await sleep(2500);
    s = await orderStatus(client, accountId, clientOrderId);
  }
  if (TERMINAL.has(s.status)) return s;
  try {
    await client.post("/openapi/trade/option/order/cancel", { account_id: accountId, client_order_id: clientOrderId }, V3);
  } catch (err) {
    console.warn(`[order] cancel ${clientOrderId} failed (may have just filled):`, err);
  }
  for (let i = 0; i < 8; i++) {
    await sleep(2500);
    s = await orderStatus(client, accountId, clientOrderId);
    if (TERMINAL.has(s.status)) return s;
  }
  return { ...s, status: "UNKNOWN" };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
