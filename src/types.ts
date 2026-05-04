/**
 * D1 table: `profile` (always one row, id = 1).
 *
 * Holds the user's long-lived taste model. The Reflector agent proposes
 * mutations to this row after every inbound feedback message; the Curator
 * reads it each morning when picking the day's phrases.
 *
 * `themes` and `no_list` are stored as JSON-serialised strings because D1
 * does not have a native array type.
 */
export interface Profile {
  id: number;                  // always 1
  regional_preference: string; // e.g. "general", "Mexico", "Spain", "Caribbean"
  vulgarity_tolerance: number; // 0 = none, 1 = mild, 2 = moderate, 3 = high
  themes: string;              // JSON-serialised string[]: ["love","work","animals","food"]
  common_vs_obscure: number;   // 0 = very common, 10 = very obscure
  no_list: string;             // JSON-serialised string[] of phrase IDs that bombed
  updated_at: string;          // ISO-8601
}

/**
 * D1 table: `idiom_history` (one row per daily send).
 *
 * Written by the Orchestrator immediately after composing each day's message.
 * Scout reads this table to deduplicate — it never suggests a phrase whose id
 * already appears in history. The Curator also reads recent rows to understand
 * what the user has already seen and how they rated it.
 *
 * `user_rating` and `user_feedback` start null and are filled in by the
 * webhook handler when the user replies.
 */
export interface IdiomHistory {
  id: number;
  sent_at: string;
  idiom_id: string;
  idiom_text: string;
  colloquialism_id: string;
  colloquialism_text: string;
  curator_justification: string;
  user_rating: number | null;  // 1–5 or null
  user_feedback: string | null;
}

/**
 * One entry in `seed-phrases.json` — the curated in-repo phrase library.
 *
 * This is NOT a D1 table. It is a static JSON file shipped with the repo that
 * Scout loads at runtime as its candidate pool. Scout filters this list against
 * `idiom_history` (to exclude already-sent phrases) and against `Profile`
 * (region, theme, vulgarity) before handing candidates to the Curator.
 */
export interface SeedPhrase {
  id: string;                              // kebab-case, unique
  text: string;                            // the phrase in Spanish
  type: "idiom" | "colloquialism";
  region: string;                          // "general", "Mexico", "Spain", etc.
  theme: string;                           // "love", "work", "animals", "food", "misc"
  vulgarity_level: number;                 // 0–3
}

/**
 * Structured output returned by the Curator AI agent (forced tool use).
 *
 * The Curator receives a filtered candidate list from Scout and the user's
 * current Profile, then picks exactly one idiom and one colloquialism.
 * Each pick includes the phrase's seed-list id and text so the Orchestrator
 * can write them straight into `idiom_history` without a second lookup.
 *
 * The Anthropic SDK enforces this shape at the call boundary via
 * `tool_choice: { type: "tool", name: "..." }` — a malformed response throws
 * rather than being silently swallowed.
 */
export interface CuratorVerdict {
  idiom: { id: string; text: string; justification: string };
  colloquialism: { id: string; text: string; justification: string };
}

/**
 * Structured output returned by the Feedback AI agent.
 *
 * When the user replies on WhatsApp (or via the fake webhook in v1), the
 * Feedback agent parses their freeform text into this typed result.
 *
 * This is a *transient analysis value*, not a stored entity — it is not
 * persisted to D1. The webhook handler already holds a reference to the
 * relevant `IdiomHistory` row and writes `user_rating` / `user_feedback`
 * directly to that row. `FeedbackResult` then flows into the Reflector, which
 * proposes `Profile` updates based on the extracted sentiment and preferences.
 * Tying an explicit `idiom_history_id` here would be redundant: every caller
 * has that id in scope and passes it to the DB update separately.
 */
export interface FeedbackResult {
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  wants_more_colloquial: boolean | null;
  wants_more_formal: boolean | null;
  wants_more_vulgar: boolean | null;
  wants_less_vulgar: boolean | null;
  theme_mentions: string[];
  raw: string;
}

/**
 * Structured output returned by the Reflector AI agent.
 *
 * After the Feedback agent parses a user reply, the Reflector decides which
 * `Profile` fields to mutate and by how much. All fields are optional — the
 * Reflector only proposes changes it has evidence for; unset fields are left
 * untouched in D1.
 */
export interface ReflectorProposal {
  regional_preference?: string;
  vulgarity_tolerance?: number;
  themes?: string[];
  common_vs_obscure?: number;
  no_list_additions?: string[];
}

/**
 * Cloudflare Worker bindings injected at runtime.
 *
 * `DB` is the D1 database bound via `[[d1_databases]]` in `wrangler.toml`.
 * `ANTHROPIC_API_KEY` is stored as a Wrangler secret (`wrangler secret put`)
 * and is never read from `process.env`.
 */
export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
}
