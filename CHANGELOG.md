# Changelog

All notable changes to the QuickBooks Online MCP Server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — formatic-labs fork

### Added
- 2026-11-01 — **Tool catalog + hosted allowlist** — `src/tools/catalog.ts` now holds `ALL_TOOLS` (the 142 tools
  `src/index.ts` used to register one by one, same order) and `HOSTED_TOOL_ALLOWLIST` (the 22-tool estimate set the
  hosted connector may expose). `src/index.ts` registers via a loop over `ALL_TOOLS`. Why: the shared package and the
  hosted endpoint need one list of tools to consume and a hard allowlist to restrict it; tests pin the count, name
  uniqueness, allowlist-subset-of-catalog, and the exact allowlist contents (no deletes, no non-estimate writes).
- 2026-11-01 — **Implementation plan for the package** — `docs/superpowers/plans/2026-11-01-qbo-connector-package.md`:
  7 tasks (tool catalog + hosted allowlist, TokenStore with refresh lock, fail-closed request context,
  `registerQboTools` with write gate + audit hook, `handleQboMcpRequest` web-standard handler + package entry,
  GitHub Packages publish, ProjectPix handoff). Stays on `@modelcontextprotocol/sdk` 1.x, whose
  `WebStandardStreamableHTTPServerTransport` lets ProjectPix mount it without an SDK migration.
- 2026-11-01 — **Design: shared package + ProjectPix-hosted remote connector** —
  `docs/superpowers/specs/2026-11-01-qbo-connector-hosting-design.md` (approved by Johnny). The connector
  becomes `@formatic-labs/qbo-mcp`, mounted inside ProjectPix (Supabase OAuth logins, per-company QBO keys
  in Supabase Vault per HomeWatch ADR-016, estimate-only tool allowlist, QBO writes owner/admin-only,
  existing Intuit app renamed). Supersedes the home-server/Tailscale Funnel hosting plan (handoff steps 3–8).
  Why: ProjectPix beta contractors need to connect their own QuickBooks; Johnny's Duet workflow needs a
  connector reachable from the cloud. Sandbox findings that shaped it: `Subtotal: $X.XX` DescriptionOnly
  lines become live subtotals; deposit is not exposed by the QBO API.
- 2026-10-05 — **At-rest encryption of secrets (Windows DPAPI).** `src/helpers/token-crypto.ts`: values stored as
  `dpapi:<base64>` are decrypted at startup; with `QUICKBOOKS_TOKEN_ENCRYPTION=dpapi`, rotated refresh tokens are
  written encrypted. `npm run encrypt-env` (`src/encrypt-env.ts`, `src/helpers/encrypt-env-file.ts`) converts an
  existing `.env` in place. Secrets go to PowerShell over stdin, never the command line. Why: Intuit's app security
  requirements; a plaintext `.env` on a workstation doesn't meet them. Verified with a real DPAPI round trip on Windows.
- 2026-10-05 — **QuickBooks Fault detail + `intuit_tid` + error log.** `formatError` now surfaces each Fault error's
  message/code/detail and the `intuit_tid` response header (previously only "Request failed with status code 400"),
  and appends every formatted error to `logs/qbo-errors.log` (override `QUICKBOOKS_ERROR_LOG_PATH`, or `off`).
  Why: diagnose real API errors and give Intuit support a trace id. Verified against the sandbox.
- 2026-10-05 — **Production sign-in via public HTTPS redirect.** `QUICKBOOKS_AUTH_REDIRECT_URI` (https tunnel to port
  8000) lets `npm run auth` complete a production OAuth sign-in with the server's own flow instead of a manual
  handshake. `npm run auth:prod` / `npm run encrypt-env:prod` (`scripts/with-prod-store.mjs`) target a separate
  `.env.production` token store so sandbox and production can't be mixed up.

### Fixed
- 2026-10-05 — **MCP connection no longer dies on a revoked/expired token.** The stdio server sets
  `QuickbooksClient.interactiveAuthAllowed = false`, so a dead token returns "run `npm run auth`" instead of starting
  the browser flow, whose stdout output corrupted the MCP stream ("Connection closed").

