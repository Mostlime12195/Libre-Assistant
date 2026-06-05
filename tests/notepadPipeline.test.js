/**
 * @file notepadPipeline.test.js
 * @description Unit tests for the notepad pipeline helpers that don't
 * require network or localforage: the consolidation prompt builder
 * and trigger detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock helpers so they're available to the vi.mock factories
// (which are themselves hoisted to the top of the file).
const hoisted = vi.hoisted(() => {
  const chatSummarizerMock = {
    getChatsNeedingSummary: vi.fn(async () => []),
    getAllChatSummaries: vi.fn(async () => []),
    processChatSummaries: vi.fn(async () => []),
  };
  const localforageStore = new Map();
  return { chatSummarizerMock, localforageStore };
});

vi.mock('../app/composables/chatSummarizer.js', () => hoisted.chatSummarizerMock);

vi.mock('~/composables/useSession', () => ({
  getSessionToken: vi.fn(async () => 'test-token'),
}));

vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async (key) =>
      hoisted.localforageStore.has(key) ? hoisted.localforageStore.get(key) : null,
    ),
    setItem: vi.fn(async (key, value) => {
      hoisted.localforageStore.set(key, value);
      return value;
    }),
    removeItem: vi.fn(async (key) => {
      hoisted.localforageStore.delete(key);
    }),
  },
}));

import { buildConsolidationPrompt, shouldRunNotepadPipeline } from '../app/composables/notepadPipeline.js';

const { chatSummarizerMock, localforageStore } = hoisted;

beforeEach(() => {
  localforageStore.clear();
  vi.clearAllMocks();
});

describe('buildConsolidationPrompt', () => {
  it('frames the task as a REPLACEMENT, not an append', () => {
    const prompt = buildConsolidationPrompt({
      previousNotepad: '',
      summaries: [],
      today: '2026-06-01',
    });

    // The prompt should make the overwrite contract crystal clear.
    expect(prompt).toMatch(/REPLACES the previous notepad/i);
    expect(prompt).toMatch(/Do NOT start with phrases like/i);
    expect(prompt).toMatch(/No YAML frontmatter/i);
  });

  it('embeds the previous notepad and the new summaries', () => {
    const prompt = buildConsolidationPrompt({
      previousNotepad: 'The user likes cats.',
      summaries: [
        {
          title: 'Cat breeds',
          summary: 'They discussed Maine Coons vs Siamese.',
          lastSummarizedAt: '2026-05-15T10:00:00.000Z',
        },
      ],
      today: '2026-06-01',
    });

    expect(prompt).toContain('The user likes cats.');
    expect(prompt).toContain('Cat breeds');
    expect(prompt).toContain('Maine Coons vs Siamese');
    // The summary should be tagged with a date prefix.
    expect(prompt).toMatch(/\[.*Cat breeds.*\]/);
  });

  it('forbids sycophantic tone explicitly', () => {
    const prompt = buildConsolidationPrompt({
      previousNotepad: '',
      summaries: [],
      today: '2026-06-01',
    });

    expect(prompt).toMatch(/Avoid sycophantic language/i);
    expect(prompt).toMatch(/Observational, not evaluative/i);
  });

  it('forbids invented personality or filled-in gaps', () => {
    const prompt = buildConsolidationPrompt({
      previousNotepad: '',
      summaries: [],
      today: '2026-06-01',
    });

    // The wording shifted between prompt iterations; check the
    // substance (forbid invention, allow omission) rather than a
    // specific phrase.
    expect(prompt).toMatch(/invent personality traits/i);
    expect(prompt).toMatch(/OMIT it/i);
  });

  it('signals that the model can choose any size or structure', () => {
    const prompt = buildConsolidationPrompt({
      previousNotepad: '',
      summaries: [],
      today: '2026-06-01',
    });

    expect(prompt).toMatch(/no fixed length/i);
    expect(prompt).toMatch(/use your judgment/i);
  });

  it('falls back to a placeholder for empty previous notepad', () => {
    const prompt = buildConsolidationPrompt({
      previousNotepad: '   \n\n  ',
      summaries: [],
      today: '2026-06-01',
    });
    expect(prompt).toMatch(/empty .* write from scratch/i);
  });
});

describe('shouldRunNotepadPipeline', () => {
  it('returns shouldRun:false when no triggers fire and no orphans', async () => {
    chatSummarizerMock.getChatsNeedingSummary.mockResolvedValueOnce([]);
    chatSummarizerMock.getAllChatSummaries.mockResolvedValueOnce([]);

    // No notepad stored, no metadata.
    const result = await shouldRunNotepadPipeline();
    expect(result.shouldRun).toBe(false);
  });

  it('triggers when ≥5 chats need summarization', async () => {
    chatSummarizerMock.getChatsNeedingSummary.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })),
    );
    chatSummarizerMock.getAllChatSummaries.mockResolvedValueOnce([]);

    const result = await shouldRunNotepadPipeline();
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toMatch(/5 chats need summarization/);
  });

  it('does NOT re-process summaries just because they are newer than lastUpdated', async () => {
    // This is the key regression: previously the pipeline would
    // re-consolidate any summary with lastSummarizedAt > lastUpdated,
    // even when the summary had already been incorporated. We
    // verify that the trigger logic only fires for genuinely
    // un-incorporated summaries.
    const recent = new Date().toISOString();
    chatSummarizerMock.getChatsNeedingSummary.mockResolvedValueOnce([]);
    chatSummarizerMock.getAllChatSummaries.mockResolvedValueOnce([
      {
        conversationId: 'c1',
        title: 'Already incorporated',
        summary: 'This summary was already folded in.',
        lastSummarizedAt: recent,
        incorporatedAt: recent,
      },
    ]);

    // No fresh notepad updates (a 5-min-old lastUpdated is well below
    // the 24h and 48h thresholds).
    localforageStore.set('user_notepad_metadata', {
      version: 1,
      lastUpdated: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      updateCount: 3,
      lastConsolidatedAt: recent,
    });

    const result = await shouldRunNotepadPipeline();
    expect(result.shouldRun).toBe(false);
  });

  it('triggers when a day has passed and there are un-incorporated summaries', async () => {
    chatSummarizerMock.getChatsNeedingSummary.mockResolvedValueOnce([]);
    chatSummarizerMock.getAllChatSummaries.mockResolvedValueOnce([
      {
        conversationId: 'c1',
        title: 'New chat',
        summary: 'Something new came up.',
        lastSummarizedAt: new Date().toISOString(),
        incorporatedAt: null,
      },
    ]);

    // Backdate the notepad so the 24h time threshold is met.
    localforageStore.set('user_notepad_metadata', {
      version: 1,
      lastUpdated: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      updateCount: 3,
      lastConsolidatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    });

    const result = await shouldRunNotepadPipeline();
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toMatch(/new summaries/i);
  });
});
