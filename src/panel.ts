import 'dotenv/config';
import {
  connectPhoenix, disconnectPhoenix,
  phoenixMarkets, phoenixBooks, allMids,
  simulateFill, connected as phoenixConnected,
} from './phoenix.js';
import { titanQuote, isTitanError } from './titan.js';
import { zeroexQuote, zeroexEnabled } from './zeroex.js';
import { TOKENS, toRaw, fmtHuman } from './tokens.js';

// ── Config ────────────────────────────────────────────────────────────────────

const SYMBOL   = 'SOL';
const FROM     = 'SOL';
const TO       = 'USDC';
const POLL_MS  = 3000;
const SIM_SIZE = 100;          // SOL — size shown in simulation panel
const BOOK_ROWS = 5;           // ask/bid rows in orderbook

// ── State ─────────────────────────────────────────────────────────────────────

interface SpotTick { price: number; latencyMs: number; ts: number }
const titanHistory: Record<number, SpotTick[]> = { 1: [], 10: [], 100: [], 500: [] };
const zeroexHistory: Record<number, SpotTick[]> = { 1: [], 10: [], 100: [], 500: [] };
const SIZES = [1, 10, 100, 500];

let tick = 0;
let pollErrors = 0;

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m', bold:   '\x1b[1m', dim:    '\x1b[2m',
  cyan:   '\x1b[96m', green:  '\x1b[92m', yellow: '\x1b[93m',
  red:    '\x1b[91m', white:  '\x1b[97m', blue:   '\x1b[94m',
  clear:  '\x1bc',
};
const c  = (s: string, ...codes: string[]) => codes.join('') + s + C.reset;
const W  = 108;
const hr = (ch = '─', n = W) => ch.repeat(n);

function latC(ms: number) { return ms < 400 ? C.green : ms < 800 ? C.yellow : C.red; }

function priceDelta(ref: number, p: number) {
  const bps = (p - ref) / ref * 10000;
  const s   = `${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps`;
  return bps < -5 ? c(s, C.yellow) : c(s, C.dim);
}

function bookBar(size: number, maxSize: number, width = 22, side: 'bid' | 'ask'): string {
  const filled = Math.min(Math.round((size / maxSize) * width), width);
  const col    = side === 'ask' ? C.red : C.green;
  return c('█'.repeat(filled), col).padEnd(width);
}

function miniSpark(ticks: SpotTick[], w = 16): string {
  if (ticks.length < 2) return c('·'.repeat(w), C.dim);
  const prices = ticks.slice(-w).map(t => t.price);
  const mn = Math.min(...prices), mx = Math.max(...prices);
  const range = mx - mn || 0.00001;
  const bars  = '▁▂▃▄▅▆▇█';
  const up    = prices[prices.length - 1] >= prices[0];
  return prices.map(p => {
    const i = Math.round(((p - mn) / range) * (bars.length - 1));
    return c(bars[i], up ? C.green : C.dim);
  }).join('');
}

function fundingColor(f: number) {
  if (Math.abs(f) > 0.003) return C.red;
  if (Math.abs(f) > 0.001) return C.yellow;
  return C.green;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const lines: string[] = [C.clear];
  const phx = phoenixMarkets[SYMBOL];
  const book = phoenixBooks[SYMBOL];

  // ── header ──
  const phxStatus = phoenixConnected ? c('Phoenix ●', C.green) : c('Phoenix ○', C.red);
  const zxStatus  = zeroexEnabled     ? c('0x ●', C.cyan)      : c('0x ○ (no key)', C.dim);
  lines.push(c(`  SOL  ·  MULTI-VENUE LIVE PANEL  ·  ${phxStatus}  ${zxStatus}`, C.bold + C.white));
  lines.push(c(`  ${new Date().toISOString()}   tick ${tick}   errors ${pollErrors}`, C.dim));
  lines.push(c(hr('═'), C.cyan));

  // ── price grid: spot vs perp ──
  const titanNow  = titanHistory[1].at(-1);
  const zeroexNow = zeroexHistory[1].at(-1);

  const leftW = 48;
  const col1 = (s: string) => s.padEnd(leftW);

  // top section: 2 columns
  const spotLines: string[] = [];
  spotLines.push(c('SPOT QUOTES  (1 SOL)', C.bold + C.cyan));
  spotLines.push('');
  if (titanNow) {
    spotLines.push(
      c('Titan DART ', C.dim) +
      c(titanNow.price.toFixed(5) + ' USDC/SOL', C.cyan + C.bold) +
      c(`  ${titanNow.latencyMs}ms`, latC(titanNow.latencyMs))
    );
  } else {
    spotLines.push(c('Titan DART  fetching…', C.dim));
  }
  if (zeroexEnabled && zeroexNow) {
    spotLines.push(
      c('0x Solana  ', C.dim) +
      c(zeroexNow.price.toFixed(5) + ' USDC/SOL', C.cyan + C.bold) +
      c(`  ${zeroexNow.latencyMs}ms`, latC(zeroexNow.latencyMs))
    );
  } else if (!zeroexEnabled) {
    spotLines.push(c('0x Solana   — needs ZEROEX_API_KEY', C.dim));
  }
  if (phx) {
    const spotMid = titanNow?.price ?? 0;
    const basis = spotMid > 0 ? (phx.markPx - spotMid) / spotMid * 10000 : null;
    spotLines.push('');
    spotLines.push(
      c('Basis mark−spot: ', C.dim) +
      (basis !== null
        ? c(`${basis >= 0 ? '+' : ''}${basis.toFixed(1)} bps`, Math.abs(basis) > 10 ? C.yellow : C.dim)
        : c('—', C.dim))
    );
  }

  const perpLines: string[] = [];
  perpLines.push(c('PHOENIX PERP  (SOL-PERP)', C.bold + C.cyan));
  perpLines.push('');
  if (phx) {
    const fundingPct = (phx.funding * 100).toFixed(4);
    const fundingDir = phx.funding >= 0 ? 'longs pay' : 'shorts pay';
    const chg24 = phx.prevDayPx > 0 ? (phx.markPx - phx.prevDayPx) / phx.prevDayPx * 100 : 0;
    perpLines.push(c('Mark      ', C.dim) + c('$' + phx.markPx.toFixed(3).padEnd(12), C.white + C.bold) + c(`24h ${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}%`, chg24 >= 0 ? C.green : C.red));
    perpLines.push(c('Oracle    ', C.dim) + c('$' + phx.oraclePx.toFixed(3), C.dim));
    perpLines.push(c('Mid       ', C.dim) + c('$' + phx.midPx.toFixed(3), C.dim));
    perpLines.push(c('Funding   ', C.dim) + c(`${phx.funding >= 0 ? '+' : ''}${fundingPct}%/hr  (${fundingDir})`, fundingColor(phx.funding)));
    perpLines.push(c('Open Int  ', C.dim) + c(`${phx.openInterest.toLocaleString('en-US', { maximumFractionDigits: 0 })} SOL  `, C.dim) + c(`$${(phx.openInterest * phx.markPx / 1e6).toFixed(2)}M`, C.dim));
    perpLines.push(c('24h Vol   ', C.dim) + c(`$${(phx.dayNtlVlm / 1e6).toFixed(2)}M`, C.dim));
  } else {
    perpLines.push(c('connecting to Phoenix…', C.dim));
  }

  // merge spot + perp as 2-col layout
  lines.push('');
  const maxRows = Math.max(spotLines.length, perpLines.length);
  for (let i = 0; i < maxRows; i++) {
    const l = (spotLines[i] ?? '').padEnd(leftW);
    const r = perpLines[i] ?? '';
    lines.push('  ' + l + '  ' + r);
  }
  lines.push('');

  // ── orderbook ──
  if (book && book.asks.length && book.bids.length) {
    lines.push(c(hr('─'), C.dim));
    lines.push(c('  PHOENIX L2  SOL-PERP ORDERBOOK', C.bold + C.cyan));
    lines.push('');

    const asks = [...book.asks].sort((a, b) => a[0] - b[0]).slice(0, BOOK_ROWS);
    const bids = [...book.bids].sort((a, b) => b[0] - a[0]).slice(0, BOOK_ROWS);
    const allSizes = [...asks, ...bids].map(r => r[1]);
    const maxSz = Math.max(...allSizes, 1);

    // asks reversed so best ask is closest to mid
    for (const [px, sz] of [...asks].reverse()) {
      const usd = px * sz;
      lines.push(
        '  ' +
        c('ASK', C.red) + '  ' +
        c(px.toFixed(3).padStart(8), C.red + C.bold) + '  ' +
        bookBar(sz, maxSz, 20, 'ask') + '  ' +
        c(sz.toLocaleString('en-US', { maximumFractionDigits: 0 }).padEnd(8), C.dim) +
        c('SOL', C.dim) + '  ' +
        c(`$${(usd / 1000).toFixed(0)}k`, C.dim)
      );
    }

    const mid = phx?.midPx ?? (((asks[0]?.[0] ?? 0) + (bids[0]?.[0] ?? 0)) / 2);
    lines.push('  ' + c(`─── MID $${mid.toFixed(3)} ${'─'.repeat(W - 18)}`, C.cyan));

    for (const [px, sz] of bids) {
      const usd = px * sz;
      lines.push(
        '  ' +
        c('BID', C.green) + '  ' +
        c(px.toFixed(3).padStart(8), C.green + C.bold) + '  ' +
        bookBar(sz, maxSz, 20, 'bid') + '  ' +
        c(sz.toLocaleString('en-US', { maximumFractionDigits: 0 }).padEnd(8), C.dim) +
        c('SOL', C.dim) + '  ' +
        c(`$${(usd / 1000).toFixed(0)}k`, C.dim)
      );
    }

    lines.push('');
  }

  // ── simulation panel ──
  lines.push(c(hr('─'), C.dim));
  lines.push(c(`  SIMULATION  →  sell ${SIM_SIZE} SOL`, C.bold + C.cyan));
  lines.push('');

  const ref100Titan  = titanHistory[SIM_SIZE].at(-1);
  const ref100Zeroex = zeroexHistory[SIM_SIZE].at(-1);
  const phxFill      = simulateFill(SYMBOL, 'sell', SIM_SIZE);

  const bestSpotPrice = ref100Titan?.price ?? ref100Zeroex?.price ?? phxFill?.avgPrice ?? 0;

  if (ref100Titan) {
    const imp = priceDelta(titanHistory[1].at(-1)?.price ?? ref100Titan.price, ref100Titan.price);
    lines.push(
      '  ' +
      c('Titan DART  ', C.bold) +
      c(`${ref100Titan.price.toFixed(5)} USDC/SOL`, C.cyan) +
      c(`  →  $${(ref100Titan.price * SIM_SIZE).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`, C.white) +
      '  ' + imp +
      c(`  lat ${ref100Titan.latencyMs}ms`, latC(ref100Titan.latencyMs))
    );
  } else {
    lines.push('  ' + c('Titan DART  fetching…', C.dim));
  }

  if (zeroexEnabled && ref100Zeroex) {
    const imp = priceDelta(bestSpotPrice, ref100Zeroex.price);
    lines.push(
      '  ' +
      c('0x Solana   ', C.bold) +
      c(`${ref100Zeroex.price.toFixed(5)} USDC/SOL`, C.cyan) +
      c(`  →  $${(ref100Zeroex.price * SIM_SIZE).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`, C.white) +
      '  ' + imp +
      c(`  lat ${ref100Zeroex.latencyMs}ms`, latC(ref100Zeroex.latencyMs))
    );
  } else if (!zeroexEnabled) {
    lines.push('  ' + c('0x Solana   —  add ZEROEX_API_KEY to .env', C.dim));
  }

  if (phxFill) {
    const notional = phxFill.totalQuote;
    const imp = bestSpotPrice > 0 ? priceDelta(bestSpotPrice, phxFill.avgPrice) : '';
    const partial = phxFill.partial ? c('  ⚠ book too thin', C.yellow) : '';
    lines.push(
      '  ' +
      c('Phoenix perp', C.bold) +
      c(`  ${phxFill.avgPrice.toFixed(5)} USDC/SOL`, C.cyan) +
      c(`  →  $${notional.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`, C.white) +
      '  ' + imp +
      c(`  ${phxFill.levels} level${phxFill.levels !== 1 ? 's' : ''}`, C.dim) +
      partial
    );
  } else {
    lines.push('  ' + c('Phoenix perp  —  waiting for orderbook…', C.dim));
  }

  lines.push('');

  // ── price sparklines ──
  lines.push(c(hr('─'), C.dim));
  lines.push(c('  PRICE HISTORY  Titan DART  (per size, last 30 ticks)', C.dim));
  lines.push('');
  for (const size of SIZES) {
    const h = titanHistory[size];
    if (!h.length) continue;
    const last = h.at(-1)!;
    const ref1 = titanHistory[1].at(-1)?.price ?? last.price;
    lines.push(
      '  ' +
      c(`${size} SOL`.padEnd(8), C.bold) +
      c(last.price.toFixed(5).padEnd(12), C.cyan) +
      priceDelta(ref1, last.price).padEnd(14) +
      miniSpark(h)
    );
  }

  lines.push('');
  lines.push(c(hr('═'), C.cyan));
  lines.push(c('  Ctrl+C to quit  ·  refreshes every 3s', C.dim));

  process.stdout.write(lines.join('\n') + '\n');
}

// ── Poll spot APIs ────────────────────────────────────────────────────────────

async function poll() {
  tick++;
  const fromTok = TOKENS[FROM];

  const titanResults = await Promise.all(
    SIZES.map(size =>
      titanQuote(FROM, TO, toRaw(size, fromTok.decimals)).then(r => ({ size, r }))
    )
  );

  for (const { size, r } of titanResults) {
    if (isTitanError(r)) { pollErrors++; continue; }
    const h = titanHistory[size];
    h.push({ price: r.price, latencyMs: r.latencyMs, ts: Date.now() });
    if (h.length > 60) h.shift();
  }

  if (zeroexEnabled) {
    const zxResults = await Promise.all(
      SIZES.map(size =>
        zeroexQuote(FROM, TO, toRaw(size, fromTok.decimals)).then(r => ({ size, r }))
      )
    );
    for (const { size, r } of zxResults) {
      if (!r) { pollErrors++; continue; }
      const h = zeroexHistory[size];
      h.push({ price: r.price, latencyMs: r.latencyMs, ts: Date.now() });
      if (h.length > 60) h.shift();
    }
  }

  render();
}

// ── Entry ─────────────────────────────────────────────────────────────────────

process.stdout.write(C.clear + c('  connecting…', C.cyan) + '\n');

connectPhoenix();

// first render on Phoenix connect
let firstRender = true;
const { onPhoenixEvent } = await import('./phoenix.js');
onPhoenixEvent((event) => {
  if ((event === 'market' || event === 'orderbook') && firstRender) {
    firstRender = false;
    render();
  }
  if (event === 'market' || event === 'orderbook') render();
});

// kick off spot polling loop
poll();
const iv = setInterval(poll, POLL_MS);

process.on('SIGINT', () => {
  clearInterval(iv);
  disconnectPhoenix();
  process.stdout.write('\x1b[0m\n  bye\n');
  process.exit(0);
});
