# Building a Multi-Venue Solana Trading Agent with Claude

Use Claude as the reasoning brain. Titan DART, 0x, and Phoenix are the tools. You describe what you want in plain language — Claude fetches live data, compares venues, and explains the trade-offs before anything gets signed.

---

## Architecture

```
You (natural language)
       │
       ▼
  Claude (claude-opus-4-7)
       │  tool_use
       ├─────────────────► Titan DART API    (spot RFQ fills)
       ├─────────────────► 0x Solana API     (spot aggregator)
       └─────────────────► Phoenix WebSocket (perp L2 book)
```

Three layers:

1. **The tools** — TypeScript modules that call live APIs (`src/titan.ts`, `src/zeroex.ts`, `src/phoenix.ts`)
2. **The agent loop** — feeds Claude tool results until it reaches a final answer (`src/agent.ts`)
3. **The interface** — CLI REPL, Claude Code CLI, or your own frontend

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/lilaclilac09/dart-watch
cd dart-watch
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

```env
ANTHROPIC_API_KEY=sk-ant-...        # required for the agent
TITAN_API_KEY=your_titan_key        # unlocks all pairs (SOL/USDC works without it)
ZEROEX_API_KEY=your_0x_key          # enables 0x venue in comparisons
WALLET_PUBKEY=your_wallet_pubkey    # for quote routing (no private key)
```

### 3. Run the agent

```bash
npm run agent
```

You'll get an interactive REPL:

```
  TRADING AGENT  ·  Titan × 0x × Phoenix
  claude-opus-4-7  ·  type your question  ·  Ctrl+C to quit
  ═══════════════════════════════════════════════════

  you › What's the best venue to sell 300 SOL right now?
  → compare_venues({"from_token":"SOL","to_token":"USDC","amount":300}…)

  🥇 Titan DART (spot)         price 84.2150  |  412ms, ~1bps fee
  🥈 Phoenix perp (L2 fill)    price 84.1800  |  3 levels, full fill
  🥉 0x Solana (spot)          price 84.1720  |  680ms, fee in spread

  Spread between best and worst: 5.1 bps.

  **Titan DART wins** at 300 SOL. The perp book has enough depth (3 levels,
  ~$25M notional) but the fill price is 3.9 bps worse than Titan's RFQ.
  Phoenix funding is +0.18%/hr (longs paying) — neutral for a spot sell.
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run agent` | Interactive Claude agent — natural language trading queries |
| `npm run panel` | Live terminal dashboard — Titan + Phoenix L2 + simulation |
| `npm run watch` | SOL/USDC price ticker with latency/impact chart |
| `npm run scan` | One-shot scan of all supported pairs |
| `npm run compare` | Titan vs 0x head-to-head table |

---

## Using Claude Code CLI (no code required)

You don't need to run the agent script. Claude Code can read the source files and call the APIs directly inside a session.

Open Claude Code in this repo:

```bash
cd dart-watch
claude
```

Then ask naturally:

```
show me the Phoenix SOL orderbook and simulate selling 500 SOL through it
```

```
run npm run scan and explain which pairs titan supports vs which need a key
```

```
read src/titan.ts and add a ORCA/USDC pair to the test matrix, then run it
```

Claude Code sees all the source files, can run bash commands, and will read results back — no boilerplate needed. The repo structure is designed to be Claude Code-native.

---

## How the Agent Works

The agent in `src/agent.ts` follows the standard tool-use agentic loop:

```
user message
      │
      ▼
  Claude API call
      │
      ├── stop_reason: "end_turn"   → print final answer, done
      │
      └── stop_reason: "tool_use"  → extract tool calls
                │
                ▼
          runTool(name, input)   ← calls live APIs
                │
                ▼
          tool_result → back into messages[] → next Claude call
                                                     │
                                                     └── (repeat until end_turn)
```

### Available tools Claude can call

| Tool | What it does |
|---|---|
| `get_spot_quote` | Calls Titan DART + 0x for a live spot quote |
| `get_phoenix_market` | Returns mark/oracle/mid price, funding, OI |
| `get_phoenix_orderbook` | Returns top N bid/ask levels with size |
| `simulate_phoenix_fill` | Walks the book for a given size, returns avg price |
| `compare_venues` | Runs all three in parallel and ranks by fill price |

### System prompt

The agent's system prompt (`SYSTEM` in `src/agent.ts`) tells Claude:
- What each venue is (spot RFQ vs aggregator vs perp)
- To always call tools before answering
- To quantify everything in bps
- That it can quote and simulate but cannot execute

Customize this for your use case — e.g. add risk limits, preferred venues, or wallet-specific context.

---

## Extending the Agent

### Add a new venue

1. Create `src/yourexchange.ts` with a `quote()` function
2. Add a tool definition to the `tools` array in `src/agent.ts`
3. Handle it in the `runTool()` switch

