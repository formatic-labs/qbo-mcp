# QBO Connector Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into the multi-company package `@formatic-labs/qbo-mcp` that ProjectPix mounts as a remote MCP endpoint, while the stdio build keeps working for sandbox development.

**Architecture:** Each tool call resolves "which company, which user" from the host through an AsyncLocalStorage request context, so the ~142 handlers that call `QuickbooksClient.getInstance()` stay unchanged. Token persistence moves behind a `TokenStore` interface (the `.env` file for stdio, Supabase Vault for ProjectPix). The package exports `handleQboMcpRequest(request, options)`, a stateless web-standard Streamable HTTP handler built on the SDK this repo already uses, so ProjectPix's route only authenticates and delegates.

**Tech Stack:** TypeScript ESM, `@modelcontextprotocol/sdk` ^1.26 (`McpServer`, `WebStandardStreamableHTTPServerTransport`), `node-quickbooks`, `intuit-oauth`, zod 3, Jest (ts-jest ESM) with a 100% coverage gate.

**Spec:** `docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md`

## Global Constraints

- Branch `feat/hosted-connector`; conventional commits; every commit has a dated `CHANGELOG.md` entry (the pre-commit hook enforces it); `npm run build` and `npm test` pass before each commit.
- Jest coverage gate stays at 100% (branches/functions/lines/statements) except the paths `jest.config.js` already exempts.
- Stay on `@modelcontextprotocol/sdk` ^1.26 (spec §10 left the SDK choice to the builder; the v1 SDK ships `WebStandardStreamableHTTPServerTransport`, so ProjectPix needs no SDK migration).
- Hosted mode never registers delete tools (D7) and only registers `HOSTED_TOOL_ALLOWLIST` (C1).
- Hosted mode must **never** fall back to the `.env` client. A request with no resolved company fails closed.
- Secrets (client secret, access/refresh tokens) never appear in logs, tool output, error text or audit records.
- The stdio entry (`dist/index.js`, `npm run auth`, `npm run encrypt-env*`) keeps current behaviour, including DPAPI.
- Package name `@formatic-labs/qbo-mcp`, registry `https://npm.pkg.github.com`.
- Keep fork changes in additive files where practical so `upstream` (intuit/quickbooks-online-mcp-server) stays mergeable.

## Review Focus

1. **Two serverless instances refresh the same company at once** → exactly one refresh call reaches Intuit, and both calls succeed with the newest token (Task 2, `refresh is serialized through the store lock`).
2. **Company disconnected/revoked in QuickBooks** → the tool returns "QuickBooks needs to be reconnected in ProjectPix" text and the store's `markReauthRequired()` is called; no stack trace (Tasks 2 and 4).
3. **Hosted request where the host can't resolve a company** (no grant, not connected) → refusal message; the `.env` client is never touched (Task 3, `hosted context never falls back to env client`).
4. **Non-admin calls `create_estimate`** → refused before any QuickBooks call, nothing written, no audit record (Task 4).
5. **Caller tries to pick another company** (adds `realmId` to params) → realm comes only from the context; hosted tool schemas declare no realm key, so the unsupported-parameter warning reports it as ignored (Task 4).

---

### Task 1: Tool catalog and hosted allowlist

**Files:**
- Create: `src/tools/catalog.ts`
- Modify: `src/index.ts` (replace the per-tool `RegisterTool(...)` calls with a loop over `ALL_TOOLS`)
- Test: `tests/unit/tools/catalog.test.ts`

