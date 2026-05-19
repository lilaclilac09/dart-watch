import 'dotenv/config';
import { titanQuote, isTitanError } from './titan.js';
import { TOKENS, fmtHuman, toRaw } from './tokens.js';

// One-shot scan: test all pairs at multiple sizes, print table + summary.

const TESTS: Array<{ from: string; to: string; amounts: number[] }> = [
  { from: 'SOL',  to: 'USDC', amounts: [0.5, 1, 10, 50, 100, 500] },
  { from: 'SOL',  to: 'USDT', amounts: [1, 10, 100] },
  { from: 'USDC', to: 'SOL',  amounts: [100, 1000, 10000] },
  { from: 'JUP',  to: 'USDC', amounts: [100, 1000, 10000] },
  { from: 'BONK', to: 'SOL',  amounts: [1_000_000, 10_000_000] },
  { from: 'mSOL', to: 'SOL',  amounts: [1, 10] },
  { from: 'WIF',  to: 'USDC', amounts: [10, 100] },
  { from: 'ORCA', to: 'USDC', amounts: [100, 1000] },
];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[96m', green: '\x1b[92m', yellow: '\x1b[93m', red: '\x1b[91m',
};
const c = (s: string, col: string) => col + s + C.reset;
const KEY = process.env.TITAN_API_KEY ?? '';

async function main() {
  console.log('\n' + c('═'.repeat(96), C.cyan));
  console.log(c('  TITAN DART · Full Pair Scan', C.bold + C.cyan));
  console.log(c(`  ${new Date().toISOString()}  ${KEY ? '🔑 authenticated' : '⚠ no API key'}`, C.dim));
  console.log(c('═'.repeat(96), C.cyan));

  const rows: Array<{
    pair: string; amount: number;
    outHuman: string; price: number; impactBps: number | null; latencyMs: number;
    computePrice?: number;
  }> = [];

  for (const { from, to, amounts } of TESTS) {
    const fromTok = TOKENS[from];
    const toTok   = TOKENS[to];
    if (!fromTok || !toTok) continue;

    console.log(`\n  ${c('─── ' + from + ' → ' + to + ' ' + '─'.repeat(70), C.dim)}`);
    console.log(
      '  ' +
      c('AMOUNT'.padEnd(18), C.dim) +
      c('OUTPUT'.padEnd(20), C.dim) +
      c('PRICE'.padEnd(14), C.dim) +
      c('IMPACT'.padEnd(14), C.dim) +
      c('LAT'.padEnd(8), C.dim) +
      c('CU PRICE', C.dim)
    );

    let refPrice: number | null = null;
    let gotAny = false;

    for (const amount of amounts) {
      const r = await titanQuote(from, to, toRaw(amount, fromTok.decimals));

      if (isTitanError(r)) {
        const msg = `${c('ERROR', C.red)}: ${r.error}`;
        console.log(`  ${(amount.toLocaleString() + ' ' + from).padEnd(18)}${msg}  ${c(r.latencyMs + 'ms', C.dim)}`);
        if (!gotAny) break;
        await delay(300);
        continue;
      }

      gotAny = true;
      if (refPrice === null) refPrice = r.price;
      const impact    = (r.price - refPrice) / refPrice * 10000;
      const impactStr = refPrice !== null
        ? c(`${impact >= 0 ? '+' : ''}${impact.toFixed(2)} bps`, Math.abs(impact) > 5 ? C.yellow : C.dim)
        : c('—', C.dim);
      const cpStr     = r.computePrice !== undefined
        ? c(`${(r.computePrice / 1000).toFixed(0)}k μL`, C.dim)
        : c('—', C.dim);
      const latC      = r.latencyMs < 400 ? C.green : r.latencyMs < 800 ? C.yellow : C.red;

      console.log(
        '  ' +
        c((amount.toLocaleString() + ' ' + from).padEnd(18), C.bold) +
        c((fmtHuman(r.outRaw, toTok.decimals) + ' ' + to).padEnd(20), C.cyan) +
        c(r.price.toFixed(6).padEnd(14), C.dim) +
        impactStr.padEnd(14) +
        c((r.latencyMs + 'ms').padEnd(8), latC) +
        cpStr
      );

      rows.push({
        pair: `${from}/${to}`,
        amount,
        outHuman:     fmtHuman(r.outRaw, toTok.decimals),
        price:        r.price,
        impactBps:    refPrice !== null ? impact : null,
        latencyMs:    r.latencyMs,
        computePrice: r.computePrice,
      });

      await delay(350);
    }
  }

  // summary
  const ok      = rows.filter(r => r.impactBps !== null && r.impactBps !== 0);
  const avgLat  = rows.reduce((s, r) => s + r.latencyMs, 0) / (rows.length || 1);
  const worst   = ok.reduce((m, r) => Math.min(m, r.impactBps!), 0);
  const avgCp   = rows.filter(r => r.computePrice).reduce((s, r) => s + r.computePrice!, 0)
                / (rows.filter(r => r.computePrice).length || 1);

  console.log('\n' + c('═'.repeat(96), C.cyan));
  console.log(c('  SUMMARY', C.bold));
  console.log(c('═'.repeat(96), C.cyan));
  console.log(`\n  Quotes returned      : ${rows.length}`);
  console.log(`  Avg latency          : ${avgLat.toFixed(0)}ms`);
  console.log(`  Avg compute price    : ${(avgCp / 1000).toFixed(0)}k micro-lamports/CU`);
  console.log(`  Worst price impact   : ${worst.toFixed(2)} bps`);

  const pairs = [...new Set(rows.map(r => r.pair))];
  console.log('\n  Impact curve per pair (smallest → largest trade):');
  for (const pair of pairs) {
    const pr = rows.filter(r => r.pair === pair && r.impactBps !== null);
    if (pr.length < 2) continue;
    const span = pr.at(-1)!.price - pr[0].price;
    const bps  = (span / pr[0].price) * 10000;
    const col  = Math.abs(bps) > 10 ? C.yellow : C.dim;
    console.log(`    ${c(pair.padEnd(14), C.dim)}  ${c(`${bps >= 0 ? '+' : ''}${bps.toFixed(2)} bps`, col)}  over ${pr.length} sizes`);
  }

  console.log('\n' + c('─'.repeat(96), C.dim));
  console.log(c('  Titan DART charges ~1 bps taker fee embedded in outputAmount', C.dim));
  console.log(c('═'.repeat(96) + '\n', C.cyan));
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main().catch(console.error);
