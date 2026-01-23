/**
 * @file branchManager.js
 * @description Manages branching logic for chat conversations, allowing users to
 * create alternative conversation paths by editing messages or regenerating responses.
 */

/**
 * Builds a tree structure from a flat messages array
 * @param {Array} messages - Flat array of messages with parentId references
 * @returns {Map} Map of messageId -> message with children array
 */
export function buildMessageTree(messages) {
    const messageMap = new Map();

    // First pass: create map of all messages
    for (const msg of messages) {
        messageMap.set(msg.id, { ...msg, children: [] });
    }

    // Second pass: build parent-child relationships
    for (const msg of messages) {
        if (msg.parentId && messageMap.has(msg.parentId)) {
            messageMap.get(msg.parentId).children.push(msg.id);
        }
    }

    return messageMap;
}

/**
 * Gets the root messages (messages without parents)
 * @param {Array} messages - All messages in the conversation
 * @returns {Array} Root messages sorted by timestamp
 */
export function getRootMessages(messages) {
    return messages
        .filter(msg => !msg.parentId)
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

/**
 * Gets all sibling messages at a given position in the tree
 * Siblings are messages with the same parentId
 * @param {Array} messages - All messages in the conversation
 * @param {string} messageId - The message to find siblings for
 * @returns {Array} Sibling messages sorted by branchIndex
 */
export function getSiblings(messages, messageId) {
    const message = messages.find(m => m.id === messageId);
    if (!message) return [];

    const parentId = message.parentId;

    // Find all messages with the same parent
    const siblings = messages.filter(m => m.parentId === parentId);

    // Sort by branchIndex (or timestamp as fallback)
    return siblings.sort((a, b) => {
        if (a.branchIndex !== undefined && b.branchIndex !== undefined) {
            return a.branchIndex - b.branchIndex;
        }
        return new Date(a.timestamp) - new Date(b.timestamp);
    });
}

/**
 * Gets sibling information for a message
 * @param {Array} messages - All messages in the conversation
 * @param {string} messageId - The message to get info for
 * @returns {Object} { current: number, total: number, siblings: string[] }
 */
export function getSiblingInfo(messages, messageId) {
    const siblings = getSiblings(messages, messageId);
    const currentIndex = siblings.findIndex(m => m.id === messageId);

    return {
        current: currentIndex >= 0 ? currentIndex : 0,
        total: siblings.length,
        siblings: siblings.map(m => m.id)
    };
}

/**
 * Gets the visible messages for a given branch path.
 * The branch path is an array of indices indicating which branch to follow at each fork.
 * @param {Array} messages - All messages in the conversation
 * @param {Array<number>} branchPath - Array of branch indices to follow
 * @returns {Array} Messages visible in the current branch path
 */
export function getMessagesForBranchPath(messages, branchPath = []) {
    if (!messages || messages.length === 0) return [];

    const result = [];

    // Start with root messages (no parent)
    const roots = getRootMessages(messages);
    if (roots.length === 0) return [];

    // Pick the first root (there should typically only be one for a conversation start)
    let currentMessage = roots[0];
    result.push(currentMessage);

    let pathIndex = 0;

    while (currentMessage) {
        // Find children of current message
        const children = messages
            .filter(m => m.parentId === currentMessage.id)
            .sort((a, b) => {
                if (a.branchIndex !== undefined && b.branchIndex !== undefined) {
                    return a.branchIndex - b.branchIndex;
                }
                return new Date(a.timestamp) - new Date(b.timestamp);
            });

        if (children.length === 0) break;

        // Determine which branch to follow
        const branchIndex = branchPath[pathIndex] ?? 0;
        const selectedChild = children[Math.min(branchIndex, children.length - 1)];

        result.push(selectedChild);
        currentMessage = selectedChild;

        // Only increment path index at actual branch points (more than one child)
        if (children.length > 1) {
            pathIndex++;
        }
    }

    return result;
}

/**
 * Calculates the branch path based on a specific message chain
 * @param {Array} messages - All messages
 * @param {string} targetMessageId - The message to trace back from
 * @returns {Array<number>} The branch path to reach this message
 */
export function calculateBranchPath(messages, targetMessageId) {
    const path = [];
    let currentMessage = messages.find(m => m.id === targetMessageId);

    if (!currentMessage) return [];

    // Trace back to root, recording branch indices
    const chain = [];
    while (currentMessage) {
        chain.unshift(currentMessage);
        currentMessage = currentMessage.parentId
            ? messages.find(m => m.id === currentMessage.parentId)
            : null;
    }

    // Now walk forward and record branch choices at each fork
    for (let i = 0; i < chain.length - 1; i++) {
        const parent = chain[i];
        const child = chain[i + 1];

        // Get siblings of the child
        const siblings = messages
            .filter(m => m.parentId === parent.id)
            .sort((a, b) => {
                if (a.branchIndex !== undefined && b.branchIndex !== undefined) {
                    return a.branchIndex - b.branchIndex;
                }
                return new Date(a.timestamp) - new Date(b.timestamp);
            });

        // Only record if there's actually a branch point
        if (siblings.length > 1) {
            const index = siblings.findIndex(m => m.id === child.id);
            path.push(index >= 0 ? index : 0);
        }
    }

    return path;
}

/**
 * Gets the next branch index for creating a new sibling
 * @param {Array} messages - All messages
 * @param {string} parentId - The parent message ID (or null for root)
 * @returns {number} The next available branch index
 */
export function getNextBranchIndex(messages, parentId) {
    const siblings = messages.filter(m => m.parentId === parentId);

    if (siblings.length === 0) return 0;

    const maxIndex = Math.max(...siblings.map(m => m.branchIndex ?? 0));
    return maxIndex + 1;
}

/**
 * Creates a new branch by duplicating a message with new content
 * Used when editing a user message or regenerating an assistant message
 * @param {Array} messages - Current messages array
 * @param {string} messageId - The message to branch from (will be replaced in new branch)
 * @param {Object} newMessageData - The new message data
 * @returns {Object} { messages: Array, newMessage: Object, branchPath: Array }
 */
export function createBranch(messages, messageId, newMessageData) {
    const existingMessage = messages.find(m => m.id === messageId);
    if (!existingMessage) {
        throw new Error(`Message ${messageId} not found`);
    }

    const parentId = existingMessage.parentId;
    const nextBranchIndex = getNextBranchIndex(messages, parentId);

    // Create the new message with branching metadata
    const newMessage = {
        ...newMessageData,
        id: newMessageData.id || generateId(),
        parentId: parentId,
        branchIndex: nextBranchIndex,
        timestamp: new Date()
    };

    // Add to messages array
    const updatedMessages = [...messages, newMessage];

    // Calculate the new branch path to reach this message
    const newBranchPath = calculateBranchPath(updatedMessages, newMessage.id);

    return {
        messages: updatedMessages,
        newMessage,
        branchPath: newBranchPath
    };
}

/**
 * Switches to a different branch at a specific point
 * @param {Array<number>} currentPath - Current branch path
 * @param {number} forkIndex - Which fork point to change (index in path array)
 * @param {number} newBranchIndex - The new branch index to use
 * @returns {Array<number>} Updated branch path
 */
export function switchBranch(currentPath, forkIndex, newBranchIndex) {
    const newPath = [...currentPath];

    // Update the branch at the fork point
    newPath[forkIndex] = newBranchIndex;

    // Truncate any path elements after this fork (reset to first branch)
    // This is because changing an earlier branch may invalidate later choices
    for (let i = forkIndex + 1; i < newPath.length; i++) {
        newPath[i] = 0;
    }

    return newPath;
}

/**
 * Migrates old conversation messages to support branching
 * Adds parentId, branchIndex, and other branching metadata to legacy messages
 * @param {Array} messages - Legacy messages without branching support
 * @returns {Array} Messages with branching metadata
 */
export function migrateMessages(messages) {
    if (!messages || messages.length === 0) return [];

    // Check if already migrated (first message has parentId defined)
    if (messages.length > 0 && messages[0].parentId !== undefined) {
        return messages;
    }

    // Sort by timestamp to ensure correct order
    const sorted = [...messages].sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    // Add branching metadata
    return sorted.map((msg, index) => ({
        ...msg,
        parentId: index > 0 ? sorted[index - 1].id : null,
        branchIndex: 0
    }));
}

/**
 * Finds all branch points (forks) in a conversation
 * @param {Array} messages - All messages
 * @returns {Array} Array of { parentId, messageIds[] } for each fork
 */
export function findBranchPoints(messages) {
    const parentChildMap = new Map();

    for (const msg of messages) {
        const parentId = msg.parentId ?? '__root__';
        if (!parentChildMap.has(parentId)) {
            parentChildMap.set(parentId, []);
        }
        parentChildMap.get(parentId).push(msg.id);
    }

    // Filter to only actual branch points (more than 1 child)
    const branchPoints = [];
    for (const [parentId, childIds] of parentChildMap) {
        if (childIds.length > 1) {
            branchPoints.push({
                parentId: parentId === '__root__' ? null : parentId,
                messageIds: childIds
            });
        }
    }

    return branchPoints;
}

/**
 * Generates a unique ID for messages
 * @returns {string} Unique ID
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Builds a map of message ID to sibling info for UI rendering
 * @param {Array} messages - All messages
 * @param {Array} visibleMessages - Currently visible messages in branch path
 * @returns {Map} Map of messageId -> { current, total, forkIndex }
 */
export function buildSiblingInfoMap(messages, visibleMessages) {
    const infoMap = new Map();
    let forkIndex = 0;

    for (const msg of visibleMessages) {
        const siblings = getSiblings(messages, msg.id);

        if (siblings.length > 1) {
            const currentIndex = siblings.findIndex(s => s.id === msg.id);
            infoMap.set(msg.id, {
                current: currentIndex,
                total: siblings.length,
                forkIndex: forkIndex,
                siblings: siblings.map(s => s.id)
            });
            forkIndex++;
        }
    }

    return infoMap;
}