### Changed
- 2026-11-01 — **TokenStore review fixes.**
  - A client built with only `tokenStore` (no `refreshToken`) now loads the refresh token, and a stored access token, from the store before treating the company as signed out. Before, it went straight to the "reconnect" path and wrongly called `markReauthRequired`. The sandbox dead-token fallback now starts the browser sign-in directly, so it doesn't reload the dead token from the store.
  - Ruling R3: when the refresh token rotated, the save is retried up to 3 times inside the lock. With the new client option `strictPersistence: true` (for hosted use), a final failure throws the new `QboTokenPersistError` from `token-store.ts`; its message contains no token values. The default (`false`, stdio) still only logs.
  - The persist-failure log is now fixed text plus the error's name. It no longer includes the store's error message.
  - `StoredQboTokens` gains the documented, optional `realmId?` field (set only by the `npm run auth` sign-in).
  - Why: a hosted company with a valid stored token must never be flagged for reauth. In hosted use the store holds the only copy of a rotated refresh token, so a failed save can't be silently dropped there.
- 2026-11-01 — **QuickBooks tokens persist through a TokenStore with a refresh lock.** New
  `src/clients/token-store.ts` (`StoredQboTokens`, `TokenStore` with read/save/withRefreshLock/markReauthRequired,
  `QboReauthRequiredError`) and `src/clients/env-file-token-store.ts` (`EnvFileTokenStore(path)`: the `.env`
  read/write that used to live in `QuickbooksClient`, moved over with the same behaviour: DPAPI, atomic write,
  symlink write-through, file rewritten only when the refresh token rotates or on sign-in; in-process mutex per
  path; `markReauthRequired` is a no-op, per ruling R1). `QuickbooksClient` takes `tokenStore?` (default
  `EnvFileTokenStore` at the token-store path) and `accessToken?`/`accessTokenExpiresAt?` seeds. It now refreshes
  inside `withRefreshLock`: it re-reads the store, uses a still-fresh stored access token without refreshing,
  otherwise refreshes with the stored refresh token (retrying once with the in-memory token if that is rejected),
  and saves the refresh token, access token and expiry. A dead or missing token calls `markReauthRequired` and
  throws `QboReauthRequiredError` with the same message text as before ("run `npm run auth`" for stdio, "re-authorize"
  for production). Why: QuickBooks refresh tokens rotate, and the hosted connector (serverless, many companies) needs
  refreshes serialized across instances. Supabase Vault + a row lock will sit behind the same interface. Verified
  with the crm-estimating sandbox smoke test.
- `.gitignore`: `.env.production`, `.env.sandbox`, `logs/`.

## [0.0.1] - 2024-01-13

### Summary

Comprehensive expansion of the QuickBooks Online MCP server from a basic implementation to a full-featured API integration with **143 tools**, **29 entity types**, **11 financial reports**, and **100% test coverage**.

---

### Added

#### Entity Handlers (Full CRUD Operations)

Extended the server with complete Create, Read, Update, Delete, and Search operations for 29 entity types:

**Financial Transactions**
- `Payment` - Customer payment recording and management
- `SalesReceipt` - Point-of-sale transaction records
- `CreditMemo` - Customer credit adjustments
- `RefundReceipt` - Customer refund processing
- `Deposit` - Bank deposit recording with line item support
- `Transfer` - Inter-account fund transfers
- `PurchaseOrder` - Vendor purchase orders with shipping addresses
- `VendorCredit` - Vendor credit adjustments

**Time & Activity**
- `TimeActivity` - Employee/vendor time tracking with billable status

**Organization**
- `Class` - Transaction classification (cost centers)
- `Department` - Departmental organization
- `Term` - Payment terms (Net 30, Due on Receipt, etc.)
- `PaymentMethod` - Payment method types (Cash, Check, Credit Card)

**Tax Entities (Read-only)**
- `TaxCode` - Tax code lookup and search
- `TaxRate` - Tax rate lookup and search
- `TaxAgency` - Tax agency lookup and search

**Company & Attachments**
- `CompanyInfo` - Company profile management with address support
- `Attachable` - File attachment management

#### Financial Reports

