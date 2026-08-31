/**
 * D1 table: `idiom_history` (one row per daily send).
 *
 * Written by the Orchestrator immediately after delivering each day's message.
 * The six meaning/example/region columns are populated by the new generator;
 * old rows will carry NULLs for those fields (added via migration 0002).
 *
 * `user_rating` and `user_feedback` start null; they are populated by the
 * inbound webhook flow when the user replies.
 */
export interface IdiomHistory {
  id: number;
  sent_at: string;
  idiom_id: string;
  idiom_text: string;
  idiom_meaning: string | null;
  idiom_example: string | null;
  idiom_region: string | null;
  colloquialism_id: string;
  colloquialism_text: string;
  colloquialism_meaning: string | null;
  colloquialism_example: string | null;
  colloquialism_region: string | null;
  curator_justification: string;
  user_rating: number | null;  // 1–5 or null
  user_feedback: string | null;
}

/**
 * Shape of one phrase entry in `seed-phrases.json`.
 *
 * The seed file ships 36 hand-curated exemplars. Their role is to show the
 * generator what good looks like — they are never sent directly to the user.
 * Deduplication is text-based (see `src/dedup.ts`), so the `id` field is used
 * only for human reference in the JSON file, not for DB dedup.
 */
export interface SeedPhrase {
  id: string;                              // kebab-case, for human reference only
  text: string;                            // the phrase in Spanish
  type: "idiom" | "colloquialism";
  region: string;                          // "general", "Mexico", "Spain", etc.
  theme: string;                           // "love", "work", "animals", "food", "misc"
}

/**
 * The data required to INSERT one row into `idiom_history`.
 *
 * All eleven fields are required because the generator always produces them.
 * `curator_justification` is repurposed as
 * "idiom: <why_different> | colloquialism: <why_different>" — a one-line
 * record of why each generated phrase was distinct enough to send.
 *
 * Omits `id` (autoincrement), `sent_at` (defaulted by the DB to
 * `datetime('now')`), and the feedback columns (`user_rating`, `user_feedback`)
 * which start null and are written later via the webhook flow.
 */
export interface IdiomHistoryInsert {
  idiom_id: string;               // normalized slug derived from phrase text
  idiom_text: string;
  idiom_meaning: string;
  idiom_example: string;
  idiom_region: string;
  colloquialism_id: string;       // normalized slug derived from phrase text
  colloquialism_text: string;
  colloquialism_meaning: string;
  colloquialism_example: string;
  colloquialism_region: string;
  curator_justification: string;  // "idiom: <why_different> | colloquialism: <why_different>"
}

/**
 * One phrase produced by the Writer generator (forced tool use).
 *
 * All fields are required — the tool schema enforces this at the SDK boundary.
 */
export interface PhraseOutput {
  phrase: string;
  region: string;
  meaning: string;           // one line, English
  example: string;           // natural Spanish sentence
  nearest_existing: string;  // phrase from history closest in meaning
  why_different: string;     // one line on distinctness from nearest_existing
}

/**
 * Structured output of a single `generate` call (forced tool use).
 *
 * One idiom and one colloquialism, each with the full PhraseOutput shape.
 */
export interface WriterOutput {
  idiom: PhraseOutput;
  colloquialism: PhraseOutput;
}

/**
 * Cloudflare Worker bindings injected at runtime.
 *
 * `DB` is the D1 database bound via `[[d1_databases]]` in `wrangler.toml`.
 * All string fields are stored as Wrangler secrets (`wrangler secret put`)
 * and are never read from `process.env`.
 *
 * Telegram is the delivery and feedback channel. The Worker sends daily
 * messages via the Telegram Bot API (`sendMessage`) and receives user replies
 * via a Telegram webhook registered with `setWebhook`.
 */
export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  // Telegram bot token from @BotFather (format: '123456:ABC...').
  // Set with `wrangler secret put TELEGRAM_BOT_TOKEN`.
  TELEGRAM_BOT_TOKEN: string;
  // Numeric chat ID of the owner (as a string). Obtained from @userinfobot.
  // Set with `wrangler secret put TELEGRAM_CHAT_ID`.
  TELEGRAM_CHAT_ID: string;
  // Shared secret passed in X-Telegram-Bot-Api-Secret-Token on inbound webhooks.
  // Generate with `openssl rand -hex 32`. Set with `wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
  TELEGRAM_WEBHOOK_SECRET: string;
  // Shared secret for POST /trigger. The caller must send
  //   Authorization: Bearer <TRIGGER_SECRET>
  // Set with `wrangler secret put TRIGGER_SECRET`.
  TRIGGER_SECRET: string;
  // Password for the web UI at `/`. Compared directly against the submitted
  // login form value. Set with `wrangler secret put WEB_PASSWORD`.
  WEB_PASSWORD: string;
  // HMAC-SHA256 signing key for the session cookie. Used to sign and verify
  // the `session` cookie so the password check cannot be bypassed by forging a
  // cookie. Generate with `openssl rand -hex 32`. Set with
  // `wrangler secret put COOKIE_SECRET`.
  COOKIE_SECRET: string;
}
