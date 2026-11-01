/**
 * Resilience tests for QuickbooksClient token handling.
 *
 * Covers two failure modes behind a production outage:
 *
 * 1. Multi-process refresh-token rotation race. A host may spawn this server
 *    more than once against the same .env (Claude Desktop + Claude Code), and
 *    Intuit invalidates the previous refresh token on every rotation. The
 *    client refreshes inside the token store's lock with the store's newest
 *    persisted token, and retries once with its in-memory token if that is
 *    rejected — so a valid in-memory token (including one just rotated but not
 *    yet persisted) is never discarded.
 * 2. In production, a genuinely dead refresh token fails with an actionable
 *    "re-authorize" error rather than opening the interactive localhost OAuth
 *    flow (Intuit rejects localhost redirects for production apps). A TRANSIENT
 *    failure (5xx/429/network) must instead stay retryable and self-heal.
 */
import { jest } from '@jest/globals';

process.env.QUICKBOOKS_CLIENT_ID = 'test-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-client-secret';
process.env.QUICKBOOKS_REFRESH_TOKEN = 'seed-refresh-token';
process.env.QUICKBOOKS_REALM_ID = '12345';
process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
process.env.QUICKBOOKS_REDIRECT_URI = 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl';

// No-op dotenv config so the real .env is never read (see auth test), plus a
// realistic parse() that mirrors dotenv's quote/inline-comment/export handling
// so readPersistedRefreshToken() is exercised against true dotenv semantics.
jest.unstable_mockModule('dotenv', () => ({
  default: {
    config: jest.fn(),
    parse: (src: Buffer | string) => {
      const out: Record<string, string> = {};
      for (const line of String(src).split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = (m[2] ?? '').trim();
        // A quoted value at the start wins; trailing content (e.g. a comment
        // after the closing quote) is ignored — matching dotenv.
        const quoted = v.match(/^(['"`])((?:\\.|[^\\])*?)\1/);
        if (quoted) v = quoted[2];
        else v = v.split(' #')[0].trim(); // strip inline comment (unquoted only)
        out[m[1]] = v;
      }
      return out;
    },
  },
}));

const refreshDispatch = jest.fn<(token: string) => Promise<unknown>>();
const openMock = jest.fn(async () => undefined);

jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    cfg: Record<string, unknown>;
    refreshUsingToken = jest.fn((token: string) => refreshDispatch(token));
    createToken = jest.fn();
    authorizeUri = jest.fn(() => 'https://appcenter.intuit.com/connect/oauth2?mock');
    constructor(cfg: Record<string, unknown>) {
      this.cfg = cfg;
    }
  }
  return { default: MockOAuthClient };
});

jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks {
    constructor(..._args: unknown[]) {}
  },
}));

jest.unstable_mockModule('open', () => ({ default: openMock }));

// http.createServer must never be reached in these tests (production throws
// before it; the rotation tests never fall back). If it is, serverCreated flips
// so we can assert "no doomed browser flow was started".
let serverCreated = false;
const fakeServer = {
  // The test only needs to observe that interactive OAuth attempted to create
  // a server. Do not invoke the listen callback: doing so starts browser-flow
  // logging after the intentionally unresolved authenticate() promise.
  listen: jest.fn(() => fakeServer),
  close: jest.fn(),
  on: jest.fn(),
  address: jest.fn(() => ({ address: '::', port: 8000, family: 'IPv6' })),
};
jest.unstable_mockModule('http', () => ({
  default: {
    createServer: jest.fn(() => {
      serverCreated = true;
      return fakeServer;
    }),
  },
}));

// Controllable fs mock: readFileSync drives readPersistedRefreshToken().
const fsReadFileSync = jest.fn<(...args: unknown[]) => string>();
jest.unstable_mockModule('fs', () => ({
  default: {
    readFileSync: fsReadFileSync,
    existsSync: jest.fn(() => false),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
  },
}));

const { QuickbooksClient } = await import('../../../src/clients/quickbooks-client');