### Add execution (real trades)

Phoenix returns Solana transaction instructions from `POST /v1/ix/place-isolated-market-order-enhanced`. You'd add a `place_phoenix_order` tool that:
1. Calls the instruction-builder endpoint
2. Assembles a Solana transaction
3. Signs with the user's keypair
4. Submits via `@solana/web3.js` `sendAndConfirmTransaction`

Wire that into the agent and Claude can propose, explain, and execute — with a confirmation gate before signing.

Example tool:

```typescript
{
  name: 'place_phoenix_market_order',
  description: 'Build and return a Phoenix perp market order transaction for user review. Does NOT sign or submit.',
  input_schema: {
    type: 'object',
    properties: {
      symbol:   { type: 'string', enum: ['SOL', 'BTC'] },
      side:     { type: 'string', enum: ['bid', 'ask'] },
      quantity: { type: 'number' },
    },
    required: ['symbol', 'side', 'quantity'],
  },
}
```

### Plug in Claude Code hooks

In your `CLAUDE.md`, add routing rules so Claude Code automatically picks up the tools:

```markdown
## Trading tools

This repo contains live trading API clients. When the user asks about:
- Swap prices / best execution → run `npm run compare` or read `src/agent.ts` tools
- Phoenix perp data → connect to WS via `src/phoenix.ts`
- Running the full panel → `npm run panel`

Always prefer live data over cached. Never simulate without checking the orderbook.
```

---

## Combining with Other Tools

The agent pattern composes with anything else Claude can call. Some useful additions:

### Price alerts (cron + notify)

```typescript
// add a tool: set_alert
{
  name: 'set_alert',
  description: 'Set a price alert. Will notify when Titan spot crosses the threshold.',
  input_schema: { ... threshold, direction: 'above'|'below' ... }
}
```

Implement with `setInterval` polling Titan and a push notification (Telegram bot, ntfy.sh, etc).

### On-chain data (Helius, RPC)

Add a `get_wallet_balances` tool that reads token accounts via Solana RPC. Claude can then factor in your actual holdings when reasoning about trade size.

### Strategy backtests

Pipe historical Titan/Phoenix data into a `run_backtest` tool. Claude can propose a parameter set, run the test, interpret the results, and iterate.

### Multi-agent (OpenClaw / agent SDK)

Use the Anthropic Agent SDK to spawn specialist sub-agents:

```
Orchestrator Claude
├── Spawn: PriceAgent      → monitors Titan/Phoenix prices
├── Spawn: RiskAgent       → checks position limits
└── Spawn: ExecutionAgent  → handles order building
```

Each agent has a focused toolset and reports to the orchestrator. The orchestrator reasons across all three before acting.

---

## Key API Notes

### Titan DART
- Endpoint: `POST https://api.titan.exchange/dart/swap`
- Returns full Solana instructions (ready to sign), not just a quote
- `outputAmount` is the exact amount after ~1 bps fee
- `slippageBps: 0` means no additional slippage allowance
- Without key: SOL/USDC, SOL/USDT, USDC/SOL only

### 0x Solana
- Endpoint: `POST https://api.0x.org/solana/swap-instructions`
- Requires `0x-api-key` header
- Returns `amount_out` — fee is embedded in the price, not explicit
- Aggregates across Jupiter, Raydium, Orca, etc.

### Phoenix Perp
- REST base: `https://perp-api.phoenix.trade`
- WebSocket: `wss://perp-api.phoenix.trade/v1/ws`
- Subscribe: `{ type: 'subscribe', subscription: { channel: 'orderbook', symbol: 'SOL' } }`
- Order building: `POST /v1/ix/place-isolated-market-order-enhanced` — returns Solana instructions
- No auth needed for market data; auth required for trader state
- Not a spot exchange — perp prices will differ from spot by basis + funding

### Anthropic SDK (agent loop)
- `claude-opus-4-7` for best reasoning across tool calls
- Set `max_tokens: 4096` — tool reasoning needs headroom
- Keep `messages[]` in memory for multi-turn context
- `/clear` in the REPL resets context without restarting

---

## File Map

```
dart-watch/
├── src/
│   ├── tokens.ts      — token registry, raw/human converters
│   ├── titan.ts       — Titan DART REST client
│   ├── zeroex.ts      — 0x Solana REST client
│   ├── phoenix.ts     — Phoenix WS client + book simulator
│   ├── agent.ts       — Claude agentic loop + CLI REPL
│   ├── panel.ts       — live terminal dashboard (no Claude)
│   ├── watch.ts       — Titan-only live ticker
│   ├── scan.ts        — one-shot pair scan
│   └── compare.ts     — Titan vs 0x table
├── .env.example
├── GUIDE.md           — this file
└── package.json
```
