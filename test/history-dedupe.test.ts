/**
 * Integration tests for the idiom_history deduplication logic in scout().
 *
 * scout() is a pure function — no LLM calls, no D1 access — so these tests
 * need no mocks. They verify the three invariants that protect lifetime
 * deduplication: exclusion via idiom_id, exclusion via colloquialism_id, and
 * cross-column accumulation across multiple history rows.
 */
import { describe, it, expect } from 'vitest';
import { scout } from '../src/agents/scout';
import type { SeedPhrase, IdiomHistory } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_PHRASES: SeedPhrase[] = [
  { id: 'idiom-a', text: 'a caballo regalado no le mires el diente', type: 'idiom',         region: 'Spain',   theme: 'misc', vulgarity_level: 0 },
  { id: 'idiom-b', text: 'no hay mal que por bien no venga',          type: 'idiom',         region: 'general', theme: 'work', vulgarity_level: 0 },
  { id: 'coll-a',  text: 'chido',                                     type: 'colloquialism', region: 'Mexico',  theme: 'misc', vulgarity_level: 0 },
  { id: 'coll-b',  text: 'tío',                                       type: 'colloquialism', region: 'Spain',   theme: 'misc', vulgarity_level: 0 },
];

function makeHistoryRow(idiomId: string, colloquialismId: string): IdiomHistory {
  return {
    id: 1,
    sent_at: '2024-01-01T13:00:00Z',
    idiom_id: idiomId,
    idiom_text: '',
    colloquialism_id: colloquialismId,
    colloquialism_text: '',
    curator_justification: '',
    user_rating: null,
    user_feedback: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('idiom_history dedupe', () => {
  it('excludes any phrase whose id matches the idiom_id column of a history row', () => {
    const history = [makeHistoryRow('idiom-a', 'unknown-coll')];
    const result = scout(ALL_PHRASES, history);

    expect(result.idioms.map((p) => p.id)).not.toContain('idiom-a');
    expect(result.idioms).toHaveLength(1); // idiom-b survives
    expect(result.colloquialisms).toHaveLength(2); // colloquialisms unaffected
  });

  it('excludes any phrase whose id matches the colloquialism_id column of a history row', () => {
    const history = [makeHistoryRow('unknown-idiom', 'coll-b')];
    const result = scout(ALL_PHRASES, history);

    expect(result.colloquialisms.map((p) => p.id)).not.toContain('coll-b');
    expect(result.colloquialisms).toHaveLength(1); // coll-a survives
    expect(result.idioms).toHaveLength(2); // idioms unaffected
  });

  it('dedupes against both columns simultaneously from a single history row', () => {
    const history = [makeHistoryRow('idiom-b', 'coll-a')];
    const result = scout(ALL_PHRASES, history);

    expect(result.idioms.map((p) => p.id)).not.toContain('idiom-b');
    expect(result.colloquialisms.map((p) => p.id)).not.toContain('coll-a');
    expect(result.idioms).toHaveLength(1);      // idiom-a survives
    expect(result.colloquialisms).toHaveLength(1); // coll-b survives
  });

  it('accumulates exclusions across multiple history rows until the pool is exhausted', () => {
    const history = [
      makeHistoryRow('idiom-a', 'coll-a'),
      makeHistoryRow('idiom-b', 'coll-b'),
    ];
    const result = scout(ALL_PHRASES, history);

    expect(result.idioms).toHaveLength(0);
    expect(result.colloquialisms).toHaveLength(0);
  });

  it('is idempotent when the same ids appear in multiple history rows', () => {
    // Sending the same pair twice should exclude those ids exactly once,
    // not remove additional phrases due to double-counting.
    const history = [
      makeHistoryRow('idiom-a', 'coll-a'),
      makeHistoryRow('idiom-a', 'coll-a'), // duplicate
    ];
    const result = scout(ALL_PHRASES, history);

    expect(result.idioms).toHaveLength(1);        // idiom-b survives
    expect(result.colloquialisms).toHaveLength(1); // coll-b survives
  });
});