function makeClient(overrides: Partial<{ environment: string; refreshToken: string }> = {}) {
  return new QuickbooksClient({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: overrides.refreshToken ?? 'in-memory-token',
    realmId: '12345',
    environment: overrides.environment ?? 'sandbox',
    redirectUri: 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl',
  });
}
const tokenOf = (client: unknown) => (client as { refreshToken?: string }).refreshToken;
const envWithToken = (t: string) => `QUICKBOOKS_CLIENT_ID=x\nQUICKBOOKS_REFRESH_TOKEN=${t}\nQUICKBOOKS_REALM_ID=12345\n`;

// Error fixtures mirroring intuit-oauth 4.2.1's REAL shapes, captured
// empirically against the live library:
//  - a rejected refresh token surfaces ONLY as the axios message
//    "Request failed with status code 400"; error_description is "",
//    authResponse.response is "", authResponse.status is a function -> undefined.
//  - transient failures carry a 5xx/429 status code or a network error message.
const deadTokenError = (code = 400) =>
  Object.assign(new Error(`Request failed with status code ${code}`), {
    error: `Request failed with status code ${code}`,
    error_description: '',
    intuit_tid: 'tid-abc',
    authResponse: { token: {}, response: '', body: '', json: null, status: () => undefined, intuit_tid: 'tid-abc' },
  });
const transientError = (code?: number) =>
  code === undefined
    ? new Error('getaddrinfo ETIMEDOUT oauth.platform.intuit.com')
    : Object.assign(new Error(`Request failed with status code ${code}`), {
        error: `Request failed with status code ${code}`,
        authResponse: { response: '', status: () => undefined },
      });

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  refreshDispatch.mockReset();
  fsReadFileSync.mockReset();
  openMock.mockClear();
  serverCreated = false;
  fsReadFileSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
});

describe('multi-process rotation race', () => {
  // Task 2: the refresh now runs inside the token store's lock and tries the
  // store's (newest persisted) refresh token FIRST, falling back to the
  // in-memory token only when the stored one is rejected. The guarantees these
  // tests pin are unchanged: a valid in-memory token is never discarded, a
  // transient error never swaps tokens, and disk values parse like dotenv.
  it('falls back to the valid in-memory token when the stale disk token is rejected (never discards a good token)', async () => {
    // Regression guard: disk holds a STALE token (a prior persist failed), but
    // the in-memory token is valid. The pre-review bug adopted disk
    // unconditionally and locked out a company whose valid token was in memory.
    const client = makeClient({ refreshToken: 'valid-in-memory-T2' });
    fsReadFileSync.mockReturnValue(envWithToken('stale-disk-T1'));
    refreshDispatch.mockImplementation(async (t) => {
      if (t === 'stale-disk-T1') throw deadTokenError(400);
      return { token: { access_token: 'a1', expires_in: 3600 } };
    });

    await client.refreshAccessToken();

    expect(refreshDispatch.mock.calls).toEqual([['stale-disk-T1'], ['valid-in-memory-T2']]);
    expect(tokenOf(client)).toBe('valid-in-memory-T2');
  });

  it('uses the sibling-rotated disk token first, without spending the stale in-memory one', async () => {
    const client = makeClient({ refreshToken: 'stale-A' });
    fsReadFileSync.mockReturnValue(envWithToken('fresh-B')); // sibling rotated & persisted
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'a2', expires_in: 3600 } });

    await client.refreshAccessToken();

    expect(refreshDispatch.mock.calls).toEqual([['fresh-B']]);
    expect(tokenOf(client)).toBe('fresh-B');
  });

  it('does NOT swap the in-memory token on a TRANSIENT first error (never discards a valid token)', async () => {
    // Regression guard for the second-pass blocker: a transient blip must not
    // replace a valid (rotated-but-unpersisted) in-memory token, nor trigger a
    // retry with another token.
    const client = makeClient({ refreshToken: 'valid-T3' });
    fsReadFileSync.mockReturnValue(envWithToken('stale-disk-T2'));
    refreshDispatch.mockRejectedValueOnce(transientError(503));

    await expect(client.refreshAccessToken()).rejects.toThrow(/Failed to refresh Quickbooks token/);
    expect(refreshDispatch).toHaveBeenCalledTimes(1); // no retry
    expect(tokenOf(client)).toBe('valid-T3'); // token preserved
  });

  it('parses a quoted disk token like dotenv', async () => {
    const client = makeClient({ refreshToken: 'dead-A' });
    fsReadFileSync.mockReturnValue('QUICKBOOKS_REFRESH_TOKEN="fresh-B" # rotated\n'); // quoted + comment
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'a', expires_in: 3600 } });

    await client.refreshAccessToken();

    // Quotes and inline comment stripped: the refresh uses fresh-B, not '"fresh-B"...'.
    expect(refreshDispatch.mock.calls).toEqual([['fresh-B']]);
  });

  it('gives up when the disk token is unchanged after a rejection (token genuinely dead)', async () => {
    const client = makeClient({ refreshToken: 'dead-token' });
    fsReadFileSync.mockReturnValue(envWithToken('dead-token')); // no sibling rotation
    refreshDispatch.mockRejectedValue(deadTokenError(400));

    await expect(client.refreshAccessToken()).rejects.toThrow(/Failed to refresh Quickbooks token/);
    expect(refreshDispatch).toHaveBeenCalledTimes(1); // no pointless retry with the same token
  });
});

