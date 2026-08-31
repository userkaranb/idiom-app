# PRD: idiom-app

A personal Spanish-immersion app that texts the user one idiom and one colloquialism every day, learns their taste from their replies, and gets better over time. Runs on Cloudflare Workers with D1 as the long-lived state. The product is the daily message + the taste-learning loop, not a Spanish course. Twilio sending is stubbed in v1 so the agent loop can be built and tested without WhatsApp Business API approval; the real send is a follow-up task.

The worker serves a password-gated web UI at `/` (Hono routes, no build step, no external JS or CSS). The page shows the history feed (most-recent first), an ad-hoc send button that calls the same daily flow as the cron, and per-row feedback forms. Delivery is via Telegram (not WhatsApp). Clicking any history card opens a per-phrase chat panel in the right column. The panel is scoped to that row's two phrases and lets the user ask follow-up questions (literal meaning, cultural context, regional usage, etc.). Conversations are ephemeral — they live in browser memory and are lost on refresh or when a different row is clicked. Any message the user typed can be explicitly promoted into that row's stored feedback via a "Save as feedback" button; promotion appends to existing feedback rather than replacing it. No model-generated text ever reaches `user_feedback`.

## What it does

**Daily push.** A Cloudflare Cron Trigger fires the Worker's `scheduled()` handler once a day. The Orchestrator runs end-to-end:

1. Load full idiom history and all verbatim user feedback from D1.
2. Sample ~15 of the 38 seed exemplars as style anchors.
3. One LLM call (forced tool use, `claude-opus-4-5`): generates one idiom + one colloquialism with `phrase`, `region`, `meaning`, `example`, `nearest_existing`, `why_different` for each.
4. Deterministic dedup gate: normalize + fuzzy-match generated phrases against all history texts and seed exemplar texts. On collision, regenerate (up to 3 attempts, naming the collision each time). On retry exhaustion, alert and fail.
5. Assemble Telegram message from returned fields in plain code (region surfaced naturally for non-general phrases).
6. Persist to `idiom_history` with new fields.

Example daily message body (shape, not exact format — Writer subagent decides):

```
Today's two:

1) "El que no llora no mama" (idiom)
   Means: if you don't speak up, you don't get what you want.
   Use: "Pídele un aumento — el que no llora no mama."

2) "Échate pa'cá" (colloquial)
   Means: come over here, c'mere.
   Use: "Oye, échate pa'cá un segundo."
```

**Inbound feedback.** The same Worker exposes a `fetch()` handler at `POST /webhook`. Telegram POSTs there when the user replies to the bot. The handler verifies the secret token header, stores the raw message text verbatim against the most-recent `idiom_history` row, and sends a plain acknowledgement back. The stored feedback is passed to the generator on the next daily run so it can learn the user's taste over time.

**Memory** — two D1 tables, both long-lived:

- `profile` — single-row table holding the user's current taste model: regional preference, themes (love / work / animals / food), common-vs-obscure preference, and a hard "no" list of phrases that bombed. Updated by the Reflector.
- `idiom_history` — one row per sent message: `sent_at`, the idiom + colloquialism that were sent, the Curator's justification, the user's rating if any, and the freeform feedback if any. Scout dedupes against this; Curator uses it as taste input.

D1 persists across worker invocations, code redeploys, and Cloudflare maintenance. The whole point of the flywheel — feedback → profile → better picks — only works because the profile lives forever.

## Constraints

- TypeScript on Cloudflare Workers (web-standard runtime — no `node:*` modules unless behind `nodejs_compat` flag, which we don't need).
- D1 for state. Schema applied via `wrangler d1 execute --file=schema.sql`. Bound to the Worker via `[[d1_databases]]` in `wrangler.toml`.
- Hono for routing both the `fetch()` (webhook) handler and helpers within the `scheduled()` (cron) handler. Hono is first-class on Workers.
- Anthropic SDK — plain `@anthropic-ai/sdk`, **not** the Claude Agent SDK. These subagents are one-shot structured-output calls, not agentic loops over local files. Use forced tool use (`tool_choice: { type: "tool", name: "..." }`) for the Curator's structured verdict.
- Cron schedule declared in `wrangler.toml` under `[triggers] crons = ["0 13 * * *"]` (or similar — exact UTC time configurable). The Worker's `scheduled()` event handler runs the daily flow.
- Secrets (`ANTHROPIC_API_KEY`) stored via `wrangler secret put`, read from `env` in the handler — not from `process.env`.
- Twilio sending is stubbed in v1: the Orchestrator `console.log`s the would-be WhatsApp body. The Twilio swap-in is a follow-up task; this PRD does not include it.

## Acceptance

1. `npm test` exits zero.
2. Triggering the `scheduled()` handler (locally via `wrangler dev --test-scheduled` or in production via the cron) produces one `console.log`'d message body containing one idiom and one colloquialism, each with a meaning and an example usage line, and appends one row to `idiom_history`.
3. Triggering the `scheduled()` handler a second time produces a *different* idiom and colloquialism — Scout dedupes against `idiom_history` and never re-sends a phrase already in history.
4. The `fetch()` handler accepts `POST /webhook` with a fake Twilio-shaped JSON body; the response is `200 OK` and the user's `profile` row is updated according to the Reflector's proposed changes.
5. Tests cover, with a local D1 instance via `wrangler` (no DB mocks): profile update logic, history dedupe, and reply parsing. Tests assert observable behavior — LLM internals are not mocked and not asserted on.
6. The Curator's structured-output schema is enforced via the Anthropic SDK's forced tool use, so a malformed Curator response throws at the SDK boundary rather than being silently parsed by hand.
7. The repo can be deployed to Cloudflare with `wrangler deploy` after a one-time `wrangler login` and a one-time `wrangler d1 create idiom-app` + `wrangler d1 execute idiom-app --file=schema.sql`. After deploy, the production cron fires daily without further intervention.

## Out of scope (v2+)

- Real Twilio sending — the swap-in itself, and any WhatsApp Business API template approval.
- Pairwise A/B picks (sending two candidates and learning from which one the user picked).
- Weekly LLM-as-judge eval pass.
- Multi-tier model routing (cheaper model for Scout, stronger model for Curator).
- Vocab features beyond the daily idiom + colloquialism.
- Any web UI or admin dashboard.
