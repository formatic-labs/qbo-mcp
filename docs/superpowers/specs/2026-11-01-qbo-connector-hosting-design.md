---
title: QBO connector — shared package + ProjectPix-hosted remote connector
date: 2026-11-01
status: approved by Johnny 2026-11-01
supersedes: Phase 4 "host on the home server behind Tailscale Funnel" in
  master-brain/docs/handoffs/2026-10-04-crm-estimating-and-qbo-connector.md and
  claude-deliverables/Formatic/QBO/qbo-mcp-hosting-handoff.txt (steps 3–8)
---

# QBO connector: shared package + ProjectPix-hosted remote connector

## 1. Intent and why

Johnny builds CRM Services estimates from a Claude Duet thread: Claude reads the job from the
ProjectPix MCP connector, then writes a line-item estimate into QuickBooks Online (QBO) through
this connector. Today the QBO connector is a local stdio process, so cloud sessions (Duet, phone,
claude.ai) can't reach it — the Oct 15 Dan Fendall job had to be copy-pasted into QBO by hand.

Beyond Johnny, the same capability ships to other contractors: ProjectPix's "quick estimation"
feature (target: **ProjectPix beta launch, soon**) and, later, HomeWatch. Contractors will use
whatever AI assistant they have (Claude, Grok, Muse, …) and connect **their own** QBO company
from an integrations / marketplace listing inside the app. It is a listed integration, not a
separately sold product.

So this connector becomes:
- a **shared package** `@formatic-labs/qbo-mcp` (the QBO tools and safety rules), and
- a **remote MCP connector hosted inside ProjectPix**, using ProjectPix's logins and storing each
  company's QBO keys separately and encrypted.

Johnny uses the ProjectPix-hosted connector himself (from Duet and from Claude Code on his
desktop — Claude Code supports remote connectors). This repo also keeps a **local stdio build for
development against the sandbox**.

## 2. Goals

1. Any MCP client that supports remote connectors with OAuth (claude.ai/Duet, Claude Code,
   others) can connect to the ProjectPix-hosted QBO connector and act on **its own company's**
   QBO books only.
2. Johnny's CRM Services company is the first tenant; his estimate workflow (headers,
   `Subtotal: $X.XX` lines, expiration date, fee line, deposit paragraph — produced by the
   assistant via the `crm-qbo-transfer` skill, see C2) works end to end from Duet.
3. Ready for ProjectPix beta contractors: each can connect QBO from ProjectPix with no help from Johnny.
4. One codebase for the QBO tools, reused by ProjectPix now and HomeWatch later.
5. The local stdio build in this repo keeps working for sandbox development and testing.

## 3. Non-goals (now)

- Billing, pricing or a standalone product listing.
- An admin dashboard for the connector.
- Intuit App Store listing (later; see §9).
- HomeWatch integration (it will mount the same package later; not built here).
- The ProjectPix marketplace / integrations **section design** itself — that is its own project in
  the ProjectPix repo. This spec defines only what the QBO integration needs from it.
- A home-server or VPS deployment of the connector against real books.

## 4. Anti-goals (would make this a failure even if it "works")