describe('production dead-token handling', () => {
  it('throws an actionable error and never opens a browser on a real HTTP-400 dead token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'dead-prod' });
    fsReadFileSync.mockReturnValue(envWithToken('dead-prod'));
    refreshDispatch.mockRejectedValue(deadTokenError(400)); // real intuit-oauth shape

    await expect(client.authenticate()).rejects.toThrow(/cannot be renewed automatically in production/);
    expect(serverCreated).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('treats a 401 as a dead token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'revoked' });
    fsReadFileSync.mockReturnValue(envWithToken('revoked'));
    refreshDispatch.mockRejectedValue(deadTokenError(401));

    await expect(client.authenticate()).rejects.toThrow(/cannot be renewed automatically in production/);
  });

  it('treats an explicit invalid_grant error_description as a dead token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'dead2' });
    fsReadFileSync.mockReturnValue(envWithToken('dead2'));
    refreshDispatch.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        error: 'invalid_grant',
        error_description: 'Token invalid or expired',
      })
    );

    await expect(client.authenticate()).rejects.toThrow(/cannot be renewed automatically in production/);
  });

  it('throws the same actionable error when a production server starts with no refresh token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: '' });
    (client as unknown as { refreshToken?: string }).refreshToken = undefined;

    await expect(client.authenticate()).rejects.toThrow(/cannot be renewed automatically in production/);
    expect(serverCreated).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('does NOT report reauth for a transient error in production, and preserves the token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'good-but-blip' });
    fsReadFileSync.mockReturnValue(envWithToken('good-but-blip'));
    refreshDispatch.mockRejectedValue(new Error('getaddrinfo ETIMEDOUT api.intuit.com'));

    const msg = await messageOf(client.authenticate());
    expect(msg).toMatch(/Failed to refresh Quickbooks token/);
    expect(msg).not.toMatch(/re-authorize|renewed automatically in production/);
    // In-memory token is NOT cleared, so the next call self-heals.
    expect(tokenOf(client)).toBe('good-but-blip');
    expect(openMock).not.toHaveBeenCalled();
  });

  it('treats a 503 as transient, not a dead token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'fine' });
    fsReadFileSync.mockReturnValue(envWithToken('fine'));
    refreshDispatch.mockRejectedValue(transientError(503));

    const msg = await messageOf(client.authenticate());
    expect(msg).not.toMatch(/renewed automatically in production/);
    expect(tokenOf(client)).toBe('fine');
  });

  it('treats a 429 rate-limit as transient, not a dead token', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'fine429' });
    fsReadFileSync.mockReturnValue(envWithToken('fine429'));
    refreshDispatch.mockRejectedValue(transientError(429));

    const msg = await messageOf(client.authenticate());
    expect(msg).not.toMatch(/renewed automatically in production/);
    expect(tokenOf(client)).toBe('fine429');
  });

  it('still succeeds in production when the refresh token is valid', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'good-prod-token' });
    fsReadFileSync.mockReturnValue(envWithToken('good-prod-token'));
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'a3', expires_in: 3600 } });

    await expect(client.authenticate()).resolves.toBeDefined();
    expect(serverCreated).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('classifies a dead token carried deep in the error cause chain', async () => {
    const client = makeClient({ environment: 'production', refreshToken: 'dead-deep' });
    fsReadFileSync.mockReturnValue(envWithToken('dead-deep'));
    // Real signal is two cause-levels down under generic wrappers.
    const outer = Object.assign(new Error('transport wrapper'), {
      cause: Object.assign(new Error('adapter wrapper'), { cause: deadTokenError(400) }),
    });
    refreshDispatch.mockRejectedValue(outer);

    await expect(client.authenticate()).rejects.toThrow(/cannot be renewed automatically in production/);
  });
});

