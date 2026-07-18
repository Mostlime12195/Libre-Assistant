/**
 * @file contextCompressionPipeline.test.js
 * @description Unit tests for the compression orchestration: reactive
 * state, threshold evaluation, auto/manual runs, locking, failure
 * handling, and the guarantee that the messages array is never mutated.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map() }));

vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItem: vi.fn(async (key, value) => {
      store.set(key, value);
      return value;
    }),
    removeItem: vi.fn(async (key) => {
      store.delete(key);
    }),
  },
}));

vi.mock('~/composables/useSession', () => ({
  getSessionToken: vi.fn(async () => 'test-session-token'),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

import {
  compressionStates,
  getCompressionState,
  clearCompressionState,
  refreshCompressionState,
  loadCompressionState,
  getCachedValidSummaries,
  compressConversation,
  maybeAutoCompress,
  dismissCompressionPrompt,
  formatTokenCount,
} from '../app/composables/contextCompressionPipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(id, content = '') {
  return { id, role: 'user', content, timestamp: new Date(), complete: true };
}

function makeAssistant(id, content = '') {
  return { id, role: 'assistant', content, timestamp: new Date(), complete: true };
}

/** n alternating messages (m0 user, m1 assistant, ...), 100 tokens each. */
function makeConvo(n, tokensEach = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const content = 'x'.repeat(tokensEach * 4);
    out.push(
      i % 2 === 0 ? makeUser(`m${i}`, content) : makeAssistant(`m${i}`, content),
    );
  }
  return out;
}

function makeSettings(overrides = {}) {
  return {
    context_compression_enabled: true,
    context_compression_model: 'test-model',
    context_compression_threshold_tokens: 4000,
    context_compression_keep_recent_tokens: 1000,
    ...overrides,
  };
}

function mockFetchSummary(text = 'SUMMARY') {
  fetchMock.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] }),
  }));
}

