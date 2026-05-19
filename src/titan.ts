import 'dotenv/config';
import { TOKENS, toHuman } from './tokens.js';

const BASE   = 'https://api.titan.exchange/dart';
const WALLET = process.env.WALLET_PUBKEY ?? '11111111111111111111111111111112';
const KEY    = process.env.TITAN_API_KEY  ?? '';

export interface TitanQuote {
  outRaw:        bigint;
  inRaw:         bigint;
  price:         number;   // outHuman / inHuman
  latencyMs:     number;
  computePrice?: number;   // micro-lamports/CU
  numIx:         number;
}

export interface TitanError {
  error:     string;
  latencyMs: number;
}

function decodeComputeUnitPrice(b64: string): number | undefined {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf[0] !== 3) return undefined;
    return buf.readUInt32LE(1) + buf.readUInt32LE(5) * 0x100000000;
  } catch { return undefined; }
}

export async function titanQuote(
  from:       string,
  to:         string,
  amountRaw:  bigint,
  slippageBps = 0,
): Promise<TitanQuote | TitanError> {
  const t0 = Date.now();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (KEY) headers['Authorization'] = `Bearer ${KEY}`;

    const res = await fetch(`${BASE}/swap`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        inputMint:     TOKENS[from].mint,
        outputMint:    TOKENS[to].mint,
        amount:        amountRaw.toString(),
        userPublicKey: WALLET,
        slippageBps,
      }),
      signal: AbortSignal.timeout(6000),
    });

    const latencyMs = Date.now() - t0;
    const data = await res.json() as {
      outputAmount?: string; inputAmount?: string;
      instructions?: Array<{ data: string }>; error?: string;
    };

    if (!res.ok || data.error || !data.outputAmount) {
      return { error: data.error ?? `HTTP ${res.status}`, latencyMs };
    }

    const outRaw = BigInt(data.outputAmount);
    const inRaw  = BigInt(data.inputAmount ?? amountRaw);

    let computePrice: number | undefined;
    for (const ix of data.instructions ?? []) {
      const p = decodeComputeUnitPrice(ix.data);
      if (p !== undefined) { computePrice = p; break; }
    }

    return {
      outRaw,
      inRaw,
      price:    toHuman(outRaw, TOKENS[to].decimals) / toHuman(inRaw, TOKENS[from].decimals),
      latencyMs,
      computePrice,
      numIx:    data.instructions?.length ?? 0,
    };
  } catch (e) {
    return { error: String(e).slice(0, 80), latencyMs: Date.now() - t0 };
  }
}

export function isTitanError(r: TitanQuote | TitanError): r is TitanError {
  return 'error' in r;
}
