/**
 * Repository factory.
 *
 * This is the ONLY file in the codebase that receives `env.DB` and distributes
 * it to repository implementations. Everything outside `src/db/` receives a
 * typed `Repos` object and never touches the raw D1 binding.
 */
import type { Env } from '../types';
import { createProfileRepo } from './profile-repo';
import { createIdiomHistoryRepo } from './idiom-history-repo';

export type { ProfileRepo } from './profile-repo';
export type { IdiomHistoryRepo } from './idiom-history-repo';

/** The two repositories the app uses, keyed by domain concept. */
export interface Repos {
  profile: import('./profile-repo').ProfileRepo;
  idiomHistory: import('./idiom-history-repo').IdiomHistoryRepo;
}

/**
 * Constructs both repositories from the Cloudflare Worker bindings.
 *
 * Called once at the top of each request/scheduled-event handler in `src/index.ts`.
 * Nothing outside `src/db/` should ever reference `env.DB` directly.
 */
export function createRepositories(env: Env): Repos {
  return {
    profile: createProfileRepo(env.DB),
    idiomHistory: createIdiomHistoryRepo(env.DB),
  };
}