**Interfaces:**
- Produces: `export const ALL_TOOLS: readonly ToolDefinition<any>[]` (every tool currently registered in `src/index.ts`, same order); `export const HOSTED_TOOL_ALLOWLIST: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test("ALL_TOOLS has unique names and matches what index.ts registered before", () => {
  const names = ALL_TOOLS.map(t => t.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.length).toBe(EXPECTED_TOOL_COUNT); // count the RegisterTool calls in src/index.ts on main before editing
});
test("allowlist is a subset of the catalog", () => {
  const names = new Set(ALL_TOOLS.map(t => t.name));
  for (const n of HOSTED_TOOL_ALLOWLIST) expect(names.has(n)).toBe(true);
});
test("allowlist contains no delete or non-estimate accounting writes", () => {
  for (const n of HOSTED_TOOL_ALLOWLIST) {
    expect(n).not.toMatch(/^delete[_-]/);
    expect(n).not.toMatch(/bill|payment|journal|vendor|employee|transfer|deposit|purchase|refund|credit_memo|sales_receipt|time_activity|account/);
  }
});
test("allowlist is exactly the estimate set", () => {
  expect([...HOSTED_TOOL_ALLOWLIST].sort()).toEqual([
    "create_customer","create_estimate","get_class","get_company_info","get_customer","get_estimate",
    "get_preferences","get_tax_code","get_tax_rate","get_term","read_invoice","read_item",
    "search_classes","search_customers","search_estimates","search_invoices","search_items",
    "search_tax_codes","search_tax_rates","search_terms","update_customer","update_estimate",
  ]);
});
```

- [ ] **Step 2: Run** `npm test -- tests/unit/tools/catalog.test.ts` → FAIL (module not found).
- [ ] **Step 3: Create `src/tools/catalog.ts`** by moving the imports out of `src/index.ts` into `ALL_TOOLS`; `src/index.ts` loops `for (const t of ALL_TOOLS) RegisterTool(server, t)`.
- [ ] **Step 4: Run** `npm test` → all pass, coverage 100%. `npm run build` succeeds.
- [ ] **Step 5: Commit** `refactor: move tool registrations into a catalog with a hosted allowlist`.

### Task 2: TokenStore abstraction and serialized refresh

**Files:**
- Create: `src/clients/token-store.ts`, `src/clients/env-file-token-store.ts`
- Modify: `src/clients/quickbooks-client.ts` (constructor config, refresh path, `saveTokensToEnv`, `readPersistedRefreshToken`)
- Test: `tests/unit/clients/token-store.test.ts`, extend `tests/unit/clients/quickbooks-client*.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StoredQboTokens { refreshToken: string; accessToken?: string; accessTokenExpiresAt?: Date }
  export interface TokenStore {
    read(): Promise<StoredQboTokens | undefined>;
    save(tokens: StoredQboTokens): Promise<void>;
    withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;   // serializes refresh per company across processes
    markReauthRequired(reason: string): Promise<void>;
  }
  export class EnvFileTokenStore implements TokenStore { constructor(path: string) }  // current .env + DPAPI behaviour; lock = in-process mutex
  ```
- `QuickbooksClient` constructor config gains `tokenStore?: TokenStore` (default `EnvFileTokenStore` at the current token-store path) and `accessToken?`/`accessTokenExpiresAt?` seeds.

- [ ] **Step 1: Write the failing tests**
  - `EnvFileTokenStore round-trips refresh token through .env with DPAPI when enabled` (mock `token-crypto`).
  - `refresh is serialized through the store lock`: two `QuickbooksClient`s sharing one fake store with a real async mutex, both expired; `Promise.all([a.authenticate(), b.authenticate()])` → `performRefresh` called once; the second client uses the token the first saved (re-read inside the lock).
  - `rotated refresh token and access token are saved after refresh` → `store.save` called with the new refresh token, access token and expiry.
  - `fresh stored access token skips refresh` → seeded `accessTokenExpiresAt` 30 min ahead → no refresh call.
  - `dead refresh token calls markReauthRequired and throws QboReauthRequiredError` (Intuit `invalid_grant`).
- [ ] **Step 2: Run** the new tests → FAIL.
- [ ] **Step 3: Implement.** Refresh path: `store.withRefreshLock(async () => { const latest = await store.read(); if latest access token is fresh → use it; else performRefresh(latest.refreshToken); await store.save(...) })`. Export `class QboReauthRequiredError extends Error` from `token-store.ts`. Existing `.env` behaviour moves into `EnvFileTokenStore` unchanged.
- [ ] **Step 4: Run** `npm test` → pass, 100% coverage; `npm run build`.
- [ ] **Step 5: Sandbox check:** `node dist/index.js` via the existing smoke script in `crm-estimating` (`node scripts/qbo-smoke-test.mjs`) still creates and reads a sandbox estimate.
- [ ] **Step 6: Commit** `refactor: persist QuickBooks tokens through a TokenStore with a refresh lock`.

