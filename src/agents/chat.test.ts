/**
 * Unit tests for the pure stripMarkdownEmphasis helper exported from chat.ts.
 *
 * The Anthropic SDK import in chat.ts uses node:fs internals that are not
 * available in the Cloudflare Workers V8 sandbox. The vi.mock below prevents
 * the SDK from loading so we can test the pure function in isolation — there
 * is no Anthropic API call involved in these tests.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}));

import { stripMarkdownEmphasis } from './chat';

describe('stripMarkdownEmphasis', () => {
  it('removes ** bold markers', () => {
    expect(stripMarkdownEmphasis('Say **hola** to start')).toBe('Say hola to start');
  });

  it('removes * italic markers', () => {
    expect(stripMarkdownEmphasis('This is *important*')).toBe('This is important');
  });

  it('removes inline backticks', () => {
    expect(stripMarkdownEmphasis('Use `ser` not `estar`')).toBe('Use ser not estar');
  });

  it('preserves newlines (does not collapse paragraphs)', () => {
    expect(stripMarkdownEmphasis('Line one.\n\nLine two.')).toBe('Line one.\n\nLine two.');
  });

  it('trims leading and trailing whitespace', () => {
    expect(stripMarkdownEmphasis('  hello  ')).toBe('hello');
  });

  it('is a no-op on plain text', () => {
    expect(stripMarkdownEmphasis('¡Hola! Great phrase.')).toBe('¡Hola! Great phrase.');
  });
});
