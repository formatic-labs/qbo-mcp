---
title: ProjectPix handoff - hosted QuickBooks (QBO) connector
date: 2026-11-01
from: qbo-mcp (formatic-labs/qbo-mcp, branch feat/hosted-connector)
to: ProjectPix APP master session + WEB session
spec: docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md (approved 2026-11-01)
copy-to: ProjectPix/docs/HANDOFF-2026-11-01-qbo-connector.md (the master stream copies it and adds the feature-map row)
---

# Handoff: QuickBooks connector inside ProjectPix

Before building, run your session-start briefing: read ProjectPix `PROJECT_LOG.md` and the Streams table.

Written as decisions. Plan your own code; the "must" lines are constraints from how the package behaves. Spec cited below as "the spec": `formatic-labs/qbo-mcp: docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md`.

## 0. What this is, in one paragraph

The package `@formatic-labs/qbo-mcp` holds the QuickBooks tools and the safety rules (estimate-focused allowlist, no
deletes, writes refused unless the actor may write). ProjectPix is the host: it signs people in, stores each company's
QuickBooks keys, and mounts the package as a second MCP endpoint. Each ProjectPix tenant connects its own QuickBooks
company; one tenant can never reach another's books. Johnny is the first tenant (CRM Services). Ready target: ProjectPix beta.

## 1. Ownership split (per ProjectPix multi-stream rules)

### APP master session (owns main, migrations, APIs)

1. **Migration** (timestamp-named). A tenant integration row for provider `qbo` (realm id, environment, status,
   connected-by, timestamps) plus **Supabase Vault** entries for the access and refresh tokens, per HomeWatch
   ADR-016 (`homewatch-platform/docs/adr/ADR-016-oauth-tokens-in-vault.md`). RLS: tenant owner/admin may read the
   **metadata only**; tokens are readable server-side only. One QuickBooks company per tenant.
2. **QBO grant**, separate from `mcp_grants.can_write` (decision D9). Per user + client. Owners/admins may hold the
   write grant. A photo/AI write grant must not imply QBO write. **Storage shape (a column on `mcp_grants` vs a new
   table) is the APP master session's builder call.** Default roles (Johnny can change; see Open for Johnny): owner,
   admin and manager may read QuickBooks through the connector; crew get no QuickBooks access; only owner/admin with
   the QBO write grant may write.
3. **Intuit OAuth callback** on projectpix.io (scope `com.intuit.quickbooks.accounting`). Stores tokens and realm id.
   Disconnect revokes at Intuit and deletes the Vault entries.
4. **Route `/api/v1/qbo/mcp`.** Authenticate exactly like `src/app/api/v1/mcp/route.ts`: Supabase OAuth via
   `verifySignInToken` (`src/lib/mcp/oauth.ts`), the `ai_enabled` tenant switch and `ai_allowed` per person, and
   `mcp_calls` logging. Then call the package's `handleQboMcpRequest`. Same well-known metadata pattern as the
   existing endpoint.
5. **Vault-backed `TokenStore`** (see section 3 for the lock rule).
6. **Weekly refresh job** (pg_cron -> HTTPS, pattern `supabase/migrations/0021_webhook_worker_cron.sql`). Refreshes
   idle connections so the refresh token (about 100 days idle) never dies. On failure it calls `markReauthRequired`,
   which sets status `reauth_required`.
7. **`onWrite` audit sink** (see section 4).
8. When QuickBooks is not connected or is `reauth_required`, tools must say "connect QuickBooks in ProjectPix",
   never a stack trace (the package already throws a clear not-connected error; make sure the route lets it through).

### WEB session (owns the desktop site at `/desk`)

- The **Integrations / app-marketplace page** with a **Connect / Reconnect / Disconnect QuickBooks** card, visible to
  owner/admin only. It already exists as a "Soon" menu item in desk slice 1 and is listed in
  `docs/HANDOFF-2026-10-26-desktop-not-built-for-app-session.md`.
- Johnny said on 2026-10-25 that integrations must launch with **Jobber, Housecall Pro and QuickBooks**.
- **The marketplace page itself needs its own design session in WEB.** QuickBooks is its first listing; this handoff
  only needs a page that can host the card.
- **Temporary home** if the marketplace isn't ready: the company settings area (call C3 in the spec). Move it when the
  marketplace ships.
- **Dependency:** the card needs APP's connect-URL and status endpoints (plus disconnect). **WEB builds after APP's endpoints land on `main`.**

### Proposed row for `docs/feature-map.md` (Johnny to confirm placement)

| Feature | Belongs to | APP | WEB |
|---|---|---|---|
| QuickBooks connector - Web-admin page (WEB) + backend (APP master) | Web-admin + backend | not started | not started |

Status note: **Johnny to confirm placement.** WEB builds after APP's endpoints land on `main` (connect-URL, status, disconnect).

## 2. Who may write: `QboActor`

`QboActor = { tenantId, userId, canWrite }`.

**`canWrite` = tenant owner/admin AND holds the QBO write grant.** Both, not either. The package refuses every
create/update when `canWrite` is false, but only the host can compute it, so get it right in the route.

## 3. How to construct the client (constraints, not suggestions)

