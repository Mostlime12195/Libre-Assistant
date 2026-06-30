/**
 * @file contextCompressor.test.js
 * @description Unit tests for the context compression core module:
 * sidecar I/O, chunk identification, token estimation, marker building,
 * and API-history transformation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import {
  CONTEXT_SUMMARY_KEY_PREFIX,
  DEFAULT_COMPRESSION_MODEL,
  loadContextSummary,
  saveContextSummary,
  deleteContextSummary,
  hashBranchPath,
  countUserTurns,
  getContextSummaryMarkers,
  identifyNextChunk,
  estimateMessageTokens,
  estimateChunkTokens,
  buildInProgressMarker,
  renderContextSummaryAsApiMessage,
  transformHistoryForAPI,
  callCompressionModel,
} from '../app/composables/contextCompressor.js';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

afterEach(() => {
  store.clear();
  vi.restoreAllMocks();
});

function makeUser(id, content = '') {
  return { id, role: 'user', content, timestamp: new Date(), complete: true };
}

function makeAssistant(id, content = '') {
  return { id, role: 'assistant', content, timestamp: new Date(), complete: true };
}

function makeMarker(overrides = {}) {
  return {
    id: 'ctx_1',
    role: 'context_summary',
    parentId: null,
    branchIndex: 0,
    timestamp: new Date(),
    rangeStart: 1,
    rangeEnd: 2,
    status: 'completed',
    summaryText: 'summary',
    compressedAt: new Date().toISOString(),
    compressedBy: DEFAULT_COMPRESSION_MODEL,
    tokenEstimate: 100,
    sourceMessageIds: [],
    ...overrides,
  };
}

describe('hashBranchPath', () => {
  it('returns "root" for empty paths', () => {
    expect(hashBranchPath([])).toBe('root');
    expect(hashBranchPath(null)).toBe('root');
  });

  it('joins branch indices with dashes', () => {
    expect(hashBranchPath([0, 1, 0])).toBe('0-1-0');
  });
});

describe('countUserTurns', () => {
  it('counts only user messages', () => {
    const messages = [
      makeUser('u1'),
      makeAssistant('a1'),
      makeUser('u2'),
      makeUser('u3'),
    ];
    expect(countUserTurns(messages)).toBe(3);
  });

  it('ignores context_summary markers', () => {
    const messages = [makeUser('u1'), makeMarker(), makeUser('u2')];
    expect(countUserTurns(messages)).toBe(2);
  });

  it('handles non-arrays', () => {
    expect(countUserTurns(null)).toBe(0);
    expect(countUserTurns(undefined)).toBe(0);
  });
});

describe('getContextSummaryMarkers', () => {
  it('returns completed and in_progress markers, ignoring stale', () => {
    const messages = [
      makeMarker({ id: 'ctx_1', status: 'completed' }),
      makeMarker({ id: 'ctx_2', status: 'in_progress' }),
      makeMarker({ id: 'ctx_3', status: 'stale' }),
    ];
    const markers = getContextSummaryMarkers(messages);
    expect(markers.map((m) => m.id)).toEqual(['ctx_1', 'ctx_2']);
  });
});

describe('identifyNextChunk', () => {
  it('identifies the first chunk of user turns', () => {
    const messages = [
      makeUser('u1'),
      makeAssistant('a1'),
      makeUser('u2'),
      makeAssistant('a2'),
      makeUser('u3'),
    ];
    const result = identifyNextChunk(messages, 2);
    expect(result.rangeStart).toBe(1);
    expect(result.rangeEnd).toBe(2);
    expect(result.chunk.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(result.isClosed).toBe(true);
  });

  it('skips messages already covered by a completed marker', () => {
    const messages = [
      makeUser('u1'),
      makeAssistant('a1'),
      makeUser('u2'),
      makeMarker({ id: 'ctx_1', rangeStart: 1, rangeEnd: 2, status: 'completed' }),
      makeUser('u3'),
      makeAssistant('a2'),
      makeUser('u4'),
      makeAssistant('a3'),
      makeUser('u5'),
    ];
    const result = identifyNextChunk(messages, 2);
    expect(result.rangeStart).toBe(3);
    expect(result.rangeEnd).toBe(4);
    expect(result.isClosed).toBe(true);
  });

  it('marks a chunk as not closed until the next user turn arrives', () => {
    const messages = [
      makeUser('u1'),
      makeAssistant('a1'),
      makeUser('u2'),
      makeAssistant('a2'),
    ];
    const result = identifyNextChunk(messages, 2);
    expect(result.rangeStart).toBe(1);
    expect(result.rangeEnd).toBe(2);
    expect(result.isClosed).toBe(false);
  });

  it('returns null when there are no user turns', () => {
    const messages = [makeAssistant('a1'), makeAssistant('a2')];
    expect(identifyNextChunk(messages, 2)).toBeNull();
  });
});

describe('estimateMessageTokens', () => {
  it('estimates from string content', () => {
    const msg = makeUser('u1', 'a'.repeat(400));
    expect(estimateMessageTokens(msg)).toBe(100);
  });

  it('includes reasoning at half weight', () => {
    const msg = { ...makeAssistant('a1', ''), reasoning: 'a'.repeat(400) };
    expect(estimateMessageTokens(msg)).toBe(50);
  });

  it('counts parts content', () => {
    const msg = {
      ...makeAssistant('a1'),
      parts: [
        { type: 'content', content: 'a'.repeat(400) },
        { type: 'reasoning', content: 'b'.repeat(400) },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(150);
  });

  it('returns at least 1 token', () => {
    expect(estimateMessageTokens({})).toBe(1);
  });
});

describe('estimateChunkTokens', () => {
  it('sums token estimates for all messages', () => {
    const messages = [
      makeUser('u1', 'a'.repeat(400)),
      makeAssistant('a1', 'b'.repeat(400)),
    ];
    expect(estimateChunkTokens(messages)).toBe(200);
  });
});

describe('buildInProgressMarker', () => {
  it('returns a context_summary marker with default values', () => {
    const marker = buildInProgressMarker({
      rangeStart: 1,
      rangeEnd: 10,
      parentId: 'parent',
      tokenEstimate: 500,
    });
    expect(marker.role).toBe('context_summary');
    expect(marker.status).toBe('in_progress');
    expect(marker.rangeStart).toBe(1);
    expect(marker.rangeEnd).toBe(10);
    expect(marker.parentId).toBe('parent');
    expect(marker.compressedBy).toBe(DEFAULT_COMPRESSION_MODEL);
    expect(marker.summaryText).toBeNull();
  });
});

describe('renderContextSummaryAsApiMessage', () => {
  it('renders a completed marker as a labeled user message', () => {
    const marker = makeMarker({ rangeStart: 1, rangeEnd: 10, summaryText: 'A short summary.' });
    const rendered = renderContextSummaryAsApiMessage(marker);
    expect(rendered.role).toBe('user');
    expect(rendered.content).toContain('Context summary: messages 1–10');
    expect(rendered.content).toContain('A short summary.');
    expect(rendered.content).toContain('--- end summary ---');
  });

  it('returns null for non-completed markers', () => {
    const marker = makeMarker({ status: 'in_progress' });
    expect(renderContextSummaryAsApiMessage(marker)).toBeNull();
  });
});

describe('transformHistoryForAPI', () => {
  it('replaces covered messages with a single summary message', () => {
    const u1 = makeUser('u1', 'hello');
    const a1 = makeAssistant('a1', 'hi');
    const marker = makeMarker({
      id: 'ctx_1',
      rangeStart: 1,
      rangeEnd: 1,
      status: 'completed',
      summaryText: 'User said hello.',
      sourceMessageIds: ['u1', 'a1'],
    });
    const u2 = makeUser('u2', 'world');
    const a2 = makeAssistant('a2', 'earth');

    const result = transformHistoryForAPI([u1, a1, marker, u2, a2]);
    expect(result.length).toBe(4);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('User said hello.');
    expect(result[1].role).toBe('assistant');
    expect(result[2]).toEqual(u2);
    expect(result[3]).toEqual(a2);
  });

  it('keeps messages verbatim when there are no completed markers', () => {
    const messages = [makeUser('u1'), makeAssistant('a1')];
    const result = transformHistoryForAPI(messages);
    expect(result).toEqual(messages);
  });

  it('drops in-progress markers', () => {
    const marker = makeMarker({ status: 'in_progress', summaryText: null });
    const messages = [makeUser('u1'), marker, makeUser('u2')];
    const result = transformHistoryForAPI(messages);
    expect(result.map((m) => m.role)).toEqual(['user', 'user']);
  });
});

describe('sidecar I/O', () => {
  it('loads an empty sidecar when none exists', async () => {
    const sidecar = await loadContextSummary('conv-1');
    expect(sidecar.conversationId).toBe('conv-1');
    expect(sidecar.chunks).toEqual([]);
  });

  it('saves and loads a sidecar record', async () => {
    await saveContextSummary('conv-1', { chunks: [{ rangeStart: 1, rangeEnd: 2 }] });
    const sidecar = await loadContextSummary('conv-1');
    expect(sidecar.chunks).toHaveLength(1);
    expect(sidecar.chunks[0].rangeStart).toBe(1);
  });

  it('deletes a sidecar record', async () => {
    await saveContextSummary('conv-1', { chunks: [] });
    expect(store.has(`${CONTEXT_SUMMARY_KEY_PREFIX}conv-1`)).toBe(true);
    await deleteContextSummary('conv-1');
    expect(store.has(`${CONTEXT_SUMMARY_KEY_PREFIX}conv-1`)).toBe(false);
  });
});

describe('callCompressionModel', () => {
  it('returns summary text on a successful API response', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '  Summary text  ' } }],
      }),
    });

    const chunk = [makeUser('u1', 'hello')];
    const result = await callCompressionModel(chunk, {
      apiKey: 'key',
      model: 'model',
      rangeStart: 1,
      rangeEnd: 1,
    });

    expect(result).toBe('Summary text');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('model');
    expect(body.customApiKey).toBe('key');
  });

  it('returns null when the API request fails', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const chunk = [makeUser('u1', 'hello')];
    const result = await callCompressionModel(chunk, {
      apiKey: 'key',
      rangeStart: 1,
      rangeEnd: 1,
    });
    expect(result).toBeNull();
  });

  it('returns null for empty chunks', async () => {
    const result = await callCompressionModel([], { apiKey: 'key' });
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