describe('sandbox transient handling', () => {
  it('does NOT launch interactive OAuth on a transient error in sandbox (preserves token)', async () => {
    const client = makeClient({ environment: 'sandbox', refreshToken: 'valid-sbx' });
    fsReadFileSync.mockReturnValue(envWithToken('valid-sbx'));
    refreshDispatch.mockRejectedValue(transientError(503));

    const msg = await messageOf(client.authenticate());
    expect(msg).toMatch(/Failed to refresh Quickbooks token/);
    expect(serverCreated).toBe(false); // no doomed/​spurious browser flow
    expect(openMock).not.toHaveBeenCalled();
    expect(tokenOf(client)).toBe('valid-sbx'); // token NOT discarded
  });

  it('DOES fall back to interactive OAuth on a genuine dead token in sandbox', async () => {
    const client = makeClient({ environment: 'sandbox', refreshToken: 'dead-sbx' });
    fsReadFileSync.mockReturnValue(envWithToken('dead-sbx'));
    refreshDispatch.mockRejectedValue(deadTokenError(400));

    // The localhost callback never completes in this harness, so the flow hangs;
    // asserting the server was created proves the dead-token path was taken.
    const authPromise = client.authenticate();
    const started = await Promise.race([
      (async () => {
        for (let i = 0; i < 50 && !serverCreated; i++) await new Promise((r) => setImmediate(r));
        return serverCreated;
      })(),
      authPromise.then(() => true).catch(() => true),
    ]);
    expect(started).toBe(true);
    expect(serverCreated).toBe(true);
  });
});

// ── TokenStore integration (Task 2) ──────────────────────────────────────────
// A fake TokenStore with a REAL async mutex, standing in for the hosted
// Supabase store (row lock) so cross-client serialization is observable.
type Tokens = { refreshToken: string; accessToken?: string; accessTokenExpiresAt?: Date };
function makeFakeStore(initial?: Tokens) {
  let current: Tokens | undefined = initial;
  let tail: Promise<void> = Promise.resolve();
  const store = {
    read: jest.fn(async () => (current ? { ...current } : undefined)),
    save: jest.fn(async (t: Tokens) => {
      current = { ...t };
    }),
    withRefreshLock: jest.fn(<T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }),
    markReauthRequired: jest.fn(async (_reason: string) => undefined),
    get current() {
      return current;
    },
  };
  return store;
}
function makeStoreClient(
  store: ReturnType<typeof makeFakeStore>,
  overrides: Partial<{
    environment: string;
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresAt: Date;
    strictPersistence: boolean;
    noRefreshToken: boolean; // build the client with tokenStore only (hosted shape)
  }> = {}
) {
  return new QuickbooksClient({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: overrides.noRefreshToken ? undefined : overrides.refreshToken ?? 'T0',
    strictPersistence: overrides.strictPersistence,
    realmId: '12345',
    environment: overrides.environment ?? 'sandbox',
    redirectUri: 'https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl',
    // jest.fn() erases withRefreshLock's generic, so cast to the config's store type.
    tokenStore: store as unknown as ConstructorParameters<typeof QuickbooksClient>[0]['tokenStore'],
    accessToken: overrides.accessToken,
    accessTokenExpiresAt: overrides.accessTokenExpiresAt,
  });
}

