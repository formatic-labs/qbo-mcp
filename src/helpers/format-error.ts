import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Formats an error into a standardized error message
 * @param error Any error object to format
 * @returns A formatted error message as a string
 *
 * Fork addition (formatic-labs/qbo-mcp): QuickBooks API failures arrive from
 * node-quickbooks either as an axios error (HTTP 4xx/5xx — the useful Fault
 * body sits in error.response.data) or as a raw `{ Fault }` body (HTTP 200
 * with a Fault). Previously both collapsed to "Request failed with status code
 * 400", hiding Intuit's actual reason. We now surface each Fault error's
 * message/detail/code plus the `intuit_tid` response header (Intuit support's
 * trace id), and append every formatted error to a local log file so it can be
 * shared when troubleshooting.
 */
export function formatError(error: unknown): string {
  const message = describe(error);
  appendErrorLog(message);
  return message;
}

type FaultError = { Message?: string; Detail?: string; code?: string };
type Fault = { Error?: FaultError[]; type?: string };
type HttpResponse = { status?: number; data?: unknown; headers?: Record<string, unknown> };

function describe(error: unknown): string {
  const response = (error as { response?: HttpResponse } | null | undefined)?.response;
  const tid = response?.headers?.['intuit_tid'];
  const tidSuffix = tid ? ` [intuit_tid: ${String(tid)}]` : '';
  const fault = extractFault(response?.data) ?? (error instanceof Error ? undefined : extractFault(error));

  if (fault) {
    const status = response?.status ? ` ${response.status}` : '';
    const details = (fault.Error ?? [])
      .map((e) => {
        const code = e.code ? ` (code ${e.code})` : '';
        const detail = e.Detail && e.Detail !== e.Message ? ` — ${e.Detail}` : '';
        return `${e.Message ?? 'Unknown fault'}${code}${detail}`;
      })
      .join('; ');
    return `Error: QuickBooks API${status} ${fault.type ?? 'Fault'}: ${details || 'no details'}${tidSuffix}`;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}${tidSuffix}`;
  } else if (typeof error === 'string') {
    return `Error: ${error}`;
  } else {
    return `Unknown error: ${JSON.stringify(error)}`;
  }
}

function extractFault(value: unknown): Fault | undefined {
  if (value && typeof value === 'object') {
    // QBO responds with { Fault: {...} }; some paths lower-case it as "fault".
    const v = value as { Fault?: unknown; fault?: unknown };
    const fault = v.Fault ?? v.fault;
    if (fault && typeof fault === 'object') return fault as Fault;
  }
  return undefined;
}

// ── Error log ────────────────────────────────────────────────────────────────
// Default: <package root>/logs/qbo-errors.log (gitignored). Override with an
// absolute QUICKBOOKS_ERROR_LOG_PATH, or set it to "off" to disable. Disabled
// by default under Jest so unit tests don't write into the repo.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function errorLogPath(): string | undefined {
  const configured = process.env.QUICKBOOKS_ERROR_LOG_PATH?.trim();
  if (configured) return configured.toLowerCase() === 'off' ? undefined : configured;
  if (process.env.NODE_ENV === 'test') return undefined;
  return path.join(moduleDir, '..', '..', 'logs', 'qbo-errors.log');
}

function appendErrorLog(message: string): void {
  const file = errorLogPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Logging is best-effort: never let a log failure mask the real error.
  }
}
