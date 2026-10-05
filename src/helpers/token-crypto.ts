/**
 * At-rest protection for the secrets kept in the token store (.env):
 * QUICKBOOKS_CLIENT_SECRET and the rotating QUICKBOOKS_REFRESH_TOKEN.
 *
 * Fork addition (formatic-labs/qbo-mcp). Intuit's app security requirements
 * expect OAuth credentials to be stored securely; a plaintext .env does not
 * meet that bar on a workstation.
 *
 * Scheme: Windows DPAPI, CurrentUser scope. An encrypted value is stored as
 * `dpapi:<base64>` and can only be decrypted by the same Windows user on the
 * same machine — a copied .env is useless elsewhere. Values without the
 * prefix are treated as plaintext, so existing .env files keep working.
 *
 * Opt in by setting QUICKBOOKS_TOKEN_ENCRYPTION=dpapi (in the host env or the
 * .env itself). When enabled, rotated refresh tokens are written encrypted;
 * `npm run encrypt-env` converts an existing .env in place.
 *
 * DPAPI is invoked through PowerShell (no native Node module needed). The
 * secret travels over stdin, never the command line, so it can't be read from
 * the process list. On non-Windows hosts encryption fails loudly rather than
 * silently storing plaintext; a cross-platform scheme belongs to the hosted
 * token store (crm-estimating Phase 4).
 */
import { execFileSync } from 'child_process';

export const DPAPI_PREFIX = 'dpapi:';

// Optional entropy binds blobs to this app: another DPAPI consumer running as
// the same user can't decrypt them without knowing this value.
const ENTROPY = 'formatic-labs/qbo-mcp';

const psScript = (op: 'Protect' | 'Unprotect', inputIsBase64: boolean) =>
  [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd()',
    inputIsBase64
      ? '$bytes = [Convert]::FromBase64String($in.Trim())'
      : '$bytes = [Text.Encoding]::UTF8.GetBytes($in)',
    `$entropy = [Text.Encoding]::UTF8.GetBytes("${ENTROPY}")`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    op === 'Protect'
      ? '[Console]::Out.Write([Convert]::ToBase64String($out))'
      : '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))',
  ].join('; ');

function runDpapi(op: 'Protect' | 'Unprotect', input: string): string {
  if (process.platform !== 'win32') {
    throw new Error(
      `DPAPI token encryption is only available on Windows (platform: ${process.platform}). ` +
        'Unset QUICKBOOKS_TOKEN_ENCRYPTION or use a host-level secret store.'
    );
  }
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript(op, op === 'Unprotect')],
    // stderr is piped (not inherited) so PowerShell noise never reaches the MCP
    // host's stderr; execFileSync puts it on the thrown error instead.
    { input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

export function isEncrypted(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith(DPAPI_PREFIX);
}

/** Decrypt a `dpapi:` value; plaintext and undefined pass through unchanged. */
export function decryptSecret(value: string | undefined): string | undefined {
  if (!isEncrypted(value)) return value;
  try {
    return runDpapi('Unprotect', value!.slice(DPAPI_PREFIX.length));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Could not decrypt a DPAPI-protected QuickBooks secret. It can only be decrypted by the ' +
        `Windows user and machine that encrypted it. (${reason})`
    );
  }
}

/** Encrypt a value with DPAPI. Already-encrypted values are returned as-is. */
export function encryptSecret(value: string): string {
  if (isEncrypted(value)) return value;
  return DPAPI_PREFIX + runDpapi('Protect', value).trim();
}

/** True when the operator has opted in to encrypting secrets at rest. */
export function encryptionEnabled(): boolean {
  return (process.env.QUICKBOOKS_TOKEN_ENCRYPTION ?? '').trim().toLowerCase() === 'dpapi';
}
