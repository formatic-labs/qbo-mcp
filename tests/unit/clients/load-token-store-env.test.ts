/**
 * loadTokenStoreEnv(): the stdio entries call it at startup so every
 * QUICKBOOKS_* setting in the token-store .env (e.g. QUICKBOOKS_ATTACHABLE_BASE_DIR,
 * QUICKBOOKS_ERROR_LOG_PATH) is in process.env before any tool runs — not only
 * once the env client is first built. Uses real dotenv against a temp file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('QUICKBOOKS_')) delete process.env[key];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-load-env-'));
const envFile = path.join(dir, 'tokens.env');
fs.writeFileSync(envFile, 'QUICKBOOKS_ATTACHABLE_BASE_DIR=/allowed/only\nQUICKBOOKS_ERROR_LOG_PATH=off\n');

const { loadTokenStoreEnv } = await import('../../../src/clients/quickbooks-client');

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('QUICKBOOKS_')) delete process.env[key];
  }
});

describe('loadTokenStoreEnv', () => {
  it('importing the module does not load the token-store .env', () => {
    expect(process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR).toBeUndefined();
  });

  it('loads the token-store .env into process.env before any client is built', () => {
    process.env.QUICKBOOKS_TOKEN_STORE_PATH = envFile;
    process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = ''; // host placeholder — the file wins
    expect(loadTokenStoreEnv()).toBe(envFile);
    expect(process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR).toBe('/allowed/only');
    expect(process.env.QUICKBOOKS_ERROR_LOG_PATH).toBe('off');
    // Idempotent.
    expect(loadTokenStoreEnv()).toBe(envFile);
    expect(process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR).toBe('/allowed/only');
  });

  it('rejects a relative QUICKBOOKS_TOKEN_STORE_PATH', () => {
    process.env.QUICKBOOKS_TOKEN_STORE_PATH = 'relative/tokens.env';
    expect(() => loadTokenStoreEnv()).toThrow(/must be an absolute path/);
  });
});
