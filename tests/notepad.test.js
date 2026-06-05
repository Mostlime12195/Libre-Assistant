/**
 * @file notepad.test.js
 * @description Unit tests for the notepad core module: validation,
 * section formatting, frontmatter stripping, and migration.
 * The persistence functions exercise the mocked localforage directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Shared in-memory store. `vi.hoisted` is the supported way to
// share state with `vi.mock` factory closures across tests.
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

import {
  stripFrontmatter,
  validateNotepad,
  getNotepadSection,
  exportNotepadAsDownload,
  isNotepadEnabled,
  migrateLegacyNotepadIfNeeded,
  loadNotepad,
  saveNotepad,
  resetNotepad,
} from '../app/composables/notepad.js';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  store.clear();
});

describe('stripFrontmatter', () => {
  it('strips a leading YAML frontmatter block', () => {
    const content = `---
version: 1
updateCount: 3
---

# Notes on the User
content here`;
    expect(stripFrontmatter(content)).toBe('# Notes on the User\ncontent here');
  });

  it('returns content unchanged when there is no frontmatter', () => {
    const content = '# Notes\n\nJust plain markdown.';
    expect(stripFrontmatter(content)).toBe('# Notes\n\nJust plain markdown.');
  });

  it('handles non-string input safely', () => {
    expect(stripFrontmatter(null)).toBe('');
    expect(stripFrontmatter(undefined)).toBe('');
    expect(stripFrontmatter(42)).toBe('');
  });
});

describe('validateNotepad', () => {
  it('accepts a normal-length notepad', () => {
    const result = validateNotepad(
      '# Notes on the user\n\nThe user likes TypeScript.',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects empty content', () => {
    expect(validateNotepad('')).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(validateNotepad(null)).toEqual({
      valid: false,
      error: expect.any(String),
    });
  });

  it('rejects content that is too short to be meaningful', () => {
    expect(validateNotepad('hi')).toEqual({
      valid: false,
      error: expect.any(String),
    });
  });
});

describe('getNotepadSection', () => {
  it('returns an empty string for an empty notepad', () => {
    expect(getNotepadSection({ content: '', metadata: {} })).toBe('');
    expect(getNotepadSection(null)).toBe('');
  });

  it('wraps non-empty content with a clear section header', () => {
    const section = getNotepadSection({
      content: 'The user is learning Vue.',
      metadata: {},
    });
    expect(section).toContain('My Notepad');
    expect(section).toContain('The user is learning Vue.');
    expect(section).toContain('---');
  });

  it('does not inject content that is only whitespace', () => {
    expect(
      getNotepadSection({ content: '   \n  \n', metadata: {} }),
    ).toBe('');
  });
});

describe('exportNotepadAsDownload', () => {
  it('produces a Blob URL and a revoke function', () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let createdWith = null;
    URL.createObjectURL = (blob) => {
      createdWith = blob;
      return 'blob:test-url';
    };
    URL.revokeObjectURL = () => {};

    try {
      const { url, revoke } = exportNotepadAsDownload({
        content: '# Hello',
      });
      expect(url).toBe('blob:test-url');
      expect(typeof revoke).toBe('function');
      expect(createdWith).toBeInstanceOf(Blob);
      expect(createdWith.type).toBe('text/markdown');
      expect(() => revoke()).not.toThrow();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('handles missing content gracefully', () => {
    const { url } = exportNotepadAsDownload({ content: '' });
    expect(typeof url).toBe('string');
  });
});

describe('isNotepadEnabled', () => {
  it('returns true only when the setting is explicitly true', () => {
    expect(isNotepadEnabled({ notepad_enabled: true })).toBe(true);
    expect(isNotepadEnabled({ notepad_enabled: false })).toBe(false);
    expect(isNotepadEnabled({})).toBe(false);
    expect(isNotepadEnabled(null)).toBe(false);
  });
});

describe('migration from legacy notebook layout', () => {
  it('moves legacy user_notebook content to user_notepad and strips frontmatter', async () => {
    const legacyContent = `---
version: 1
updateCount: 7
---

# Notes on the User
The user is debugging Vue.`;
    const legacyMetadata = { version: 1, updateCount: 7 };

    store.set('user_notebook', legacyContent);
    store.set('user_notebook_metadata', legacyMetadata);

    const { migrated } = await migrateLegacyNotepadIfNeeded();
    expect(migrated).toBe(true);

    expect(store.get('user_notepad')).toBe(
      '# Notes on the User\nThe user is debugging Vue.',
    );
    const newMeta = store.get('user_notepad_metadata');
    expect(newMeta.updateCount).toBe(7);
    expect(store.has('user_notebook')).toBe(false);
    expect(store.has('user_notebook_metadata')).toBe(false);
  });

  it('removes the legacy global_chatbot_memory key even when nothing to migrate', async () => {
    store.set('global_chatbot_memory', ['old fact']);
    const { migrated } = await migrateLegacyNotepadIfNeeded();
    expect(migrated).toBe(false);
    expect(store.has('global_chatbot_memory')).toBe(false);
  });

  it('does nothing when the new layout is already in place', async () => {
    store.set('user_notepad', '# Already here');
    store.set('user_notepad_metadata', { updateCount: 1 });
    const { migrated } = await migrateLegacyNotepadIfNeeded();
    expect(migrated).toBe(false);
    expect(store.get('user_notepad')).toBe('# Already here');
  });
});

describe('loadNotepad', () => {
  it('returns an empty notepad with default metadata when nothing is stored', async () => {
    const notepad = await loadNotepad();
    expect(notepad.content).toBe('');
    expect(notepad.metadata).toMatchObject({
      version: 1,
      updateCount: 0,
      lastConsolidatedAt: null,
    });
  });

  it('returns the stored content and metadata', async () => {
    store.set('user_notepad', '# Existing content');
    store.set('user_notepad_metadata', {
      version: 1,
      lastUpdated: '2024-01-01T00:00:00.000Z',
      updateCount: 4,
      lastConsolidatedAt: '2024-01-01T00:00:00.000Z',
    });
    const notepad = await loadNotepad();
    expect(notepad.content).toBe('# Existing content');
    expect(notepad.metadata.updateCount).toBe(4);
  });
});

describe('saveNotepad', () => {
  it('writes content and merges metadata, stamping lastUpdated', async () => {
    const result = await saveNotepad('# New content', { updateCount: 5 });
    expect(result.content).toBe('# New content');
    expect(result.metadata.updateCount).toBe(5);
    expect(result.metadata.lastUpdated).toBeTruthy();
    expect(store.get('user_notepad')).toBe('# New content');
  });

  it('preserves metadata fields not in the patch', async () => {
    await saveNotepad('first', { updateCount: 1, lastConsolidatedAt: 'x' });
    const result = await saveNotepad('second', { updateCount: 2 });
    expect(result.metadata.updateCount).toBe(2);
    expect(result.metadata.lastConsolidatedAt).toBe('x');
  });
});

describe('resetNotepad', () => {
  it('clears the content and resets metadata', async () => {
    await saveNotepad('something', { updateCount: 3 });
    await resetNotepad();
    expect(store.get('user_notepad')).toBe('');
    const meta = store.get('user_notepad_metadata');
    expect(meta.updateCount).toBe(0);
    expect(meta.lastConsolidatedAt).toBeNull();
  });
});
