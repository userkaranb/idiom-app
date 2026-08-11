import type { Env, SeedPhrase, IdiomHistoryInsert, WriterOutput, PhraseOutput } from './types';
import type { Repos } from './db';
import { generate } from './agents/writer';
import { findCollision, normalizePhrase } from './dedup';
import seedPhrases from '../seed-phrases.json';

const MAX_RETRIES = 3;
const EXEMPLAR_SAMPLE_SIZE = 15;

function sampleExemplars(phrases: SeedPhrase[], n: number): SeedPhrase[] {
  const shuffled = [...phrases].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function slugify(text: string): string {
  return normalizePhrase(text).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function regionNote(region: string): string {
  const notes: Record<string, string> = {
    'Puerto Rico': "you'll hear this constantly in San Juan",
    'Spain': 'common in Spain',
    'Mexico': 'very common in Mexico',
    'Argentina': 'typical in Argentina',
    'Colombia': 'used in Colombia',
  };
  return notes[region] ?? region;
}

function formatPhrase(p: PhraseOutput, label: string): string {
  const lines = [`${label}: "${p.phrase}"`];
  if (p.region !== 'general') {
    lines.push(`   (${regionNote(p.region)})`);
  }
  lines.push(`   ${p.meaning}`);
  lines.push(`   ${p.example}`);
  return lines.join('\n');
}

function assembleMessage(output: WriterOutput): string {
  return (
    `Today's two:\n\n` +
    formatPhrase(output.idiom, 'Idiom') +
    `\n\n` +
    formatPhrase(output.colloquialism, 'Colloquialism')
  );
}

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
  const history = await repos.idiomHistory.listAllSentHistory();

  const feedbackItems = history
    .map(r => r.user_feedback)
    .filter((f): f is string => f !== null && f.length > 0);

  const allSeeds = seedPhrases as SeedPhrase[];
  const exemplars = sampleExemplars(allSeeds, EXEMPLAR_SAMPLE_SIZE);

  // Forbidden: all history phrase texts + all seed exemplar texts verbatim.
  // Seeded exemplars are style anchors — the model must not send them directly.
  const forbiddenTexts = [
    ...history.map(r => r.idiom_text),
    ...history.map(r => r.colloquialism_text),
    ...allSeeds.map(s => s.text),
  ].filter(Boolean);

  let output: WriterOutput | null = null;
  let collisionHint: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const candidate = await generate(env, exemplars, history, feedbackItems, collisionHint);

    const idiomCollision  = findCollision(candidate.idiom.phrase, forbiddenTexts);
    const collCollision   = findCollision(candidate.colloquialism.phrase, forbiddenTexts);

    if (idiomCollision === null && collCollision === null) {
      output = candidate;
      break;
    }

    collisionHint = idiomCollision ?? collCollision ?? undefined;
    console.log('[orchestrator] dedup collision on attempt=%d collision="%s"', attempt + 1, collisionHint);
  }

  if (output === null) {
    throw new Error(
      'Generator: dedup retry limit reached — could not generate non-duplicate phrases after ' + MAX_RETRIES + ' attempts',
    );
  }

  console.log('[orchestrator] generated idiom="%s" colloquialism="%s"', output.idiom.phrase, output.colloquialism.phrase);

  const messageBody = assembleMessage(output);
  console.log('[idiom-app] Daily message:\n' + messageBody);

  const response = await fetch(
    'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: messageBody }),
    },
  );
  if (!response.ok) {
    console.error('[orchestrator] Telegram sendMessage failed status=%s', response.status);
    throw new Error('Telegram sendMessage failed: ' + response.status + ': ' + await response.text());
  }
  console.log('[orchestrator] Telegram sendMessage status=%s', response.status);

  const entry: IdiomHistoryInsert = {
    idiom_id:                slugify(output.idiom.phrase),
    idiom_text:              output.idiom.phrase,
    idiom_meaning:           output.idiom.meaning,
    idiom_example:           output.idiom.example,
    idiom_region:            output.idiom.region,
    colloquialism_id:        slugify(output.colloquialism.phrase),
    colloquialism_text:      output.colloquialism.phrase,
    colloquialism_meaning:   output.colloquialism.meaning,
    colloquialism_example:   output.colloquialism.example,
    colloquialism_region:    output.colloquialism.region,
    curator_justification:
      `idiom: ${output.idiom.why_different} | colloquialism: ${output.colloquialism.why_different}`,
  };
  await repos.idiomHistory.recordSent(entry);
}
