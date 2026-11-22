# Acceptance audit — 2026-11-22

Checked PR #1 and the CLI guide against [ACCEPTANCE.md](../ACCEPTANCE.md). The merged PR that added the acceptance workflow passes its own evidence check.

| # | Failing item | Source rule | Resolution |
|---|---|---|---|
| 1 | GUIDE.md did not state status or next action | §5, `ship-visible-mvp.mdc` — “LIVE / BLOCKED / LOCAL ONLY + next human action” | Added the local-only CLI launch line. |
| 2 | TypeScript rejected the order-book fallback; ask/bid 102/98 produced 51 instead of the midpoint of 100 | §2, `verification.mdc` — test the specific flow and point to artifacts | Parenthesized both operands before averaging; typecheck and focused regression verified locally. |

**Checks:** `npx --no-install tsc --noEmit` (exit 0 after fix); focused Node midpoint regression printed `Midpoint regression: 102/98 → 100; published midpoint 101 takes precedence`.

**Manual QA:** No browser UI; checked the local fallback output with fixed bid/ask inputs. No authenticated vendor interaction or quote execution.

**Limitations:** The CLI’s full live flow was not checked without configured vendor credentials.

| blocked_on | evidence | impact | human_action | not_doing |
|---|---|---|---|---|
| Anthropic credential for the CLI | `npm run agent` exited 1 with `Missing ANTHROPIC_API_KEY in .env` | degraded — the local midpoint regression ran; the authenticated CLI did not start | Configure the Anthropic key in a local `.env` per `GUIDE.md` | Do not use a dummy key or present the midpoint regression as authenticated QA |

**Status: LOCAL ONLY** — configure the keys in GUIDE.md and run `npm run agent`.
