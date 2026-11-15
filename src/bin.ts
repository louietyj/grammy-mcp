#!/usr/bin/env node
import { parseArgs } from "node:util";
import { autoRetry } from "@grammyjs/auto-retry";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Api } from "grammy";
import { attachTools, createTools } from "./mod.js";

const USAGE = `Usage: BOT_TOKEN=<token> grammy-mcp [--fetch-urls]

Serves every grammY Api method as an MCP tool over stdio, named like the method.
Which tools an agent may use is up to your MCP client's permissions.
  --fetch-urls  download URLs in file fields and upload them, lifting Telegram's
                5 MB (photo) / 20 MB limits on files it fetches itself`;

const { values } = parseArgs({
  options: {
    "fetch-urls": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error(`BOT_TOKEN is not set.\n\n${USAGE}`);
  process.exit(1);
}

const api = new Api(token);
api.config.use(autoRetry());

const server = new Server(
  { name: "grammy-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
attachTools(server, createTools(api, { fetchUrls: values["fetch-urls"] }));
await server.connect(new StdioServerTransport());