Added 11 financial report endpoints:

| Report | Handler | Description |
|--------|---------|-------------|
| Balance Sheet | `get-quickbooks-balance-sheet.handler.ts` | Assets, liabilities, and equity snapshot |
| Profit & Loss | `get-quickbooks-profit-and-loss.handler.ts` | Income statement with accounting method options |
| Cash Flow | `get-quickbooks-cash-flow.handler.ts` | Statement of cash flows |
| Trial Balance | `get-quickbooks-trial-balance.handler.ts` | Debit/credit balance verification |
| General Ledger | `get-quickbooks-general-ledger.handler.ts` | Complete transaction history |
| Customer Sales | `get-quickbooks-customer-sales.handler.ts` | Sales analysis by customer |
| Customer Balance | `get-quickbooks-customer-balance.handler.ts` | Outstanding customer balances |
| Aged Receivables | `get-quickbooks-aged-receivables.handler.ts` | AR aging with customer filter |
| Aged Receivables Detail | `get-quickbooks-aged-receivables-detail.handler.ts` | Detailed AR aging breakdown |
| Aged Payables | `get-quickbooks-aged-payables.handler.ts` | AP aging analysis |
| Vendor Expenses | `get-quickbooks-vendor-expenses.handler.ts` | Expense analysis by vendor |

#### Testing Infrastructure

**Jest Configuration with ESM Support**
- Configured Jest with `--experimental-vm-modules` for native ESM testing
- Set up `ts-jest` with ESM preset for TypeScript compilation
- Created `tsconfig.test.json` for test-specific TypeScript settings

**Mock System**
- Created `tests/mocks/quickbooks.mock.ts` with comprehensive QuickBooks client mocking
- Implemented `mockQuickBooksInstance` with all API method stubs
- Added `resetAllMocks()` helper for test isolation

**Test Suites (335 tests total)**
- `class.handlers.test.ts` - Class entity CRUD tests
- `company-attachable.handlers.test.ts` - Company info and attachable tests
- `credit-memo.handlers.test.ts` - Credit memo CRUD tests
- `department-term-paymentmethod.handlers.test.ts` - Settings entity tests
- `deposit-transfer.handlers.test.ts` - Banking transaction tests
- `payment.handlers.test.ts` - Payment CRUD tests
- `refund-purchase-order-vendor-credit.handlers.test.ts` - Vendor transaction tests
- `reports.handlers.test.ts` - All 11 financial report tests
- `sales-receipt.handlers.test.ts` - Sales receipt CRUD tests
- `tax-entities.handlers.test.ts` - Tax entity read/search tests
- `time-activity.handlers.test.ts` - Time tracking tests
- `format-error.test.ts` - Error formatting helper tests

#### Documentation

- Comprehensive `README.md` with:
  - Badge indicators (143 tools, 29 entities, 11 reports)
  - Complete tool reference with collapsible sections
  - Quick start guide with installation instructions
  - Claude Code MCP configuration examples
  - Authentication setup guide (OAuth 2.0)
  - Project structure documentation

---

### Technical Implementation Details

#### Handler Architecture Pattern

Each handler follows a consistent pattern:

```typescript
// 1. Import dependencies
import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

// 2. Define typed input interface
export interface CreateEntityInput {
  required_field: string;
  optional_field?: string;
}

// 3. Implement async handler with error handling
export async function createQuickbooksEntity(data: CreateEntityInput): Promise<ToolResponse<any>> {
  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();

    // Build payload with conditional field mapping
    const payload: any = { RequiredField: data.required_field };
    if (data.optional_field) payload.OptionalField = data.optional_field;

    // Execute QuickBooks API call with callback wrapper
    return new Promise((resolve) => {
      quickbooks.createEntity(payload, (err: any, result: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
```

#### ESM Testing Pattern

Tests use dynamic imports after mock setup for ESM compatibility:

