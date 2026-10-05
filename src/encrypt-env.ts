#!/usr/bin/env node
/**
 * Fork addition: `npm run encrypt-env` — encrypt QUICKBOOKS_CLIENT_SECRET and
 * QUICKBOOKS_REFRESH_TOKEN in the token store with Windows DPAPI.
 *
 * Target file: QUICKBOOKS_TOKEN_STORE_PATH if set (absolute), else <package root>/.env —
 * the same resolution the server uses.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { encryptEnvFile } from './helpers/encrypt-env-file.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim() || path.join(here, '..', '.env');

try {
  const done = encryptEnvFile(target);
  console.log(`Token store: ${target}`);
  console.log(done.length ? `Encrypted: ${done.join(', ')}` : 'Nothing to encrypt (already encrypted or empty).');
  console.log('QUICKBOOKS_TOKEN_ENCRYPTION=dpapi is set; rotated tokens will be stored encrypted.');
} catch (err) {
  console.error('Encryption failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
