import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Env, CuratorVerdict } from '../../src/types';

const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { write } from '../../src/agents/writer';

const mockEnv: Env = {
  DB: {} as D1Database,
  ANTHROPIC_API_KEY: 'test-key',
  TWILIO_ACCOUNT_SID: 'AC-test',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_FROM_NUMBER: '+15702184457',
  TWILIO_TO_NUMBER: '+15551234567',
  TRIGGER_SECRET: 'test-trigger-secret',
};

const verdict: CuratorVerdict = {
  idiom:         { id: 'idiom-1', text: 'no hay mal que por bien no venga', justification: 'Matches theme.' },
  colloquialism: { id: 'coll-1',  text: 'chido',                            justification: 'Fits region.' },
};

describe('write', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns the trimmed text from the first text block', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '  Today\'s two phrases:\n1) chido\n  ' }],
    });
    const result = await write(mockEnv, verdict);
    expect(result).toBe("Today's two phrases:\n1) chido");
  });

  it('throws when the response contains no text block', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'x', name: 'something', input: {} }],
    });
    await expect(write(mockEnv, verdict)).rejects.toThrow('Writer');
  });

  it('throws when the response content array is empty', async () => {
    mockCreate.mockResolvedValue({ content: [] });
    await expect(write(mockEnv, verdict)).rejects.toThrow('Writer');
  });

  it('includes both phrase texts in the outgoing message prompt', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'message body' }],
    });
    await write(mockEnv, verdict);
    const callArgs = mockCreate.mock.calls[0][0];
    const userContent: string = callArgs.messages[0].content;
    expect(userContent).toContain(verdict.idiom.text);
    expect(userContent).toContain(verdict.colloquialism.text);
  });
});
