#!/usr/bin/env node
/**
 * Fork addition: run a dist/ entry point against the PRODUCTION token store
 * (<package root>/.env.production) instead of the default sandbox .env.
 *
 *   npm run encrypt-env:prod   -> encrypt the production secrets in place
 *   npm run auth:prod          -> first-time production sign-in (needs
 *                                 QUICKBOOKS_AUTH_REDIRECT_URI = public https tunnel URL)
 *
 * QUICKBOOKS_TOKEN_STORE_PATH must be set in the process env before the client
 * module loads (it decides which file dotenv reads), so we spawn a child.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/with-prod-store.mjs <dist/entry.js> [...args]');
  process.exit(2);
}
const store = path.join(root, '.env.production');
console.error(`[with-prod-store] token store: ${store}`);
const result = spawnSync(process.execPath, [path.join(root, entry), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: { ...process.env, QUICKBOOKS_TOKEN_STORE_PATH: store },
});
process.exit(result.status ?? 1);
