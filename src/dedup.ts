/**
 * Text-based deduplication utilities.
 *
 * Normalises Spanish phrases to ASCII lowercase and computes edit distance so
 * near-exact matches (accent variants, minor word order changes) are caught
 * even when strict string equality fails.
 */

export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip combining diacritics (accents)
    .replace(/[^\w\s]/g, ' ')         // replace punctuation with space
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns the first entry in `sentTexts` that collides with `generated`,
 * or null if no collision is found.
 *
 * A collision is defined as: normalized edit distance <= threshold.
 * Default threshold of 3 catches exact matches and trivial variants
 * (e.g. "echar un vistazo" vs "echarle un vistazo").
 */
export function findCollision(
  generated: string,
  sentTexts: string[],
  threshold = 3,
): string | null {
  const normGenerated = normalizePhrase(generated);
  for (const sent of sentTexts) {
    if (!sent) continue;
    const normSent = normalizePhrase(sent);
    if (levenshtein(normGenerated, normSent) <= threshold) {
      return sent;
    }
  }
  return null;
}
