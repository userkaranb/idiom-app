import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Env, SeedPhrase, Profile } from '../../src/types';

// vi.hoisted runs before any imports, so these mocks are available
// inside the vi.mock factory below.
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { curate } from '../../src/agents/curator';

const mockEnv: Env = {
  DB: {} as D1Database,
  ANTHROPIC_API_KEY: 'test-key',
  TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
  TELEGRAM_CHAT_ID: '123456789',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  TRIGGER_SECRET: 'test-trigger-secret',
};

const candidates = {
  idioms: [
    { id: 'idiom-1', text: 'no hay mal que por bien no venga', type: 'idiom' as const, region: 'general', theme: 'work', vulgarity_level: 0 },
  ],
  colloquialisms: [
    { id: 'coll-1', text: 'chido', type: 'colloquialism' as const, region: 'Mexico', theme: 'misc', vulgarity_level: 0 },
  ],
};

const profile: Profile = {
  id: 1,
  regional_preference: 'Mexico',
  vulgarity_tolerance: 1,
  themes: '["work","misc"]',
  common_vs_obscure: 3,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

const validToolUseResponse = {
  content: [
    {
      type: 'tool_use',
      id: 'tool_123',
      name: 'pick_daily_phrases',
      input: {
        idiom:        { id: 'idiom-1', text: 'no hay mal que por bien no venga', justification: 'Matches work theme.' },
        colloquialism: { id: 'coll-1', text: 'chido', justification: 'Common in Mexico.' },
      },
    },
  ],
};

describe('curate', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns a CuratorVerdict shaped from the tool input block', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    const verdict = await curate(mockEnv, candidates, profile);
    expect(verdict.idiom.id).toBe('idiom-1');
    expect(verdict.idiom.text).toBe('no hay mal que por bien no venga');
    expect(verdict.idiom.justification).toMatch(/work/i);
    expect(verdict.colloquialism.id).toBe('coll-1');
    expect(verdict.colloquialism.text).toBe('chido');
  });

  it('throws when the response contains no pick_daily_phrases tool-use block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'some fallback text' }] });
    await expect(curate(mockEnv, candidates, profile)).rejects.toThrow('Curator');
  });

  it('throws when the response content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [] });
    await expect(curate(mockEnv, candidates, profile)).rejects.toThrow('Curator');
  });

  it('uses forced tool_choice with name pick_daily_phrases', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    await curate(mockEnv, candidates, profile);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'pick_daily_phrases' });
  });

  it('throws when the model returns an idiom id not in the candidate list', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use', id: 'tool_x', name: 'pick_daily_phrases',
        input: {
          idiom:        { id: 'hallucinated-idiom', text: 'gato escaldado', justification: 'x' },
          colloquialism: { id: 'coll-1', text: 'chido', justification: 'y' },
        },
      }],
    });
    await expect(curate(mockEnv, candidates, profile)).rejects.toThrow('not in the candidate list');
  });

  it('throws when the model returns a colloquialism id not in the candidate list', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use', id: 'tool_x', name: 'pick_daily_phrases',
        input: {
          idiom:        { id: 'idiom-1', text: 'no hay mal que por bien no venga', justification: 'x' },
          colloquialism: { id: 'me-muero-de-hambre', text: 'me muero de hambre', justification: 'y' },
        },
      }],
    });
    await expect(curate(mockEnv, candidates, profile)).rejects.toThrow('not in the candidate list');
  });

  it('returns candidate text by id even when the model echoes different text', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use', id: 'tool_x', name: 'pick_daily_phrases',
        input: {
          idiom:        { id: 'idiom-1', text: 'WRONG TEXT FROM MODEL', justification: 'x' },
          colloquialism: { id: 'coll-1', text: 'ALSO WRONG', justification: 'y' },
        },
      }],
    });
    const verdict = await curate(mockEnv, candidates, profile);
    expect(verdict.idiom.text).toBe('no hay mal que por bien no venga');
    expect(verdict.colloquialism.text).toBe('chido');
  });
});
