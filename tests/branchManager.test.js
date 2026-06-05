/**
 * Tests for app/composables/branchManager.js
 *
 * The branch manager implements the conversation-branching model: a flat
 * messages array where each message has a `parentId` and an optional
 * `branchIndex`, plus helpers to walk the resulting tree, switch branches,
 * and migrate legacy (non-branching) messages.
 */

import { describe, it, expect } from "vitest";
import {
  buildMessageTree,
  getRootMessages,
  getSiblings,
  getSiblingInfo,
  getMessagesForBranchPath,
  calculateBranchPath,
  getNextBranchIndex,
  createBranch,
  switchBranch,
  migrateMessages,
  findBranchPoints,
  getRootSiblingInfo,
  buildSiblingInfoMap,
} from "../app/composables/branchManager.js";

// Helper to build messages with a known date ordering
const msg = (id, parentId, opts = {}) => ({
  id,
  parentId,
  branchIndex: opts.branchIndex ?? 0,
  timestamp: opts.timestamp ?? new Date(0),
  role: opts.role ?? "user",
  content: opts.content ?? "",
});

describe("buildMessageTree", () => {
  it("returns a map keyed by message id with their children populated", () => {
    const messages = [msg("a", null), msg("b", "a")];
    const tree = buildMessageTree(messages);

    expect(tree.size).toBe(2);
    expect(tree.get("a").children).toEqual(["b"]);
    expect(tree.get("b").children).toEqual([]);
  });

  it("populates children arrays based on parentId", () => {
    const messages = [
      msg("a", null),
      msg("b", "a"),
      msg("c", "a"),
    ];
    const tree = buildMessageTree(messages);

    expect(tree.get("a").children).toEqual(["b", "c"]);
    expect(tree.get("b").children).toEqual([]);
    expect(tree.get("c").children).toEqual([]);
  });

  it("does not lose messages with missing parents (orphan-safe)", () => {
    const messages = [msg("a", null), msg("b", "ghost")];
    const tree = buildMessageTree(messages);

    expect(tree.size).toBe(2);
    // "b" should not appear in any children list
    expect(tree.get("a").children).toEqual([]);
  });

  it("returns an empty map for an empty array", () => {
    expect(buildMessageTree([]).size).toBe(0);
  });
});