### Task 3: Request context and lazy env client

**Files:**
- Create: `src/context/qbo-context.ts`
- Modify: `src/clients/quickbooks-client.ts` (module-level env read + `throw` becomes lazy `getEnvClient()`; `getInstance()`/`getAuthCredentials()` consult the context first)
- Test: `tests/unit/context/qbo-context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface QboActor { tenantId: string; userId: string; canWrite: boolean }
  export interface QboCallContext { client: QuickbooksClient; actor?: QboActor }
  export function runWithQboContext<T>(ctx: QboCallContext, fn: () => Promise<T>): Promise<T>;
  export function currentQboContext(): QboCallContext | undefined;
  export function enterHostedMode(): void;   // after this, getInstance() without a context throws QboNotConnectedError
  export class QboNotConnectedError extends Error {}
  export function getEnvClient(): QuickbooksClient; // lazily built from QUICKBOOKS_* env; throws only when called
  ```

- [ ] **Step 1: Write the failing tests**
  - `importing the library entry without QUICKBOOKS_* env does not throw` (dynamic import with env cleared).
  - `getInstance uses the context client inside runWithQboContext` (two fake clients, two concurrent contexts, each call sees its own).
  - `hosted context never falls back to env client`: `enterHostedMode()`, call `QuickbooksClient.getInstance()` outside any context → rejects `QboNotConnectedError`; `getEnvClient` spy not called.
  - `stdio mode without context uses the env client` (current behaviour).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `AsyncLocalStorage` from `node:async_hooks`. Keep the exported `quickbooksClient` name working for `auth-server.ts` / `encrypt-env.ts` (e.g. a lazy getter or an accessor they call), so the stdio tools are unaffected.
- [ ] **Step 4: Run** `npm test` → pass, 100%; `npm run build`.
- [ ] **Step 5: Commit** `feat: per-call QuickBooks request context with fail-closed hosted mode`.

### Task 4: `registerQboTools` with allowlist, write gate and audit hook

**Files:**
- Create: `src/register-qbo-tools.ts`
- Modify: `src/helpers/register-tool.ts` (accept an options object; existing env-based disabling still applies), `src/index.ts` (call `registerQboTools(server)` with stdio defaults)
- Test: `tests/unit/register-qbo-tools.test.ts`

**Interfaces:**
- Consumes: `ALL_TOOLS`, `HOSTED_TOOL_ALLOWLIST` (Task 1); `runWithQboContext`, `QboCallContext`, `QboNotConnectedError` (Task 3); `QboReauthRequiredError` (Task 2).
- Produces:
  ```ts
  export interface QboWriteAuditEvent { tool: string; category: "WRITE" | "UPDATE"; entityType?: string; entityId?: string; intuitTid?: string; actor?: QboActor; ok: boolean; error?: string }
  export interface RegisterQboToolsOptions {
    tools?: readonly string[];                       // default: all (stdio); hosted passes HOSTED_TOOL_ALLOWLIST
    resolveContext?: (extra: { authInfo?: AuthInfo }) => Promise<QboCallContext>; // hosted: required
    onWrite?: (e: QboWriteAuditEvent) => Promise<void> | void;
    hosted?: boolean;                                // true → delete tools never registered, regardless of env
  }
  export function registerQboTools(server: McpServer, options?: RegisterQboToolsOptions): void;
  ```
- Messages (exact copy, returned as a single text content item):
  - not connected: `QuickBooks isn't connected for this company. An owner or admin can connect it in ProjectPix → Settings → Integrations.`
  - reauth: `QuickBooks needs to be reconnected for this company. An owner or admin can reconnect it in ProjectPix → Settings → Integrations.`
  - write refused: `Only an owner or admin with QuickBooks access can create or change records in QuickBooks.`

