import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env, Profile, CuratorVerdict, IdiomHistory, IdiomHistoryInsert } from '../src/types';
import type { Repos } from '../src/db';

// vi.hoisted runs before any imports so these mock functions are available
// inside the vi.mock factory closures below.
const { mockScout, mockCurate, mockWrite, mockMessagesCreate } = vi.hoisted(() => ({
  mockScout:          vi.fn(),
  mockCurate:         vi.fn(),
  mockWrite:          vi.fn(),
  mockMessagesCreate: vi.fn().mockResolvedValue({ sid: 'SM-test-sid' }),
}));

vi.mock('../src/agents/scout',   () => ({ scout:  mockScout  }));
vi.mock('../src/agents/curator', () => ({ curate: mockCurate }));
vi.mock('../src/agents/writer',  () => ({ write:  mockWrite  }));

// Prevent the real Twilio client from being constructed during tests.
// Any test that allows the real constructor to run would hit the Twilio API.
vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

import { runDailyFlow } from '../src/orchestrator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockProfile: Profile = {
  id: 1,
  regional_preference: 'general',
  vulgarity_tolerance: 1,
  themes: '["work","misc"]',
  common_vs_obscure: 3,
  no_list: '[]',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockVerdict: CuratorVerdict = {
  idiom: {
    id: 'el-que-no-llora',
    text: 'El que no llora no mama',
    justification: 'Common work idiom.',
  },
  colloquialism: {
    id: 'chido',
    text: 'chido',
    justification: 'Very common in Mexico.',
  },
};

const scoutCandidates = {
  idioms: [
    { id: 'el-que-no-llora', text: 'El que no llora no mama', type: 'idiom' as const, region: 'general', theme: 'work', vulgarity_level: 0 },
  ],
  colloquialisms: [
    { id: 'chido', text: 'chido', type: 'colloquialism' as const, region: 'Mexico', theme: 'misc', vulgarity_level: 0 },
  ],
};

// ---------------------------------------------------------------------------
// Fake repository factory
//
// Returns a Repos whose methods are vi.fn() stubs so tests can assert on
// which methods were called and with what arguments.
// ---------------------------------------------------------------------------

