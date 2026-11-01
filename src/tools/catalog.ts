import type { ToolDefinition } from "../types/tool-definition.js";
import { CreateInvoiceTool } from "./create-invoice.tool.js";
import { ReadInvoiceTool } from "./read-invoice.tool.js";
import { SearchInvoicesTool } from "./search-invoices.tool.js";
import { UpdateInvoiceTool } from "./update-invoice.tool.js";
import { GetInvoicePdfTool } from "./get-invoice-pdf.tool.js";
import { CreateAccountTool } from "./create-account.tool.js";
import { UpdateAccountTool } from "./update-account.tool.js";
import { SearchAccountsTool } from "./search-accounts.tool.js";
import { ReadItemTool } from "./read-item.tool.js";
import { SearchItemsTool } from "./search-items.tool.js";
import { CreateItemTool } from "./create-item.tool.js";
import { UpdateItemTool } from "./update-item.tool.js";
import { DeleteItemTool } from "./delete-item.tool.js";
import { GetAccountTool } from "./get-account.tool.js";
import { DeleteInvoiceTool } from "./delete-invoice.tool.js";
import { CreateCustomerTool } from "./create-customer.tool.js";
import { GetCustomerTool } from "./get-customer.tool.js";
import { UpdateCustomerTool } from "./update-customer.tool.js";
import { DeleteCustomerTool } from "./delete-customer.tool.js";
import { CreateEstimateTool } from "./create-estimate.tool.js";
import { GetEstimateTool } from "./get-estimate.tool.js";
import { UpdateEstimateTool } from "./update-estimate.tool.js";
import { DeleteEstimateTool } from "./delete-estimate.tool.js";
import { SearchCustomersTool } from "./search-customers.tool.js";
import { SearchEstimatesTool } from "./search-estimates.tool.js";
import { CreateBillTool } from "./create-bill.tool.js";
import { UpdateBillTool } from "./update-bill.tool.js";
import { DeleteBillTool } from "./delete-bill.tool.js";
import { GetBillTool } from "./get-bill.tool.js";
import { CreateVendorTool } from "./create-vendor.tool.js";
import { UpdateVendorTool } from "./update-vendor.tool.js";
import { DeleteVendorTool } from "./delete-vendor.tool.js";
import { GetVendorTool } from "./get-vendor.tool.js";
import { SearchBillsTool } from "./search-bills.tool.js";
import { SearchVendorsTool } from "./search-vendors.tool.js";
import { CreateEmployeeTool } from "./create-employee.tool.js";
import { GetEmployeeTool } from "./get-employee.tool.js";
import { UpdateEmployeeTool } from "./update-employee.tool.js";
import { SearchEmployeesTool } from "./search-employees.tool.js";
import { DeleteEmployeeTool } from "./delete-employee.tool.js";
import { CreateJournalEntryTool } from "./create-journal-entry.tool.js";
import { GetJournalEntryTool } from "./get-journal-entry.tool.js";
import { UpdateJournalEntryTool } from "./update-journal-entry.tool.js";
import { DeleteJournalEntryTool } from "./delete-journal-entry.tool.js";
import { SearchJournalEntriesTool } from "./search-journal-entries.tool.js";
import { CreateBillPaymentTool } from "./create-bill-payment.tool.js";
import { GetBillPaymentTool } from "./get-bill-payment.tool.js";
import { UpdateBillPaymentTool } from "./update-bill-payment.tool.js";
import { DeleteBillPaymentTool } from "./delete-bill-payment.tool.js";
import { SearchBillPaymentsTool } from "./search-bill-payments.tool.js";
import { CreatePurchaseTool } from "./create-purchase.tool.js";
import { GetPurchaseTool } from "./get-purchase.tool.js";
import { UpdatePurchaseTool } from "./update-purchase.tool.js";
import { DeletePurchaseTool } from "./delete-purchase.tool.js";
import { SearchPurchasesTool } from "./search-purchases.tool.js";
import { CreatePaymentTool } from "./create-payment.tool.js";
import { GetPaymentTool } from "./get-payment.tool.js";
import { UpdatePaymentTool } from "./update-payment.tool.js";
import { DeletePaymentTool } from "./delete-payment.tool.js";
import { SearchPaymentsTool } from "./search-payments.tool.js";
import { CreateSalesReceiptTool } from "./create-sales-receipt.tool.js";
import { GetSalesReceiptTool } from "./get-sales-receipt.tool.js";
import { UpdateSalesReceiptTool } from "./update-sales-receipt.tool.js";
import { DeleteSalesReceiptTool } from "./delete-sales-receipt.tool.js";
import { SearchSalesReceiptsTool } from "./search-sales-receipts.tool.js";
import { CreateCreditMemoTool } from "./create-credit-memo.tool.js";
import { GetCreditMemoTool } from "./get-credit-memo.tool.js";
import { UpdateCreditMemoTool } from "./update-credit-memo.tool.js";
import { DeleteCreditMemoTool } from "./delete-credit-memo.tool.js";
import { SearchCreditMemosTool } from "./search-credit-memos.tool.js";
import { CreateRefundReceiptTool } from "./create-refund-receipt.tool.js";
import { GetRefundReceiptTool } from "./get-refund-receipt.tool.js";
import { UpdateRefundReceiptTool } from "./update-refund-receipt.tool.js";
import { DeleteRefundReceiptTool } from "./delete-refund-receipt.tool.js";
import { SearchRefundReceiptsTool } from "./search-refund-receipts.tool.js";
import { CreatePurchaseOrderTool } from "./create-purchase-order.tool.js";
import { GetPurchaseOrderTool } from "./get-purchase-order.tool.js";
import { UpdatePurchaseOrderTool } from "./update-purchase-order.tool.js";
import { DeletePurchaseOrderTool } from "./delete-purchase-order.tool.js";
import { SearchPurchaseOrdersTool } from "./search-purchase-orders.tool.js";
import { CreateVendorCreditTool } from "./create-vendor-credit.tool.js";
import { GetVendorCreditTool } from "./get-vendor-credit.tool.js";
import { UpdateVendorCreditTool } from "./update-vendor-credit.tool.js";
import { DeleteVendorCreditTool } from "./delete-vendor-credit.tool.js";
import { SearchVendorCreditsTool } from "./search-vendor-credits.tool.js";
import { CreateDepositTool } from "./create-deposit.tool.js";
import { GetDepositTool } from "./get-deposit.tool.js";
import { UpdateDepositTool } from "./update-deposit.tool.js";
import { DeleteDepositTool } from "./delete-deposit.tool.js";
import { SearchDepositsTool } from "./search-deposits.tool.js";
import { CreateTransferTool } from "./create-transfer.tool.js";
import { GetTransferTool } from "./get-transfer.tool.js";
import { UpdateTransferTool } from "./update-transfer.tool.js";
import { DeleteTransferTool } from "./delete-transfer.tool.js";
import { SearchTransfersTool } from "./search-transfers.tool.js";
import { CreateTimeActivityTool } from "./create-time-activity.tool.js";
import { GetTimeActivityTool } from "./get-time-activity.tool.js";
import { UpdateTimeActivityTool } from "./update-time-activity.tool.js";
import { DeleteTimeActivityTool } from "./delete-time-activity.tool.js";
import { SearchTimeActivitiesTool } from "./search-time-activities.tool.js";
import { CreateClassTool } from "./create-class.tool.js";
import { GetClassTool } from "./get-class.tool.js";
import { UpdateClassTool } from "./update-class.tool.js";
import { SearchClassesTool } from "./search-classes.tool.js";
import { CreateDepartmentTool } from "./create-department.tool.js";
import { GetDepartmentTool } from "./get-department.tool.js";
import { UpdateDepartmentTool } from "./update-department.tool.js";
import { SearchDepartmentsTool } from "./search-departments.tool.js";
import { CreateTermTool } from "./create-term.tool.js";
import { GetTermTool } from "./get-term.tool.js";
import { UpdateTermTool } from "./update-term.tool.js";
import { SearchTermsTool } from "./search-terms.tool.js";
import { CreatePaymentMethodTool } from "./create-payment-method.tool.js";
import { GetPaymentMethodTool } from "./get-payment-method.tool.js";
import { UpdatePaymentMethodTool } from "./update-payment-method.tool.js";
import { SearchPaymentMethodsTool } from "./search-payment-methods.tool.js";
import { SearchBudgetsTool } from "./search-budgets.tool.js";
import { GetTaxCodeTool } from "./get-tax-code.tool.js";
import { SearchTaxCodesTool } from "./search-tax-codes.tool.js";
import { GetTaxRateTool } from "./get-tax-rate.tool.js";
import { SearchTaxRatesTool } from "./search-tax-rates.tool.js";
import { GetTaxAgencyTool } from "./get-tax-agency.tool.js";
import { SearchTaxAgenciesTool } from "./search-tax-agencies.tool.js";
import { GetCompanyInfoTool } from "./get-company-info.tool.js";
import { UpdateCompanyInfoTool } from "./update-company-info.tool.js";
import { GetPreferencesTool } from "./get-preferences.tool.js";
import { CreateAttachableTool } from "./create-attachable.tool.js";
import { GetAttachableTool } from "./get-attachable.tool.js";
import { UpdateAttachableTool } from "./update-attachable.tool.js";
import { DeleteAttachableTool } from "./delete-attachable.tool.js";
import { SearchAttachablesTool } from "./search-attachables.tool.js";
import { GetBalanceSheetTool } from "./get-balance-sheet.tool.js";
import { GetProfitAndLossTool } from "./get-profit-and-loss.tool.js";
import { GetCashFlowTool } from "./get-cash-flow.tool.js";
import { GetTrialBalanceTool } from "./get-trial-balance.tool.js";
import { GetGeneralLedgerTool } from "./get-general-ledger.tool.js";
import { GetCustomerSalesTool } from "./get-customer-sales.tool.js";
import { GetAgedReceivablesTool } from "./get-aged-receivables.tool.js";
import { GetCustomerBalanceTool } from "./get-customer-balance.tool.js";
import { GetAgedPayablesTool } from "./get-aged-payables.tool.js";
import { GetVendorExpensesTool } from "./get-vendor-expenses.tool.js";
import { GetVendorBalanceTool } from "./get-vendor-balance.tool.js";

