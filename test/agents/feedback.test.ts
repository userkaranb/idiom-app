import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Env } from '../../src/types';

const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { parseFeedback } from '../../src/agents/feedback';

const mockEnv: Env = {
  DB: {} as D1Database,
  ANTHROPIC_API_KEY: 'test-key',
  TWILIO_ACCOUNT_SID: 'AC-test',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_FROM_NUMBER: '+15702184457',
  TWILIO_TO_NUMBER: '+15551234567',
  TRIGGER_SECRET: 'test-trigger-secret',
};

const validParsedInput = {
  sentiment: 'positive' as const,
  wants_more_colloquial: true,
  wants_more_formal: null,
  wants_more_vulgar: null,
  wants_less_vulgar: null,
  theme_mentions: ['food', 'travel'],
};

const validToolUseResponse = {
  content: [
    {
      type: 'tool_use',
      id: 'tool_abc',
      name: 'parse_feedback',
      input: validParsedInput,
    },
  ],
};

describe('parseFeedback', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns a FeedbackResult with structured fields and the raw reply text', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    const replyText = 'loved it, more street slang please';
    const result = await parseFeedback(mockEnv, replyText);
    expect(result.sentiment).toBe('positive');
    expect(result.wants_more_colloquial).toBe(true);
    expect(result.theme_mentions).toEqual(['food', 'travel']);
    expect(result.raw).toBe(replyText);
  });

  it('preserves null fields from the parsed tool input', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    const result = await parseFeedback(mockEnv, 'great!');
    expect(result.wants_more_formal).toBeNull();
    expect(result.wants_more_vulgar).toBeNull();
    expect(result.wants_less_vulgar).toBeNull();
  });

  it('throws when the response contains no parse_feedback tool-use block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hmm' }] });
    await expect(parseFeedback(mockEnv, 'reply')).rejects.toThrow('Feedback');
  });

  it('throws when the response content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [] });
    await expect(parseFeedback(mockEnv, 'reply')).rejects.toThrow('Feedback');
  });

  it('uses forced tool_choice with name parse_feedback', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    await parseFeedback(mockEnv, 'some reply');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'parse_feedback' });
  });
});
