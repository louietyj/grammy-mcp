import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tools } from "./tools.js";

export { createTools, DESCRIBE_TYPE } from "./tools.js";
export type { ToolDefinition, ToolOptions, ToolResult, Tools } from "./tools.js";
export { decodeDataUri } from "./files.js";

/** Serve `tools` from an MCP SDK server (which must declare the `tools` capability). */
export function attachTools(server: Server, tools: Tools): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.definitions,
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    (request) => tools.call(request.params.name, request.params.arguments ?? {}),
  );
}
