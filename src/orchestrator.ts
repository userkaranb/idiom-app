import twilio from 'twilio';
import type { Env, SeedPhrase, IdiomHistory, Profile } from './types';
import { scout } from './agents/scout';
import { curate } from './agents/curator';
import { write } from './agents/writer';
import seedPhrases from '../seed-phrases.json';

export async function runDailyFlow(env: Env): Promise<void> {
  // 1. Read the singleton profile row. schema.sql guarantees id=1 always exists
  // via INSERT OR IGNORE, but guard here so a misconfigured environment gives
  // a clear error rather than a downstream TypeError.
  const profileResult = await env.DB
    .prepare('SELECT * FROM profile WHERE id = 1')
    .all<Profile>();
  const profile = profileResult.results[0];
  if (!profile) {
    throw new Error('runDailyFlow: profile row with id=1 not found in D1');
  }

  // 2. Read history rows. Only idiom_id and colloquialism_id are needed by
  // Scout for deduplication; selecting the full row avoids a cast but wastes
  // bandwidth for a table that grows at one row per day.
  const historyResult = await env.DB
    .prepare('SELECT idiom_id, colloquialism_id FROM idiom_history')
    .all<IdiomHistory>();
  const history = historyResult.results;

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

  // 7. Log for wrangler tail debugging, then deliver via Twilio WhatsApp.
  console.log('[idiom-app] Daily message:\n' + messageBody);

  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  try {
    await client.messages.create({
      from: env.TWILIO_FROM_NUMBER,
      to:   env.TWILIO_TO_NUMBER,
      body: messageBody,
    });
  } catch (error) {
    console.error('[idiom-app] Twilio send failed:', error);
    throw error;
  }

  // 8. Persist what was sent so Scout can exclude it on every future run.
  const curatorJustification =
    `idiom: ${verdict.idiom.justification} | colloquialism: ${verdict.colloquialism.justification}`;
  await env.DB
    .prepare(
      `INSERT INTO idiom_history
         (sent_at, idiom_id, idiom_text, colloquialism_id, colloquialism_text, curator_justification)
       VALUES
         (datetime('now'), ?, ?, ?, ?, ?)`,
    )
    .bind(
      verdict.idiom.id,
      verdict.idiom.text,
      verdict.colloquialism.id,
      verdict.colloquialism.text,
      curatorJustification,
    )
    .run();
}
