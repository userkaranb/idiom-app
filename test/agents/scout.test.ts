import { describe, it, expect } from 'vitest';
import { scout } from '../../src/agents/scout';
import type { SeedPhrase, IdiomHistory } from '../../src/types';

const phrases: SeedPhrase[] = [
  { id: 'idiom-a', text: 'no hay mal que por bien no venga', type: 'idiom',       region: 'general', theme: 'work',    vulgarity_level: 0 },
  { id: 'idiom-b', text: 'a caballo regalado no le mires el diente', type: 'idiom', region: 'Spain',   theme: 'misc',    vulgarity_level: 0 },
  { id: 'coll-a',  text: 'chido',                                     type: 'colloquialism', region: 'Mexico',  theme: 'misc',  vulgarity_level: 0 },
  { id: 'coll-b',  text: 'tío',                                        type: 'colloquialism', region: 'Spain',   theme: 'misc',  vulgarity_level: 0 },
];

function makeHistoryRow(idiomId: string, collId: string): IdiomHistory {
  return {
    id: 1,
    sent_at: '2024-01-01T13:00:00Z',
    idiom_id: idiomId,
    idiom_text: '',
    colloquialism_id: collId,
    colloquialism_text: '',
    curator_justification: '',
    user_rating: null,
    user_feedback: null,
  };
}

describe('scout', () => {
  it('returns all phrases split by type when history is empty', () => {
    const result = scout(phrases, []);
    expect(result.idioms).toHaveLength(2);
    expect(result.colloquialisms).toHaveLength(2);
    expect(result.idioms.every((p) => p.type === 'idiom')).toBe(true);
    expect(result.colloquialisms.every((p) => p.type === 'colloquialism')).toBe(true);
  });

  it('excludes a phrase whose id appears as idiom_id in history', () => {
    const history = [makeHistoryRow('idiom-a', 'coll-z')];
    const result = scout(phrases, history);
    expect(result.idioms.map((p) => p.id)).not.toContain('idiom-a');
    expect(result.idioms).toHaveLength(1);
    expect(result.colloquialisms).toHaveLength(2);
  });

  it('excludes a phrase whose id appears as colloquialism_id in history', () => {
    const history = [makeHistoryRow('idiom-z', 'coll-a')];
    const result = scout(phrases, history);
    expect(result.colloquialisms.map((p) => p.id)).not.toContain('coll-a');
    expect(result.colloquialisms).toHaveLength(1);
    expect(result.idioms).toHaveLength(2);
  });

  it('deduplicates across both idiom_id and colloquialism_id columns', () => {
    const history = [
      makeHistoryRow('idiom-a', 'coll-a'),
      makeHistoryRow('idiom-b', 'coll-b'),
    ];
    const result = scout(phrases, history);
    expect(result.idioms).toHaveLength(0);
    expect(result.colloquialisms).toHaveLength(0);
  });

  it('handles duplicate entries in history without double-counting exclusions', () => {
    const history = [
      makeHistoryRow('idiom-a', 'coll-z'),
      makeHistoryRow('idiom-a', 'coll-z'), // same pair twice
    ];
    const result = scout(phrases, history);
    expect(result.idioms.map((p) => p.id)).not.toContain('idiom-a');
    expect(result.idioms).toHaveLength(1);
  });

  it('returns all phrases when history contains only unknown ids', () => {
    const history = [makeHistoryRow('unknown-1', 'unknown-2')];
    const result = scout(phrases, history);
    expect(result.idioms).toHaveLength(2);
    expect(result.colloquialisms).toHaveLength(2);
  });
});
