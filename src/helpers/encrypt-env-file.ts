/**
 * Fork addition (formatic-labs/qbo-mcp): encrypt the secrets in a token store
 * (.env) in place with DPAPI and turn on QUICKBOOKS_TOKEN_ENCRYPTION so rotated
 * refresh tokens stay encrypted. Idempotent — already-encrypted values are left
 * alone. Used by `npm run encrypt-env`.
 */
import fs from 'fs';
import { encryptSecret, isEncrypted } from './token-crypto.js';

const SECRET_KEYS = ['QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_REFRESH_TOKEN'];

export function encryptEnvContent(content: string): { content: string; encrypted: string[] } {
  const encrypted: string[] = [];
  const lines = content.split('\n').map((line) => {
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!SECRET_KEYS.includes(key) || !value || isEncrypted(value)) return line;
    encrypted.push(key);
    return `${key}=${encryptSecret(value)}`;
  });

  // Make sure future token rotations are written encrypted too.
  const flagIndex = lines.findIndex((l) => l.startsWith('QUICKBOOKS_TOKEN_ENCRYPTION='));
  if (flagIndex === -1) lines.push('QUICKBOOKS_TOKEN_ENCRYPTION=dpapi');
  else lines[flagIndex] = 'QUICKBOOKS_TOKEN_ENCRYPTION=dpapi';

  return { content: lines.join('\n'), encrypted };
}

export function encryptEnvFile(filePath: string): string[] {
  const { content, encrypted } = encryptEnvContent(fs.readFileSync(filePath, 'utf-8'));
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return encrypted;
}