describe('TokenStore: serialized refresh', () => {
  it('refresh is serialized through the store lock: one network refresh, second client reuses the saved token', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    const a = makeStoreClient(store);
    const b = makeStoreClient(store);
    refreshDispatch.mockImplementation(async (t: string) => {
      await new Promise((r) => setImmediate(r)); // hold the lock across a tick
      return { token: { access_token: `at-from-${t}`, expires_in: 3600, refresh_token: 'T1' } };
    });

    await Promise.all([a.authenticate(), b.authenticate()]);

    expect(refreshDispatch).toHaveBeenCalledTimes(1);
    expect(refreshDispatch).toHaveBeenCalledWith('T0');
    expect(store.withRefreshLock).toHaveBeenCalledTimes(2);
    // b re-read the store inside the lock and adopted a's rotated tokens.
    expect(tokenOf(b)).toBe('T1');
    expect((b as unknown as { accessToken?: string }).accessToken).toBe('at-from-T0');
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('rotated refresh token and access token are saved after refresh', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    const client = makeStoreClient(store);
    refreshDispatch.mockResolvedValueOnce({
      token: { access_token: 'new-at', expires_in: 3600, refresh_token: 'rotated-T1' },
    });
    const before = Date.now();

    await client.authenticate();

    expect(store.save).toHaveBeenCalledTimes(1);
    const saved = store.save.mock.calls[0][0] as Tokens;
    expect(saved.refreshToken).toBe('rotated-T1');
    expect(saved.accessToken).toBe('new-at');
    expect(saved.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(saved.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(tokenOf(client)).toBe('rotated-T1');
  });

  it('saves the access token even when Intuit does not rotate the refresh token', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    const client = makeStoreClient(store);
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'at-only' } }); // no expires_in, no rotation

    await client.authenticate();

    const saved = store.save.mock.calls[0][0] as Tokens;
    expect(saved).toEqual({ refreshToken: 'T0', accessToken: 'at-only', accessTokenExpiresAt: expect.any(Date) });
  });

  it('fresh stored access token skips refresh (seeded 30 min ahead)', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    const client = makeStoreClient(store, {
      accessToken: 'seeded-at',
      accessTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    await client.authenticate();

    expect(refreshDispatch).not.toHaveBeenCalled();
    expect(store.withRefreshLock).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('a fresh access token already in the store (saved by another instance) is adopted inside the lock without a refresh', async () => {
    const expiresAt = new Date(Date.now() + 40 * 60 * 1000);
    const store = makeFakeStore({ refreshToken: 'T5', accessToken: 'sibling-at', accessTokenExpiresAt: expiresAt });
    const client = makeStoreClient(store, { refreshToken: 'T4' }); // in-memory token is stale

    const result = await client.refreshAccessToken();

    expect(refreshDispatch).not.toHaveBeenCalled();
    expect(result.access_token).toBe('sibling-at');
    expect(result.expires_in).toBeGreaterThan(30 * 60);
    expect(tokenOf(client)).toBe('T5');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('an expiring access token in the store is not adopted; the stored refresh token is used', async () => {
    const store = makeFakeStore({
      refreshToken: 'T5',
      accessToken: 'old-at',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000), // inside the 5-min buffer
    });
    const client = makeStoreClient(store, { refreshToken: 'T4' });
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'fresh-at', expires_in: 3600, refresh_token: 'T6' } });

    await client.refreshAccessToken();

    expect(refreshDispatch.mock.calls).toEqual([['T5']]);
    expect(store.current?.refreshToken).toBe('T6');
  });

  it('a store access token without an expiry is treated as stale', async () => {
    const store = makeFakeStore({ refreshToken: 'T5', accessToken: 'no-expiry-at' });
    const client = makeStoreClient(store);
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'fresh-at', expires_in: 3600 } });

    await client.refreshAccessToken();

    expect(refreshDispatch).toHaveBeenCalledWith('T5');
  });

  it('logs (without failing the refresh) when the store cannot save, and never logs token values or the store message', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    store.save.mockRejectedValue(new Error('disk full near secret-rt'));
    const client = makeStoreClient(store);
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'secret-at', expires_in: 3600, refresh_token: 'secret-rt' } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(client.refreshAccessToken()).resolves.toEqual({ access_token: 'secret-at', expires_in: 3600 });

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toMatch(/Failed to persist refreshed QuickBooks tokens \(Error\)/);
    expect(logged).not.toMatch(/secret-at|secret-rt|disk full/);
    expect(store.save).toHaveBeenCalledTimes(3); // rotated: retried (R3)
  });
});

