/**
 * Unit tests for the TokenStore abstraction (src/clients/token-store.ts) and
 * its stdio implementation, EnvFileTokenStore (src/clients/env-file-token-store.ts).
 *
 * EnvFileTokenStore keeps today's .env behaviour: the rotated refresh token
 * (and the realm id after an interactive sign-in) are written to the .env
 * token store, DPAPI-encrypted when QUICKBOOKS_TOKEN_ENCRYPTION=dpapi. Access
 * tokens are never written to .env. Every test works on a temp directory —
 * never the repo's real .env.
 *
 * token-crypto is mocked with a deterministic, reversible stand-in so the
 * DPAPI path is exercised without PowerShell.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const decryptCalls: string[] = [];
jest.unstable_mockModule('../../../src/helpers/token-crypto', () => ({
  decryptSecret: (v: string | undefined) => {
    if (v === undefined || !v.startsWith('dpapi:<')) return v;
    decryptCalls.push(v);
    if (v === 'dpapi:<undecryptable>') throw new Error('Could not decrypt');
    return v.slice('dpapi:<'.length, -1);
  },
  encryptSecret: (v: string) => `dpapi:<${v}>`,
  encryptionEnabled: () => process.env.QUICKBOOKS_TOKEN_ENCRYPTION === 'dpapi',
}));

const { EnvFileTokenStore } = await import('../../../src/clients/env-file-token-store');
const { QboReauthRequiredError, QboTokenPersistError } = await import('../../../src/clients/token-store');

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-token-store-'));
  envPath = path.join(dir, '.env');
  decryptCalls.length = 0;
  delete process.env.QUICKBOOKS_TOKEN_ENCRYPTION;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.QUICKBOOKS_TOKEN_ENCRYPTION;
});

describe('QboReauthRequiredError', () => {
  it('is an Error with its own name so callers can tell it apart', () => {
    const err = new QboReauthRequiredError('reconnect QuickBooks');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(QboReauthRequiredError);
    expect(err.name).toBe('QboReauthRequiredError');
    expect(err.message).toBe('reconnect QuickBooks');
  });
});

describe('QboTokenPersistError', () => {
  it('is an Error with its own name', () => {
    const err = new QboTokenPersistError('could not save');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QboTokenPersistError');
    expect(err.message).toBe('could not save');
  });
});

describe('EnvFileTokenStore', () => {
  it('round-trips the refresh token through .env with DPAPI when enabled', async () => {
    fs.writeFileSync(envPath, 'QUICKBOOKS_CLIENT_ID=abc\nQUICKBOOKS_REFRESH_TOKEN=old\nQUICKBOOKS_REALM_ID=1\n');
    process.env.QUICKBOOKS_TOKEN_ENCRYPTION = 'dpapi';
    const store = new EnvFileTokenStore(envPath);

    await store.save({
      refreshToken: 'rotated-rt',
      accessToken: 'at-never-on-disk',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    });

    const written = fs.readFileSync(envPath, 'utf-8');
    expect(written).toContain('QUICKBOOKS_REFRESH_TOKEN=dpapi:<rotated-rt>');
    expect(written).toContain('QUICKBOOKS_CLIENT_ID=abc'); // other lines kept
    expect(written).toContain('QUICKBOOKS_REALM_ID=1');
    expect(written).not.toContain('at-never-on-disk'); // access tokens never written to .env
    expect(written).not.toMatch(/QUICKBOOKS_REFRESH_TOKEN=rotated-rt/); // never plaintext

    await expect(store.read()).resolves.toEqual({ refreshToken: 'rotated-rt' });
    expect(decryptCalls).toContain('dpapi:<rotated-rt>');
  });

  it('writes the refresh token in plaintext when encryption is not enabled', async () => {
    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN=old\n');
    const store = new EnvFileTokenStore(envPath);

    await store.save({ refreshToken: 'plain-rt' });

    expect(fs.readFileSync(envPath, 'utf-8')).toContain('QUICKBOOKS_REFRESH_TOKEN=plain-rt');
    await expect(store.read()).resolves.toEqual({ refreshToken: 'plain-rt' });
  });

  it('reads with dotenv semantics (quotes and inline comments stripped)', async () => {
    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN="quoted-rt" # rotated\n');
    await expect(new EnvFileTokenStore(envPath).read()).resolves.toEqual({ refreshToken: 'quoted-rt' });
  });

  it('returns undefined when the file is missing, has no token, has an empty token, or cannot be decrypted', async () => {
    const store = new EnvFileTokenStore(envPath);
    await expect(store.read()).resolves.toBeUndefined(); // missing file

    fs.writeFileSync(envPath, 'QUICKBOOKS_CLIENT_ID=abc\n');
    await expect(store.read()).resolves.toBeUndefined(); // no key

    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN=   \n');
    await expect(store.read()).resolves.toBeUndefined(); // blank value

    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN=dpapi:<undecryptable>\n');
    await expect(store.read()).resolves.toBeUndefined(); // decrypt failure is swallowed
  });

  it('creates the file when it does not exist yet', async () => {
    await new EnvFileTokenStore(envPath).save({ refreshToken: 'first-rt' });
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('QUICKBOOKS_REFRESH_TOKEN=first-rt');
  });

  it('skips the write when the stored refresh token is unchanged (only rotations touch .env)', async () => {
    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN=dpapi:<same-rt>\n');
    const before = fs.statSync(envPath).mtimeMs;
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    try {
      await new EnvFileTokenStore(envPath).save({ refreshToken: 'same-rt', accessToken: 'at' });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.statSync(envPath).mtimeMs).toBe(before);
  });

  it('persists the realm id alongside the token after an interactive sign-in', async () => {
    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN=rt\n');
    await new EnvFileTokenStore(envPath).save({ refreshToken: 'rt', realmId: '777' });
    const written = fs.readFileSync(envPath, 'utf-8');
    expect(written).toContain('QUICKBOOKS_REALM_ID=777');
    expect(written).toContain('QUICKBOOKS_REFRESH_TOKEN=rt');
  });

  it('removes the temp file and rethrows when the atomic write fails', async () => {
    const missingDir = path.join(dir, 'does-not-exist', '.env');
    await expect(new EnvFileTokenStore(missingDir).save({ refreshToken: 'rt' })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]); // no stray temp file
  });

  it('markReauthRequired is a no-op for the stdio store (ruling R1)', async () => {
    fs.writeFileSync(envPath, 'QUICKBOOKS_REFRESH_TOKEN=rt\n');
    await expect(new EnvFileTokenStore(envPath).markReauthRequired('refresh token rejected')).resolves.toBeUndefined();
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('QUICKBOOKS_REFRESH_TOKEN=rt\n');
  });

  it('withRefreshLock serializes callers on the same path, even across store instances', async () => {
    const a = new EnvFileTokenStore(envPath);
    const b = new EnvFileTokenStore(envPath);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));

    const first = a.withRefreshLock(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      return 1;
    });
    const second = b.withRefreshLock(async () => {
      order.push('second:start');
      return 2;
    });

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first:start']); // second waits for the lock

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('withRefreshLock releases the lock when the callback throws', async () => {
    const store = new EnvFileTokenStore(envPath);
    await expect(store.withRefreshLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(store.withRefreshLock(async () => 'next')).resolves.toBe('next');
  });

  it('withRefreshLock does not serialize different paths', async () => {
    const other = new EnvFileTokenStore(path.join(dir, 'other.env'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new EnvFileTokenStore(envPath).withRefreshLock(() => gate);
    await expect(other.withRefreshLock(async () => 'independent')).resolves.toBe('independent');
    release();
    await held;
  });
});