describe("getRootMessages", () => {
  it("returns only messages with no parent", () => {
    const messages = [
      msg("a", null),
      msg("b", "a"),
      msg("c", "a"),
    ];
    const roots = getRootMessages(messages);
    expect(roots.map((m) => m.id)).toEqual(["a"]);
  });

  it("sorts roots by timestamp ascending", () => {
    const messages = [
      msg("b", null, { timestamp: new Date(200) }),
      msg("a", null, { timestamp: new Date(100) }),
    ];
    const roots = getRootMessages(messages);
    expect(roots.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("getSiblings", () => {
  it("returns messages with the same parentId", () => {
    const messages = [
      msg("a", null),
      msg("b1", "a", { branchIndex: 0 }),
      msg("b2", "a", { branchIndex: 1 }),
    ];
    const sibs = getSiblings(messages, "b1");
    expect(sibs.map((m) => m.id)).toEqual(["b1", "b2"]);
  });

  it("sorts by branchIndex when present", () => {
    const messages = [
      msg("a", null),
      msg("b2", "a", { branchIndex: 2 }),
      msg("b0", "a", { branchIndex: 0 }),
      msg("b1", "a", { branchIndex: 1 }),
    ];
    const sibs = getSiblings(messages, "b2");
    expect(sibs.map((m) => m.id)).toEqual(["b0", "b1", "b2"]);
  });

  it("returns an empty array for an unknown messageId", () => {
    expect(getSiblings([], "ghost")).toEqual([]);
  });
});

describe("getSiblingInfo", () => {
  it("returns current index, total count, and ids", () => {
    const messages = [
      msg("a", null),
      msg("b0", "a", { branchIndex: 0 }),
      msg("b1", "a", { branchIndex: 1 }),
      msg("b2", "a", { branchIndex: 2 }),
    ];
    const info = getSiblingInfo(messages, "b1");
    expect(info).toEqual({
      current: 1,
      total: 3,
      siblings: ["b0", "b1", "b2"],
    });
  });
});

describe("getMessagesForBranchPath", () => {
  it("returns a single-root linear chain when branchPath is empty", () => {
    const messages = [
      msg("a", null),
      msg("b", "a"),
      msg("c", "b"),
    ];
    const visible = getMessagesForBranchPath(messages, []);
    expect(visible.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("follows the chosen branch at a fork", () => {
    const messages = [
      msg("a", null),
      msg("b0", "a", { branchIndex: 0 }),
      msg("b1", "a", { branchIndex: 1 }),
      msg("c0", "b1"),
    ];
    // branchPath[0] = 1 means "pick the second child of `a`"
    const visible = getMessagesForBranchPath(messages, [1]);
    expect(visible.map((m) => m.id)).toEqual(["a", "b1", "c0"]);
  });

  it("handles multiple roots by treating branchPath[0] as the root index", () => {
    const messages = [
      msg("r0", null, { timestamp: new Date(100) }),
      msg("r1", null, { timestamp: new Date(200) }),
    ];
    const visible = getMessagesForBranchPath(messages, [1]);
    expect(visible.map((m) => m.id)).toEqual(["r1"]);
  });

  it("returns [] for empty messages", () => {
    expect(getMessagesForBranchPath([])).toEqual([]);
  });
});

describe("calculateBranchPath", () => {
  it("returns [] for an unknown target id", () => {
    expect(calculateBranchPath([], "ghost")).toEqual([]);
  });

  it("returns the branch indices needed to reach a deeply-nested message", () => {
    // root -> [b0, b1] -> c (child of b1)
    const messages = [
      msg("root", null),
      msg("b0", "root", { branchIndex: 0 }),
      msg("b1", "root", { branchIndex: 1 }),
      msg("c", "b1"),
    ];
    const path = calculateBranchPath(messages, "c");
    expect(path).toEqual([1]); // pick b1 (index 1) at the only fork
  });

  it("includes root index when there are multiple roots and the target is not the first", () => {
    const messages = [
      msg("r0", null, { timestamp: new Date(100) }),
      msg("r1", null, { timestamp: new Date(200) }),
    ];
    const path = calculateBranchPath(messages, "r1");
    expect(path).toEqual([1]);
  });
});

describe("getNextBranchIndex", () => {
  it("returns 0 when there are no siblings", () => {
    expect(getNextBranchIndex([], "p")).toBe(0);
  });

  it("returns max(existing) + 1", () => {
    const messages = [
      msg("b0", "p", { branchIndex: 0 }),
      msg("b1", "p", { branchIndex: 1 }),
    ];
    expect(getNextBranchIndex(messages, "p")).toBe(2);
  });

  it("treats missing branchIndex as 0", () => {
    const messages = [msg("a", "p")];
    expect(getNextBranchIndex(messages, "p")).toBe(1);
  });
});

describe("createBranch", () => {
  it("appends a new message sharing the same parent", () => {
    const messages = [
      msg("a", null),
      msg("b", "a", { branchIndex: 0 }),
    ];
    const result = createBranch(messages, "b", {
      role: "assistant",
      content: "alt response",
    });

    expect(result.messages).toHaveLength(3);
    expect(result.newMessage.parentId).toBe("a");
    expect(result.newMessage.branchIndex).toBe(1);
    expect(result.newMessage.role).toBe("assistant");
    expect(result.newMessage.content).toBe("alt response");
  });

  it("throws if the source message does not exist", () => {
    expect(() => createBranch([], "ghost", {})).toThrow(/not found/);
  });

  it("returns a branchPath that points at the new message", () => {
    const messages = [msg("a", null), msg("b", "a", { branchIndex: 0 })];
    const { branchPath, newMessage } = createBranch(messages, "b", {
      role: "assistant",
      content: "alt",
    });

    // Sanity: passing branchPath back through the getter reaches newMessage
    const visible = getMessagesForBranchPath(
      [...messages, newMessage],
      branchPath
    );
    expect(visible[visible.length - 1].id).toBe(newMessage.id);
  });
});

describe("switchBranch", () => {
  it("changes the branch at a specific fork", () => {
    expect(switchBranch([0, 1, 0], 1, 2)).toEqual([0, 2, 0]);
  });

  it("resets subsequent path entries to 0", () => {
    expect(switchBranch([0, 1, 2, 3], 0, 2)).toEqual([2, 0, 0, 0]);
  });

  it("does not mutate the original array", () => {
    const original = [0, 1, 2];
    switchBranch(original, 0, 5);
    expect(original).toEqual([0, 1, 2]);
  });
});

describe("migrateMessages", () => {
  it("adds parentId/branchIndex to legacy messages in order", () => {
    const legacy = [
      { id: "a", timestamp: new Date(100), role: "user" },
      { id: "b", timestamp: new Date(200), role: "assistant" },
      { id: "c", timestamp: new Date(300), role: "user" },
    ];
    const migrated = migrateMessages(legacy);

    expect(migrated[0].parentId).toBe(null);
    expect(migrated[1].parentId).toBe("a");
    expect(migrated[2].parentId).toBe("b");
    migrated.forEach((m) => expect(m.branchIndex).toBe(0));
  });

  it("returns empty array for empty input", () => {
    expect(migrateMessages([])).toEqual([]);
  });

  it("returns the input unchanged if it is already migrated", () => {
    const migrated = [
      { id: "a", parentId: null, branchIndex: 0 },
    ];
    const result = migrateMessages(migrated);
    expect(result).toBe(migrated); // same reference
  });

  it("sorts by timestamp before linking parents", () => {
    const legacy = [
      { id: "b", timestamp: new Date(200) },
      { id: "a", timestamp: new Date(100) },
    ];
    const migrated = migrateMessages(legacy);
    expect(migrated.map((m) => m.id)).toEqual(["a", "b"]);
    expect(migrated[1].parentId).toBe("a");
  });
});

describe("findBranchPoints", () => {
  it("returns forks (parents with > 1 child)", () => {
    const messages = [
      msg("a", null),
      msg("b0", "a", { branchIndex: 0 }),
      msg("b1", "a", { branchIndex: 1 }),
      msg("c", "b1"),
    ];
    const forks = findBranchPoints(messages);
    expect(forks).toHaveLength(1);
    expect(forks[0].parentId).toBe("a");
    expect(forks[0].messageIds).toEqual(["b0", "b1"]);
  });

  it("returns roots fork for multiple root messages", () => {
    const messages = [
      msg("r0", null, { timestamp: new Date(100) }),
      msg("r1", null, { timestamp: new Date(200) }),
    ];
    const forks = findBranchPoints(messages);
    expect(forks).toHaveLength(1);
    expect(forks[0].parentId).toBe(null);
  });

  it("returns [] when there are no forks", () => {
    const messages = [msg("a", null), msg("b", "a")];
    expect(findBranchPoints(messages)).toEqual([]);
  });
});

describe("getRootSiblingInfo", () => {
  it("returns null for non-root messages", () => {
    const messages = [msg("a", null), msg("b", "a")];
    expect(getRootSiblingInfo(messages, "b")).toBe(null);
  });

  it("returns null when there is only one root", () => {
    const messages = [msg("a", null)];
    expect(getRootSiblingInfo(messages, "a")).toBe(null);
  });

  it("returns position info for a root with siblings", () => {
    const messages = [
      msg("r0", null, { timestamp: new Date(100) }),
      msg("r1", null, { timestamp: new Date(200) }),
    ];
    const info = getRootSiblingInfo(messages, "r1");
    expect(info).toEqual({ current: 1, total: 2 });
  });
});

describe("buildSiblingInfoMap", () => {
  it("annotates visible messages that have siblings (a fork point)", () => {
    const messages = [
      msg("a", null),
      msg("b0", "a", { branchIndex: 0 }),
      msg("b1", "a", { branchIndex: 1 }),
    ];
    const visible = [messages[0], messages[1]]; // viewing branch 0
    const map = buildSiblingInfoMap(messages, visible);

    // "a" is a lone root (no root siblings) so it's NOT in the map.
    // "b0" is at a fork, so it IS in the map.
    expect(map.has("a")).toBe(false);
    expect(map.has("b0")).toBe(true);
    expect(map.get("b0").total).toBe(2);
    expect(map.get("b0").current).toBe(0);
  });

  it("annotates root messages that have root siblings", () => {
    const messages = [
      msg("r0", null, { timestamp: new Date(100) }),
      msg("r1", null, { timestamp: new Date(200) }),
    ];
    const visible = [messages[1]]; // viewing r1
    const map = buildSiblingInfoMap(messages, visible);

    expect(map.has("r1")).toBe(true);
    expect(map.get("r1").total).toBe(2);
    expect(map.get("r1").current).toBe(1);
  });
});
