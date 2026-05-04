import Anthropic from '@anthropic-ai/sdk';
import type { Env, CuratorVerdict } from '../types';

export async function write(env: Env, verdict: CuratorVerdict): Promise<string> {
  // Build the Anthropic client each call — Workers are stateless.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system:
      'You write concise Spanish-learning messages for a native-English speaker. ' +
      'For each phrase given, provide: the phrase, a one-line meaning in English, ' +
      'and one natural example sentence in Spanish. Be warm and brief.',
    messages: [
      {
        role: 'user',
        content:
          `Write today's daily message for these two phrases:\n` +
          `Idiom: "${verdict.idiom.text}"\n` +
          `Colloquialism: "${verdict.colloquialism.text}"`,
      },
    ],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) throw new Error('Writer: no text block in response');
  return textBlock.text.trim();
}
