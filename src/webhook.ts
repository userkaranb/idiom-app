import { Context } from 'hono';
import type { Env } from './types';
import type { Repos } from './db';
import { parseFeedback } from './agents/feedback';
import { reflect } from './agents/reflector';

/**
 * Handles an inbound Telegram webhook update (POST /webhook).
 *
 * Telegram calls this endpoint for every message sent to the bot. The handler:
 *   1. Verifies the X-Telegram-Bot-Api-Secret-Token header against TELEGRAM_WEBHOOK_SECRET.
 *   2. Confirms the message is from the configured owner chat (TELEGRAM_CHAT_ID).
 *   3. Skips non-text messages (stickers, images, etc.) with a 200 ack so Telegram
 *      stops retrying — erroring on these would trigger Telegram's retry loop.
 *   4. Runs the Feedback → Reflector pipeline and writes results to D1.
 */
export async function handleTelegramWebhook(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
  const incomingSecret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (incomingSecret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('Forbidden', 403);
  }

  const body = await c.req.json<{
    update_id: number;
    message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      date: number;
      text?: string;
    };
  }>();

  const message = body.message;

  if (!message || String(message.chat.id) !== c.env.TELEGRAM_CHAT_ID) {
    return c.text('Forbidden', 403);
  }

  if (typeof message.text !== 'string' || message.text.length === 0) {
    // Non-text update (sticker, photo, etc.) — ack to stop Telegram retrying.
    return c.json({ ok: true, skipped: true });
  }

  const profile = await repos.profile.getCurrent();
  const recentRow = await repos.idiomHistory.getMostRecent();

  const feedbackResult = await parseFeedback(c.env, message.text);
  const proposal = await reflect(c.env, profile, feedbackResult);

  await repos.profile.applyReflectorChanges(proposal);

  if (recentRow !== null) {
    await repos.idiomHistory.recordFeedback(recentRow.id, feedbackResult.raw);
  }

  return c.json({ ok: true });
}
