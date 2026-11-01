// Fork: registerQboTools — the single entry point that puts the QuickBooks
// tools on an McpServer, for both the stdio server and the hosted connector.
//
// stdio (default): every catalog tool, QUICKBOOKS_DISABLE_* env still honoured,
// handlers called exactly as before (the env client backs them).
//
// hosted (`hosted: true`): only the allowlist (default HOSTED_TOOL_ALLOWLIST),
// delete tools never — whatever the allowlist or env says (spec D7). Each call:
//   1. resolveContext(extra) -> { client, actor } for the caller's company;
//   2. create/update refused unless actor.canWrite (spec D9);
//   3. the unchanged handler runs inside runWithQboContext, after a token
//      preflight so reconnect / save failures surface as clear messages instead
//      of being swallowed into a handler's "Error ..." text;
//   4. every create/update is reported to onWrite (spec D8).
// User-facing failures are fixed copy (QBO_MESSAGES): no stack, no token, no
// error detail ever leaves the process from this layer.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { ALL_TOOLS, HOSTED_TOOL_ALLOWLIST } from "./tools/catalog.js";
import { CRUD_CATEGORY, getCrudCategory, RegisterTool, type ToolHandlerFn } from "./helpers/register-tool.js";
import {
  enterHostedMode,
  QboNotConnectedError,
  runWithQboContext,
  type QboActor,
  type QboCallContext,
} from "./context/qbo-context.js";
import { QboConfigError, QboReauthRequiredError, QboTokenPersistError } from "./clients/token-store.js";
import { QuickbooksClient } from "./clients/quickbooks-client.js";

/** One create/update attempt, reported to the host's audit log. Never holds tokens. */
export interface QboWriteAuditEvent {
  tool: string;
  category: "WRITE" | "UPDATE";
  entityType?: string;
  entityId?: string;
  intuitTid?: string;
  actor?: QboActor;
  ok: boolean;
  error?: string;
}

export interface RegisterQboToolsOptions {
  /**
   * Tool names to register. Default: all (stdio); hosted defaults to HOSTED_TOOL_ALLOWLIST.
   * Hosted: must be a subset of HOSTED_TOOL_ALLOWLIST (the ceiling, widened only by
   * editing it in this package). Any other name throws — a programmer error, so the
   * host's request fails (500) rather than exposing an unvetted tool.
   */
  tools?: readonly string[];
  /** Resolves the caller's company client and actor for one call. Required when hosted. */
  resolveContext?: (extra: { authInfo?: AuthInfo }) => Promise<QboCallContext>;
  /** Audit hook for every create/update. Failures are logged and never change the response. */
  onWrite?: (e: QboWriteAuditEvent) => Promise<void> | void;
  /** true -> delete tools are never registered, regardless of the list or env. */
  hosted?: boolean;
}

/** Exact user-facing copy, each returned as a single text content item. */
export const QBO_MESSAGES = {
  notConnected:
    "QuickBooks isn't connected for this company. An owner or admin can connect it in ProjectPix → Settings → Integrations.",
  reauth:
    "QuickBooks needs to be reconnected for this company. An owner or admin can reconnect it in ProjectPix → Settings → Integrations.",
  writeRefused: "Only an owner or admin with QuickBooks access can create or change records in QuickBooks.",
  persistFailed:
    "QuickBooks couldn't save its updated sign-in for this company. Please try again; if it keeps happening, reconnect QuickBooks in ProjectPix → Settings → Integrations.",
  generic: "Something went wrong reaching QuickBooks. Please try again.",
} as const;

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Fixed copy for an error, or undefined when it is not one of the known QuickBooks errors. */
function knownErrorMessage(err: unknown): string | undefined {
  if (err instanceof QboNotConnectedError) return QBO_MESSAGES.notConnected;
  if (err instanceof QboReauthRequiredError) return QBO_MESSAGES.reauth;
  if (err instanceof QboTokenPersistError) return QBO_MESSAGES.persistFailed;
  // Missing realmId is the host's configuration error (ruling R9): generic copy, never "reconnect".
  if (err instanceof QboConfigError) return QBO_MESSAGES.generic;
  return undefined;
}

