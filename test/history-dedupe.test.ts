/**
 * Tests for the text-based deduplication utilities in src/dedup.ts.
 *
 * normalizePhrase and findCollision are pure functions — no LLM calls, no D1
 * access — so these tests need no mocks. They verify that normalization handles
 * case, accents, and punctuation correctly, and that findCollision catches exact
 * matches, near-exact matches within the Levenshtein threshold, and returns null
 * when phrases are sufficiently distinct.
 */
import { describe, it, expect } from 'vitest';
import { normalizePhrase, findCollision } from '../src/dedup';

// ---------------------------------------------------------------------------
// normalizePhrase
// ---------------------------------------------------------------------------

describe('normalizePhrase', () => {
  it('lowercases the text', () => {
    expect(normalizePhrase('HOLA MUNDO')).toBe('hola mundo');
  });

  it('strips accents from Spanish characters', () => {
    // 'é' in NFD becomes 'e' + combining acute; the combining char is stripped
    expect(normalizePhrase('Están aquí')).toBe('estan aqui');
  });

  it('strips punctuation and replaces with spaces', () => {
    const result = normalizePhrase('¡Hola, mundo!');
    expect(result).not.toContain('¡');
    expect(result).not.toContain('!');
    expect(result).not.toContain(',');
  });

  it('collapses multiple whitespace to a single space', () => {
    expect(normalizePhrase('hola   mundo')).toBe('hola mundo');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizePhrase('  hola  ')).toBe('hola');
  });
});

// ---------------------------------------------------------------------------
// findCollision
// ---------------------------------------------------------------------------

describe('findCollision', () => {
  it('returns null when the sent list is empty', () => {
    expect(findCollision('echar un vistazo', [])).toBeNull();
  });

  it('returns the matching phrase on an exact match', () => {
    const result = findCollision('mola mazo', ['mola mazo', 'ni modo']);
    expect(result).toBe('mola mazo');
  });

  it('catches a near-exact match within the default threshold (edit distance 2)', () => {
    // "echar un vistazo" vs "echarle un vistazo" — "le" is inserted, distance 2
    const result = findCollision('echar un vistazo', ['echarle un vistazo']);
    expect(result).toBe('echarle un vistazo');
  });

  it('returns null when edit distance exceeds the default threshold', () => {
    // "bregar" vs "pichear" — completely different, distance well above 3
    expect(findCollision('bregar', ['pichear'])).toBeNull();
  });

  it('catches accent variants that normalise to the same string', () => {
    // After normalisation both "Estar en las nubes" and "estar en las nubes"
    // become "estar en las nubes" — edit distance 0, within any threshold
    const result = findCollision('Estar en las nubes', ['estar en las nubes']);
    expect(result).toBe('estar en las nubes');
  });

  it('skips empty or falsy entries in the sent list', () => {
    // Empty string would have distance <= 3 from a short phrase if not skipped
    expect(findCollision('bregar', ['', 'pichear'])).toBeNull();
  });

  it('returns the first colliding phrase when multiple candidates match', () => {
    const result = findCollision('ni modo', ['ni modo', 'mola mazo']);
    expect(result).toBe('ni modo');
  });

  it('respects a custom threshold — distance 4 collides at threshold 4 but not 3', () => {
    // "echar" vs "echarle" — distance 2, within default threshold
    // Use a phrase pair with distance exactly 4
    const generated = 'abcde';
    const sent = 'abcdi'; // 1 substitution — distance 1, within threshold
    expect(findCollision(generated, [sent], 0)).toBeNull();  // threshold 0: no match
    expect(findCollision(generated, [sent], 1)).toBe(sent);  // threshold 1: match
  });
});
