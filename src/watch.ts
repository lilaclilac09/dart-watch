import 'dotenv/config';
import { titanQuote, isTitanError } from './titan.js';
import { TOKENS, toRaw } from './tokens.js';

// ── Config ────────────────────────────────────────────────────────────────────

const FROM    = 'SOL';
const TO      = 'USDC';
const SIZES   = [1, 10, 100, 500];   // human units
const POLL_MS = 2000;
const MAX_HIST = 120;                 // ticks to keep (~4 min)

// ── State ─────────────────────────────────────────────────────────────────────

interface Tick { ts: number; price: number; latencyMs: number; computePrice?: number }
const hist: Record<number, Tick[]> = Object.fromEntries(SIZES.map(s => [s, []]));
let tick = 0, errs = 0;

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[96m',
  green:  '\x1b[92m',
  yellow: '\x1b[93m',
  red:    '\x1b[91m',
  clear:  '\x1bc',
};
const c = (s: string, ...codes: string[]) => codes.join('') + s + C.reset;

function latColor(ms: number) {
  if (ms < 400) return C.green;
  if (ms < 800) return C.yellow;
  return C.red;
}

function miniChart(ticks: Tick[], w = 28): string {
  if (ticks.length < 2) return ' '.repeat(w);
  const slice  = ticks.slice(-w);
  const prices = slice.map(t => t.price);
  const min    = Math.min(...prices);
  const max    = Math.max(...prices);
  const range  = max - min || 0.00001;
  const bars   = '▁▂▃▄▅▆▇█';
  const mid    = Math.floor(prices.length / 2);
  const avgL   = prices.slice(0, mid).reduce((a, b) => a + b, 0) / (mid || 1);
  const avgR   = prices.slice(mid).reduce((a, b) => a + b, 0) / ((prices.length - mid) || 1);
  const up     = avgR >= avgL;
  return slice.map(t => {
    const i = Math.round(((t.price - min) / range) * (bars.length - 1));
    return c(bars[i], up ? C.green : C.dim);
  }).join('');
}

function latChart(ticks: Tick[], w = 20): string {
  if (!ticks.length) return ' '.repeat(w);
  const slice = ticks.slice(-w);
  return slice.map(t => c('█', latColor(t.latencyMs))).join('');
}

function arrow(ticks: Tick[]): string {
  if (ticks.length < 2) return ' ';
  const d = ticks[ticks.length - 1].price - ticks[ticks.length - 2].price;
  return d > 0 ? c('▲', C.green) : d < 0 ? c('▼', C.red) : c('─', C.dim);
}

function impactBps(ref: number, p: number): string {
  const bps = (p - ref) / ref * 10000;
  const s   = `${bps >= 0 ? '+' : ''}${bps.toFixed(2)} bps`;
  return bps < -3 ? c(s, C.yellow) : c(s, C.dim);
}

