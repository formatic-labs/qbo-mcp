#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { RegisterTool } from "./helpers/register-tool.js";
import { ALL_TOOLS } from "./tools/catalog.js";
import { QuickbooksClient, installProcessErrorLogging, loadTokenStoreEnv } from "./clients/quickbooks-client.js";

const main = async () => {
  // Fork: stdio-only startup that used to happen at client-module import —
  // load .env into process.env before any tool runs, and log stray errors.
  loadTokenStoreEnv();
  installProcessErrorLogging();

  // Fork: never start the interactive browser OAuth flow inside the stdio MCP
  // server — it writes to stdout and breaks the protocol stream. A dead token
  // returns an actionable "run npm run auth" error instead.
  QuickbooksClient.interactiveAuthAllowed = false;

  // Create an MCP server
  const server = QuickbooksMCPServer.GetServer();
  // Register every tool in the catalog (src/tools/catalog.ts)
  for (const tool of ALL_TOOLS) RegisterTool(server, tool);

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