describe('TokenStore: client built with tokenStore only (fix round 1, #1)', () => {
  it('seeds the refresh token from the store and authenticates; never flags reauth', async () => {
    const store = makeFakeStore({ refreshToken: 'stored-T9' });
    const client = makeStoreClient(store, { environment: 'production', noRefreshToken: true });
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'at9', expires_in: 3600 } });

    await expect(client.authenticate()).resolves.toBeDefined();

    expect(refreshDispatch.mock.calls).toEqual([['stored-T9']]);
    expect(store.markReauthRequired).not.toHaveBeenCalled();
    expect(serverCreated).toBe(false);
  });

  it('seeds a fresh stored access token too, so no refresh is needed', async () => {
    const store = makeFakeStore({
      refreshToken: 'stored-T9',
      accessToken: 'stored-at',
      accessTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    const client = makeStoreClient(store, { environment: 'production', noRefreshToken: true });

    await expect(client.authenticate()).resolves.toBeDefined();

    expect(refreshDispatch).not.toHaveBeenCalled();
    expect(store.markReauthRequired).not.toHaveBeenCalled();
  });

  it('refreshAccessToken() also seeds from the store', async () => {
    const store = makeFakeStore({ refreshToken: 'stored-T9' });
    const client = makeStoreClient(store, { environment: 'production', noRefreshToken: true });
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'at9', expires_in: 3600 } });

    await expect(client.refreshAccessToken()).resolves.toEqual({ access_token: 'at9', expires_in: 3600 });
    expect(store.markReauthRequired).not.toHaveBeenCalled();
  });

  it('only flags reauth when the store is empty as well', async () => {
    const { QboReauthRequiredError } = await import('../../../src/clients/token-store');
    const store = makeFakeStore(undefined);
    const client = makeStoreClient(store, { environment: 'production', noRefreshToken: true });

    await expect(client.authenticate()).rejects.toBeInstanceOf(QboReauthRequiredError);
    expect(store.markReauthRequired).toHaveBeenCalledTimes(1);
    expect(refreshDispatch).not.toHaveBeenCalled();
  });
});

describe('TokenStore: persisting a rotated token (fix round 1, #2 / ruling R3)', () => {
  const rotatedResponse = () => ({ token: { access_token: 'at-r', expires_in: 3600, refresh_token: 'rotated-R' } });

  it('retries the save: fails twice then succeeds -> saved, no error', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    store.save.mockRejectedValueOnce(new Error('blip')).mockRejectedValueOnce(new Error('blip'));
    const client = makeStoreClient(store, { strictPersistence: true });
    refreshDispatch.mockResolvedValueOnce(rotatedResponse());
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(client.refreshAccessToken()).resolves.toEqual({ access_token: 'at-r', expires_in: 3600 });

    expect(store.save).toHaveBeenCalledTimes(3);
    expect(store.current?.refreshToken).toBe('rotated-R');
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/Failed to persist/);
  });

  it('strictPersistence: always failing -> QboTokenPersistError after 3 attempts, no token values in the message', async () => {
    const { QboTokenPersistError } = await import('../../../src/clients/token-store');
    const store = makeFakeStore({ refreshToken: 'T0' });
    store.save.mockRejectedValue(new Error('db down'));
    const client = makeStoreClient(store, { strictPersistence: true });
    refreshDispatch.mockResolvedValueOnce(rotatedResponse());

    const err = await client.authenticate().catch((e) => e);

    expect(err).toBeInstanceOf(QboTokenPersistError);
    expect((err as Error).name).toBe('QboTokenPersistError');
    expect((err as Error).message).toMatch(/after 3 attempts/);
    expect((err as Error).message).not.toMatch(/rotated-R|at-r|T0|db down/);
    expect(store.save).toHaveBeenCalledTimes(3);
  });

  it('default (stdio): always failing -> logs and returns the access token after 3 attempts', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    store.save.mockRejectedValue(new Error('read-only fs'));
    const client = makeStoreClient(store);
    refreshDispatch.mockResolvedValueOnce(rotatedResponse());
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(client.refreshAccessToken()).resolves.toEqual({ access_token: 'at-r', expires_in: 3600 });

    expect(store.save).toHaveBeenCalledTimes(3);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Failed to persist refreshed QuickBooks tokens \(Error\)/);
  });

  it('a non-rotated save failure is tried once and only logged, even with strictPersistence', async () => {
    const store = makeFakeStore({ refreshToken: 'T0' });
    store.save.mockRejectedValue('not-an-error-object');
    const client = makeStoreClient(store, { strictPersistence: true });
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'at-n', expires_in: 3600, refresh_token: 'T0' } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(client.refreshAccessToken()).resolves.toEqual({ access_token: 'at-n', expires_in: 3600 });

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Failed to persist refreshed QuickBooks tokens \(string\)/);
  });
});

