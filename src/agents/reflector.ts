import Anthropic from '@anthropic-ai/sdk';
import type { Env, Profile, FeedbackResult, ReflectorProposal } from '../types';

const REFLECT_TOOL: Anthropic.Tool = {
  name: 'propose_profile_update',
  description: 'Propose changes to the user taste profile based on their feedback.',
  input_schema: {
    type: 'object' as const,
    properties: {
      regional_preference: { type: 'string' },
      vulgarity_tolerance: { type: 'number' },
      themes:              { type: 'array', items: { type: 'string' } },
      common_vs_obscure:   { type: 'number' },
      no_list_additions:   { type: 'array', items: { type: 'string' } },
    },
    required: [],
  },
};

export async function reflect(
  env: Env,
  profile: Profile,
  feedback: FeedbackResult,
): Promise<ReflectorProposal> {
  // Build the Anthropic client each call — Workers are stateless.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system:
      'You update a Spanish-learning taste profile based on user feedback. ' +
      'Only propose changes that the feedback clearly supports. ' +
      'Omit fields that should not change.',
    messages: [
      {
        role: 'user',
        content:
          `Current profile: ${JSON.stringify(profile)}\n` +
          `Feedback signals: ${JSON.stringify(feedback)}\n` +
          'Propose profile updates.',
      },
    ],
    tools: [REFLECT_TOOL],
    tool_choice: { type: 'tool', name: 'propose_profile_update' },
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_profile_update',
  );
  if (!toolBlock) throw new Error('Reflector: expected tool_use block not found');

  return toolBlock.input as ReflectorProposal;
}
