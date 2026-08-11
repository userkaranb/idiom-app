import type { Env } from './types';

function buildAlertText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `⚠️ Daily flow failed: ${message}`;
}

/**
 * Sends a Telegram alert to the owner when the daily cron flow fails.
 *
 * Never throws — all errors from the Telegram fetch are caught and logged
 * so the caller's error-handling path is never disrupted by a secondary
 * failure. This prevents a double-alert loop when the original failure was
 * itself a Telegram sendMessage error.
 *
 * Precedent: `src/webhook.ts` uses the same pattern for the confirmation reply.
 */
export async function sendTelegramAlert(env: Env, error: unknown): Promise<void> {
  try {
    const text = buildAlertText(error);
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      },
    );
    if (!response.ok) {
      console.error('[telegram] alert sendMessage failed status=%s', response.status);
    }
  } catch (alertError) {
    console.error('[telegram] alert sendMessage threw:', alertError);
  }
}