```typescript
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// Mock MUST be defined before dynamic imports
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
}));

// Dynamic import AFTER mock setup
const { createEntity } = await import('../../../src/handlers/create-entity.handler');

describe('Entity Handlers', () => {
  beforeEach(() => {
    resetAllMocks(); // Reset all mock state between tests
  });

  it('should create entity successfully', async () => {
    mockQuickBooksInstance.createEntity.mockImplementation((payload, cb) =>
      cb(null, { Id: '123' })
    );

    const result = await createEntity({ required_field: 'value' });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual({ Id: '123' });
  });
});
```

#### Branch Coverage Strategy

Achieved 100% branch coverage by testing:

1. **Success paths** - Normal API responses
2. **API error paths** - QuickBooks API returning errors via callback
3. **Authentication error paths** - Token refresh/auth failures
4. **Optional field variations** - Testing with and without optional fields
5. **Empty response handling** - QueryResponse with missing entity arrays

Example of branch coverage for optional fields:

```typescript
// Handler code with branches:
if (data.company_addr) {
  payload.CompanyAddr = {};
  if (data.company_addr.line1) payload.CompanyAddr.Line1 = data.company_addr.line1;  // Branch A
  if (data.company_addr.city) payload.CompanyAddr.City = data.company_addr.city;      // Branch B
}

// Tests to cover all branches:
it('should update with line1 only', async () => {
  await updateCompanyInfo({ id: '1', sync_token: '0', company_addr: { line1: '123 Main' } });
});

it('should update with city only', async () => {
  await updateCompanyInfo({ id: '1', sync_token: '0', company_addr: { city: 'LA' } });
});
```

---

### Configuration Changes

#### jest.config.js

```javascript
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  // ESM support
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
```

#### package.json (test script)

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest"
  }
}
```

---

### Coverage Statistics

| Metric | Coverage |
|--------|----------|
| Statements | 100% |
| Branches | 100% |
| Functions | 100% |
| Lines | 100% |

**Test Summary:**
- 12 test suites
- 335 tests
- 0 snapshots
- ~8 seconds execution time

---

### File Structure

```
mcp-quickbooks-online/
├── src/
│   ├── clients/
│   │   └── quickbooks-client.ts      # OAuth client wrapper
│   ├── handlers/                      # 87 handler files
│   │   ├── create-quickbooks-*.ts    # Create operations
│   │   ├── get-quickbooks-*.ts       # Read operations
│   │   ├── update-quickbooks-*.ts    # Update operations
│   │   ├── delete-quickbooks-*.ts    # Delete operations
│   │   └── search-quickbooks-*.ts    # Search operations
│   ├── tools/                         # MCP tool definitions
│   ├── helpers/
│   │   └── format-error.ts           # Error formatting utility
│   ├── types/
│   │   └── tool-response.ts          # Response type definitions
│   └── index.ts                       # MCP server entry point
├── tests/
│   ├── mocks/
│   │   └── quickbooks.mock.ts        # QuickBooks client mock
│   └── unit/
│       ├── handlers/                  # 11 handler test files
│       └── helpers/                   # Helper tests
├── jest.config.js                     # Jest ESM configuration
├── tsconfig.test.json                # Test TypeScript config
├── README.md                          # Comprehensive documentation
└── CHANGELOG.md                       # This file
```

---

### Why These Changes Were Made

1. **Complete API Coverage**: The original Intuit repo provided basic functionality. This expansion provides access to all QuickBooks Online API capabilities needed for real accounting workflows.

2. **Test Coverage**: 100% test coverage ensures reliability and catches regressions. The ESM testing pattern enables modern JavaScript module testing.

3. **Type Safety**: TypeScript interfaces for all inputs provide compile-time validation and better IDE support.

4. **Consistent Patterns**: All handlers follow the same architecture, making the codebase maintainable and predictable.

5. **Error Handling**: Standardized error formatting through `formatError()` provides consistent error messages across all operations.

---

### Migration Notes

If upgrading from the original Intuit implementation:

1. All original functionality is preserved
2. New handlers use the same client and authentication
3. Tool names follow the pattern `{action}_{entity}` (e.g., `create_payment`)
4. All tools return `ToolResponse<T>` with `isError`, `result`, and `error` fields

---

## [Unreleased]

### Planned

- Integration tests with QuickBooks sandbox
- Batch operation support
- Webhook handling for real-time updates
- Report export to CSV/PDF formats
