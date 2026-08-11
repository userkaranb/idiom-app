/**
 * Repository factory.
 *
 * This is the ONLY file in the codebase that receives `env.DB` and distributes
 * it to repository implementations. Everything outside `src/db/` receives a
 * typed `Repos` object and never touches the raw D1 binding.
 */
import type { Env } from '../types';
import { createIdiomHistoryRepo } from './idiom-history-repo';

export type { IdiomHistoryRepo } from './idiom-history-repo';

/** The repository the app uses, keyed by domain concept. */
export interface Repos {
  idiomHistory: import('./idiom-history-repo').IdiomHistoryRepo;
}

/**
 * Constructs the repository from the Cloudflare Worker bindings.
 *
 * Called once at the top of each request/scheduled-event handler in `src/index.ts`.
 * Nothing outside `src/db/` should ever reference `env.DB` directly.
 */
export function createRepositories(env: Env): Repos {
  return { idiomHistory: createIdiomHistoryRepo(env.DB) };
}
