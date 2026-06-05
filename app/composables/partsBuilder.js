/**
 * PartsBuilder - Manages the structured parts array for assistant messages
 *
 * Design Principles:
 * 1. IMMUTABILITY: All updates create new objects, never mutate existing ones
 * 2. UUID-BASED: Each part has a unique ID for reliable tracking
 * 3. APPEND-ONLY: Parts are only added, never replaced (except for content updates within a part)
 * 4. CLEAR SEPARATION: Each part type gets its own part
 * 5. TOOL TRACKING: Tools are tracked by their API index to handle streaming correctly
 */

/**
 * Generate a unique ID
 */
function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Deep clone an object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export class PartsBuilder {
  constructor() {
    this.parts = [];
    this.partMap = new Map(); // Map of partId -> part
    this.toolIndexToPartId = new Map(); // Map of apiIndex -> partId
    this.toolIdToPartId = new Map(); // Map of toolId -> partId
    this.completedToolIds = new Set(); // Set of tool IDs that have results
    this.nextToolIndex = 0; // Global counter for tool indices
  }

  /**
   * Mark a tool as completed (has received result)
   */
  markToolCompleted(toolId) {
    if (toolId) {
      this.completedToolIds.add(toolId);
    }
  }

  /**
   * Check if a tool is completed
   */
  isToolCompleted(toolId) {
    return toolId ? this.completedToolIds.has(toolId) : false;
  }

  /**
   * Get a snapshot of all parts (immutable copy)
   */
  getParts() {
    return deepClone(this.parts);
  }

  /**
   * Get all tools as a flat array (for backward compatibility)
   */
  getAllTools() {
    return this.parts
      .filter(p => p.type === 'tool_group')
      .flatMap(p => p.tools);
  }

  /**
   * Append text content
   */
  appendContent(text) {
    if (!text) return this.getParts();

    const contentPart = this.parts.find(p => p.type === 'content' && !p._finalized);

    if (contentPart) {
      const updatedPart = { ...contentPart, content: contentPart.content + text };
      this._replacePart(contentPart._id, updatedPart);
    } else {
      this._addPart({
        _id: generateId(),
        type: 'content',
        content: text,
        _finalized: false
      });
    }

    return this.getParts();
  }

  /**
   * Finalize the current content part
   */
  finalizeContent() {
    const contentPart = this.parts.find(p => p.type === 'content' && !p._finalized);
    if (contentPart) {
      this._replacePart(contentPart._id, { ...contentPart, _finalized: true });
    }
    return this.getParts();
  }

  /**
   * Append reasoning text
   */
  appendReasoning(text) {
    if (!text || !text.trim() || text.trim() === 'None') return this.getParts();

    const reasoningPart = this.parts.find(p => p.type === 'reasoning' && !p._finalized);

    if (reasoningPart) {
      const updatedPart = { ...reasoningPart, content: reasoningPart.content + text };
      this._replacePart(reasoningPart._id, updatedPart);
    } else {
      this._addPart({
        _id: generateId(),
        type: 'reasoning',
        content: text,
        _finalized: false
      });
    }

    return this.getParts();
  }

  /**
   * Finalize the current reasoning part
   */
  finalizeReasoning() {
    const reasoningPart = this.parts.find(p => p.type === 'reasoning' && !p._finalized);
    if (reasoningPart) {
      this._replacePart(reasoningPart._id, { ...reasoningPart, _finalized: true });
    }
    return this.getParts();
  }

  /**
   * Add or update a tool
   *
   * Logic:
   * 1. Finalize any open content part (tools separate content segments)
   * 2. If tool has an ID we've seen before -> update existing tool
   * 3. If API index is mapped AND the mapped tool hasn't completed -> update that part
   * 4. Otherwise -> create new tool part
   *
   * This handles:
   * - Streaming chunks for the same tool
   * - Multiple tools in sequence
   * - Different tool types in the same turn
   * - Content before and after tools (e.g., content -> tool -> content)
   */
  addOrUpdateTool(toolType, toolData) {
    // CRITICAL: Finalize any open content part before adding a tool
    // This ensures content segments are properly separated by tool calls
    // e.g., "reason -> search -> content -> crawl -> content" creates two separate content parts
    this.finalizeContent();

    const apiIndex = toolData.index;
    const toolId = toolData.id;

    // Case 1: Tool has an ID we've seen before - update it
    if (toolId && this.toolIdToPartId.has(toolId)) {
      const partId = this.toolIdToPartId.get(toolId);
      const part = this.partMap.get(partId);

      if (part && part.type === 'tool_group') {
        const tool = part.tools[0];
        if (tool) {
          const updatedTool = {
            ...tool,
            type: toolData.type || tool.type,
            function: {
              name: toolData.function?.name || tool.function.name,
              arguments: tool.function.arguments + (toolData.function?.arguments || '')
            }
          };

          this._replacePart(partId, { ...part, tools: [updatedTool] });
          return this.getParts();
        }
      }
    }

    // Case 2: API index is mapped AND the tool hasn't completed yet - update existing
    if (apiIndex !== undefined && this.toolIndexToPartId.has(apiIndex)) {
      const partId = this.toolIndexToPartId.get(apiIndex);
      const part = this.partMap.get(partId);

      if (part && part.type === 'tool_group') {
        const tool = part.tools[0];
        const isCompleted = tool?.id && this.completedToolIds.has(tool.id);

        // Only update if not completed
        if (!isCompleted) {
          const updatedTool = {
            ...tool,
            id: toolId || tool.id,
            type: toolData.type || tool.type,
            function: {
              name: toolData.function?.name || tool.function.name,
              arguments: tool.function.arguments + (toolData.function?.arguments || '')
            }
          };

          this._replacePart(partId, { ...part, tools: [updatedTool] });

          if (toolId) {
            this.toolIdToPartId.set(toolId, partId);
          }
          return this.getParts();
        }
        // Tool has completed - this is a new tool with the same index (new iteration)
        // Fall through to create new tool
      }
    }

    // Case 3: Create new tool part
    const globalIndex = this.nextToolIndex++;
    const newToolId = toolId || `tool-${globalIndex}`;

    const newPart = {
      _id: generateId(),
      type: 'tool_group',
      toolType: toolType,
      tools: [{
        index: globalIndex,
        id: newToolId,
        type: toolData.type || 'function',
        function: {
          name: toolData.function?.name || '',
          arguments: toolData.function?.arguments || ''
        },
        result: null
      }]
    };

    this._addPart(newPart);
    this.toolIndexToPartId.set(apiIndex, newPart._id);

    if (toolId) {
      this.toolIdToPartId.set(toolId, newPart._id);
    }

    return this.getParts();
  }

  /**
   * Set the result for a tool by its ID
   */
  setToolResult(toolId, result) {
    const partId = this.toolIdToPartId.get(toolId);

    if (partId) {
      const part = this.partMap.get(partId);
      if (part && part.type === 'tool_group') {
        const tool = part.tools[0];
        if (tool && tool.id === toolId) {
          const updatedTool = { ...tool, result };
          this._replacePart(partId, { ...part, tools: [updatedTool] });
          this.markToolCompleted(toolId);
          return true;
        }
      }
    }

    // Fallback: search all parts
    for (const part of this.parts) {
      if (part.type === 'tool_group') {
        const tool = part.tools.find(t => t.id === toolId);
        if (tool) {
          const updatedTool = { ...tool, result };
          this._replacePart(part._id, { ...part, tools: [updatedTool] });
          this.markToolCompleted(toolId);
          this.toolIdToPartId.set(toolId, part._id);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Add an image
   */
  addImage(url, revisedPrompt = null) {
    if (!url) return this.getParts();

    const imagePart = this.parts.find(p => p.type === 'image');

    if (imagePart) {
      const updatedPart = {
        ...imagePart,
        images: [...imagePart.images, { url, revised_prompt: revisedPrompt }]
      };
      this._replacePart(imagePart._id, updatedPart);
    } else {
      this._addPart({
        _id: generateId(),
        type: 'image',
        images: [{ url, revised_prompt: revisedPrompt }]
      });
    }

    return this.getParts();
  }

  /**
   * Process image data from API
   */
  processImage(imageData) {
    const url = imageData.image_url?.url || imageData.url;
    const revisedPrompt = imageData.revised_prompt || null;

    if (url) {
      return this.addImage(url, revisedPrompt);
    }
    return this.getParts();
  }

  /**
   * Ensure content part exists at the beginning
   */
  ensureContentPartFirst(content) {
    if (this.parts.some(p => p.type === 'content') || !content) {
      return this.getParts();
    }

    const newPart = {
      _id: generateId(),
      type: 'content',
      content: content,
      _finalized: true
    };

    this.parts = [newPart, ...this.parts];
    this.partMap.set(newPart._id, newPart);

    return this.getParts();
  }

  /**
   * Internal: Add a part
   */
  _addPart(part) {
    this.parts = [...this.parts, part];
    this.partMap.set(part._id, part);
  }

  /**
   * Internal: Replace a part
   */
  _replacePart(partId, newPart) {
    const index = this.parts.findIndex(p => p._id === partId);
    if (index === -1) return;

    this.parts = [
      ...this.parts.slice(0, index),
      newPart,
      ...this.parts.slice(index + 1)
    ];

    this.partMap.set(partId, newPart);
  }

  /**
   * Check if parts exist
   */
  hasParts() {
    return this.parts.length > 0;
  }

  hasContentPart() {
    return this.parts.some(p => p.type === 'content');
  }

  hasImagePart() {
    return this.parts.some(p => p.type === 'image');
  }

  /**
   * Create a reactive-ready copy for Vue
   */
  toReactiveArray() {
    return this.parts.map(part => deepClone(part));
  }
}

/**
 * TimingTracker - Tracks timing information
 */
export class TimingTracker {
  constructor(message) {
    this.message = message;
    this.firstTokenReceived = false;
  }

  markFirstToken() {
    if (!this.firstTokenReceived) {
      this.message.firstTokenTime = new Date();
      this.firstTokenReceived = true;
    }
  }

  startReasoning() {
    if (this.message.reasoningStartTime === null) {
      this.message.reasoningStartTime = new Date();
    }
  }

  endReasoning() {
    if (this.message.reasoningStartTime !== null &&
        this.message.reasoningEndTime === null) {
      this.message.reasoningEndTime = new Date();
    }
  }

  calculateReasoningDuration() {
    if (this.message.reasoningStartTime === null || this.message.reasoningStartTime === undefined) {
      return null;
    }
    const endTime = this.message.reasoningEndTime || new Date();
    return endTime.getTime() - this.message.reasoningStartTime.getTime();
  }
}
