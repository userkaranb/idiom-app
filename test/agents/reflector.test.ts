import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Env, Profile, FeedbackResult } from '../../src/types';

const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { reflect } from '../../src/agents/reflector';

const mockEnv: Env = {
  DB: {} as D1Database,
  ANTHROPIC_API_KEY: 'test-key',
  TWILIO_ACCOUNT_SID: 'AC-test',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_FROM_NUMBER: 'whatsapp:+14155238886',
  TWILIO_TO_NUMBER: 'whatsapp:+15551234567',
};

const profile: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 0,
  themes: '["work","food"]',
  common_vs_obscure: 2,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

const feedback: FeedbackResult = {
  sentiment: 'positive',
  wants_more_colloquial: true,
  wants_more_formal: null,
  wants_more_vulgar: null,
  wants_less_vulgar: null,
  theme_mentions: ['animals'],
  raw: 'loved it! more animal idioms please',
};

const validToolUseResponse = {
  content: [
    {
      type: 'tool_use',
      id: 'tool_xyz',
      name: 'propose_profile_update',
      input: {
        themes: ['work', 'food', 'animals'],
        common_vs_obscure: 3,
      },
    },
  ],
};

describe('reflect', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns a ReflectorProposal shaped from the tool input block', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    const proposal = await reflect(mockEnv, profile, feedback);
    expect(proposal.themes).toEqual(['work', 'food', 'animals']);
    expect(proposal.common_vs_obscure).toBe(3);
  });

  it('accepts a proposal that only updates a subset of profile fields', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tool_xyz',
          name: 'propose_profile_update',
          input: { vulgarity_tolerance: 1 },
        },
      ],
    });
    const proposal = await reflect(mockEnv, profile, feedback);
    expect(proposal.vulgarity_tolerance).toBe(1);
    expect(proposal.themes).toBeUndefined();
  });

  it('throws when the response contains no propose_profile_update tool-use block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'consider this' }] });
    await expect(reflect(mockEnv, profile, feedback)).rejects.toThrow('Reflector');
  });

  it('throws when the response content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [] });
    await expect(reflect(mockEnv, profile, feedback)).rejects.toThrow('Reflector');
  });

  it('uses forced tool_choice with name propose_profile_update', async () => {
    mockCreate.mockResolvedValue(validToolUseResponse);
    await reflect(mockEnv, profile, feedback);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'propose_profile_update' });
  });
});
