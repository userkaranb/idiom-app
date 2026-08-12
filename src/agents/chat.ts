import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../types';

/**
 * Sends a multi-turn conversation to Claude Haiku and returns the assistant's
 * reply text.
 *
 * This is a plain chat call — no forced tool use, no streaming. The caller
 * supplies the full system prompt and message history; this module owns only
 * the Anthropic API boundary and the model choice.
 *
 * Model: claude-haiku-4-5 — fast and cheap for conversational follow-ups.
 * The daily generation that requires deeper reasoning uses claude-opus-4-5.
 */
export async function chat(
  env: Env,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );
  if (!textBlock) {
    throw new Error('Chat agent: expected text content block in response');
  }
  return textBlock.text;
}
