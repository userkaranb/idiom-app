import type { Env, SeedPhrase, IdiomHistoryInsert } from './types';
import type { Repos } from './db';
import { scout } from './agents/scout';
import { curate } from './agents/curator';
import { write } from './agents/writer';
import seedPhrases from '../seed-phrases.json';

/**
 * Runs the full daily send flow.
 *
 * Called by the Cloudflare Cron Trigger handler in `src/index.ts`, which
 * constructs `repos` from the D1 binding before invoking this function. The
 * orchestrator never touches the raw D1 binding — all persistence goes through
 * the repository layer.
 *
 * @param env   Worker bindings (Anthropic API key, Telegram credentials; DB is accessed via `repos`)
 * @param repos Pre-constructed repository pair from `createRepositories(env)`
 */
export async function runDailyFlow(env: Env, repos: Repos): Promise<void> {
  // 1. Read the singleton profile row. Throws with a clear error if absent.
  const profile = await repos.profile.getCurrent();

  // 2. Read full history so Scout can exclude every phrase sent to date.
  const history = await repos.idiomHistory.listAllSentHistory();

  // 3. Filter seed phrases against sent history.
  const candidates = scout(seedPhrases as SeedPhrase[], history);

  // 4. Both pools must be non-empty. Proceeding with an empty pool would cause
  // Curator to hallucinate a phrase that isn't in the seed list, breaking
  // lifetime deduplication.
  if (candidates.idioms.length === 0 || candidates.colloquialisms.length === 0) {
    throw new Error('Scout: no remaining idioms/colloquialisms — seed list exhausted');
  }

  // 5. Curator picks exactly one idiom and one colloquialism from the candidates.
  const verdict = await curate(env, candidates, profile);

  // 6. Writer composes the user-facing message from the verdict.
  const messageBody = await write(env, verdict);

  // 7. Log for wrangler tail debugging, then deliver via Telegram bot.
  console.log('[idiom-app] Daily message:\n' + messageBody);

  const response = await fetch(
    'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: messageBody,
      }),
    },
  );
  if (!response.ok) {
    throw new Error('Telegram sendMessage failed: ' + response.status + ': ' + await response.text());
  }

  // 8. Persist what was sent so Scout can exclude it on every future run.
  const entry: IdiomHistoryInsert = {
    idiom_id: verdict.idiom.id,
    idiom_text: verdict.idiom.text,
    colloquialism_id: verdict.colloquialism.id,
    colloquialism_text: verdict.colloquialism.text,
    curator_justification:
      `idiom: ${verdict.idiom.justification} | colloquialism: ${verdict.colloquialism.justification}`,
  };
  await repos.idiomHistory.recordSent(entry);
}