- Build a fresh `QuickbooksClient` per request in `resolveContext`, with an explicit **`tokenStore`**, the **`realmId`
  from the integration row**, and **`strictPersistence: true`**. A failed save of a rotated refresh token then fails
  loudly instead of silently losing the token. `TokenStore.read()` does not return `realmId`, so pass it from the row.
- **`TokenStore.withRefreshLock(fn)` must hold a session-level lock for the whole of `fn`**, which reads the token,
  calls Intuit over HTTP, then saves. Use a Postgres advisory lock, or `SELECT ... FOR UPDATE`, on a **direct
  connection held for the whole `fn`**. Per-call PostgREST requests cannot hold a lock across calls, so they will not do.
  Refresh tokens rotate; two instances refreshing one company at once is the failure this prevents.
- `markReauthRequired(reason)` receives text with no secrets; store it as status and show "Reconnect QuickBooks" in the card.
- The hosted `tools` option may only be a **subset of `HOSTED_TOOL_ALLOWLIST`**; anything else rejects. Widening the
  surface means editing the allowlist in the package, not in ProjectPix. Hosted surface today: customers, items,
  estimates, plus read-only lookups (company info, preferences, tax codes, terms, classes, invoice read/search). No
  deletes, bills, payments, journal entries, vendors, employees.
- Next.js may need `serverExternalPackages: ["node-quickbooks", "intuit-oauth"]` in `next.config`.

## 4. Audit

- `onWrite` receives a `QboWriteAuditEvent` after every create/update: who, which tool, QBO entity type + Id,
  `intuit_tid`. `tenantId` in the event identifies the company; the sink may add `realmId`.
- Store it in an audit table or `mcp_calls`.
- **Set a retention policy; proposed default: 1 year for QBO audit rows.** The event's `error` text can contain customer details copied from QuickBooks fault messages.
- The package does **not** audit refused writes or failed context resolution. Log those host-side if you want them.

## 5. Install

- Package `@formatic-labs/qbo-mcp@^0.1.0` from GitHub Packages. It publishes when Johnny approves the `v0.1.0` tag
  (tag-driven workflow).
- Local development: `npm pack` or `npm link` against a built qbo-mcp checkout. Vercel preview and production builds wait for the published `@formatic-labs/qbo-mcp@0.1.0` installed via `NPM_RC`. If you need a deploy before then, ask Johnny for an early tag. Do not add a git-token install path.
- Vercel: commit `.npmrc` with `@formatic-labs:registry=https://npm.pkg.github.com`; put the read token in the
  **`NPM_RC`** env var per `claude-deliverables\Formatic\GitHub-Packages-Playbook.md`. The token comes from the
  password manager; clients never receive it.
- Usage example: README section "Hosted use (ProjectPix)" in this repo.

## 6. Notes for whoever writes skills or prompts (proven in the sandbox)

- `Subtotal: $X.XX` sent as a `DescriptionOnly` line becomes a live QuickBooks subtotal.
- `DescriptionOnly` header lines keep their position.
- `ExpirationDate` is settable.
- The estimate **Deposit request is not exposed by the QuickBooks API**. It stays a manual step until HomeWatch moves
  deposits in-portal.
- Editing an estimate through the API while a person has it open in QuickBooks makes that person's next save fail.
- The package is generic. CRM's estimate format lives in the `crm-qbo-transfer` skill, not here (call C2).

## 7. Johnny's manual steps (decision D10)

1. In the Intuit developer portal, **rename the app** "CRM Connector" to **"QBO Connector"**. If Intuit rejects names
   containing QuickBooks/QBO, use the fallback "Formatic Connector for QuickBooks". No new Intuit app.
2. Add the **projectpix.io production redirect URI** for the OAuth callback.
3. **Update the production questionnaire answers** that assumed single-company private use (now multi-company).
4. **Vercel Pro** before beta (Hobby forbids commercial use).
5. Later, before other contractors' books connect: review Intuit's multi-company requirements (section 9 of `formatic-labs/qbo-mcp: docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md`).

## 8. Test order

1. Build and test against the **QuickBooks sandbox company** first.
2. Then Johnny connects the **real CRM Services books** in ProjectPix.
3. First real-books test: a "ZZ TEST" customer and estimate with a header line and `Subtotal:` lines. Johnny deletes
   the estimate and inactivates the customer by hand (delete is not exposed).
4. Then the Duet test: Johnny adds the connector in claude.ai (Settings -> Connectors), reads a ProjectPix job, builds the estimate.

(Section 8, steps 3 to 5, of `formatic-labs/qbo-mcp: docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md`.)

## 9. Pre-launch security gate

Before **any beta contractor connects**, run Cloudflare's `security-audit` skill in **full audit mode** (committed in
ProjectPix at `.claude/skills/security-audit/`, see `docs/pre-launch-security-gate.md`). Critical/High findings are
fixed or accepted by Johnny. Particular attention: tenant isolation of the QBO route and the Vault read path, and
that no token is ever logged or returned to a client.

## Open for Johnny

- Confirm the feature-map placement (section 1).
- Confirm default QBO roles (owner/admin/manager read; crew none; owner/admin with the write grant write).
- Confirm audit retention (default 1 year).
- Approve the `v0.1.0` tag so the package publishes.