function makeFakeRepos({
  profileRows = [mockProfile] as (Profile | null)[],
  historyRows  = [] as IdiomHistory[],
} = {}): Repos {
  // getCurrent: return the first non-null profile, or throw when absent.
  const getCurrent = vi.fn(async () => {
    const profile = profileRows[0] ?? null;
    if (!profile) throw new Error('profile row with id=1 not found in D1');
    return profile;
  });

  const applyReflectorChanges = vi.fn().mockResolvedValue(mockProfile);
  const listAllSentHistory    = vi.fn().mockResolvedValue(historyRows);
  const getMostRecent         = vi.fn().mockResolvedValue(null);
  const recordSent            = vi.fn().mockResolvedValue(undefined);
  const recordFeedback        = vi.fn().mockResolvedValue(undefined);
  const listRecent            = vi.fn().mockResolvedValue([]);
  const containsPhrase        = vi.fn().mockResolvedValue(false);

  return {
    profile:      { getCurrent, applyReflectorChanges },
    idiomHistory: { listAllSentHistory, getMostRecent, recordSent, recordFeedback, listRecent, containsPhrase },
  };
}

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    ANTHROPIC_API_KEY: 'test-key',
    TWILIO_ACCOUNT_SID: 'AC-test-sid',
    TWILIO_AUTH_TOKEN: 'test-auth-token',
    TWILIO_FROM_NUMBER: '+15702184457',
    TWILIO_TO_NUMBER: '+15551234567',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDailyFlow', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScout.mockReturnValue(scoutCandidates);
    mockCurate.mockResolvedValue(mockVerdict);
    mockWrite.mockResolvedValue("¡Hola! Today's phrase is...");
    mockMessagesCreate.mockResolvedValue({ sid: 'SM-test-sid' });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Acceptance criterion: profile is read before Scout ---

  it('reads the current profile before calling Scout', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(repos.profile.getCurrent).toHaveBeenCalledOnce();
    // Scout must have been called (meaning the profile read was a prerequisite)
    expect(mockScout).toHaveBeenCalledOnce();
  });

  // --- Acceptance criterion: history is read before Scout ---

  it('reads idiom history before calling Scout', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(repos.idiomHistory.listAllSentHistory).toHaveBeenCalledOnce();
    expect(mockScout).toHaveBeenCalledOnce();
  });

  // --- Acceptance criterion: history rows are passed to Scout ---

  it('passes history rows to Scout', async () => {
    const historyRows = [
      {
        id: 1, sent_at: '2024-01-01T13:00:00Z',
        idiom_id: 'seen-idiom', idiom_text: '',
        colloquialism_id: 'seen-coll', colloquialism_text: '',
        curator_justification: '', user_rating: null, user_feedback: null,
      },
    ] as IdiomHistory[];
    const repos = makeFakeRepos({ historyRows });

    await runDailyFlow(makeEnv(), repos);

    expect(mockScout).toHaveBeenCalledWith(
      expect.any(Array), // the seed-phrases.json array
      historyRows,
    );
  });

  // --- Acceptance criterion: profile is passed to Curator ---

  it('passes the profile to Curator', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(mockCurate).toHaveBeenCalledWith(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'test-key' }),
      scoutCandidates,
      mockProfile,
    );
  });

  // --- Acceptance criterion: verdict is passed to Writer ---

  it('passes the CuratorVerdict to Writer', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'test-key' }),
      mockVerdict,
    );
  });

  // --- Acceptance criterion: console.log called exactly once with message body ---

  it('logs the message body exactly once with the [idiom-app] prefix', async () => {
    const repos = makeFakeRepos();
    const messageBody = "¡Hola! Today's phrase is...";
    mockWrite.mockResolvedValue(messageBody);

    await runDailyFlow(makeEnv(), repos);

    const appLogCalls = consoleLogSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && (msg as string).startsWith('[idiom-app]'),
    );
    expect(appLogCalls).toHaveLength(1);
    expect(appLogCalls[0][0]).toBe('[idiom-app] Daily message:\n' + messageBody);
  });

  // --- Acceptance criterion: Twilio send is called with correct arguments ---

  it('calls twilio.messages.create with the from/to/body the Writer produced', async () => {
    const repos = makeFakeRepos();
    const messageBody = "¡Hola! Today's phrase is...";
    mockWrite.mockResolvedValue(messageBody);

    await runDailyFlow(makeEnv(), repos);

    expect(mockMessagesCreate).toHaveBeenCalledOnce();
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      from: '+15702184457',
      to:   '+15551234567',
      body: messageBody,
    });
  });

  // --- Acceptance criterion: Twilio send failure is logged and rethrown ---

  it('rethrows a Twilio send error so the cron tick fails loudly', async () => {
    const repos = makeFakeRepos();
    const sendError = new Error('Twilio API unreachable');
    mockMessagesCreate.mockRejectedValue(sendError);

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow('Twilio API unreachable');
  });

  it('logs the Twilio error before rethrowing it', async () => {
    const repos = makeFakeRepos();
    const sendError = new Error('network timeout');
    mockMessagesCreate.mockRejectedValue(sendError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow('network timeout');

    expect(errorSpy).toHaveBeenCalled();
  });

  // --- Acceptance criterion: idiom_history row is recorded after Writer returns ---

  it('records the sent idiom after Writer returns', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    expect(repos.idiomHistory.recordSent).toHaveBeenCalledOnce();
  });

  it('records the sent idiom with verdict fields and combined justification', async () => {
    const repos = makeFakeRepos();
    await runDailyFlow(makeEnv(), repos);

    const expectedEntry: IdiomHistoryInsert = {
      idiom_id:              mockVerdict.idiom.id,
      idiom_text:            mockVerdict.idiom.text,
      colloquialism_id:      mockVerdict.colloquialism.id,
      colloquialism_text:    mockVerdict.colloquialism.text,
      curator_justification: `idiom: ${mockVerdict.idiom.justification} | colloquialism: ${mockVerdict.colloquialism.justification}`,
    };
    expect(repos.idiomHistory.recordSent).toHaveBeenCalledWith(expectedEntry);
  });

  // --- Acceptance criterion: throw when profile row is missing ---

  it('throws a descriptive error when the profile row is absent', async () => {
    const repos = makeFakeRepos({ profileRows: [null] });

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow(
      'profile row with id=1 not found in D1',
    );
  });

  // --- Acceptance criterion: throw when Scout exhausts candidates ---

  it('throws when Scout returns an empty idioms array', async () => {
    mockScout.mockReturnValue({ idioms: [], colloquialisms: scoutCandidates.colloquialisms });
    const repos = makeFakeRepos();

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow(
      'Scout: no remaining idioms/colloquialisms — seed list exhausted',
    );
  });

  it('throws when Scout returns an empty colloquialisms array', async () => {
    mockScout.mockReturnValue({ idioms: scoutCandidates.idioms, colloquialisms: [] });
    const repos = makeFakeRepos();

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow(
      'Scout: no remaining idioms/colloquialisms — seed list exhausted',
    );
  });

  it('does not call Curator when Scout returns empty candidates', async () => {
    mockScout.mockReturnValue({ idioms: [], colloquialisms: [] });
    const repos = makeFakeRepos();

    await expect(runDailyFlow(makeEnv(), repos)).rejects.toThrow();
    expect(mockCurate).not.toHaveBeenCalled();
  });
});