- **Any path by which one company's session can read or write another company's QBO books.**
- QBO refresh tokens stored unencrypted, logged, sent to the client, or committed anywhere.
- Delete operations reachable on real books.
- Two live connections to the same QBO company through the same Intuit app fighting over rotating
  refresh tokens (the reason Johnny's private real-books copy was dropped).
- A second, separate account system for contractors.
- More moving parts than needed (no new always-on server, no separate auth server).

## 5. Decisions made in the conversation

| # | Decision | Whose |
|---|---|---|
| D1 | Hosting lives with ProjectPix (Vercel + Supabase), not the home server or the personal Hostinger VPS. | Johnny |
| D2 | Contractors sign in with their **ProjectPix account**; no separate login. | Claude's recommendation; Johnny delegated ("whatever is most effective") |
| D3 | Shared package + ProjectPix mount; HomeWatch mounts the same package later. | Johnny ("both") |
| D4 | No home-server/real-books copy. Johnny uses the ProjectPix-hosted connector from Duet and Claude Code; the local stdio build is for **sandbox development only**. If ProjectPix is ever down, signing a local copy into real books takes ~5 minutes. | Claude; Johnny said take the simplest route with the same result |
| D5 | Ready by ProjectPix beta launch. | Johnny |
| D6 | QBO keys stored per HomeWatch **ADR-016**: metadata in a `tenant_integrations`-style table, tokens in **Supabase Vault**, refresh before expiry, failed refresh → status `reauth_required`. | Existing ADR (homewatch-platform/docs/adr/ADR-016-oauth-tokens-in-vault.md) |
| D7 | Delete tools are **never registered** in the hosted connector. | Handoff step 6 |
| D8 | Every write is logged with company, user, tool, QBO entity type + Id, and `intuit_tid`. | Handoff step 6 |
| D9 | **QBO writes need their own grant, owner/admin only by default.** Separate from the photo/AI write grant: a QBO-specific consent (or grant flag) per user + client; owners and admins may create/update in QBO; managers and crew get QBO **read** at most. | Johnny (2026-11-01, Claude's recommendation) |
| D10 | **Reuse the existing Intuit app, renamed** (from "CRM Connector" to the universal name Johnny chose, "QBO Connector", subject to Intuit's naming rules — fallback e.g. "Formatic Connector for QuickBooks"). Every contractor, Johnny included, connects through it; each company authorizes its own books. Update the production questionnaire answers that assumed single-company private use. No new Intuit app. | Johnny |

## 6. Constraints and facts the builder must know

**qbo-mcp today (this repo, `formatic-labs/qbo-mcp`, fork of `intuit/quickbooks-online-mcp-server`):**
- `@modelcontextprotocol/sdk` ^1.26, `node-quickbooks`, `intuit-oauth`, zod 3. Stdio only
  (`src/index.ts`). Upstream Intuit has **no** HTTP transport (checked 2026-11-01).
- ~142 handlers call `QuickbooksClient.getInstance()`, a process-wide singleton that reads one
  company's credentials from env/`.env` at module load (`src/clients/quickbooks-client.ts`) and
  persists rotated refresh tokens back to `.env` (DPAPI-encrypted on Windows).
- Tools are registered through `src/helpers/register-tool.ts`, which already gates categories by
  env (e.g. `QUICKBOOKS_DISABLE_DELETE`).
- Error detail + `intuit_tid` extraction exists (`src/helpers/format-error.ts`).

**ProjectPix (`formatic-labs/ProjectPix`, deploys from mirror `crmsvc/projectpix-deploy` to projectpix.io):**
- Next.js 15.5 on **Vercel (Hobby plan today)**, Supabase (Auth email+password, Postgres, RLS
  via `get_my_tenant_id()`), photos in Cloudflare R2. All serverless; functions use `maxDuration = 60`.
- Its MCP server is a Next.js route, `src/app/api/v1/mcp/route.ts`, stateless Streamable HTTP via
  `@modelcontextprotocol/server` ^2.3.1. **Supabase Auth's built-in OAuth 2.1 server** is the
  authorization server; ProjectPix is the resource server (`/.well-known/oauth-protected-resource/...`,
  `/.well-known/oauth-authorization-server`, consent page `src/app/oauth/consent/`).
  `verifySignInToken` (`src/lib/mcp/oauth.ts`) maps a token → user → `profiles.tenant_id` →
  `mcp_grants`; calls are logged in `mcp_calls`; tenant switch `ai_enabled` and per-person
  `ai_allowed` gate AI access. Dynamic client registration is a Supabase dashboard toggle
  (`docs/launch-checklist.md`, unchecked there).
- Background work pattern: `pg_cron` + `pg_net` calling a Vercel route every minute
  (`supabase/migrations/0021_webhook_worker_cron.sql`), because Hobby cron is daily only.
- No Vault/pgsodium use yet; secrets elsewhere are hashed or plain.
- `docs/projectpix_integrations_devarch_migration.md` already plans QBO as the first outbound
  integration; `clients.qbo_customer_id` is planned; `get_estimate_feed` MCP tool exists.

**QuickBooks / Intuit:**
- Intuit app "CRM Connector" has production keys (questionnaire submitted 2026-10-05).
  Production redirect URIs must be added in the Intuit portal; the hosted callback will live on projectpix.io.
- Refresh tokens **rotate**; the newest must be saved after every refresh, and concurrent refreshes
  for one company must not race (the existing client already shares one in-flight refresh per process;
  serverless needs this per company across instances).
- Proven estimate behaviors (sandbox, 2026-10-04 and 2026-11-01): `DescriptionOnly` text lines keep
  position; `Subtotal: $X.XX` as a `DescriptionOnly` line becomes a live QBO subtotal;
  `SubTotalLineDetail` mid-estimate is dropped; `ExpirationDate` settable; the estimate **Deposit
  request is not exposed by the API at all** (stays manual); an API edit while a user has the
  estimate open in the QBO UI makes their next save fail.
- Intuit's security requirements apply (encryption at rest, error handling); connecting other
  companies' books raises the bar (see §9).

**Formatic package rules:** published to GitHub Packages under `@formatic-labs` (registry
`https://npm.pkg.github.com`); consuming Vercel projects get the `NPM_RC` env var with a
read-packages token (playbook: claude-deliverables/Formatic/GitHub-Packages-Playbook.md); the
package must be added to `Formatic-Package-Menu.md` when published.

## 7. Shape of the solution

### 7.1 The package (`@formatic-labs/qbo-mcp`, this repo)
- Exports a function that registers the QBO tools onto an MCP server instance, taking:
  - a **credentials provider**: given the current request context, returns QBO credentials for one
    company (client id/secret, realm id, environment, current access/refresh token) and a callback
    to **persist rotated tokens**;
  - options: which tool categories to enable (delete off by default for hosted use), and a
    **write-audit hook** called after every create/update with company, user, tool, entity type,
    entity Id, and `intuit_tid`.
- The process-wide singleton is replaced (or wrapped) so each call uses the **current request's
  company**. Builder's choice of mechanism (e.g. AsyncLocalStorage behind `getInstance()` so the
  142 handlers don't change).
- The existing stdio entry point stays, using an `.env`-backed credentials provider (current
  behavior, including DPAPI) — that is the local sandbox dev build.
- Upstream `intuit/quickbooks-online-mcp-server` changes should remain mergeable: keep fork changes
  in additive files where practical.

### 7.2 The ProjectPix mount (built in the ProjectPix repo)
- A second MCP endpoint next to the existing one (e.g. `/api/v1/qbo/mcp`), stateless Streamable
  HTTP, protected like the existing endpoint (same Supabase OAuth, same well-known metadata
  pattern, same `ai_enabled` / `ai_allowed` checks, same `mcp_calls` logging), **plus a separate
  QBO grant (D9)**: today `mcp_grants` has one row per user+client with a single `can_write`, so
  QBO access needs its own consent/flag; QBO write tools refuse unless the user is owner/admin and
  holds the QBO write grant.
- Credentials provider backed by ADR-016-style storage: integration metadata row per tenant
  (provider `qbo`, realm id, environment, status, connected-by, timestamps) + Vault entries for
  access and refresh tokens. RLS so only that tenant's owner/admin can see the metadata; tokens
  readable only server-side.
- **Token refresh** serialized per tenant across serverless instances (e.g. a row lock or
  compare-and-swap on the stored refresh token) and saved after every rotation. A scheduled
  refresh keeps idle connections alive (refresh tokens expire after ~100 days of non-use) using the
  existing pg_cron → HTTPS pattern; failure sets `reauth_required`.
- **Connect QuickBooks** flow: an owner/admin clicks Connect on the integrations page → Intuit
  OAuth (scope `com.intuit.quickbooks.accounting`) → callback on projectpix.io stores tokens and
  realm → page shows Connected (company name) / Reconnect / Disconnect. Disconnect revokes at
  Intuit and deletes the Vault entries.
- When QBO isn't connected (or `reauth_required`), tools return a clear message telling the user
  to connect QuickBooks in ProjectPix — never a stack trace.
- One QBO company per ProjectPix tenant.

### 7.3 Johnny's own use
- Duet and Claude Code connect to the ProjectPix QBO endpoint like any contractor.
- This repo's stdio build stays signed into the **sandbox** for development.

## 8. Rollout order

1. Package refactor + publish (this repo): credentials provider, per-request client, audit hook,
   delete off; existing 665 tests stay green; sandbox smoke test passes through the new provider.
2. ProjectPix: storage (migration), Connect QuickBooks flow, `/api/v1/qbo/mcp` route, refresh job.
   Tested against the **sandbox** company first.
3. Intuit portal (Johnny): rename the app (D10), add the projectpix.io production redirect URI,
   update questionnaire answers for multi-company use. Can be done any time before step 4.
4. Johnny connects real CRM Services books in ProjectPix; first real-books test = "ZZ TEST"
   customer + estimate with header + `Subtotal:` lines; Johnny deletes the estimate and
   inactivates the customer by hand.
5. Johnny adds the connector in claude.ai (Settings → Connectors) and runs a Duet test: read
   ProjectPix job → build estimate.
6. Pre-launch security gate (Cloudflare `security-audit`, full audit mode) before any beta
   contractor connects — per standing rule.

## 9. Open items for later (not blocking the build)

- **Vercel plan:** Hobby forbids commercial use; ProjectPix beta needs Pro anyway (~$20/mo).
- **Intuit multi-company requirements:** once other contractors' books connect, review Intuit's
  app requirements (security review; App Store listing optional). Track before beta, not before build.
- **Deposit:** stays a manual step in QBO until HomeWatch moves deposits into its own portal.
- The ProjectPix integrations/marketplace section design (separate project) decides where the
  Connect QuickBooks card sits; this spec only needs a page that can host it.

## 9a. Calls made by Claude (Johnny: check these)

- **C1 — Hosted tool surface is an estimate-focused allowlist, not all ~142 tools.** Hosted:
  customers (search/get/create/update), items (search/read), estimates (search/get/create/update),
  plus read-only lookups the estimate flow needs (company info, preferences, tax codes, terms,
  classes, invoice read/search for history). No bills, payments, journal entries, vendors,
  employees, transfers, deposits, or any delete. The local stdio build keeps the full set.
  Why: smallest surface for the security gate and Intuit's review; widen later by adding names
  to the allowlist.
- **C2 — The package stays generic; CRM's estimate format is not in it.** Header lines,
  `Subtotal: $X.XX` lines, the fee line and the deposit paragraph are produced by the assistant
  following the `crm-qbo-transfer` skill. The connector only has to pass raw QBO objects through
  faithfully (already true). Other contractors get their own skill/prompt or none.
- **C3 — ProjectPix work lands through its master stream** (owner of migrations and APIs, per
  the repo's multi-stream rules) with a `docs/HANDOFF-<date>-qbo-connector.md` + feature-map row.
  If the integrations/marketplace page isn't ready, the Connect QuickBooks card lives temporarily
  in the existing company settings area and moves when the marketplace ships.

## 10. Left to the builder

- Package API names and module layout; how the per-request client is threaded through handlers.
- Whether ProjectPix depends on the published package or a git dependency during development.
- Exact table/column names, as long as they follow ADR-016's split (metadata table + Vault).
- Locking mechanism for refresh; the refresh job's schedule.
- Which MCP SDK major to standardize on (qbo-mcp uses `@modelcontextprotocol/sdk` 1.x, ProjectPix
  uses `@modelcontextprotocol/server` 2.x) — pick one, note the reason.
- Test strategy (follow each repo's existing conventions; TDD per standing rules).
