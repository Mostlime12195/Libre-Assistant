/**
 * Tool Manager for handling AI tool calls
 * Provides a flexible framework for registering and executing tools
 */

// Import necessary functions
import { useSettings } from './useSettings';

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
   * Get the custom API key from settings
   */
  getApiKey() {
    // Try to get from settings manager if available
    if (typeof window !== 'undefined') {
      const settingsManager = useSettings();
      return settingsManager.settings?.custom_api_key;
    }
    return null;
  }

  /**
   * Register default tools
   */
  registerDefaultTools() {
    // Exa Search Tool - calls server route with API key
    this.registerTool(
      'search',
      async (args) => {
        if (!args.q) {
          throw new Error('Search tool requires a "q" (query) argument');
        }

        const apiKey = this.getApiKey();
        if (!apiKey) {
          throw new Error('API key is required for search');
        }

        try {
          const params = new URLSearchParams({
            q: args.q,
            numResults: args.numResults || 5
          });

          const response = await fetch(`/api/search?${params.toString()}`, {
            headers: {
              'X-API-Key': apiKey
            }
          });

          if (!response.ok) {
            throw new Error(`Search request failed with status ${response.status}`);
          }

          const data = await response.json();

          // Format results for the AI
          if (!data.results || data.results.length === 0) {
            return {
              results: [],
              message: "No results found for query."
            };
          }

          return {
            results: data.results.map(r => ({
              title: r.title,
              url: r.url,
              description: r.description,
              date: r.date
            })),
            query: args.q
          };

        } catch (error) {
          console.error("Search tool error:", error);
          throw error;
        }
      },
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web for current information, news, or specific topics using Exa AI search. Use this when you need information beyond your knowledge cutoff.",
          parameters: {
            type: "object",
            properties: {
              q: {
                type: "string",
                description: "The search query"
              },
              numResults: {
                type: "integer",
                description: "Number of results to return (default 5, max 10)",
                maximum: 10
              }
            },
            required: ["q"]
          }
        }
      }
    );

    // Exa Page Contents Tool - calls server route with API key
    this.registerTool(
      'getPageContents',
      async (args) => {
        if (!args.urls || !Array.isArray(args.urls) || args.urls.length === 0) {
          throw new Error('getPageContents tool requires a "urls" array argument');
        }

        const apiKey = this.getApiKey();
        if (!apiKey) {
          throw new Error('API key is required for page contents');
        }

        try {
          const response = await fetch('/api/exa-contents', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey
            },
            body: JSON.stringify({
              urls: args.urls.slice(0, 10) // Limit to 10 URLs
            })
          });

          if (!response.ok) {
            throw new Error(`Page contents request failed with status ${response.status}`);
          }

          const data = await response.json();

          // Format results for the AI
          if (!data.results || data.results.length === 0) {
            return {
              results: [],
              message: "Could not retrieve content for the provided URLs."
            };
          }

          return {
            results: data.results.map(r => ({
              url: r.url,
              title: r.title,
              content: r.content,
              publishedDate: r.publishedDate
            }))
          };

        } catch (error) {
          console.error("Page contents tool error:", error);
          throw error;
        }
      },
      {
        type: "function",
        function: {
          name: "getPageContents",
          description: "Retrieve the full content of web pages using Exa AI. Use this to get detailed information from specific URLs found via search or provided by the user. Can fetch up to 10 pages at once.",
          parameters: {
            type: "object",
            properties: {
              urls: {
                type: "array",
                description: "Array of URLs to fetch content from (max 10)",
                items: {
                  type: "string"
                }
              }
            },
            required: ["urls"]
          }
        }
      }
    );
  }
}

// Create a singleton instance
const toolManager = new ToolManager();

export { toolManager, ToolManager };