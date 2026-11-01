// Fork: per-call QuickBooks request context.
//
// The ~142 upstream handlers call QuickbooksClient.getInstance() (and a few
// getAuthCredentials()) with no arguments. Instead of threading a client
// through every handler, the hosted connector wraps each MCP request in
// runWithQboContext({ client, actor }); getInstance() reads the client from
// AsyncLocalStorage, so concurrent requests for different companies each see
// their own client.
//
// Two modes:
// - stdio (default): no context -> the lazily built env client (QUICKBOOKS_*
//   env / .env), exactly the pre-fork behaviour.
// - hosted (after enterHostedMode()): no context -> QboNotConnectedError. The
//   env client and the .env token store are never used (fail closed).
//
// Circular import note: quickbooks-client.ts imports this module and this
// module imports quickbooks-client.ts. Neither uses the other's bindings at
// module top level (only inside functions), so ESM evaluation order is safe.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createEnvClient, type QuickbooksClient } from '../clients/quickbooks-client.js';

/** Who is making the call, as resolved by the host (e.g. ProjectPix). */
export interface QboActor {
  tenantId: string;
  userId: string;
  canWrite: boolean;
}

/** Everything a single tool call needs: the company's client and the actor. */
export interface QboCallContext {
  client: QuickbooksClient;
  actor?: QboActor;
}

/** Thrown in hosted mode when a call has no QuickBooks connection in context. */
export class QboNotConnectedError extends Error {
  constructor(message = 'QuickBooks is not connected for this request. Connect QuickBooks and try again.') {
    super(message);
    this.name = 'QboNotConnectedError';
  }
}

const storage = new AsyncLocalStorage<QboCallContext>();
let hostedMode = false;
let envClient: QuickbooksClient | undefined;

/** Run fn with ctx as the active QuickBooks context for every async call inside it. */
export function runWithQboContext<T>(ctx: QboCallContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** The active context, or undefined outside runWithQboContext. */
export function currentQboContext(): QboCallContext | undefined {
  return storage.getStore();
}

/**
 * Switch this process to hosted mode (one-way, idempotent). Afterwards a call
 * with no context throws QboNotConnectedError and a QuickbooksClient without
 * an explicit tokenStore cannot be constructed.
 */
export function enterHostedMode(): void {
  hostedMode = true;
}

/** True once enterHostedMode() has been called. */
export function isHostedMode(): boolean {
  return hostedMode;
}

/**
 * The stdio env client, built on first call from QUICKBOOKS_* env (after
 * loading the token-store .env) and memoized. Throws only when called with the
 * env missing — importing this module never throws. Refuses in hosted mode.
 */
export function getEnvClient(): QuickbooksClient {
  if (hostedMode) throw new QboNotConnectedError();
  envClient ??= createEnvClient();
  return envClient;
}