/**
 * Every tool the QuickBooks MCP server exposes, in registration order.
 * (Moved verbatim from the RegisterTool calls that used to live in src/index.ts.)
 */
export const ALL_TOOLS: readonly ToolDefinition<any>[] = [
  CreateCustomerTool,
  GetCustomerTool,
  UpdateCustomerTool,
  DeleteCustomerTool,
  SearchCustomersTool,
  CreateEstimateTool,
  GetEstimateTool,
  UpdateEstimateTool,
  DeleteEstimateTool,
  SearchEstimatesTool,
  CreateBillTool,
  UpdateBillTool,
  DeleteBillTool,
  GetBillTool,
  SearchBillsTool,
  ReadInvoiceTool,
  SearchInvoicesTool,
  CreateInvoiceTool,
  UpdateInvoiceTool,
  DeleteInvoiceTool,
  GetInvoicePdfTool,
  CreateAccountTool,
  GetAccountTool,
  UpdateAccountTool,
  SearchAccountsTool,
  ReadItemTool,
  SearchItemsTool,
  CreateItemTool,
  UpdateItemTool,
  DeleteItemTool,
  CreateVendorTool,
  UpdateVendorTool,
  DeleteVendorTool,
  GetVendorTool,
  SearchVendorsTool,
  CreateEmployeeTool,
  GetEmployeeTool,
  UpdateEmployeeTool,
  DeleteEmployeeTool,
  SearchEmployeesTool,
  CreateJournalEntryTool,
  GetJournalEntryTool,
  UpdateJournalEntryTool,
  DeleteJournalEntryTool,
  SearchJournalEntriesTool,
  CreateBillPaymentTool,
  GetBillPaymentTool,
  UpdateBillPaymentTool,
  DeleteBillPaymentTool,
  SearchBillPaymentsTool,
  CreatePurchaseTool,
  GetPurchaseTool,
  UpdatePurchaseTool,
  DeletePurchaseTool,
  SearchPurchasesTool,
  CreatePaymentTool,
  GetPaymentTool,
  UpdatePaymentTool,
  DeletePaymentTool,
  SearchPaymentsTool,
  CreateSalesReceiptTool,
  GetSalesReceiptTool,
  UpdateSalesReceiptTool,
  DeleteSalesReceiptTool,
  SearchSalesReceiptsTool,
  CreateCreditMemoTool,
  GetCreditMemoTool,
  UpdateCreditMemoTool,
  DeleteCreditMemoTool,
  SearchCreditMemosTool,
  CreateRefundReceiptTool,
  GetRefundReceiptTool,
  UpdateRefundReceiptTool,
  DeleteRefundReceiptTool,
  SearchRefundReceiptsTool,
  CreatePurchaseOrderTool,
  GetPurchaseOrderTool,
  UpdatePurchaseOrderTool,
  DeletePurchaseOrderTool,
  SearchPurchaseOrdersTool,
  CreateVendorCreditTool,
  GetVendorCreditTool,
  UpdateVendorCreditTool,
  DeleteVendorCreditTool,
  SearchVendorCreditsTool,
  CreateDepositTool,
  GetDepositTool,
  UpdateDepositTool,
  DeleteDepositTool,
  SearchDepositsTool,
  CreateTransferTool,
  GetTransferTool,
  UpdateTransferTool,
  DeleteTransferTool,
  SearchTransfersTool,
  CreateTimeActivityTool,
  GetTimeActivityTool,
  UpdateTimeActivityTool,
  DeleteTimeActivityTool,
  SearchTimeActivitiesTool,
  CreateClassTool,
  GetClassTool,
  UpdateClassTool,
  SearchClassesTool,
  CreateDepartmentTool,
  GetDepartmentTool,
  UpdateDepartmentTool,
  SearchDepartmentsTool,
  CreateTermTool,
  GetTermTool,
  UpdateTermTool,
  SearchTermsTool,
  CreatePaymentMethodTool,
  GetPaymentMethodTool,
  UpdatePaymentMethodTool,
  SearchPaymentMethodsTool,
  SearchBudgetsTool,
  GetTaxCodeTool,
  SearchTaxCodesTool,
  GetTaxRateTool,
  SearchTaxRatesTool,
  GetTaxAgencyTool,
  SearchTaxAgenciesTool,
  GetCompanyInfoTool,
  UpdateCompanyInfoTool,
  GetPreferencesTool,
  CreateAttachableTool,
  GetAttachableTool,
  UpdateAttachableTool,
  DeleteAttachableTool,
  SearchAttachablesTool,
  GetBalanceSheetTool,
  GetProfitAndLossTool,
  GetCashFlowTool,
  GetTrialBalanceTool,
  GetGeneralLedgerTool,
  GetCustomerSalesTool,
  GetAgedReceivablesTool,
  GetCustomerBalanceTool,
  GetAgedPayablesTool,
  GetVendorExpensesTool,
  GetVendorBalanceTool,
];

/**
 * The tools the hosted (multi-company) connector is allowed to expose:
 * the estimate workflow only - customer + estimate CRUD (no deletes), plus the
 * read-only lookups an estimate needs (items, classes, terms, tax codes/rates,
 * company info, preferences, invoices for reference). Everything else
 * (bills, payments, journal entries, vendors, employees, ...) stays out of
 * the hosted surface. Must remain a subset of ALL_TOOLS (enforced by tests).
 */
export const HOSTED_TOOL_ALLOWLIST: readonly string[] = [
  "create_customer",
  "create_estimate",
  "get_class",
  "get_company_info",
  "get_customer",
  "get_estimate",
  "get_preferences",
  "get_tax_code",
  "get_tax_rate",
  "get_term",
  "read_invoice",
  "read_item",
  "search_classes",
  "search_customers",
  "search_estimates",
  "search_invoices",
  "search_items",
  "search_tax_codes",
  "search_tax_rates",
  "search_terms",
  "update_customer",
  "update_estimate",
];
