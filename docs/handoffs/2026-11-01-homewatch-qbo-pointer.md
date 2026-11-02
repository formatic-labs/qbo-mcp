---
title: HomeWatch pointer - QuickBooks connector
date: 2026-11-01
from: qbo-mcp (formatic-labs/qbo-mcp, branch feat/hosted-connector)
to: homewatch-platform sessions (future)
---

# HomeWatch: QuickBooks later, via the shared package

**Nothing to build now.** Pick this up when HomeWatch reaches its integrations phase.

- HomeWatch gets QuickBooks by mounting `@formatic-labs/qbo-mcp` the same way ProjectPix does: its own authenticated
  MCP route calls `handleQboMcpRequest`, with a per-request `QuickbooksClient` and a host-owned `TokenStore`.
- **Reuse ADR-016** (`docs/adr/ADR-016-oauth-tokens-in-vault.md`): metadata row plus Supabase Vault tokens, refresh
  before expiry, failed refresh -> `reauth_required`. ProjectPix is the first implementation of it for QBO.
- **Follow whatever integrations/marketplace pattern ProjectPix ships** (Connect/Reconnect/Disconnect card, QBO grant
  separate from other AI write grants, owner/admin-only writes). Do not invent a second pattern.
- Same Intuit app ("QBO Connector"); each company authorizes its own books. Add HomeWatch's production redirect URI
  in the Intuit portal when the time comes.
- Hosted tools are the package's allowlist only (estimate-focused, no deletes). Widening is a change to the package.
- HomeWatch moving deposits in-portal is what retires the manual "Deposit request" step in QuickBooks.
- Locking, `strictPersistence`, `QboActor`, audit retention: see the ProjectPix handoff, sections 2 to 4.

Links (in the qbo-mcp repo):
- Spec: `docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md`
- ProjectPix handoff: `docs/handoffs/2026-11-01-projectpix-qbo-connector.md`
