import WebSocket from 'ws';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PhoenixMarket {
  markPx:      number;
  midPx:       number;
  oraclePx:    number;
  funding:     number;   // per-hour rate (not annualized)
  openInterest: number;  // SOL
  dayNtlVlm:   number;   // USD
  prevDayPx:   number;
  updatedAt:   number;
}

export interface PhoenixBook {
  bids: [number, number][]; // [price, size]
  asks: [number, number][];
  updatedAt: number;
}

export interface AllMids {
  [symbol: string]: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

export const phoenixMarkets: Record<string, PhoenixMarket> = {};
export const phoenixBooks:   Record<string, PhoenixBook>   = {};
export const allMids:        AllMids = {};
export let   connected = false;

// ── Simulate market order fill through the book ───────────────────────────────

export interface FillResult {
  totalQuote: number;
  avgPrice:   number;
  levels:     number;   // how many book levels consumed
  filled:     number;   // base filled
  partial:    boolean;  // true if book was exhausted before full fill
}

export function simulateFill(
  symbol: string,
  side:   'buy' | 'sell',
  sizeBase: number,
): FillResult | null {
  const book = phoenixBooks[symbol];
  if (!book) return null;

  const levels = side === 'buy' ? book.asks : book.bids;
  // asks sorted asc, bids sorted desc
  const sorted = side === 'buy'
    ? [...levels].sort((a, b) => a[0] - b[0])
    : [...levels].sort((a, b) => b[0] - a[0]);

  let remaining = sizeBase;
  let totalQuote = 0;
  let numLevels  = 0;

  for (const [px, sz] of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(sz, remaining);
    totalQuote += take * px;
    remaining  -= take;
    numLevels++;
  }

  const filled = sizeBase - remaining;
  return {
    totalQuote,
    avgPrice:  filled > 0 ? totalQuote / filled : 0,
    levels:    numLevels,
    filled,
    partial:   remaining > 0,
  };
}

// ── WebSocket client ──────────────────────────────────────────────────────────

const WS_URL = 'wss://perp-api.phoenix.trade/v1/ws';

type Listener = (event: string, data: unknown) => void;
const listeners: Listener[] = [];

export function onPhoenixEvent(fn: Listener) {
  listeners.push(fn);
}

function emit(event: string, data: unknown) {
  for (const fn of listeners) fn(event, data);
}

interface PhoenixMsg {
  channel:   string;
  symbol?:   string;
  status?:   string;
  error?:    string;
  mids?:     Record<string, number>;
  markPx?:   number;
  midPx?:    number;
  oraclePx?: number;
  funding?:  number;
  openInterest?: number;
  dayNtlVlm?: number;
  prevDayPx?:  number;
  orderbook?: { bids: [number, number][]; asks: [number, number][] };
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const subscriptions = [
  { channel: 'allMids' },
  { channel: 'market',    symbol: 'SOL' },
  { channel: 'orderbook', symbol: 'SOL' },
  { channel: 'market',    symbol: 'BTC' },
];

function subscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const sub of subscriptions) {
    ws.send(JSON.stringify({ type: 'subscribe', subscription: sub }));
  }
}

export function connectPhoenix() {
  if (ws) { try { ws.terminate(); } catch {} }

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    connected = true;
    subscribe();
    emit('connected', null);
  });

  ws.on('message', (raw) => {
    let msg: PhoenixMsg;
    try { msg = JSON.parse(raw.toString()) as PhoenixMsg; } catch { return; }

    if (msg.channel === 'allMids' && msg.mids) {
      Object.assign(allMids, msg.mids);
      emit('allMids', allMids);
    }

    if (msg.channel === 'market' && msg.symbol) {
      const s = msg.symbol;
      phoenixMarkets[s] = {
        markPx:       msg.markPx      ?? phoenixMarkets[s]?.markPx      ?? 0,
        midPx:        msg.midPx       ?? phoenixMarkets[s]?.midPx       ?? 0,
        oraclePx:     msg.oraclePx    ?? phoenixMarkets[s]?.oraclePx    ?? 0,
        funding:      msg.funding     ?? phoenixMarkets[s]?.funding      ?? 0,
        openInterest: msg.openInterest ?? phoenixMarkets[s]?.openInterest ?? 0,
        dayNtlVlm:    msg.dayNtlVlm   ?? phoenixMarkets[s]?.dayNtlVlm   ?? 0,
        prevDayPx:    msg.prevDayPx   ?? phoenixMarkets[s]?.prevDayPx   ?? 0,
        updatedAt:    Date.now(),
      };
      emit('market', { symbol: s, data: phoenixMarkets[s] });
    }

    if (msg.channel === 'orderbook' && msg.symbol && msg.orderbook) {
      phoenixBooks[msg.symbol] = {
        bids:      msg.orderbook.bids,
        asks:      msg.orderbook.asks,
        updatedAt: Date.now(),
      };
      emit('orderbook', { symbol: msg.symbol, book: phoenixBooks[msg.symbol] });
    }
  });

  ws.on('close', () => {
    connected = false;
    emit('disconnected', null);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectPhoenix(); }, 3000);
    }
  });

  ws.on('error', () => {
    connected = false;
  });
}

export function disconnectPhoenix() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws?.terminate();
  ws = null;
  connected = false;
}
