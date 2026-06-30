/**
 * @file contextCompressionPipeline.test.js
 * @description Unit tests for the context compression pipeline:
 * settings resolution, trigger detection, marker insertion, and marker
 * updates.
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

import {
  resolveCompressionSettings,
  shouldRunCompression,
  insertInProgressMarker,
  updateMarker,
} from '../app/composables/contextCompressionPipeline.js';

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
    compressedBy: 'deepseek/deepseek-v4-flash',
    tokenEstimate: 100,
    sourceMessageIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe('resolveCompressionSettings', () => {
  it('uses defaults when settings are empty', () => {
    const resolved = resolveCompressionSettings({});
    expect(resolved.enabled).toBe(true);
    expect(resolved.model).toBe('deepseek/deepseek-v4-flash');
    expect(resolved.chunkSize).toBe(10);
    expect(resolved.minChunkTokens).toBe(2000);
  });

  it('reads configured values', () => {
    const resolved = resolveCompressionSettings({
      context_compression_enabled: false,
      context_compression_model: 'custom/model',
      context_compression_chunk_size: 5,
      context_compression_min_chunk_tokens: 1000,
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.model).toBe('custom/model');
    expect(resolved.chunkSize).toBe(5);
    expect(resolved.minChunkTokens).toBe(1000);
  });

  it('clamps invalid values to safe defaults', () => {
    const resolved = resolveCompressionSettings({
      context_compression_chunk_size: 1,
      context_compression_min_chunk_tokens: -100,
    });
    expect(resolved.chunkSize).toBe(10);
    expect(resolved.minChunkTokens).toBe(2000);
  });
});

describe('shouldRunCompression', () => {
  it('does not run when disabled', () => {
    const messages = [makeUser('u1', 'a'.repeat(10000))];
    const result = shouldRunCompression(messages, { context_compression_enabled: false });
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('does not run when no chunk closes', () => {
    const messages = [makeUser('u1'), makeAssistant('a1')];
    const result = shouldRunCompression(messages, { context_compression_chunk_size: 2 });
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe('chunk_not_closed');
  });

  it('does not run when the chunk is below the token floor', () => {
    const messages = [
      makeUser('u1', 'short'),
      makeAssistant('a1', 'short reply'),
      makeUser('u2', 'short'),
      makeAssistant('a2', 'short reply'),
      makeUser('u3', 'next'),
    ];
    const result = shouldRunCompression(messages, {
      context_compression_chunk_size: 2,
      context_compression_min_chunk_tokens: 1000,
    });
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe('below_token_floor');
  });

  it('runs when a closed chunk exceeds the token floor', () => {
    const messages = [
      makeUser('u1', 'a'.repeat(3000)),
      makeAssistant('a1', 'a'.repeat(3000)),
      makeUser('u2', 'a'.repeat(3000)),
      makeAssistant('a2', 'a'.repeat(3000)),
      makeUser('u3', 'next'),
    ];
    const result = shouldRunCompression(messages, {
      context_compression_chunk_size: 2,
      context_compression_min_chunk_tokens: 1000,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('does not double-cover an already summarized chunk', () => {
    const messages = [
      makeUser('u1', 'a'.repeat(3000)),
      makeAssistant('a1', 'a'.repeat(3000)),
      makeUser('u2', 'a'.repeat(3000)),
      makeAssistant('a2', 'a'.repeat(3000)),
      makeMarker({ id: 'ctx_1', rangeStart: 1, rangeEnd: 2, status: 'completed' }),
      makeUser('u3', 'a'.repeat(3000)),
      makeAssistant('a3', 'a'.repeat(3000)),
      makeUser('u4', 'a'.repeat(3000)),
      makeAssistant('a4', 'a'.repeat(3000)),
      makeUser('u5', 'next'),
    ];
    const result = shouldRunCompression(messages, {
      context_compression_chunk_size: 2,
      context_compression_min_chunk_tokens: 1000,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.chunk.rangeStart).toBe(3);
  });
});

describe('insertInProgressMarker', () => {
  it('inserts a marker after the last chunk message', () => {
    const u1 = makeUser('u1');
    const a1 = makeAssistant('a1');
    const messages = [u1, a1];
    const chunk = {
      chunk: messages,
      rangeStart: 1,
      rangeEnd: 1,
    };
    const { messages: nextMessages, marker } = insertInProgressMarker(messages, chunk, {
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(marker.role).toBe('context_summary');
    expect(marker.status).toBe('in_progress');
    expect(marker.parentId).toBe('a1');
    expect(nextMessages.map((m) => m.id)).toEqual(['u1', 'a1', marker.id]);
  });

  it('appends the marker when the chunk message is not found', () => {
    const chunk = {
      chunk: [makeUser('missing')],
      rangeStart: 1,
      rangeEnd: 1,
    };
    const { messages: nextMessages, marker } = insertInProgressMarker([], chunk, {
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(nextMessages).toHaveLength(1);
    expect(nextMessages[0].id).toBe(marker.id);
  });
});

describe('updateMarker', () => {
  it('updates only the matching marker by id', () => {
    const marker1 = makeMarker({ id: 'ctx_1', status: 'in_progress' });
    const marker2 = makeMarker({ id: 'ctx_2', status: 'in_progress' });
    const messages = [marker1, marker2];
    const result = updateMarker(messages, 'ctx_1', { status: 'completed', summaryText: 'Done' });
    expect(result[0].status).toBe('completed');
    expect(result[0].summaryText).toBe('Done');
    expect(result[1].status).toBe('in_progress');
  });

  it('returns the original array when markerId is missing', () => {
    const messages = [makeMarker()];
    expect(updateMarker(messages, null, { status: 'completed' })).toBe(messages);
  });
});