function pctile(ticks: Tick[], p: number): number {
  const sorted = [...ticks].sort((a, b) => a.latencyMs - b.latencyMs);
  return sorted[Math.floor(sorted.length * p)]?.latencyMs ?? 0;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const lines: string[] = [C.clear];
  const W = 100;

  lines.push(c(`  TITAN DART  ·  ${FROM} → ${TO}  ·  live`, C.bold, C.cyan));
  lines.push(c(`  ${new Date().toISOString()}   tick ${tick}   errors ${errs}`, C.dim));
  lines.push(c('═'.repeat(W), C.cyan));
  lines.push('');

  const refTicks = hist[SIZES[0]];
  const refPrice = refTicks.at(-1)?.price ?? null;

  // table header
  const H = [
    'SIZE'.padEnd(10),
    'PRICE'.padEnd(16),
    'ΔREF'.padEnd(14),
    'LAT'.padEnd(8),
    'P50'.padEnd(8),
    'P95'.padEnd(8),
    'CU'.padEnd(10),
    'PRICE CHART',
  ];
  lines.push('  ' + c(H.join(''), C.dim));
  lines.push('  ' + c('─'.repeat(W - 2), C.dim));

  for (const size of SIZES) {
    const h    = hist[size];
    const last = h.at(-1);
    if (!last) {
      lines.push(`  ${c((size + ' SOL').padEnd(10), C.bold)}${c('fetching…', C.dim)}`);
      continue;
    }
    const impact = refPrice !== null ? impactBps(refPrice, last.price) : c('—', C.dim);
    const p50    = pctile(h, 0.5);
    const p95    = pctile(h, 0.95);
    const cu     = last.computePrice !== undefined ? `${(last.computePrice / 1000).toFixed(0)}k μL` : '—';

    lines.push(
      '  ' +
      c((size + ' SOL').padEnd(10), C.bold) +
      arrow(h) + ' ' +
      c(last.price.toFixed(5).padEnd(15), C.cyan) +
      impact.padEnd(14) +
      c(`${last.latencyMs}ms`.padEnd(8), latColor(last.latencyMs)) +
      c(`${p50}ms`.padEnd(8), C.dim) +
      c(`${p95}ms`.padEnd(8), C.dim) +
      c(cu.padEnd(10), C.dim) +
      miniChart(h)
    );
  }

  lines.push('');

  // impact bar chart
  if (refPrice !== null) {
    lines.push(c('  PRICE IMPACT vs 1 SOL', C.dim));
    for (const size of SIZES.slice(1)) {
      const last = hist[size].at(-1);
      if (!last) continue;
      const bps    = (last.price - refPrice) / refPrice * 10000;
      const filled = Math.min(Math.abs(Math.round(bps * 5)), 50);
      const bar    = bps < 0
        ? c('░'.repeat(filled), C.yellow)
        : c('▓'.repeat(filled), C.green);
      const label  = `${bps >= 0 ? '+' : ''}${bps.toFixed(2)} bps`;
      lines.push(
        `    ${c((size + ' SOL').padEnd(8), C.dim)}  ${bar.padEnd(50)}  ${c(label, Math.abs(bps) > 5 ? C.yellow : C.dim)}`
      );
    }
    lines.push('');
  }

  // latency sparkline for 1 SOL
  const latTicks = hist[1].slice(-40);
  if (latTicks.length > 1) {
    const mean = Math.round(latTicks.reduce((s, t) => s + t.latencyMs, 0) / latTicks.length);
    lines.push(c('  LATENCY  1 SOL  (last 40 polls)', C.dim));
    lines.push('    ' + latChart(latTicks, 40));
    lines.push(c(`    avg ${mean}ms  ·  p50 ${pctile(latTicks, 0.5)}ms  ·  p95 ${pctile(latTicks, 0.95)}ms`, C.dim));
    lines.push('');
  }

  lines.push(c('═'.repeat(W), C.cyan));
  lines.push(c('  Ctrl+C to quit', C.dim));

  process.stdout.write(lines.join('\n') + '\n');
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  tick++;
  const results = await Promise.all(
    SIZES.map(size =>
      titanQuote(FROM, TO, toRaw(size, TOKENS[FROM].decimals))
        .then(r => ({ size, r }))
    )
  );

  for (const { size, r } of results) {
    if (isTitanError(r)) { errs++; continue; }
    const h = hist[size];
    h.push({ ts: Date.now(), price: r.price, latencyMs: r.latencyMs, computePrice: r.computePrice });
    if (h.length > MAX_HIST) h.shift();
  }

  render();
}

// ── Entry ─────────────────────────────────────────────────────────────────────

process.stdout.write(C.clear + c('  TITAN DART · connecting…', C.cyan) + '\n');
poll();
const iv = setInterval(poll, POLL_MS);
process.on('SIGINT', () => { clearInterval(iv); process.stdout.write('\x1b[0m\n'); process.exit(0); });
