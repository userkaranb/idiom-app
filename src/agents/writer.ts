import Anthropic from '@anthropic-ai/sdk';
import type { Env, SeedPhrase, IdiomHistory, WriterOutput } from '../types';

const GENERATE_TOOL: Anthropic.Tool = {
  name: 'generate_daily_phrases',
  description: "Generate one fresh Spanish idiom and one colloquialism for today's daily message.",
  input_schema: {
    type: 'object' as const,
    properties: {
      idiom: {
        type: 'object',
        properties: {
          phrase:           { type: 'string', description: 'The Spanish idiom, exactly as it would appear in writing.' },
          region:           { type: 'string', description: 'Regional usage: "general", "Puerto Rico", "Spain", "Mexico", "Argentina", "Colombia", etc.' },
          meaning:          { type: 'string', description: 'One-line English meaning.' },
          example:          { type: 'string', description: 'A natural Spanish sentence using the phrase.' },
          nearest_existing: { type: 'string', description: 'The phrase from the already-sent list that is closest in meaning to what you just generated.' },
          why_different:    { type: 'string', description: 'One line explaining why the generated phrase is distinct enough to send.' },
        },
        required: ['phrase', 'region', 'meaning', 'example', 'nearest_existing', 'why_different'],
      },
      colloquialism: {
        type: 'object',
        properties: {
          phrase:           { type: 'string' },
          region:           { type: 'string' },
          meaning:          { type: 'string' },
          example:          { type: 'string' },
          nearest_existing: { type: 'string' },
          why_different:    { type: 'string' },
        },
        required: ['phrase', 'region', 'meaning', 'example', 'nearest_existing', 'why_different'],
      },
    },
    required: ['idiom', 'colloquialism'],
  },
};

export async function generate(
  env: Env,
  seedExemplars: SeedPhrase[],
  history: IdiomHistory[],
  feedbackItems: string[],
  collisionHint?: string,
): Promise<WriterOutput> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const sentPhrases = [
    ...history.map(r => r.idiom_text),
    ...history.map(r => r.colloquialism_text),
  ].filter(Boolean);

  const collisionLine = collisionHint
    ? `\nIMPORTANT: Your previous attempt generated something too close to "${collisionHint}". Do not generate that phrase or anything semantically equivalent.`
    : '';

  const systemPrompt =
    `You are a Spanish-language educator for a native English speaker who wants to learn authentic, living Spanish — not textbook phrases.\n\n` +
    `Your job: generate ONE fresh Spanish idiom and ONE fresh colloquialism that the user has never seen before. ` +
    `Generate phrases you would actually hear from native speakers. Prefer concrete, vivid, usable phrases over abstract ones.\n\n` +
    `Style exemplars (these show you what good looks like — do NOT generate any of these exact phrases, but match their register and authenticity):\n` +
    seedExemplars.map(s => `- "${s.text}" (${s.type}, ${s.region})`).join('\n') +
    `\n\nAlready sent — you must not generate any of these or close variants:\n` +
    (sentPhrases.length > 0 ? sentPhrases.map(p => `- "${p}"`).join('\n') : '(none yet — this is the first message)') +
    collisionLine;

  const feedbackSection = feedbackItems.length > 0
    ? `\n\nUser feedback history (verbatim, most recent last — use this to understand their taste):\n` +
      feedbackItems.map((f, i) => `${i + 1}. "${f}"`).join('\n')
    : '';

  const userMessage =
    `Generate today's idiom and colloquialism.` +
    feedbackSection +
    `\n\nFor each phrase, provide: the phrase itself, its regional usage, a one-line English meaning, a natural example sentence in Spanish, the nearest already-sent phrase in meaning, and why the new phrase is distinct enough to send.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [GENERATE_TOOL],
    tool_choice: { type: 'tool', name: 'generate_daily_phrases' },
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'generate_daily_phrases',
  );
  if (!toolBlock) {
    throw new Error('Generator: expected tool_use block not found in response');
  }

  return toolBlock.input as WriterOutput;
}
