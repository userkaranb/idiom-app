import { Context } from 'hono';
import type { Env } from './types';
import type { Repos } from './db';

/**
 * Handles an inbound Telegram webhook update (POST /webhook).
 *
 * Telegram calls this endpoint for every message sent to the bot. The handler:
 *   1. Verifies the X-Telegram-Bot-Api-Secret-Token header against TELEGRAM_WEBHOOK_SECRET.
 *   2. Confirms the message is from the configured owner chat (TELEGRAM_CHAT_ID).
 *   3. Skips non-text messages (stickers, images, etc.) with a 200 ack so Telegram
 *      stops retrying — erroring on these would trigger Telegram's retry loop.
 *   4. Stores the raw message text as feedback against the most-recent history row.
 *   5. Sends a plain acknowledgement back to the user.
 */
export async function handleTelegramWebhook(
  c: Context<{ Bindings: Env }>,
  repos: Repos,
): Promise<Response> {
  const incomingSecret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (incomingSecret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    console.log('[webhook] secret token mismatch — rejecting');
    return c.text('Forbidden', 403);
  }
  console.log('[webhook] secret token verified');

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
  console.log('[webhook] received update_id=%s', body.update_id);

  const message = body.message;
  if (!message) return c.text('Forbidden', 403);

  if (String(message.chat.id) !== c.env.TELEGRAM_CHAT_ID) {
    console.log('[webhook] chat_id mismatch — rejecting');
    return c.text('Forbidden', 403);
  }

  if (typeof message.text !== 'string' || message.text.length === 0) {
    console.log('[webhook] skipping non-text message update_id=%s', body.update_id);
    return c.json({ ok: true, skipped: true });
  }

  const recentRow = await repos.idiomHistory.getMostRecent();
  if (recentRow !== null) {
    await repos.idiomHistory.recordFeedback(recentRow.id, message.text);
    console.log('[webhook] feedback recorded history_row_id=%s update_id=%s', recentRow.id, body.update_id);
  } else {
    console.log('[webhook] no recent history row — skipping recordFeedback update_id=%s', body.update_id);
  }

  const ackText = "✅ Got it! I'll factor this into tomorrow's phrase.";
  const tgRes = await fetch(
    'https://api.telegram.org/bot' + c.env.TELEGRAM_BOT_TOKEN + '/sendMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c.env.TELEGRAM_CHAT_ID, text: ackText }),
    },
  );
  if (!tgRes.ok) {
    console.error('[webhook] Telegram reply failed:', tgRes.status, await tgRes.text());
  }

  return c.json({ ok: true });
}
