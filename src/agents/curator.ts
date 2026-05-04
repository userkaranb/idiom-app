import Anthropic from '@anthropic-ai/sdk';
import type { Env, SeedPhrase, Profile, CuratorVerdict } from '../types';

const PICK_TOOL: Anthropic.Tool = {
  name: 'pick_daily_phrases',
  description: "Pick one idiom and one colloquialism for today's daily message.",
  input_schema: {
    type: 'object' as const,
    properties: {
      idiom: {
        type: 'object',
        properties: {
          id:            { type: 'string' },
          text:          { type: 'string' },
          justification: { type: 'string', description: "One sentence explaining this pick in terms of the user's profile." },
        },
        required: ['id', 'text', 'justification'],
      },
      colloquialism: {
        type: 'object',
        properties: {
          id:            { type: 'string' },
          text:          { type: 'string' },
          justification: { type: 'string', description: "One sentence explaining this pick in terms of the user's profile." },
        },
        required: ['id', 'text', 'justification'],
      },
    },
    required: ['idiom', 'colloquialism'],
  },
};

export async function curate(
  env: Env,
  candidates: { idioms: SeedPhrase[]; colloquialisms: SeedPhrase[] },
  profile: Profile,
): Promise<CuratorVerdict> {
  // Build the Anthropic client each call — Workers are stateless.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const systemPrompt =
    `You are a Spanish-language curator. Your job is to select one idiom and one colloquialism\n` +
    `that best match the user's taste profile.\n\n` +
    `The candidates list is inspiration — you may use a candidate directly or propose a different\n` +
    `phrase entirely if you know one that fits the profile better. The only constraint is that the\n` +
    `chosen phrase must not appear in the "Never send again" list below.\n\n` +
    `User profile:\n` +
    `- Regional preference: ${profile.regional_preference}\n` +
    `- Vulgarity tolerance: ${profile.vulgarity_tolerance} (0=none 3=high)\n` +
    `- Themes: ${profile.themes}\n` +
    `- Common vs obscure: ${profile.common_vs_obscure} (0=very common 10=very obscure)\n` +
    `- Never send again: ${profile.no_list}`;

  const userMessage =
    `Candidate phrases (for inspiration — not the only options):\n${JSON.stringify(candidates, null, 2)}\n\n` +
    `Pick one idiom and one colloquialism. You may select from the candidates or choose any other\n` +
    `appropriate Spanish phrase not already in the "Never send again" list.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [PICK_TOOL],
    tool_choice: { type: 'tool', name: 'pick_daily_phrases' },
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'pick_daily_phrases',
  );
  if (!toolBlock) {
    throw new Error('Curator: expected tool_use block not found in response');
  }

  return toolBlock.input as CuratorVerdict;
}
