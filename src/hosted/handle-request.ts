// Fork: web-standard hosted MCP handler. A host (e.g. a Next.js route) authenticates
// the caller, builds an AuthInfo, and returns handleQboMcpRequest(...) as-is.
//
// Stateless by design: each request gets a fresh McpServer + transport (no session
// id, plain JSON responses), so it runs on serverless without sticky state. The
// per-call company/actor comes from the host's resolveContext, never from env.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { registerQboTools, type RegisterQboToolsOptions } from "../register-qbo-tools.js";
import { enterHostedMode } from "../context/qbo-context.js";
import { HOSTED_TOOL_ALLOWLIST } from "../tools/catalog.js";

export interface QboHostedOptions extends Omit<RegisterQboToolsOptions, "hosted" | "tools"> {
  /** Resolves the caller's company client and actor for one call. */
  resolveContext: NonNullable<RegisterQboToolsOptions["resolveContext"]>;
  /**
   * Tool names to expose. Default: HOSTED_TOOL_ALLOWLIST. Must be a subset of it:
   * the allowlist is the ceiling, widened only by editing HOSTED_TOOL_ALLOWLIST in
   * this package. Any other name makes handleQboMcpRequest reject. Delete tools are
   * never exposed.
   */
  tools?: readonly string[];
}

/** Handle one MCP request (JSON-RPC over POST) for an already-authenticated caller. */
export async function handleQboMcpRequest(
  request: Request,
  authInfo: AuthInfo,
  options: QboHostedOptions,
): Promise<Response> {
  // Idempotent. Done here so a host can never forget it: from now on the .env
  // client is unreachable and a missing context fails closed.
  enterHostedMode();

  if (options.tools) {
    const extra = options.tools.filter((n) => !HOSTED_TOOL_ALLOWLIST.includes(n));
    if (extra.length) {
      throw new Error(`handleQboMcpRequest: tools not in HOSTED_TOOL_ALLOWLIST: ${extra.join(", ")}`);
    }
  }

  const server = new McpServer({ name: "qbo-mcp", version: "0.1.0" });
  registerQboTools(server, { ...options, hosted: true });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { authInfo });
  } finally {
    // Per-request teardown (stateless: nothing outlives the request). The JSON
    // response is already built when handleRequest resolves, so closing is safe.
    await server.close();
  }
}
