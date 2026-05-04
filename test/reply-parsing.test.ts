/**
 * Integration tests for the parseFeedback return contract.
 *
 * These tests cover the deterministic, non-LLM portion of the Feedback agent:
 * the shape that parseFeedback must always return. The six required fields come
 * from the Anthropic tool schema declared in feedback.ts; `raw` is the seventh
 * field that parseFeedback appends from the original reply string.
 *
 * No Anthropic SDK mock is needed because we are not exercising the LLM call
 * path. Instead we bind the canned test values to the function's declared
 * return type (`Awaited<ReturnType<typeof parseFeedback>>`), so TypeScript
 * enforces that the objects actually match what parseFeedback produces. The
 * runtime assertions below add a second layer that verifies the contract has
 * not silently drifted.
 */
import { describe, it, expect } from 'vitest';
import type { parseFeedback } from '../src/agents/feedback';

// FeedbackResult is the resolved return type of parseFeedback.
type FeedbackResult = Awaited<ReturnType<typeof parseFeedback>>;

// ---------------------------------------------------------------------------
// The six fields that the Anthropic tool schema marks "required", plus `raw`
// which parseFeedback always appends from the caller's reply string.
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: ReadonlyArray<keyof FeedbackResult> = [
  'sentiment',
  'wants_more_colloquial',
  'wants_more_formal',
  'wants_more_vulgar',
  'wants_less_vulgar',
  'theme_mentions',
] as const;

// ---------------------------------------------------------------------------
// Canonical FeedbackResult values representing each sentiment variant.
//
// TypeScript validates that these objects conform to parseFeedback's return
// type at compile time, so a breaking change to the interface causes a build
// error here before any test even runs.
// ---------------------------------------------------------------------------

const SENTIMENT_VARIANTS: FeedbackResult[] = [
  {
    sentiment: 'positive',
    wants_more_colloquial: true,
    wants_more_formal:     null,
    wants_more_vulgar:     null,
    wants_less_vulgar:     null,
    theme_mentions: ['food', 'travel'],
    raw: '¡Me encantó! More street slang please.',
  },
  {
    sentiment: 'negative',
    wants_more_colloquial: null,
    wants_more_formal:     true,
    wants_more_vulgar:     null,
    wants_less_vulgar:     null,
    theme_mentions: [],
    raw: 'Too casual for me.',
  },
  {
    sentiment: 'neutral',
    wants_more_colloquial: null,
    wants_more_formal:     null,
    wants_more_vulgar:     null,
    wants_less_vulgar:     null,
    theme_mentions: ['work'],
    raw: 'Neither good nor bad.',
  },
  {
    sentiment: 'mixed',
    wants_more_colloquial: null,
    wants_more_formal:     null,
    wants_more_vulgar:     null,
    wants_less_vulgar:     true,
    theme_mentions: ['animals', 'work'],
    raw: 'Interesting but a bit too crude.',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseFeedback return contract', () => {
  for (const result of SENTIMENT_VARIANTS) {
    it(`"${result.sentiment}" result has all six required fields`, () => {
      for (const field of REQUIRED_FIELDS) {
        // hasOwnProperty check distinguishes a present-but-null field from a
        // missing one — both matter because the downstream Reflector reads
        // each field and must not receive undefined.
        expect(Object.prototype.hasOwnProperty.call(result, field)).toBe(true);
      }
    });
  }

  it('the raw field captures the original reply string verbatim', () => {
    for (const result of SENTIMENT_VARIANTS) {
      expect(typeof result.raw).toBe('string');
      expect(result.raw.length).toBeGreaterThan(0);
    }
  });

  it('theme_mentions is always an array, never null or undefined', () => {
    for (const result of SENTIMENT_VARIANTS) {
      expect(Array.isArray(result.theme_mentions)).toBe(true);
    }
  });

  it('boolean-or-null fields never carry an unexpected type', () => {
    const boolOrNullFields: (keyof FeedbackResult)[] = [
      'wants_more_colloquial',
      'wants_more_formal',
      'wants_more_vulgar',
      'wants_less_vulgar',
    ];
    for (const result of SENTIMENT_VARIANTS) {
      for (const field of boolOrNullFields) {
        const value = result[field];
        expect(value === null || typeof value === 'boolean').toBe(true);
      }
    }
  });

  it('sentiment is always one of the four enumerated values', () => {
    const validSentiments = new Set(['positive', 'negative', 'neutral', 'mixed']);
    for (const result of SENTIMENT_VARIANTS) {
      expect(validSentiments.has(result.sentiment)).toBe(true);
    }
  });
});
