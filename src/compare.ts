import 'dotenv/config';
import { titanQuote, isTitanError } from './titan.js';
import { TOKENS, fmtHuman, toRaw } from './tokens.js';

// Head-to-head: Titan DART vs 0x Solana — runs once, prints table.
// Requires both TITAN_API_KEY and ZEROEX_API_KEY.

const ZEROEX_BASE = 'https://api.0x.org/solana';
const WALLET      = process.env.WALLET_PUBKEY ?? '11111111111111111111111111111112';
const ZEROEX_KEY  = process.env.ZEROEX_API_KEY ?? '';

const PAIRS: Array<{ from: string; to: string; amounts: number[] }> = [
  { from: 'SOL',  to: 'USDC', amounts: [1, 10, 100, 500] },
  { from: 'JUP',  to: 'USDC', amounts: [100, 1000] },
  { from: 'BONK', to: 'USDC', amounts: [1_000_000, 10_000_000] },
  { from: 'mSOL', to: 'SOL',  amounts: [1, 10] },
  { from: 'WIF',  to: 'USDC', amounts: [10, 100] },
];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[96m', green: '\x1b[92m', yellow: '\x1b[93m', red: '\x1b[91m',
};
const c = (s: string, col: string) => col + s + C.reset;

async function zeroexQuote(
  from: string, to: string, amountRaw: bigint,
): Promise<{ out: bigint; latencyMs: number } | null> {
  const t0 = Date.now();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ZEROEX_KEY) headers['0x-api-key'] = ZEROEX_KEY;
    const res = await fetch(`${ZEROEX_BASE}/swap-instructions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token_in:     TOKENS[from].mint,
        token_out:    TOKENS[to].mint,
        amount_in:    Number(amountRaw),
        slippage_bps: 0,
        taker:        WALLET,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return null;
    const data = await res.json() as { amount_out?: string };
    if (!data.amount_out) return null;
    return { out: BigInt(data.amount_out), latencyMs };
  } catch { return null; }
}

function diffBps(titan: bigint, zeroex: bigint): number {
  return Number(zeroex - titan) * 10000 / Number(titan);
}

async function main() {
  const hasKeys = !!(process.env.TITAN_API_KEY && ZEROEX_KEY);
  console.log('\n' + c('═'.repeat(100), C.cyan));
  console.log(c('  TITAN DART  vs  0x SOLANA  ·  head-to-head', C.bold + C.cyan));
  console.log(c(`  ${new Date().toISOString()}  ${hasKeys ? '🔑 both keys loaded' : '⚠ missing API key(s)'}`, C.dim));
  console.log(c('═'.repeat(100), C.cyan));

  const results: Array<{
    pair: string; amount: number;
    titanOut: string; zeroexOut: string;
    edgeBps: number | null; winner: string;
    titanLat: number; zeroexLat: number;
  }> = [];

  for (const { from, to, amounts } of PAIRS) {
    const toTok = TOKENS[to];
    console.log(`\n  ${c('─── ' + from + ' → ' + to + ' ' + '─'.repeat(78), C.dim)}`);
    console.log(
      '  ' +
      c('SIZE'.padEnd(20), C.dim) +
      c('TITAN'.padEnd(22), C.dim) +
      c('0x'.padEnd(22), C.dim) +
      c('EDGE (0x - Titan)', C.dim)
    );

    for (const amount of amounts) {
      const raw = toRaw(amount, TOKENS[from].decimals);
      const [tRes, zRes] = await Promise.all([
        titanQuote(from, to, raw),
        zeroexQuote(from, to, raw),
      ]);

      const tOut = !isTitanError(tRes) ? tRes.outRaw : null;
      const zOut = zRes?.out ?? null;
      const tLat = !isTitanError(tRes) ? tRes.latencyMs : -1;
      const zLat = zRes?.latencyMs ?? -1;

      const tStr = tOut !== null ? c(fmtHuman(tOut, toTok.decimals) + ' ' + to, C.cyan) : c('ERROR', C.red);
      const zStr = zOut !== null ? c(fmtHuman(zOut, toTok.decimals) + ' ' + to, C.cyan) : c('ERROR', C.red);

      let edgeStr = c('—', C.dim);
      let bps: number | null = null;
      let winner = '—';
      if (tOut !== null && zOut !== null) {
        bps    = diffBps(tOut, zOut);
        winner = tOut >= zOut ? 'Titan' : '0x';
        const bpsLabel = `${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps`;
        const winCol   = winner === 'Titan' ? C.green : C.cyan;
        edgeStr = c(`${winner} ▶ ${bpsLabel}`, winCol);
      }

      console.log(
        '  ' +
        c((amount.toLocaleString() + ' ' + from).padEnd(20), C.bold) +
        tStr.padEnd(22) +
        zStr.padEnd(22) +
        edgeStr +
        c(`  T:${tLat}ms  Z:${zLat}ms`, C.dim)
      );

      results.push({
        pair: `${from}/${to}`, amount,
        titanOut:  tOut !== null ? fmtHuman(tOut, toTok.decimals) : 'ERROR',
        zeroexOut: zOut !== null ? fmtHuman(zOut, toTok.decimals) : 'ERROR',
        edgeBps: bps, winner,
        titanLat: tLat, zeroexLat: zLat,
      });

      await new Promise(r => setTimeout(r, 500));
    }
  }

  // summary
  const ok     = results.filter(r => r.edgeBps !== null);
  const tWins  = ok.filter(r => r.winner === 'Titan').length;
  const zWins  = ok.filter(r => r.winner === '0x').length;
  const avgEdge = ok.reduce((s, r) => s + r.edgeBps!, 0) / (ok.length || 1);
  const avgTLat = results.filter(r => r.titanLat > 0).reduce((s, r) => s + r.titanLat, 0)
                / (results.filter(r => r.titanLat > 0).length || 1);
  const avgZLat = results.filter(r => r.zeroexLat > 0).reduce((s, r) => s + r.zeroexLat, 0)
                / (results.filter(r => r.zeroexLat > 0).length || 1);

  console.log('\n' + c('═'.repeat(100), C.cyan));
  console.log(c('  SUMMARY', C.bold));
  console.log(c('═'.repeat(100), C.cyan));
  console.log(`\n  Pairs tested          : ${results.length}`);
  console.log(`  Titan wins            : ${c(String(tWins), C.green)}/${ok.length}`);
  console.log(`  0x wins               : ${c(String(zWins), C.cyan)}/${ok.length}`);
  console.log(`  Avg edge (0x − Titan) : ${c(`${avgEdge >= 0 ? '+' : ''}${avgEdge.toFixed(2)} bps`, Math.abs(avgEdge) > 5 ? C.yellow : C.dim)}`);
  console.log(`  Avg latency           : Titan ${avgTLat.toFixed(0)}ms  ·  0x ${avgZLat.toFixed(0)}ms`);
  console.log('\n' + c('─'.repeat(100), C.dim));
  console.log(c('  Titan DART: ~1 bps explicit taker fee  ·  0x: fee embedded in spread', C.dim));
  console.log(c('═'.repeat(100) + '\n', C.cyan));
}

main().catch(console.error);
