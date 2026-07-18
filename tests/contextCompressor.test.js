/**
 * @file contextCompressor.test.js
 * @description Unit tests for the sidecar-based context compression core:
 * settings resolution, token estimation, summary validity, range
 * selection, history transformation, and sidecar normalization.
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
  loadContextSummary,
  saveContextSummary,
  deleteContextSummary,
  resolveCompressionSettings,
  estimateMessageTokens,
  estimateChunkTokens,
  findValidSummaries,
  buildApiHistory,
  estimateEffectiveTokens,
  selectCompressionRange,
  shouldOfferCompression,
  buildSummaryRecord,
  renderSummaryAsApiMessage,
  hashBranchPath,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_KEEP_RECENT_TOKENS,
  MAX_RANGE_TOKENS,
} from '../app/composables/contextCompressor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(id, content = '') {
  return { id, role: 'user', content, timestamp: new Date(), complete: true };
}

function makeAssistant(id, content = '') {
  return { id, role: 'assistant', content, timestamp: new Date(), complete: true };
}

/** A message whose estimated token count is exactly `tokens`. */
function msgOfTokens(id, role, tokens) {
  const content = 'x'.repeat(tokens * 4);
  return role === 'user' ? makeUser(id, content) : makeAssistant(id, content);
}

/** Builds n alternating messages (m0 user, m1 assistant, ...), 100 tokens each. */
function makeConvo(n, tokensEach = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(msgOfTokens(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', tokensEach));
  }
  return out;
}

function makeChunk(ids, overrides = {}) {
  return {
    id: overrides.id || `ctx_${ids[0]}`,
    anchorMessageId: ids[ids.length - 1],
    sourceMessageIds: ids.slice(),
    summaryText: 'compressed summary text',
    status: 'completed',
    compressedAt: new Date().toISOString(),
    compressedBy: 'test-model',
    sourceTokens: 100 * ids.length,
    summaryTokens: 10,
    branchPathHash: 'root',
    ...overrides,
  };
}

beforeEach(() => {
  store.clear();
});

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

describe('resolveCompressionSettings', () => {
  it('returns defaults for empty settings', () => {
    const s = resolveCompressionSettings({});
    expect(s.enabled).toBe(true);
    expect(s.model).toBe('deepseek/deepseek-v4-flash');
    expect(s.thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS);
    expect(s.keepRecentTokens).toBe(DEFAULT_KEEP_RECENT_TOKENS);
  });

  it('respects explicit values', () => {
    const s = resolveCompressionSettings({
      context_compression_enabled: false,
      context_compression_model: '  custom/model  ',
      context_compression_threshold_tokens: 20000,
      context_compression_keep_recent_tokens: 3000,
    });
    expect(s.enabled).toBe(false);
    expect(s.model).toBe('custom/model');
    expect(s.thresholdTokens).toBe(20000);
    expect(s.keepRecentTokens).toBe(3000);
  });

  it('falls back on invalid numbers', () => {
    const s = resolveCompressionSettings({
      context_compression_threshold_tokens: 100, // below minimum
      context_compression_keep_recent_tokens: -5,
    });
    expect(s.thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS);
    expect(s.keepRecentTokens).toBe(DEFAULT_KEEP_RECENT_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('estimateMessageTokens', () => {
  it('estimates plain content', () => {
    expect(estimateMessageTokens(makeUser('u', 'x'.repeat(400)))).toBe(100);
  });

  it('counts content parts and half-weight reasoning', () => {
    const msg = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'content', content: 'x'.repeat(400) },
        { type: 'reasoning', content: 'y'.repeat(400) },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(150);
  });

  it('counts tool results at full weight', () => {
    const msg = {
      id: 'a',
      role: 'assistant',
      parts: [
        {
          type: 'tool_group',
          tools: [
            { function: { arguments: 'x'.repeat(40) }, result: 'y'.repeat(360) },
          ],
        },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(100);
  });

  it('never returns zero for a message', () => {
    expect(estimateMessageTokens(makeUser('u', ''))).toBe(1);
    expect(estimateMessageTokens(null)).toBe(0);
  });
});

describe('estimateChunkTokens', () => {
  it('sums message estimates', () => {
    const convo = makeConvo(5);
    expect(estimateChunkTokens(convo)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Sidecar I/O
// ---------------------------------------------------------------------------

describe('sidecar I/O', () => {
  it('round-trips chunk records', async () => {
    const chunk = makeChunk(['m0', 'm1']);
    await saveContextSummary('c1', { chunks: [chunk] });
    const record = await loadContextSummary('c1');
    expect(record.chunks).toHaveLength(1);
    expect(record.chunks[0].anchorMessageId).toBe('m1');
  });

  it('discards legacy and malformed records on load', async () => {
    store.set('context_summary_c2', {
      chunks: [
        { rangeStart: 1, rangeEnd: 10, status: 'completed', summaryText: 'old' }, // legacy
        { garbage: true },
        makeChunk(['m0']),
      ],
    });
    const record = await loadContextSummary('c2');
    expect(record.chunks).toHaveLength(1);
    expect(record.chunks[0].anchorMessageId).toBe('m0');
  });

  it('returns an empty record for unknown conversations', async () => {
    const record = await loadContextSummary('nope');
    expect(record.chunks).toEqual([]);
  });

  it('deletes the sidecar', async () => {
    await saveContextSummary('c3', { chunks: [makeChunk(['m0'])] });
    await deleteContextSummary('c3');
    const record = await loadContextSummary('c3');
    expect(record.chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findValidSummaries
// ---------------------------------------------------------------------------

describe('findValidSummaries', () => {
  it('validates a summary whose span matches contiguously', () => {
    const convo = makeConvo(6);
    const chunk = makeChunk(['m0', 'm1', 'm2', 'm3']);
    const valid = findValidSummaries(convo, [chunk]);
    expect(valid).toHaveLength(1);
    expect(valid[0].startIndex).toBe(0);
    expect(valid[0].endIndex).toBe(3);
  });

  it('invalidates a summary when a covered message was edited (id changed)', () => {
    const convo = makeConvo(6);
    const chunk = makeChunk(['m0', 'm1', 'm2', 'm3']);
    const edited = convo.map((m) =>
      m.id === 'm2' ? { ...m, id: 'm2-edited' } : m,
    );
    expect(findValidSummaries(edited, [chunk])).toHaveLength(0);
  });

  it('keeps later summaries valid when an earlier one is invalidated', () => {
    const convo = makeConvo(6);
    const first = makeChunk(['m0', 'm1']);
    const second = makeChunk(['m2', 'm3']);
    const edited = convo.map((m) =>
      m.id === 'm0' ? { ...m, id: 'm0-edited' } : m,
    );
    const valid = findValidSummaries(edited, [first, second]);
    expect(valid).toHaveLength(1);
    expect(valid[0].id).toBe(second.id);
  });

  it('keeps summaries valid on branches that share the covered prefix', () => {
    const convo = makeConvo(4);
    const chunk = makeChunk(['m0', 'm1']);
    const branch = [convo[0], convo[1], makeUser('uX', 'other'), makeAssistant('aX', 'other')];
    const valid = findValidSummaries(branch, [chunk]);
    expect(valid).toHaveLength(1);
  });

  it('skips failed and legacy records', () => {
    const convo = makeConvo(4);
    const failed = makeChunk(['m0', 'm1'], { status: 'failed', summaryText: null });
    const legacy = { rangeStart: 1, rangeEnd: 2, status: 'completed', summaryText: 'x' };
    expect(findValidSummaries(convo, [failed, legacy])).toHaveLength(0);
  });

  it('matches sequential summaries in order', () => {
    const convo = makeConvo(8);
    const s1 = makeChunk(['m0', 'm1']);
    const s2 = makeChunk(['m2', 'm3']);
    const valid = findValidSummaries(convo, [s1, s2]);
    expect(valid).toHaveLength(2);
    expect(valid[1].startIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildApiHistory
// ---------------------------------------------------------------------------

describe('buildApiHistory', () => {
  it('replaces a covered span with summary + acknowledgement', () => {
    const convo = makeConvo(6);
    const valid = findValidSummaries(convo, [makeChunk(['m0', 'm1', 'm2', 'm3'])]);
    const out = buildApiHistory(convo, valid);

    expect(out).toHaveLength(4);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toContain('Earlier conversation summary');
    expect(out[0].content).toContain('compressed summary text');
    expect(out[1].role).toBe('assistant');
    expect(out[2]).toBe(convo[4]);
    expect(out[3]).toBe(convo[5]);
  });

  it('supports multiple summaries', () => {
    const convo = makeConvo(6);
    const valid = findValidSummaries(convo, [
      makeChunk(['m0', 'm1']),
      makeChunk(['m2', 'm3']),
    ]);
    const out = buildApiHistory(convo, valid);
    expect(out).toHaveLength(6);
    expect(out[0].content).toContain('summary');
    expect(out[2].content).toContain('summary');
    expect(out[4]).toBe(convo[4]);
  });

  it('never leaks a summary into a branch sharing only part of its span', () => {
    const convo = makeConvo(4);
    const chunk = makeChunk(['m0', 'm1', 'm2', 'm3']);
    const branch = [convo[0], convo[1], makeUser('uX', 'x'), makeAssistant('aX', 'x')];
    const out = buildApiHistory(branch, [chunk]);
    expect(out).toHaveLength(4);
    expect(out.every((m) => !String(m.content).includes('compressed summary text'))).toBe(true);
  });

  it('returns a verbatim copy when there are no summaries', () => {
    const convo = makeConvo(3);
    const out = buildApiHistory(convo, []);
    expect(out).toEqual(convo);
    expect(out).not.toBe(convo);
  });
});

describe('estimateEffectiveTokens', () => {
  it('counts summaries instead of covered messages', () => {
    const convo = makeConvo(6); // 600 tokens verbatim
    const valid = findValidSummaries(convo, [makeChunk(['m0', 'm1', 'm2', 'm3'])]);
    const effective = estimateEffectiveTokens(convo, valid);
    expect(effective).toBeLessThan(600);
    expect(effective).toBeGreaterThan(150); // tail (200) minus… summary + ack + tail
  });
});

// ---------------------------------------------------------------------------
// selectCompressionRange
// ---------------------------------------------------------------------------

describe('selectCompressionRange', () => {
  it('compresses everything eligible outside the keep-recent window', () => {
    const convo = makeConvo(10); // 100 tokens each
    const range = selectCompressionRange(convo, [], { keepRecentTokens: 200 });
    // Tail: m9 + m8 (200 tokens). Eligible: m0..m7.
    expect(range.sourceMessageIds).toEqual(convo.slice(0, 8).map((m) => m.id));
    expect(range.anchorMessageId).toBe('m7');
    expect(range.tokenEstimate).toBe(800);
  });

  it('starts after the last valid summary', () => {
    const convo = makeConvo(10);
    const valid = findValidSummaries(convo, [makeChunk(['m0', 'm1', 'm2', 'm3'])]);
    const range = selectCompressionRange(convo, valid, { keepRecentTokens: 200 });
    expect(range.sourceMessageIds[0]).toBe('m4');
    expect(range.anchorMessageId).toBe('m7');
  });

  it('returns null when everything fits in the keep-recent window', () => {
    const convo = makeConvo(2);
    expect(
      selectCompressionRange(convo, [], { keepRecentTokens: 500 }),
    ).toBeNull();
  });

  it('sizes the range to the auto target', () => {
    const convo = makeConvo(10);
    const range = selectCompressionRange(convo, [], {
      keepRecentTokens: 200,
      targetTokens: 250,
    });
    expect(range.sourceMessageIds).toEqual(['m0', 'm1']);
    expect(range.tokenEstimate).toBe(200);
  });

  it('pulls in the assistant reply instead of splitting a turn', () => {
    const convo = makeConvo(10);
    const range = selectCompressionRange(convo, [], {
      keepRecentTokens: 200,
      targetTokens: 350,
    });
    // 300 tokens lands on m2 (user); the reply m3 is pulled in.
    expect(range.sourceMessageIds).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(range.tokenEstimate).toBe(400);
  });

  it('caps the range at maxRangeTokens', () => {
    const convo = makeConvo(10);
    const range = selectCompressionRange(convo, [], {
      keepRecentTokens: 200,
      maxRangeTokens: 300,
    });
    expect(range.tokenEstimate).toBeLessThanOrEqual(300);
    expect(range.sourceMessageIds).toEqual(['m0', 'm1', 'm2']);
  });

  it('still makes progress when a single message exceeds the cap', () => {
    const huge = msgOfTokens('big', 'user', MAX_RANGE_TOKENS + 10000);
    const tail = msgOfTokens('tail', 'assistant', 50);
    const range = selectCompressionRange([huge, tail], [], {
      keepRecentTokens: 100,
    });
    expect(range).not.toBeNull();
    expect(range.sourceMessageIds).toEqual(['big']);
  });
});

// ---------------------------------------------------------------------------
// shouldOfferCompression
// ---------------------------------------------------------------------------

describe('shouldOfferCompression', () => {
  it('is true only above threshold with an eligible range', () => {
    expect(
      shouldOfferCompression({ effectiveTokens: 5000, thresholdTokens: 4000, hasEligibleRange: true }),
    ).toBe(true);
    expect(
      shouldOfferCompression({ effectiveTokens: 4000, thresholdTokens: 4000, hasEligibleRange: true }),
    ).toBe(false);
    expect(
      shouldOfferCompression({ effectiveTokens: 9000, thresholdTokens: 4000, hasEligibleRange: false }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Records & rendering
// ---------------------------------------------------------------------------

describe('buildSummaryRecord', () => {
  it('captures coverage and token estimates', () => {
    const range = {
      anchorMessageId: 'm3',
      sourceMessageIds: ['m0', 'm1', 'm2', 'm3'],
      tokenEstimate: 400,
    };
    const record = buildSummaryRecord({
      range,
      summaryText: 'x'.repeat(40),
      model: 'test-model',
      branchPathHash: 'root',
    });
    expect(record.status).toBe('completed');
    expect(record.anchorMessageId).toBe('m3');
    expect(record.sourceMessageIds).toHaveLength(4);
    expect(record.sourceTokens).toBe(400);
    expect(record.summaryTokens).toBe(10);
  });
});

describe('renderSummaryAsApiMessage', () => {
  it('labels the summary with its coverage', () => {
    const rendered = renderSummaryAsApiMessage(makeChunk(['m0', 'm1', 'm2']));
    expect(rendered.role).toBe('user');
    expect(rendered.content).toContain('covers 3 messages');
    expect(rendered.content).toContain('compressed summary text');
  });
});

describe('hashBranchPath', () => {
  it('is stable and branch-sensitive', () => {
    expect(hashBranchPath([])).toBe('root');
    expect(hashBranchPath([0, 1])).toBe('0-1');
  });
});