/** "create_bill_payment" / "update-vendor" -> "BillPayment" / "Vendor". */
function entityTypeOf(toolName: string): string {
  return toolName
    .replace(/^(create|update)[_-]/, "")
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * The catalog tools report failures as a text item starting "Error ..." (none
 * sets isError). Skips the unsupported-parameter WARNING item if present.
 */
function errorTextOf(result: any): string | undefined {
  const first = (result.content as any[]).find((c) => !String(c.text).startsWith("WARNING:"));
  const text = String(first?.text);
  return text.startsWith("Error") ? text : undefined;
}

/** Error name only — a thrown message could carry anything (tokens, payloads). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

/** The created/updated record's Id, from the JSON text item a successful tool returns. */
function entityIdOf(result: any): string | undefined {
  for (const c of result.content as any[]) {
    try {
      const id = JSON.parse(c.text)?.Id;
      if (id !== undefined) return String(id);
    } catch {
      /* not JSON — keep looking */
    }
  }
  return undefined;
}

async function audit(onWrite: RegisterQboToolsOptions["onWrite"], event: QboWriteAuditEvent): Promise<void> {
  if (!onWrite) return;
  try {
    await onWrite(event);
  } catch (err) {
    // Fixed string + error name only: the hook's message could carry anything.
    console.error(`[qbo-mcp] write audit hook failed: ${errorName(err)}`);
  }
}

/** Register the QuickBooks tools on `server`. See the file header for stdio vs hosted. */
export function registerQboTools(server: McpServer, options: RegisterQboToolsOptions = {}): void {
  const { hosted = false, resolveContext, onWrite } = options;
  if (hosted && !resolveContext) {
    throw new Error("registerQboTools: resolveContext is required when hosted is true");
  }
  if (hosted) {
    // Idempotent. Done here (not only in handleQboMcpRequest) so every hosted
    // entry point gets the protections: from now on the .env client is
    // unreachable, a missing context fails closed, and a client needs an
    // explicit tokenStore and realmId.
    enterHostedMode();
    // Ruling R5: the allowlist is the ceiling. A name outside it is a programmer
    // error and throws (the host's request fails) instead of widening the surface.
    if (options.tools) {
      const extra = options.tools.filter((n) => !HOSTED_TOOL_ALLOWLIST.includes(n));
      if (extra.length) {
        throw new Error(`registerQboTools: tools not in HOSTED_TOOL_ALLOWLIST: ${extra.join(", ")}`);
      }
    }
  }

  const wanted = options.tools ?? (hosted ? HOSTED_TOOL_ALLOWLIST : undefined);
  if (wanted) {
    const known = new Set(ALL_TOOLS.map((t) => t.name));
    const unknown = wanted.filter((n) => !known.has(n));
    if (unknown.length) throw new Error(`registerQboTools: unknown tool name(s): ${unknown.join(", ")}`);
  }
  const wantedSet = wanted ? new Set(wanted) : undefined;

  for (const tool of ALL_TOOLS) {
    const category = getCrudCategory(tool.name);
    if (hosted && category === CRUD_CATEGORY.DELETE) continue; // D7: never, whatever the list says
    if (wantedSet && !wantedSet.has(tool.name)) continue;

    const isWrite = category === CRUD_CATEGORY.WRITE || category === CRUD_CATEGORY.UPDATE;
    const auditBase = isWrite
      ? { tool: tool.name, category: category as "WRITE" | "UPDATE", entityType: entityTypeOf(tool.name) }
      : undefined;

    const wrap = (inner: ToolHandlerFn): ToolHandlerFn => async (args: unknown, extra?: { authInfo?: AuthInfo }) => {
      // 1. Resolve the caller's company (hosted) — failures are fixed copy, never detail.
      let ctx: QboCallContext | undefined;
      if (resolveContext) {
        try {
          ctx = await resolveContext({ authInfo: extra?.authInfo });
        } catch (err) {
          return textResult(knownErrorMessage(err) ?? QBO_MESSAGES.generic);
        }
        // 2. Write gate (D9): only an actor holding the QuickBooks write grant.
        if (isWrite && ctx.actor?.canWrite !== true) return textResult(QBO_MESSAGES.writeRefused);
      }

      const actor = ctx?.actor;
      const call = async () => {
        // Preflight the token so a reconnect / save failure reaches us instead
        // of being swallowed by the handler's own catch.
        if (ctx) await QuickbooksClient.getInstance();
        return inner(args, extra);
      };

      // 3. Run the unchanged handler inside the context.
      let result: any;
      try {
        result = ctx ? await runWithQboContext(ctx, call) : await call();
      } catch (err) {
        if (auditBase) {
          await audit(onWrite, { ...auditBase, ...(actor ? { actor } : {}), ok: false, error: errorName(err) });
        }
        const message = knownErrorMessage(err);
        if (message) return textResult(message);
        if (resolveContext) return textResult(QBO_MESSAGES.generic);
        throw err; // stdio: pre-fork behaviour (the SDK turns it into an error result)
      }

      // 4. Audit (D8).
      if (auditBase) {
        const errorText = errorTextOf(result);
        const event: QboWriteAuditEvent = { ...auditBase, ...(actor ? { actor } : {}), ok: errorText === undefined };
        if (errorText === undefined) {
          const entityId = entityIdOf(result);
          if (entityId !== undefined) event.entityId = entityId;
        } else {
          event.error = errorText.slice(0, 1000);
          const tid = /\[intuit_tid: ([^\]]+)\]/.exec(errorText)?.[1];
          if (tid) event.intuitTid = tid;
        }
        await audit(onWrite, event);
      }
      return result;
    };

    RegisterTool(server, tool, { wrap });
  }
}
