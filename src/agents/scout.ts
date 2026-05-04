import type { SeedPhrase, IdiomHistory } from '../types';

/**
 * Returns candidates that have NOT been sent before.
 * Dedupes against both idiom_id and colloquialism_id columns of history.
 */
export function scout(
  allPhrases: SeedPhrase[],
  history: IdiomHistory[],
): { idioms: SeedPhrase[]; colloquialisms: SeedPhrase[] } {
  const sentIds = new Set<string>();
  for (const row of history) {
    sentIds.add(row.idiom_id);
    sentIds.add(row.colloquialism_id);
  }
  const available = allPhrases.filter((p) => !sentIds.has(p.id));
  return {
    idioms:         available.filter((p) => p.type === 'idiom'),
    colloquialisms: available.filter((p) => p.type === 'colloquialism'),
  };
}
