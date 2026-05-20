import 'dotenv/config';
import { TOKENS, toHuman } from './tokens.js';

const BASE   = 'https://api.0x.org/solana';
const WALLET = process.env.WALLET_PUBKEY ?? '11111111111111111111111111111112';
const KEY    = process.env.ZEROEX_API_KEY ?? '';

export const zeroexEnabled = !!KEY;

export interface ZeroexQuote {
  outRaw:    bigint;
  price:     number;
  latencyMs: number;
}

export async function zeroexQuote(
  from:      string,
  to:        string,
  amountRaw: bigint,
): Promise<ZeroexQuote | null> {
  if (!KEY) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/swap-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', '0x-api-key': KEY },
      body: JSON.stringify({
        token_in:     TOKENS[from].mint,
        token_out:    TOKENS[to].mint,
        amount_in:    Number(amountRaw),
        slippage_bps: 0,
        taker:        WALLET,
      }),
      signal: AbortSignal.timeout(6000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return null;
    const data = await res.json() as { amount_out?: string };
    if (!data.amount_out) return null;
    const outRaw = BigInt(data.amount_out);
    return {
      outRaw,
      price:    toHuman(outRaw, TOKENS[to].decimals) / toHuman(amountRaw, TOKENS[from].decimals),
      latencyMs,
    };
  } catch { return null; }
}
