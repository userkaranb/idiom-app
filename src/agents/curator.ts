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
    `You MUST select exclusively from the candidate list provided in the user message.\n` +
    `Do not invent, suggest, or return any phrase that is not present in the candidates.\n\n` +
    `User profile:\n` +
    `- Regional preference: ${profile.regional_preference}\n` +
    `- Vulgarity tolerance: ${profile.vulgarity_tolerance} (0=none 3=high)\n` +
    `- Themes: ${profile.themes}\n` +
    `- Common vs obscure: ${profile.common_vs_obscure} (0=very common 10=very obscure)\n` +
    `- Never send again: ${profile.no_list}`;

  const userMessage =
    `Candidate phrases — you MUST choose from this list only:\n${JSON.stringify(candidates, null, 2)}\n\n` +
    `Pick the idiom id from candidates.idioms and the colloquialism id from candidates.colloquialisms\n` +
    `that best fit the user profile. You may not return any id that does not appear in the list above.`;

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

  const verdict = toolBlock.input as CuratorVerdict;

  // Build id → candidate maps for O(1) lookup
  const idiomMap = new Map(candidates.idioms.map((p) => [p.id, p]));
  const collMap  = new Map(candidates.colloquialisms.map((p) => [p.id, p]));

  const matchedIdiom = idiomMap.get(verdict.idiom.id);
  if (!matchedIdiom) {
    throw new Error(
      `Curator: idiom id "${verdict.idiom.id}" is not in the candidate list. ` +
      `Valid ids: ${[...idiomMap.keys()].join(', ')}`,
    );
  }
  const matchedColl = collMap.get(verdict.colloquialism.id);
  if (!matchedColl) {
    throw new Error(
      `Curator: colloquialism id "${verdict.colloquialism.id}" is not in the candidate list. ` +
      `Valid ids: ${[...collMap.keys()].join(', ')}`,
    );
  }

  // Return canonical text from the seed list, not whatever the model echoed
  return {
    idiom:        { id: matchedIdiom.id, text: matchedIdiom.text, justification: verdict.idiom.justification },
    colloquialism: { id: matchedColl.id,  text: matchedColl.text,  justification: verdict.colloquialism.justification },
  };
}
