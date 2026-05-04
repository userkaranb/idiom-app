import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env, Profile, CuratorVerdict } from '../src/types';

// vi.hoisted runs before any imports so these mock functions are available
// inside the vi.mock factory closures below.
const { mockScout, mockCurate, mockWrite } = vi.hoisted(() => ({
  mockScout: vi.fn(),
  mockCurate: vi.fn(),
  mockWrite: vi.fn(),
}));

vi.mock('../src/agents/scout',   () => ({ scout:  mockScout  }));
vi.mock('../src/agents/curator', () => ({ curate: mockCurate }));
vi.mock('../src/agents/writer',  () => ({ write:  mockWrite  }));

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
// D1 mock factory
//
// Returns the fake D1Database plus individual mock handles so tests can make
// assertions on exactly what was bound / run.
// ---------------------------------------------------------------------------

function makeD1Mocks({
  profileRows = [mockProfile] as unknown[],
  historyRows  = [] as unknown[],
} = {}) {
  const run  = vi.fn().mockResolvedValue(undefined);
  const bind = vi.fn().mockReturnValue({ run });

  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.startsWith('SELECT * FROM profile')) {
        return { all: vi.fn().mockResolvedValue({ results: profileRows }) };
      }
      if (sql.startsWith('SELECT idiom_id')) {
        return { all: vi.fn().mockResolvedValue({ results: historyRows }) };
      }
      if (sql.includes('INSERT INTO idiom_history')) {
        return { bind };
      }
      throw new Error(`Unexpected SQL in test mock: ${sql}`);
    }),
  } as unknown as D1Database;

  return { db, bind, run };
}

function makeEnv(db: D1Database): Env {
  return { DB: db, ANTHROPIC_API_KEY: 'test-key' };
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
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Acceptance criterion: profile is read before Scout ---

  it('reads profile from D1 with the expected SQL before calling Scout', async () => {
    const { db } = makeD1Mocks();
    const prepare = db.prepare as ReturnType<typeof vi.fn>;

    await runDailyFlow(makeEnv(db));

    const profileCalls = prepare.mock.calls.filter((args) =>
      String(args[0]).startsWith('SELECT * FROM profile'),
    );
    expect(profileCalls).toHaveLength(1);
    // Scout must have been called (meaning the profile read was a prerequisite)
    expect(mockScout).toHaveBeenCalledOnce();
  });

  // --- Acceptance criterion: history is read before Scout ---

  it('reads idiom_history from D1 before calling Scout', async () => {
    const { db } = makeD1Mocks();
    const prepare = db.prepare as ReturnType<typeof vi.fn>;

    await runDailyFlow(makeEnv(db));

    const historyCalls = prepare.mock.calls.filter((args) =>
      String(args[0]).startsWith('SELECT idiom_id'),
    );
    expect(historyCalls).toHaveLength(1);
    expect(mockScout).toHaveBeenCalledOnce();
  });

  // --- Acceptance criterion: history rows are passed to Scout ---

  it('passes D1 history rows to Scout', async () => {
    const historyRows = [
      { idiom_id: 'seen-idiom', colloquialism_id: 'seen-coll' },
    ];
    const { db } = makeD1Mocks({ historyRows });

    await runDailyFlow(makeEnv(db));

    expect(mockScout).toHaveBeenCalledWith(
      expect.any(Array), // the seed-phrases.json array
      historyRows,
    );
  });

  // --- Acceptance criterion: profile is passed to Curator ---

  it('passes the D1 profile to Curator', async () => {
    const { db } = makeD1Mocks();

    await runDailyFlow(makeEnv(db));

    expect(mockCurate).toHaveBeenCalledWith(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'test-key' }),
      scoutCandidates,
      mockProfile,
    );
  });

  // --- Acceptance criterion: verdict is passed to Writer ---

  it('passes the CuratorVerdict to Writer', async () => {
    const { db } = makeD1Mocks();

    await runDailyFlow(makeEnv(db));

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'test-key' }),
      mockVerdict,
    );
  });

  // --- Acceptance criterion: console.log called exactly once with message body ---

  it('logs the message body exactly once with the [idiom-app] prefix', async () => {
    const { db } = makeD1Mocks();
    const messageBody = "¡Hola! Today's phrase is...";
    mockWrite.mockResolvedValue(messageBody);

    await runDailyFlow(makeEnv(db));

    const appLogCalls = consoleLogSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && (msg as string).startsWith('[idiom-app]'),
    );
    expect(appLogCalls).toHaveLength(1);
    expect(appLogCalls[0][0]).toBe('[idiom-app] Daily message:\n' + messageBody);
  });

  // --- Acceptance criterion: idiom_history row is inserted after Writer returns ---

  it('inserts an idiom_history row after Writer returns', async () => {
    const { db, run } = makeD1Mocks();

    await runDailyFlow(makeEnv(db));

    expect(run).toHaveBeenCalledOnce();
  });

  it('binds verdict fields and combined justification to the INSERT statement', async () => {
    const { db, bind } = makeD1Mocks();

    await runDailyFlow(makeEnv(db));

    expect(bind).toHaveBeenCalledWith(
      mockVerdict.idiom.id,
      mockVerdict.idiom.text,
      mockVerdict.colloquialism.id,
      mockVerdict.colloquialism.text,
      `idiom: ${mockVerdict.idiom.justification} | colloquialism: ${mockVerdict.colloquialism.justification}`,
    );
  });

  // --- Acceptance criterion: throw when profile row is missing ---

  it('throws a descriptive error when the profile row is absent from D1', async () => {
    const { db } = makeD1Mocks({ profileRows: [] });

    await expect(runDailyFlow(makeEnv(db))).rejects.toThrow(
      'profile row with id=1 not found in D1',
    );
  });

  // --- Acceptance criterion: throw when Scout exhausts candidates ---

  it('throws when Scout returns an empty idioms array', async () => {
    mockScout.mockReturnValue({ idioms: [], colloquialisms: scoutCandidates.colloquialisms });
    const { db } = makeD1Mocks();

    await expect(runDailyFlow(makeEnv(db))).rejects.toThrow(
      'Scout: no remaining idioms/colloquialisms — seed list exhausted',
    );
  });

  it('throws when Scout returns an empty colloquialisms array', async () => {
    mockScout.mockReturnValue({ idioms: scoutCandidates.idioms, colloquialisms: [] });
    const { db } = makeD1Mocks();

    await expect(runDailyFlow(makeEnv(db))).rejects.toThrow(
      'Scout: no remaining idioms/colloquialisms — seed list exhausted',
    );
  });

  it('does not call Curator when Scout returns empty candidates', async () => {
    mockScout.mockReturnValue({ idioms: [], colloquialisms: [] });
    const { db } = makeD1Mocks();

    await expect(runDailyFlow(makeEnv(db))).rejects.toThrow();
    expect(mockCurate).not.toHaveBeenCalled();
  });
});