- [ ] **Step 1: Write the failing tests** (use the SDK's in-memory client/server pair or call the registered handler directly):
  - `hosted registers exactly the allowlist` and `hosted never registers delete tools even if the allowlist names one`.
  - `stdio default registers all tools and respects QUICKBOOKS_DISABLE_DELETE` (existing behaviour).
  - `each call runs inside the resolved context` (handler sees `currentQboContext()` from `resolveContext`).
  - `write tool refused when actor.canWrite is false` → write-refused text, handler not invoked, `onWrite` not called.
  - `read tool allowed when canWrite is false`.
  - `resolveContext throwing QboNotConnectedError returns the not-connected text`; `QboReauthRequiredError` returns the reauth text.
  - `onWrite receives tool, entityType, entityId on success` (parse the JSON result content; `create_estimate` → `entityType: "Estimate"`, `entityId` = result `Id`) and `ok:false` + error on failure; audit records contain no token strings.
  - `hosted tool schemas declare no realm key` (no `realmId`/`realm_id` among any hosted tool's known params).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Wrap each handler: resolve context → gate writes by `getCrudCategory` → `runWithQboContext` → call → audit. `intuitTid` comes from the formatted error when present (success responses from node-quickbooks don't expose it; leave undefined).
- [ ] **Step 4: Run** `npm test` → pass, 100%; `npm run build`; stdio `node dist/index.js` lists the same tools as before Task 1.
- [ ] **Step 5: Commit** `feat: registerQboTools with hosted allowlist, write gate and audit hook`.

### Task 5: Web-standard request handler and package entry

**Files:**
- Create: `src/hosted/handle-request.ts`, `src/lib.ts`
- Modify: `package.json` (`name`, `exports`, `types`, `files`, `publishConfig`, `repository`), `tsconfig.json` if needed for declarations
- Test: `tests/unit/hosted/handle-request.test.ts`

**Interfaces:**
- Consumes: `registerQboTools`, `RegisterQboToolsOptions` (Task 4); `enterHostedMode` (Task 3).
- Produces:
  ```ts
  export interface QboHostedOptions extends Omit<RegisterQboToolsOptions, "hosted" | "tools"> {
    resolveContext: NonNullable<RegisterQboToolsOptions["resolveContext"]>;
    tools?: readonly string[];        // default HOSTED_TOOL_ALLOWLIST
  }
  export function handleQboMcpRequest(request: Request, authInfo: AuthInfo, options: QboHostedOptions): Promise<Response>;
  ```
  Stateless: a new `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` per request; `authInfo` passed through `handleRequest(request, { authInfo })`.
- `src/lib.ts` exports: `handleQboMcpRequest`, `registerQboTools`, `HOSTED_TOOL_ALLOWLIST`, `ALL_TOOLS`, `QuickbooksClient`, `TokenStore`, `StoredQboTokens`, `EnvFileTokenStore`, `runWithQboContext`, `QboCallContext`, `QboActor`, `QboWriteAuditEvent`, `QboNotConnectedError`, `QboReauthRequiredError`.
- `package.json`: `"name": "@formatic-labs/qbo-mcp"`, `"exports": { ".": { "types": "./dist/lib.d.ts", "import": "./dist/lib.js" } }`, `"bin"` unchanged (`dist/index.js`), `"publishConfig": { "registry": "https://npm.pkg.github.com" }`, `"repository"` → `formatic-labs/qbo-mcp`. Version `0.1.0`.

- [ ] **Step 1: Write the failing tests**
  - `initialize then tools/list returns the allowlist` (POST JSON-RPC `initialize`, then `tools/list`, with a fake `resolveContext`).
  - `tools/call create_estimate reaches the context client` (fake client records the call).
  - `importing @formatic-labs/qbo-mcp (dist/lib.js) has no side effects` (no stdio transport started, no env read).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `enterHostedMode()` is called once on first `handleQboMcpRequest`.
- [ ] **Step 4: Run** `npm test` → pass, 100%; `npm run build`; `npm pack --dry-run` lists `dist/lib.js`, `dist/lib.d.ts`, `dist/index.js` and no `.env*`, `logs/`, `coverage/`.
- [ ] **Step 5: Commit** `feat: web-standard hosted MCP handler and @formatic-labs/qbo-mcp package entry`.

### Task 6: Publish pipeline, docs, Formatic menu

**Files:**
- Create: `.github/workflows/publish.yml` (on tag `v*`: `npm ci`, `npm test`, `npm run build`, `npm publish` with `GITHUB_TOKEN` `packages: write`)
- Modify: `README.md` (section "Hosted use (ProjectPix)": `handleQboMcpRequest` example with a `TokenStore`), `CHANGELOG.md`
- Modify (outside repo, same change): `G:\.shortcut-targets-by-id\1nfbqpU3qns0K45KAMBSfDdT0RxLYRsuA\claude-deliverables\Formatic\Formatic-Package-Menu.md` — add the `@formatic-labs/qbo-mcp` row (status "Built, unpublished" until the tag is pushed).

- [ ] **Step 1:** Write the workflow following `GitHub-Packages-Playbook.md` §3 (same shape as `@formatic-labs/local-business-mcp-server`'s pipeline).
- [ ] **Step 2: Verify** `npm pack --dry-run` again and `actionlint` (or `gh workflow view` after push) shows no errors.
- [ ] **Step 3: Sandbox end-to-end through the new path:** a scratch script calls `handleQboMcpRequest` with an `EnvFileTokenStore` on the sandbox `.env` and a fake owner actor → `tools/call create_estimate` with a header line, two items and `Subtotal: $X.XX` lines → read back shows the same order. Delete nothing; mark the memo "ZZ TEST".
- [ ] **Step 4: Commit** `ci: publish @formatic-labs/qbo-mcp to GitHub Packages`; push the branch and open a PR. **Tagging `v0.1.0` (which publishes) waits for Johnny's yes.**

### Task 7: ProjectPix handoff

**Files:**
- Create: `docs/handoffs/2026-11-01-projectpix-qbo-connector.md` (in this repo; the ProjectPix master stream copies it to `ProjectPix/docs/HANDOFF-2026-11-01-qbo-connector.md` and adds a feature-map row — this session does not touch the ProjectPix checkout, which has uncommitted work on another branch)

Contents (one section each, decisions only — the ProjectPix builder plans the code):
1. What to build, from spec §7.2: migration (tenant integration row for provider `qbo` + Vault entries per ADR-016; RLS owner/admin read of metadata only), QBO grant per user+client separate from `mcp_grants.can_write` (D9), Connect/Reconnect/Disconnect card (temporary home: company settings, C3), Intuit OAuth callback on projectpix.io, `/api/v1/qbo/mcp` route that authenticates exactly like `src/app/api/v1/mcp/route.ts` then calls `handleQboMcpRequest`, a Vault-backed `TokenStore` whose `withRefreshLock` uses a Postgres row lock, a pg_cron → HTTPS job that refreshes idle connections weekly and calls `markReauthRequired` on failure, `onWrite` → an audit table or `mcp_calls`.
2. `QboActor.canWrite` = owner/admin **and** holds the QBO write grant.
3. Package install: `NPM_RC` on Vercel per the playbook; `@formatic-labs/qbo-mcp@^0.1.0`.
4. Test order: sandbox company first; then Johnny connects real CRM Services books; then the ZZ TEST estimate (spec §8 steps 3–5).
5. Johnny's manual steps: rename the Intuit app, add the projectpix.io redirect URI, update questionnaire answers (D10); Vercel Pro before beta.
6. Pre-launch gate: Cloudflare `security-audit` full mode before any beta contractor connects.

- [ ] **Step 1:** Write the file. **Step 2:** Commit `docs: ProjectPix handoff for the hosted QBO connector` with CHANGELOG entry.

---

## Out of this plan (spec §8 steps 2–6)

The ProjectPix build (Task 7's handoff), Johnny's Intuit portal changes, the real-books test, the Duet test and the security gate happen after this plan, in the ProjectPix repo and with Johnny.
