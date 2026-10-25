import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../version.mjs';
import { vehicleTools } from './vehicle-tools.mjs';
import { researchTools } from './research-tools.mjs';
import { accountTools } from './account-tools.mjs';

/** One registry drives MCP registration, status and the website's tool directory. */
export function createToolRegistry(context) {
  const definitions = [];
  const collect = group => (name, description, inputSchema, handler) => {
    if (definitions.some(tool => tool.name === name)) throw new Error(`Duplicate tool: ${name}`);
    definitions.push({name, description, inputSchema, handler, group});
  };
  vehicleTools(collect('Vehicle reports'));
  researchTools(collect('Research and analysis'));
  accountTools(collect('Saved vehicles and preferences'), context);
  const mutations = new Set(['save_vin', 'remove_saved_vin', 'get_output_preferences', 'update_output_preferences']);
  const toolCatalog = [...new Set(definitions.map(t => t.group))].map(name => ({
    name, tools: definitions.filter(t => t.group === name).map(({name, description}) => ({name, description})),
  }));
  return {
    toolNames: definitions.map(t => t.name),
    toolCatalog,
    createMcpServer() {
      const server = new McpServer({name:'vin-mcp', version:VERSION}, {
        instructions: 'Start with explore_capabilities for coverage. Use decode_vin for a VIN report, compare_vehicles for 2–4 VINs, and ownership_scenario for explicit cost assumptions. Model-year campaigns are not VIN repair status. Unknown values are not zero. Account tools require the user’s website login token.',
      });
      for (const {name, description, inputSchema, handler, group} of definitions) {
        server.registerTool(name, {description, inputSchema, annotations:{
          readOnlyHint: !mutations.has(name),
          destructiveHint: name === 'remove_saved_vin',
          openWorldHint: group !== 'Saved vehicles and preferences',
        }}, handler);
      }
      return server;
    },
  };
}
