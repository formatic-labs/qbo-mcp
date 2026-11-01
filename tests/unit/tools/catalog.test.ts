import { jest, describe, test, expect } from '@jest/globals';
import { mockQuickbooksClient, mockQuickbooksClientClass } from '../../mocks/quickbooks.mock';

// Tool modules import handlers that import the QuickBooks client; mock it so
// importing the whole catalog doesn't spin up real auth/config.
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { ALL_TOOLS, HOSTED_TOOL_ALLOWLIST } = await import('../../../src/tools/catalog');

// Number of RegisterTool calls src/index.ts made before the catalog refactor.
const EXPECTED_TOOL_COUNT = 142;

describe("tool catalog", () => {
  test("ALL_TOOLS has unique names and matches what index.ts registered before", () => {
    const names = ALL_TOOLS.map((t: { name: string }) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(EXPECTED_TOOL_COUNT);
  });

  test("allowlist is a subset of the catalog", () => {
    const names = new Set(ALL_TOOLS.map((t: { name: string }) => t.name));
    for (const n of HOSTED_TOOL_ALLOWLIST) expect(names.has(n)).toBe(true);
  });

  test("allowlist contains no delete or non-estimate accounting writes", () => {
    for (const n of HOSTED_TOOL_ALLOWLIST) {
      expect(n).not.toMatch(/^delete[_-]/);
      expect(n).not.toMatch(
        /bill|payment|journal|vendor|employee|transfer|deposit|purchase|refund|credit_memo|sales_receipt|time_activity|account/
      );
    }
  });

  test("allowlist is exactly the estimate set", () => {
    expect([...HOSTED_TOOL_ALLOWLIST].sort()).toEqual([
      "create_customer", "create_estimate", "get_class", "get_company_info", "get_customer", "get_estimate",
      "get_preferences", "get_tax_code", "get_tax_rate", "get_term", "read_invoice", "read_item",
      "search_classes", "search_customers", "search_estimates", "search_invoices", "search_items",
      "search_tax_codes", "search_tax_rates", "search_terms", "update_customer", "update_estimate",
    ]);
  });
});
