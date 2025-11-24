/**
 * Tool Manager for handling AI tool calls
 * Provides a flexible framework for registering and executing tools
 */

// Import necessary functions
import { addMemory, modifyMemory, deleteMemory, listMemory } from './memory';

class ToolManager {
  constructor() {
    this.tools = new Map();
    this.registerDefaultTools();
  }

  /**
   * Register a new tool
   * @param {string} name - The tool name
   * @param {Function} executor - Function that executes the tool with parameters
   * @param {Object} schema - Tool schema definition in OpenAI format
   */
  registerTool(name, executor, schema) {
    this.tools.set(name, { executor, schema });
  }

  /**
   * Unregister a tool
   * @param {string} name - The tool name to remove
   */
  unregisterTool(name) {
    this.tools.delete(name);
  }

  /**
   * Get all registered tools' schemas for API requests
   */
  getToolSchemas() {
    return Array.from(this.tools.values()).map(tool => tool.schema);
  }

  /**
   * Get a specific tool
   */
  getTool(name) {
    return this.tools.get(name);
  }

  /**
   * Execute a tool with given arguments
   * @param {string} name - Tool name
   * @param {Object} args - Arguments for the tool
   * @returns {Promise<any>} - Tool execution result
   */
  async executeTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }
    
    try {
      return await tool.executor(args);
    } catch (error) {
      console.error(`Error executing tool "${name}":`, error);
      throw error;
    }
  }

  /**
   * Get schemas for specific tool names
   */
  getSchemasByNames(names = []) {
    return names
      .map(name => this.tools.get(name))
      .filter(Boolean)
      .map(tool => tool.schema);
  }

  /**
   * Get all tool names
   */
  getToolNames() {
    return Array.from(this.tools.keys());
  }

  /**
   * Register default tools
   */
  registerDefaultTools() {
    // Memory tools
    this.registerTool(
      'listMemory',
      async () => {
        return await listMemory();
      },
      {
        type: "function",
        function: {
          name: "listMemory",
          description: "Retrieve all stored memory facts",
          parameters: {
            type: "object",
            properties: {},
          }
        }
      }
    );

    this.registerTool(
      'addMemory',
      async (args) => {
        if (!args.fact) {
          throw new Error('addMemory tool requires a "fact" argument');
        }
        await addMemory(args.fact);
        return { success: true, message: `Added fact: "${args.fact}"` };
      },
      {
        type: "function",
        function: {
          name: "addMemory",
          description: "Add a new fact to memory",
          parameters: {
            type: "object",
            properties: {
              fact: {
                type: "string",
                description: "The fact to add to memory"
              }
            },
            required: ["fact"]
          }
        }
      }
    );

    this.registerTool(
      'modifyMemory',
      async (args) => {
        if (!args.oldFact || !args.newFact) {
          throw new Error('modifyMemory tool requires "oldFact" and "newFact" arguments');
        }
        await modifyMemory(args.oldFact, args.newFact);
        return {
          success: true,
          message: `Modified fact: "${args.oldFact}" -> "${args.newFact}"`
        };
      },
      {
        type: "function",
        function: {
          name: "modifyMemory",
          description: "Update an existing fact in memory",
          parameters: {
            type: "object",
            properties: {
              oldFact: {
                type: "string",
                description: "The existing fact to modify"
              },
              newFact: {
                type: "string",
                description: "The new fact to replace it with"
              }
            },
            required: ["oldFact", "newFact"]
          }
        }
      }
    );

    this.registerTool(
      'deleteMemory',
      async (args) => {
        if (!args.fact) {
          throw new Error('deleteMemory tool requires a "fact" argument');
        }
        await deleteMemory(args.fact);
        return { success: true, message: `Deleted fact: "${args.fact}"` };
      },
      {
        type: "function",
        function: {
          name: "deleteMemory",
          description: "Remove a specific fact from memory",
          parameters: {
            type: "object",
            properties: {
              fact: {
                type: "string",
                description: "The fact to delete from memory"
              }
            },
            required: ["fact"]
          }
        }
      }
    );
  }
}

// Create a singleton instance
const toolManager = new ToolManager();

export { toolManager, ToolManager };