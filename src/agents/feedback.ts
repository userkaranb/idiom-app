import Anthropic from '@anthropic-ai/sdk';
import type { Env, FeedbackResult } from '../types';

const PARSE_TOOL: Anthropic.Tool = {
  name: 'parse_feedback',
  description: "Extract structured signals from a user's freeform reply to their daily Spanish message.",
  input_schema: {
    type: 'object' as const,
    properties: {
      sentiment:             { type: 'string', enum: ['positive', 'negative', 'neutral', 'mixed'] },
      wants_more_colloquial: { type: ['boolean', 'null'] },
      wants_more_formal:     { type: ['boolean', 'null'] },
      wants_more_vulgar:     { type: ['boolean', 'null'] },
      wants_less_vulgar:     { type: ['boolean', 'null'] },
      theme_mentions:        { type: 'array', items: { type: 'string' } },
    },
    required: ['sentiment', 'wants_more_colloquial', 'wants_more_formal',
               'wants_more_vulgar', 'wants_less_vulgar', 'theme_mentions'],
  },
};

export async function parseFeedback(env: Env, reply: string): Promise<FeedbackResult> {
  // Build the Anthropic client each call — Workers are stateless.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: `User reply: "${reply}"` }],
    tools: [PARSE_TOOL],
    tool_choice: { type: 'tool', name: 'parse_feedback' },
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'parse_feedback',
  );
  if (!toolBlock) throw new Error('Feedback: expected tool_use block not found');

  return { ...(toolBlock.input as Omit<FeedbackResult, 'raw'>), raw: reply };
}
