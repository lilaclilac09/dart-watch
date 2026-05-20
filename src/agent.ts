/**
 * Claude-powered multi-venue trading agent.
 *
 * Claude acts as the reasoning layer. The APIs (Titan, 0x, Phoenix) are tools.
 * You describe what you want in plain language; Claude picks venues, compares
 * fills, and explains the trade-offs before executing anything.
 *
 * Run:  npm run agent
 * Env:  ANTHROPIC_API_KEY + TITAN_API_KEY (optional: ZEROEX_API_KEY)
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as readline from 'readline';
import { titanQuote, isTitanError } from './titan.js';
import { zeroexQuote } from './zeroex.js';
import {
  connectPhoenix, disconnectPhoenix,
  phoenixMarkets, phoenixBooks,
  simulateFill, allMids,
} from './phoenix.js';
import { TOKENS, toRaw, fmtHuman } from './tokens.js';

// ── Anthropic client ──────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tool definitions (what Claude can call) ───────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: 'get_spot_quote',
    description: `Get a live spot swap quote from Titan DART and/or 0x Solana.
Returns output amount, effective price (output/input), and latency.
Titan DART uses RFQ-style fills with ~1 bps explicit taker fee.
0x Solana aggregates routes with fee embedded in spread.
Use this when the user wants to swap tokens at spot price.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        from_token: {
          type: 'string',
          enum: ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'mSOL', 'WIF', 'ORCA'],
          description: 'Token to sell',
        },
        to_token: {
          type: 'string',
          enum: ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'mSOL', 'WIF', 'ORCA'],
          description: 'Token to buy',
        },
        amount: {
          type: 'number',
          description: 'Amount of from_token to sell (human units, e.g. 100 for 100 SOL)',
        },
        venues: {
          type: 'array',
          items: { type: 'string', enum: ['titan', '0x'] },
          description: 'Which venues to query. Defaults to both.',
        },
      },
      required: ['from_token', 'to_token', 'amount'],
    },
  },
  {
    name: 'get_phoenix_market',
    description: `Get live Phoenix perp market data for a symbol.
Returns mark price, oracle price, mid price, funding rate (per hour),
open interest, and 24h volume. Phoenix is a perpetual futures DEX —
prices here reflect the perp market, not spot.
Use this to check perp premium/discount vs spot, or funding direction.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: {
          type: 'string',
          enum: ['SOL', 'BTC', 'ETH'],
          description: 'Market symbol',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_phoenix_orderbook',
    description: `Get the live Phoenix L2 orderbook for a symbol.
Returns top bids and asks with price and size.
Use this to understand liquidity depth or simulate a perp trade fill.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: {
          type: 'string',
          enum: ['SOL', 'BTC', 'ETH'],
        },
        depth: {
          type: 'number',
          description: 'Number of price levels to return (default 5)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'simulate_phoenix_fill',
    description: `Simulate a market order fill through the Phoenix L2 orderbook.
Walks the book at the current snapshot price levels and returns:
average fill price, total quote received/paid, number of levels consumed,
and whether the book was too thin to fill the full size.
Use this to estimate slippage for a perp trade on Phoenix.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol:    { type: 'string', enum: ['SOL', 'BTC', 'ETH'] },
        side:      { type: 'string', enum: ['buy', 'sell'], description: 'buy = long, sell = short/close long' },
        size_base: { type: 'number', description: 'Size in base token (e.g. 100 for 100 SOL)' },
      },
      required: ['symbol', 'side', 'size_base'],
    },
  },
  {
    name: 'compare_venues',
    description: `Compare fill quality across ALL available venues for a given trade.
Runs Titan DART, 0x (if key available), and Phoenix perp simulation in parallel.
Returns a ranked summary showing which venue gives the best effective price.
Use this when the user wants the best execution or asks "which venue is better".`,
    input_schema: {
      type: 'object' as const,
      properties: {
        from_token: { type: 'string', enum: ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'mSOL', 'WIF'] },
        to_token:   { type: 'string', enum: ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'mSOL', 'WIF'] },
        amount:     { type: 'number', description: 'Amount of from_token (human units)' },
      },
      required: ['from_token', 'to_token', 'amount'],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {

    case 'get_spot_quote': {
      const from    = input.from_token as string;
      const to      = input.to_token   as string;
      const amount  = input.amount     as number;
      const venues  = (input.venues as string[] | undefined) ?? ['titan', '0x'];
      const raw     = toRaw(amount, TOKENS[from]?.decimals ?? 9);
      const results: string[] = [];

      if (venues.includes('titan')) {
        const r = await titanQuote(from, to, raw);
        if (isTitanError(r)) {
          results.push(`Titan DART: ERROR — ${r.error} (${r.latencyMs}ms)`);
        } else {
          results.push(
            `Titan DART: ${fmtHuman(r.outRaw, TOKENS[to].decimals)} ${to} ` +
            `| price ${r.price.toFixed(6)} ${to}/${from} ` +
            `| latency ${r.latencyMs}ms ` +
            `| fee ~1 bps explicit`
          );
        }
      }

      if (venues.includes('0x')) {
        const r = await zeroexQuote(from, to, raw);
        if (!r) {
          results.push('0x Solana: ERROR or no API key set');
        } else {
          results.push(
            `0x Solana: ${fmtHuman(r.outRaw, TOKENS[to].decimals)} ${to} ` +
            `| price ${r.price.toFixed(6)} ${to}/${from} ` +
            `| latency ${r.latencyMs}ms ` +
            `| fee embedded in spread`
          );
        }
      }

      return results.join('\n');
    }

    case 'get_phoenix_market': {
      const symbol = input.symbol as string;
      const m = phoenixMarkets[symbol];
      if (!m) return `No data for ${symbol} yet — Phoenix WS may still be connecting.`;
      const fundingAnnual = m.funding * 24 * 365 * 100;
      return [
        `Phoenix ${symbol}-PERP`,
        `  Mark price   : $${m.markPx.toFixed(4)}`,
        `  Oracle price : $${m.oraclePx.toFixed(4)}`,
        `  Mid price    : $${m.midPx.toFixed(4)}`,
        `  Funding/hr   : ${m.funding >= 0 ? '+' : ''}${(m.funding * 100).toFixed(4)}%  (${m.funding >= 0 ? 'longs pay shorts' : 'shorts pay longs'})`,
        `  Funding APR  : ${m.funding >= 0 ? '+' : ''}${fundingAnnual.toFixed(1)}%`,
        `  Open interest: ${m.openInterest.toLocaleString()} ${symbol}  ($${(m.openInterest * m.markPx / 1e6).toFixed(2)}M)`,
        `  24h volume   : $${(m.dayNtlVlm / 1e6).toFixed(2)}M`,
        `  24h change   : ${m.prevDayPx > 0 ? ((m.markPx - m.prevDayPx) / m.prevDayPx * 100).toFixed(2) : '—'}%`,
      ].join('\n');
    }

    case 'get_phoenix_orderbook': {
      const symbol = input.symbol as string;
      const depth  = Math.min((input.depth as number | undefined) ?? 5, 10);
      const book   = phoenixBooks[symbol];
      if (!book) return `No orderbook for ${symbol} yet.`;

      const asks = [...book.asks].sort((a, b) => a[0] - b[0]).slice(0, depth);
      const bids = [...book.bids].sort((a, b) => b[0] - a[0]).slice(0, depth);
      const mid  = phoenixMarkets[symbol]?.midPx ?? ((asks[0]?.[0] ?? 0 + bids[0]?.[0] ?? 0) / 2);

      const lines = [
        `Phoenix ${symbol}-PERP orderbook (top ${depth} levels)`,
        '',
        ...asks.reverse().map(([px, sz]) => `  ASK  ${px.toFixed(3).padStart(8)}  ${sz.toFixed(2).padStart(10)} ${symbol}  ($${(px * sz / 1000).toFixed(0)}k)`),
        `  ─── MID $${mid.toFixed(3)} ───`,
        ...bids.map(([px, sz]) =>       `  BID  ${px.toFixed(3).padStart(8)}  ${sz.toFixed(2).padStart(10)} ${symbol}  ($${(px * sz / 1000).toFixed(0)}k)`),
      ];
      return lines.join('\n');
    }

    case 'simulate_phoenix_fill': {
      const symbol   = input.symbol    as string;
      const side     = input.side      as 'buy' | 'sell';
      const sizeBase = input.size_base as number;
      const fill     = simulateFill(symbol, side, sizeBase);
      if (!fill) return `No orderbook data for ${symbol}.`;
      return [
        `Phoenix ${symbol}-PERP  ${side.toUpperCase()}  ${sizeBase} ${symbol}`,
        `  Average fill price : $${fill.avgPrice.toFixed(4)}`,
        `  Total quote        : $${fill.totalQuote.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
        `  Levels consumed    : ${fill.levels}`,
        `  Filled             : ${fill.filled.toFixed(4)} ${symbol}`,
        fill.partial ? '  ⚠ WARNING: book too thin — order would be partially filled at these prices' : '  ✓ Full fill at these prices',
      ].join('\n');
    }

    case 'compare_venues': {
      const from   = input.from_token as string;
      const to     = input.to_token   as string;
      const amount = input.amount     as number;
      const raw    = toRaw(amount, TOKENS[from]?.decimals ?? 9);

      const [titanR, zeroexR] = await Promise.all([
        titanQuote(from, to, raw),
        zeroexQuote(from, to, raw),
      ]);

      // for perp: only makes sense for SOL/BTC/ETH vs USDC
      const perpSymbol = ['SOL', 'BTC', 'ETH'].includes(from) ? from : to;
      const perpSide   = ['SOL', 'BTC', 'ETH'].includes(from) ? 'sell' : 'buy';
      const perpFill   = simulateFill(perpSymbol, perpSide, amount);

      const lines: string[] = [`Venue comparison — ${amount} ${from} → ${to}`, ''];
      const prices: Array<{ venue: string; price: number; note: string }> = [];

      if (!isTitanError(titanR)) {
        prices.push({ venue: 'Titan DART (spot)', price: titanR.price, note: `${titanR.latencyMs}ms, ~1bps fee` });
      } else {
        lines.push(`Titan DART: ERROR — ${titanR.error}`);
      }

      if (zeroexR) {
        prices.push({ venue: '0x Solana (spot)', price: zeroexR.price, note: `${zeroexR.latencyMs}ms, fee in spread` });
      } else {
        lines.push('0x Solana: no key or error');
      }

      if (perpFill && perpFill.avgPrice > 0) {
        prices.push({ venue: 'Phoenix perp (L2 fill)', price: perpFill.avgPrice, note: `${perpFill.levels} levels, ${perpFill.partial ? 'partial fill' : 'full fill'}` });
      }

      prices.sort((a, b) => b.price - a.price);
      prices.forEach((p, i) => {
        const rank = ['🥇', '🥈', '🥉'][i] ?? '  ';
        lines.push(`${rank} ${p.venue.padEnd(26)}  price ${p.price.toFixed(6)}  |  ${p.note}`);
      });

      if (prices.length > 1) {
        const best  = prices[0].price;
        const worst = prices[prices.length - 1].price;
        const spread = (best - worst) / worst * 10000;
        lines.push('');
        lines.push(`Spread between best and worst: ${spread.toFixed(1)} bps`);
      }

      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

const SYSTEM = `You are a Solana trading analyst with access to live market data from three venues:

1. **Titan DART** — on-chain spot swap via RFQ. Instant fills, ~1 bps explicit taker fee. Best for token swaps.
2. **0x Solana** — spot swap aggregator. Routes across DEXs, fee embedded in price spread. Needs API key.
3. **Phoenix Perp** — on-chain perpetual futures DEX. You can read the live L2 orderbook and mark/oracle prices.

When the user asks about trading or prices:
- Always call tools to get live data before answering.
- Compare venues when multiple are relevant.
- Explain basis (perp mark vs spot mid), funding rate direction, and price impact clearly.
- Quote in bps whenever comparing prices.
- Be direct and quantitative. No filler.
- If a trade would be large relative to orderbook depth, warn about partial fills.
- You cannot execute trades — you can only quote and simulate.`;

const messages: Anthropic.MessageParam[] = [];

async function chat(userMsg: string): Promise<void> {
  messages.push({ role: 'user', content: userMsg });

  // agentic loop: Claude may call multiple tools in sequence
  while (true) {
    const response = await client.messages.create({
      model:      'claude-opus-4-7',
      max_tokens: 4096,
      system:     SYSTEM,
      tools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    // if no tool calls, we have the final answer
    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');
      console.log('\n' + text + '\n');
      break;
    }

    // process tool calls and feed results back
    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.error(`  → ${block.name}(${JSON.stringify(block.input).slice(0, 80)}…)`);
        const result = await runTool(block.name, block.input as Record<string, unknown>);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }
}

// ── CLI REPL ──────────────────────────────────────────────────────────────────

const C = { reset: '\x1b[0m', cyan: '\x1b[96m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[92m' };

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  process.stdout.write('\x1bc');
  console.log(C.bold + C.cyan + '  TRADING AGENT  ·  Titan × 0x × Phoenix' + C.reset);
  console.log(C.dim  + '  Claude claude-opus-4-7  ·  type your question  ·  Ctrl+C to quit' + C.reset);
  console.log(C.cyan + '  ' + '═'.repeat(70) + C.reset + '\n');
  console.log(C.dim + '  Examples:' + C.reset);
  console.log(C.dim + '    "What\'s the best price to sell 500 SOL right now?"' + C.reset);
  console.log(C.dim + '    "Compare all venues for buying 50 SOL"' + C.reset);
  console.log(C.dim + '    "What is the Phoenix funding rate and what does it mean?"' + C.reset);
  console.log(C.dim + '    "If I sell 200 SOL on Phoenix perp, how deep is the book?"' + C.reset);
  console.log();

  // connect Phoenix WS in background
  connectPhoenix();
  // wait a moment for the WS to populate
  await new Promise(r => setTimeout(r, 1500));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question(C.green + '  you › ' + C.reset, async (line) => {
      const q = line.trim();
      if (!q) { ask(); return; }
      if (q === '/clear') { messages.length = 0; console.log(C.dim + '  [context cleared]\n' + C.reset); ask(); return; }
      if (q === '/quit' || q === '/exit') { disconnectPhoenix(); rl.close(); process.exit(0); }
      try {
        await chat(q);
      } catch (e) {
        console.error('Error:', e);
      }
      ask();
    });
  };

  ask();
}

main();
