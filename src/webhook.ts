import { Context } from 'hono';
import type { Env, FeedbackResult, ReflectorProposal } from './types';
import type { Repos } from './db';
import { parseFeedback } from './agents/feedback';
import { reflect } from './agents/reflector';

/**
 * Formats the structured output of the Feedback and Reflector agents into a
 * plain-text Telegram message the user can read in their chat.
 *
 * This is a pure function — no network calls, no LLM, no side effects. The LLM
 * agents already did the understanding work; this function just surfaces their
 * output in human-readable form.
 */
export function buildConfirmationMessage(
  feedbackResult: FeedbackResult,
  proposal: ReflectorProposal,
): string {
  const lines: string[] = ['✅ Got your feedback!', '', 'What I understood:'];

  lines.push(`• Sentiment: ${feedbackResult.sentiment}`);

  if (feedbackResult.wants_more_colloquial === true) {
    lines.push('• Wants more colloquial: yes');
  }
  if (feedbackResult.wants_more_formal === true) {
    lines.push('• Wants more formal: yes');
  }
  if (feedbackResult.wants_more_vulgar === true) {
    lines.push('• Wants more vulgar: yes');
  }
  if (feedbackResult.wants_less_vulgar === true) {
    lines.push('• Wants less vulgar: yes');
  }
  if (feedbackResult.theme_mentions.length > 0) {
    lines.push(`• Themes mentioned: ${feedbackResult.theme_mentions.join(', ')}`);
  }

  lines.push('', 'Profile updates applied:');

  const proposalFields = Object.keys(proposal) as (keyof ReflectorProposal)[];
  if (proposalFields.length === 0) {
    lines.push('No profile changes needed.');
  } else {
    if (proposal.regional_preference !== undefined) {
      lines.push(`• Regional preference → ${proposal.regional_preference}`);
    }
    if (proposal.vulgarity_tolerance !== undefined) {
      lines.push(`• Vulgarity tolerance → ${proposal.vulgarity_tolerance}`);
    }
    if (proposal.themes !== undefined) {
      lines.push(`• Themes → ${JSON.stringify(proposal.themes)}`);
    }
    if (proposal.common_vs_obscure !== undefined) {
      lines.push(`• Common vs obscure → ${proposal.common_vs_obscure}`);
    }
    if (proposal.no_list_additions !== undefined) {
      lines.push(`• Added to no-list → ${proposal.no_list_additions.join(', ')}`);
    }
  }

  lines.push('', "I'll factor this into tomorrow's message 🎯");

  return lines.join('\n');
}

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

  if (!message) {
    return c.text('Forbidden', 403);
  }

  if (String(message.chat.id) !== c.env.TELEGRAM_CHAT_ID) {
    console.log('[webhook] chat_id mismatch expected=%s got=%s — rejecting', c.env.TELEGRAM_CHAT_ID, String(message.chat.id));
    return c.text('Forbidden', 403);
  }

  if (typeof message.text !== 'string' || message.text.length === 0) {
    // Non-text update (sticker, photo, etc.) — ack to stop Telegram retrying.
    console.log('[webhook] skipping non-text message update_id=%s', body.update_id);
    return c.json({ ok: true, skipped: true });
  }

  const profile = await repos.profile.getCurrent();
  const recentRow = await repos.idiomHistory.getMostRecent();

  const feedbackResult = await parseFeedback(c.env, message.text);
  console.log('[webhook] parseFeedback sentiment=%s update_id=%s', feedbackResult.sentiment, body.update_id);

  const proposal = await reflect(c.env, profile, feedbackResult);
  console.log('[webhook] reflector proposal themes=%s common_vs_obscure=%s update_id=%s', JSON.stringify(proposal.themes), proposal.common_vs_obscure, body.update_id);

  await repos.profile.applyReflectorChanges(proposal);
  console.log('[webhook] profile updated update_id=%s', body.update_id);

  if (recentRow !== null) {
    await repos.idiomHistory.recordFeedback(recentRow.id, feedbackResult.raw);
    console.log('[webhook] feedback recorded history_row_id=%s update_id=%s', recentRow.id, body.update_id);
  } else {
    console.log('[webhook] no recent history row — skipping recordFeedback update_id=%s', body.update_id);
  }

  const confirmText = buildConfirmationMessage(feedbackResult, proposal);
  const tgRes = await fetch(
    'https://api.telegram.org/bot' + c.env.TELEGRAM_BOT_TOKEN + '/sendMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c.env.TELEGRAM_CHAT_ID, text: confirmText }),
    },
  );
  if (!tgRes.ok) {
    // Log and continue — feedback is already processed and stored. Throwing here
    // would cause Telegram to retry the webhook indefinitely.
    console.error('[webhook] Telegram reply failed:', tgRes.status, await tgRes.text());
  }

  return c.json({ ok: true });
}