beforeEach(() => {
  store.clear();
  fetchMock.mockReset();
  mockFetchSummary();
  for (const key of Object.keys(compressionStates)) {
    delete compressionStates[key];
  }
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

describe('getCompressionState', () => {
  it('lazily creates and reuses state', () => {
    const a = getCompressionState('c1');
    const b = getCompressionState('c1');
    expect(a).toBe(b);
    expect(a.status).toBe('idle');
  });

  it('returns null without a conversation id', () => {
    expect(getCompressionState(null)).toBeNull();
  });
});

describe('refreshCompressionState', () => {
  it('computes effective tokens and threshold crossing', () => {
    const convo = makeConvo(50); // 5000 tokens
    refreshCompressionState('c1', convo, makeSettings());
    const state = getCompressionState('c1');
    expect(state.effectiveTokens).toBe(5000);
    expect(state.thresholdReached).toBe(true);
    expect(state.hasEligibleRange).toBe(true);
    expect(state.validSummaries).toEqual([]);
  });

  it('stays below threshold for short chats', () => {
    refreshCompressionState('c1', makeConvo(10), makeSettings());
    expect(getCompressionState('c1').thresholdReached).toBe(false);
  });
});

describe('dismissCompressionPrompt', () => {
  it('dismisses and re-offers after ~25% growth', () => {
    const convo = makeConvo(50);
    const settings = makeSettings();
    refreshCompressionState('c1', convo, settings);

    dismissCompressionPrompt('c1');
    expect(getCompressionState('c1').dismissed).toBe(true);

    // Small growth: still dismissed.
    refreshCompressionState('c1', makeConvo(55), settings);
    expect(getCompressionState('c1').dismissed).toBe(true);

    // >25% growth past the dismissal point: re-offered.
    refreshCompressionState('c1', makeConvo(70), settings);
    expect(getCompressionState('c1').dismissed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compressConversation
// ---------------------------------------------------------------------------

describe('compressConversation', () => {
  it('manual mode compresses the whole eligible span and never mutates messages', async () => {
    const convo = makeConvo(20); // 2000 tokens; tail keeps 10
    const snapshot = JSON.parse(JSON.stringify(convo));

    const result = await compressConversation({
      conversationId: 'c1',
      getVisibleMessages: () => convo,
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      mode: 'manual',
    });

    expect(result.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const state = getCompressionState('c1');
    expect(state.chunks).toHaveLength(1);
    expect(state.chunks[0].sourceMessageIds).toEqual(
      convo.slice(0, 10).map((m) => m.id),
    );
    expect(state.chunks[0].anchorMessageId).toBe('m9');
    expect(state.lastSavings.sourceTokens).toBe(1000);

    // Sidecar persisted.
    const stored = store.get('context_summary_c1');
    expect(stored.chunks).toHaveLength(1);

    // The messages array was not touched.
    expect(JSON.parse(JSON.stringify(convo))).toEqual(snapshot);

    // The summary now applies to the history.
    expect(state.validSummaries).toHaveLength(1);
    expect(getCachedValidSummaries('c1')).toHaveLength(1);
    // Effective tokens dropped well below the verbatim 2000.
    expect(state.effectiveTokens).toBeLessThan(1200);
  });

  it('manual mode splits oversized spans into sequential ranges', async () => {
    const convo = makeConvo(450); // 45k tokens, tail keeps 10
    const result = await compressConversation({
      conversationId: 'c2',
      getVisibleMessages: () => convo,
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      mode: 'manual',
    });

    expect(result.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const state = getCompressionState('c2');
    expect(state.chunks).toHaveLength(5);
    expect(state.chunks[0].sourceMessageIds).toHaveLength(100);
    expect(state.chunks[1].sourceMessageIds[0]).toBe('m100');
    expect(state.chunks[4].anchorMessageId).toBe('m439');
  });

  it('auto mode compresses exactly one range per run', async () => {
    const convo = makeConvo(200); // 20k tokens, far above threshold
    const result = await compressConversation({
      conversationId: 'c3',
      getVisibleMessages: () => convo,
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      mode: 'auto',
    });

    expect(result.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const state = getCompressionState('c3');
    expect(state.chunks).toHaveLength(1);
    // Auto target: max(2000, 20000 - 4000 + 600) = 16600 → capped per-range anyway.
    expect(state.chunks[0].sourceMessageIds.length).toBeGreaterThan(0);
  });

  it('serializes concurrent runs for the same conversation', async () => {
    const convo = makeConvo(50);
    const [r1, r2] = await Promise.all([
      compressConversation({
        conversationId: 'c4',
        getVisibleMessages: () => convo,
        settings: makeSettings(),
        apiKey: 'key',
        branchPath: [],
        mode: 'auto',
      }),
      compressConversation({
        conversationId: 'c4',
        getVisibleMessages: () => convo,
        settings: makeSettings(),
        apiKey: 'key',
        branchPath: [],
        mode: 'auto',
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCompressionState('c4').chunks).toHaveLength(1);
  });

  it('fails gracefully when the model call fails', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const convo = makeConvo(50);

    const result = await compressConversation({
      conversationId: 'c5',
      getVisibleMessages: () => convo,
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      mode: 'manual',
    });

    expect(result.status).toBe('failed');
    const state = getCompressionState('c5');
    expect(state.lastError).toBeTruthy();
    expect(state.chunks).toHaveLength(0);
    expect(state.status).toBe('idle');
    expect(store.has('context_summary_c5')).toBe(false);
  });

  it('discards the result when the conversation was cleared mid-run', async () => {
    let resolveFetch;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const convo = makeConvo(50);
    const promise = compressConversation({
      conversationId: 'c6',
      getVisibleMessages: () => convo,
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      mode: 'manual',
    });

    // Wait until the run is actually blocked on the model call.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    clearCompressionState('c6');
    resolveFetch({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'SUMMARY' } }] }),
    });

    const result = await promise;
    expect(result.status).toBe('discarded');
    expect(store.has('context_summary_c6')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeAutoCompress
// ---------------------------------------------------------------------------

describe('maybeAutoCompress', () => {
  it('runs one range when above threshold', async () => {
    const convo = makeConvo(50); // 5000 > 4000
    const result = await maybeAutoCompress({
      conversationId: 'a1',
      getVisibleMessages: () => convo,
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      isIncognito: false,
    });
    expect(result.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCompressionState('a1').chunks).toHaveLength(1);
  });

  it('skips when auto is disabled', async () => {
    const result = await maybeAutoCompress({
      conversationId: 'a2',
      getVisibleMessages: () => makeConvo(50),
      settings: makeSettings({ context_compression_enabled: false }),
      apiKey: 'key',
      branchPath: [],
      isIncognito: false,
    });
    expect(result.reason).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips without an API key or in incognito', async () => {
    const noKey = await maybeAutoCompress({
      conversationId: 'a3',
      getVisibleMessages: () => makeConvo(50),
      settings: makeSettings(),
      apiKey: '',
      branchPath: [],
      isIncognito: false,
    });
    expect(noKey.reason).toBe('no_api_key');

    const incognito = await maybeAutoCompress({
      conversationId: 'a3',
      getVisibleMessages: () => makeConvo(50),
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      isIncognito: true,
    });
    expect(incognito.reason).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips below the threshold', async () => {
    const result = await maybeAutoCompress({
      conversationId: 'a4',
      getVisibleMessages: () => makeConvo(10),
      settings: makeSettings(),
      apiKey: 'key',
      branchPath: [],
      isIncognito: false,
    });
    expect(result.reason).toBe('below_threshold');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sidecar loading & misc
// ---------------------------------------------------------------------------

describe('loadCompressionState', () => {
  it('loads stored chunks into state', async () => {
    store.set('context_summary_l1', {
      chunks: [
        {
          id: 'ctx_1',
          anchorMessageId: 'm3',
          sourceMessageIds: ['m0', 'm1', 'm2', 'm3'],
          summaryText: 'older context',
          status: 'completed',
          sourceTokens: 400,
          summaryTokens: 5,
        },
      ],
    });

    await loadCompressionState('l1');
    const convo = makeConvo(10);
    refreshCompressionState('l1', convo, makeSettings());

    const state = getCompressionState('l1');
    expect(state.loaded).toBe(true);
    expect(state.validSummaries).toHaveLength(1);
    expect(state.validSummaries[0].endIndex).toBe(3);
  });
});

describe('formatTokenCount', () => {
  it('formats compactly', () => {
    expect(formatTokenCount(48000)).toBe('~48k');
    expect(formatTokenCount(900)).toBe('~900');
    expect(formatTokenCount(0)).toBe('0');
  });
});
