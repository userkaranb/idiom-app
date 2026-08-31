import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Env, SeedPhrase, IdiomHistory, WriterOutput } from '../../src/types';

const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { generate } from '../../src/agents/writer';

const mockEnv: Env = {
  DB: {} as D1Database,
  ANTHROPIC_API_KEY: 'test-key',
  TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
  TELEGRAM_CHAT_ID: '123456789',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  TRIGGER_SECRET: 'test-trigger-secret',
  WEB_PASSWORD: 'test-password',
  COOKIE_SECRET: 'test-cookie-secret',
};

const mockExemplars: SeedPhrase[] = [
  { id: 'idiom-a', text: 'Meter la pata', type: 'idiom', region: 'general', theme: 'misc' },
  { id: 'coll-a', text: 'Ni modo', type: 'colloquialism', region: 'Mexico', theme: 'misc' },
];

const mockHistory: IdiomHistory[] = [];

const mockToolOutput: WriterOutput = {
  idiom: {
    phrase: 'ponerse las pilas',
    region: 'general',
    meaning: 'to get your act together',
    example: 'Tienes que ponerte las pilas antes del examen.',
    nearest_existing: 'none',
    why_different: 'Focuses on diligence, not mishaps.',
  },
  colloquialism: {
    phrase: 'bregar',
    region: 'Puerto Rico',
    meaning: 'to deal with / to handle',
    example: 'Tengo que bregar con eso mañana.',
    nearest_existing: 'none',
    why_different: 'Puerto Rican-specific meaning, not found elsewhere.',
  },
};

function buildToolResponse(input: WriterOutput) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'generate_daily_phrases',
        input,
      },
    ],
  };
}

describe('generate', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('uses the claude-opus-4-5 model', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    await generate(mockEnv, mockExemplars, mockHistory, []);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-opus-4-5');
  });

  it('forces tool use with generate_daily_phrases', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    await generate(mockEnv, mockExemplars, mockHistory, []);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'generate_daily_phrases' });
  });

  it('returns the tool block input as WriterOutput', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    const result = await generate(mockEnv, mockExemplars, mockHistory, []);

    expect(result).toEqual(mockToolOutput);
  });

  it('throws when no tool_use block is found in the response', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'unexpected text' }] });

    await expect(generate(mockEnv, mockExemplars, mockHistory, [])).rejects.toThrow('Generator');
  });

  it('throws when the response content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [] });

    await expect(generate(mockEnv, mockExemplars, mockHistory, [])).rejects.toThrow('Generator');
  });

  it('includes exemplar texts in the system prompt', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    await generate(mockEnv, mockExemplars, mockHistory, []);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain('Meter la pata');
    expect(callArgs.system).toContain('Ni modo');
  });

  it('includes collisionHint in the system prompt when provided', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    await generate(mockEnv, mockExemplars, mockHistory, [], 'echarle un vistazo');

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain('echarle un vistazo');
    expect(callArgs.system).toContain('IMPORTANT');
  });

  it('includes feedback items in the user message when provided', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    await generate(mockEnv, mockExemplars, mockHistory, ['loved it!', 'more Puerto Rico please']);

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content as string;
    expect(userMessage).toContain('loved it!');
    expect(userMessage).toContain('more Puerto Rico please');
  });

  it('omits the feedback section when no feedback items are provided', async () => {
    mockCreate.mockResolvedValue(buildToolResponse(mockToolOutput));
    await generate(mockEnv, mockExemplars, mockHistory, []);

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content as string;
    expect(userMessage).not.toContain('feedback history');
  });
});