describe('TokenStore: dead refresh token', () => {
  it('dead refresh token calls markReauthRequired and throws QboReauthRequiredError (production, invalid_grant)', async () => {
    const { QboReauthRequiredError } = await import('../../../src/clients/token-store');
    const store = makeFakeStore({ refreshToken: 'dead' });
    const client = makeStoreClient(store, { environment: 'production', refreshToken: 'dead' });
    refreshDispatch.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), { error: 'invalid_grant', error_description: '' })
    );

    const err = await client.authenticate().catch((e) => e);

    expect(err).toBeInstanceOf(QboReauthRequiredError);
    expect((err as Error).message).toMatch(/cannot be renewed automatically in production/);
    expect(store.markReauthRequired).toHaveBeenCalledTimes(1);
    expect(String(store.markReauthRequired.mock.calls[0][0])).not.toMatch(/dead/); // no token in the reason
    expect(serverCreated).toBe(false);
  });

  it('stdio (interactive disabled): keeps the "run `npm run auth`" wording, as a QboReauthRequiredError (ruling R1)', async () => {
    const { QboReauthRequiredError } = await import('../../../src/clients/token-store');
    const store = makeFakeStore({ refreshToken: 'dead-sbx' });
    const client = makeStoreClient(store, { environment: 'sandbox', refreshToken: 'dead-sbx' });
    refreshDispatch.mockRejectedValue(deadTokenError(400));
    QuickbooksClient.interactiveAuthAllowed = false;
    try {
      const err = await client.authenticate().catch((e) => e);
      expect(err).toBeInstanceOf(QboReauthRequiredError);
      expect((err as Error).message).toMatch(/Reconnect by running `npm run auth` in the qbo-mcp folder/);
      expect(store.markReauthRequired).toHaveBeenCalledTimes(1);
      expect(serverCreated).toBe(false);
    } finally {
      QuickbooksClient.interactiveAuthAllowed = true;
    }
  });

  it('a failing markReauthRequired never masks the reauth error', async () => {
    const { QboReauthRequiredError } = await import('../../../src/clients/token-store');
    const store = makeFakeStore({ refreshToken: 'dead' });
    store.markReauthRequired.mockRejectedValueOnce(new Error('db down'));
    const client = makeStoreClient(store, { environment: 'production', refreshToken: 'dead' });
    refreshDispatch.mockRejectedValue(deadTokenError(401));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(client.authenticate()).rejects.toBeInstanceOf(QboReauthRequiredError);
    expect(errSpy).toHaveBeenCalled();
  });

  it('a transient error never marks the company as needing reauth', async () => {
    const store = makeFakeStore({ refreshToken: 'fine' });
    const client = makeStoreClient(store, { environment: 'production', refreshToken: 'fine' });
    refreshDispatch.mockRejectedValue(transientError(503));

    await expect(client.authenticate()).rejects.toThrow(/Failed to refresh Quickbooks token/);
    expect(store.markReauthRequired).not.toHaveBeenCalled();
  });
});
