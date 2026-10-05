import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatError, errorLogPath } from '../../../src/helpers/format-error';

describe('formatError', () => {
  it('should format Error instances', () => {
    const error = new Error('Something went wrong');
    expect(formatError(error)).toBe('Error: Something went wrong');
  });

  it('should format string errors', () => {
    expect(formatError('A string error')).toBe('Error: A string error');
  });

  it('should format unknown error types', () => {
    const unknownError = { code: 500, message: 'Server error' };
    expect(formatError(unknownError)).toBe(
      'Unknown error: {"code":500,"message":"Server error"}'
    );
  });

  it('should handle null errors', () => {
    expect(formatError(null)).toBe('Unknown error: null');
  });

  it('should handle undefined errors', () => {
    expect(formatError(undefined)).toBe('Unknown error: undefined');
  });

  it('should handle number errors', () => {
    expect(formatError(404)).toBe('Unknown error: 404');
  });
});

// ── Fork: QuickBooks Fault + intuit_tid surfacing and the error log ─────────

const axiosError = (status: number, data: unknown, headers: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers },
  });

describe('formatError — QuickBooks faults (fork)', () => {
  it('surfaces Fault message, code, detail and intuit_tid from an axios error', () => {
    const err = axiosError(
      400,
      {
        Fault: {
          type: 'ValidationFault',
          Error: [{ Message: 'Invalid Reference Id', Detail: 'Names element id 103 not found', code: '2500' }],
        },
      },
      { intuit_tid: 'tid-123' }
    );
    expect(formatError(err)).toBe(
      'Error: QuickBooks API 400 ValidationFault: Invalid Reference Id (code 2500) — Names element id 103 not found [intuit_tid: tid-123]'
    );
  });

  it('joins multiple fault errors and omits a Detail identical to the Message', () => {
    const err = axiosError(400, { fault: { Error: [{ Message: 'A', Detail: 'A' }, { Detail: 'only detail' }] } });
    expect(formatError(err)).toBe('Error: QuickBooks API 400 Fault: A; Unknown fault — only detail');
  });

  it('handles a raw { Fault } body (HTTP 200 fault) with no errors listed', () => {
    expect(formatError({ Fault: { type: 'SystemFault' } })).toBe('Error: QuickBooks API SystemFault: no details');
  });

  it('keeps the plain message (plus intuit_tid) when the response has no Fault', () => {
    expect(formatError(axiosError(503, 'Service Unavailable', { intuit_tid: 'tid-9' }))).toBe(
      'Error: Request failed with status code 503 [intuit_tid: tid-9]'
    );
  });

  it('ignores a non-object Fault value', () => {
    expect(formatError({ Fault: 'nope' })).toBe('Unknown error: {"Fault":"nope"}');
  });
});

describe('error log (fork)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is disabled under Jest by default, and by "off"', () => {
    delete process.env.QUICKBOOKS_ERROR_LOG_PATH;
    expect(errorLogPath()).toBeUndefined();
    process.env.QUICKBOOKS_ERROR_LOG_PATH = 'OFF';
    expect(errorLogPath()).toBeUndefined();
  });

  it('defaults to <package root>/logs/qbo-errors.log outside tests', () => {
    delete process.env.QUICKBOOKS_ERROR_LOG_PATH;
    process.env.NODE_ENV = 'production';
    expect(errorLogPath()).toMatch(/logs[\\/]qbo-errors\.log$/);
  });

  it('appends a timestamped line to the configured log file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-log-')), 'nested', 'errors.log');
    process.env.QUICKBOOKS_ERROR_LOG_PATH = file;
    formatError('first');
    formatError(new Error('second'));
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* Error: first$/);
    expect(lines[1]).toMatch(/Error: second$/);
  });

  it('never throws when the log cannot be written', () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-log-')), 'a-file');
    fs.writeFileSync(blocker, '');
    process.env.QUICKBOOKS_ERROR_LOG_PATH = path.join(blocker, 'sub', 'errors.log'); // parent is a file
    expect(formatError('still returned')).toBe('Error: still returned');
  });
});
