export interface Profile {
  id: number;                  // always 1
  regional_preference: string; // e.g. "general", "Mexico", "Spain", "Caribbean"
  vulgarity_tolerance: number; // 0 = none, 1 = mild, 2 = moderate, 3 = high
  themes: string;              // JSON-serialised string[]: ["love","work","animals","food"]
  common_vs_obscure: number;   // 0 = very common, 10 = very obscure
  no_list: string;             // JSON-serialised string[] of phrase IDs that bombed
  updated_at: string;          // ISO-8601
}

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

export interface SeedPhrase {
  id: string;                              // kebab-case, unique
  text: string;                            // the phrase in Spanish
  type: "idiom" | "colloquialism";
  region: string;                          // "general", "Mexico", "Spain", etc.
  theme: string;                           // "love", "work", "animals", "food", "misc"
  vulgarity_level: number;                 // 0–3
}

export interface CuratorVerdict {
  idiom: { id: string; text: string; justification: string };
  colloquialism: { id: string; text: string; justification: string };
}

export interface FeedbackResult {
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  wants_more_colloquial: boolean | null;
  wants_more_formal: boolean | null;
  wants_more_vulgar: boolean | null;
  wants_less_vulgar: boolean | null;
  theme_mentions: string[];
  raw: string;
}

export interface ReflectorProposal {
  regional_preference?: string;
  vulgarity_tolerance?: number;
  themes?: string[];
  common_vs_obscure?: number;
  no_list_additions?: string[];
}

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
}
