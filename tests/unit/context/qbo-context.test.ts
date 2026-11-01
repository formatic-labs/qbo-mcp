/**
 * Behavioral tests for the per-call QuickBooks request context
 * (src/context/qbo-context.ts) and the lazy env client it backs.
 *
 * - Importing the client/context modules with no QUICKBOOKS_* env must not
 *   throw: the env client is built only when first needed.
 * - Inside runWithQboContext, QuickbooksClient.getInstance()/getAuthCredentials()
 *   use the context's client, isolated across concurrent async calls.
 * - After enterHostedMode(), a call outside any context fails closed with
 *   QboNotConnectedError and never builds the env client (dotenv is the spy:
 *   building the env client is the only thing that loads .env), and a client
 *   constructed without an explicit tokenStore is a hard error.
 * - Without hosted mode, a call outside a context uses the env client (stdio).
 *
 * Hosted mode is process-wide and one-way, so the stdio test runs first and
 * the hosted tests last (jest runs tests in a file in declaration order).
 */
import { jest } from '@jest/globals';
import type { TokenStore } from '../../../src/clients/token-store';

// Start with NO QuickBooks env at all — the import below must still succeed.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('QUICKBOOKS_')) delete process.env[key];
}

// dotenv.config is only ever called while building the env client, so it is
// the observable "getEnvClient ran" signal. It never touches a real .env.
const dotenvConfig = jest.fn();
jest.unstable_mockModule('dotenv', () => ({
  default: { config: dotenvConfig, parse: jest.fn(() => ({})) },
}));

jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    refreshUsingToken = jest.fn();
    createToken = jest.fn();
    authorizeUri = jest.fn(() => 'https://mock');
    constructor(_cfg: Record<string, unknown>) {}
  }
  return { default: MockOAuthClient };
});

// Record the realm each QuickBooks instance was built for, so a test can tell
// which client served a call.
jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks {
    realmId: string;
    constructor(...args: unknown[]) {
      this.realmId = args[4] as string;
    }
  },
}));
jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));
jest.unstable_mockModule('http', () => ({
  default: { createServer: jest.fn(() => ({ listen: jest.fn(), close: jest.fn(), on: jest.fn() })) },
}));

// Sequential on purpose: the two modules import each other, and jest's ESM
// linker mis-links a cycle requested by two concurrent dynamic imports.
const importBoth = async () => {
  const ctx = await import('../../../src/context/qbo-context');
  const qb = await import('../../../src/clients/quickbooks-client');
  return [ctx, qb] as const;
};

// Importing with an empty env must not throw (previously the module threw at
// import when QUICKBOOKS_CLIENT_ID/SECRET were missing).
const importResult = await importBoth().then(
  (mods) => ({ ok: true as const, mods }),
  (error: unknown) => ({ ok: false as const, error }),
);

// jest's clearMocks resets call counts before each test, so capture this now.
const dotenvCallsAtImport = dotenvConfig.mock.calls.length;

function mods() {
  if (!importResult.ok) throw importResult.error;
  const [ctx, qb] = importResult.mods;
  return { ...ctx, ...qb };
}

const memoryStore = (): TokenStore => ({
  read: jest.fn(async () => undefined),
  save: jest.fn(async () => undefined),
  markReauthRequired: jest.fn(async () => undefined),
  withRefreshLock: <T>(fn: () => Promise<T>) => fn(),
});

// A client that can serve getInstance()/getAuthCredentials() without any
// network: fresh access token, refresh token and realm all present.
function freshClient(realmId: string) {
  const { QuickbooksClient } = mods();
  return new QuickbooksClient({
    clientId: 'cid',
    clientSecret: 'secret',
    refreshToken: `refresh-${realmId}`,
    realmId,
    environment: 'sandbox',
    redirectUri: 'http://localhost:8000/callback',
    tokenStore: memoryStore(),
    accessToken: `access-${realmId}`,
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('qbo-context', () => {
  it('importing the client and context without QUICKBOOKS_* env does not throw', () => {
    expect(importResult.ok).toBe(true);
    expect(dotenvCallsAtImport).toBe(0);
  });

  it('getEnvClient throws only when called, and names the missing env', () => {
    const { getEnvClient } = mods();
    expect(() => getEnvClient()).toThrow(/Client ID, Client Secret and Redirect URI/);
  });

  it('currentQboContext is undefined outside a context and set inside one', async () => {
    const { currentQboContext, runWithQboContext } = mods();
    expect(currentQboContext()).toBeUndefined();
    const client = freshClient('ctx-realm');
    const actor = { tenantId: 't1', userId: 'u1', canWrite: false };
    const seen = await runWithQboContext({ client, actor }, async () => currentQboContext());
    expect(seen?.client).toBe(client);
    expect(seen?.actor).toEqual(actor);
    expect(currentQboContext()).toBeUndefined();
  });

  it('getInstance uses the context client inside runWithQboContext (concurrent contexts stay isolated)', async () => {
    const { QuickbooksClient, runWithQboContext } = mods();
    const a = freshClient('realm-a');
    const b = freshClient('realm-b');

    const run = (client: ReturnType<typeof freshClient>) =>
      runWithQboContext({ client }, async () => {
        const first = (await QuickbooksClient.getInstance()) as unknown as { realmId: string };
        await tick(); // interleave the two contexts
        const second = (await QuickbooksClient.getInstance()) as unknown as { realmId: string };
        const creds = await QuickbooksClient.getAuthCredentials();
        return [first.realmId, second.realmId, creds.realmId, creds.accessToken];
      });

    const [ra, rb] = await Promise.all([run(a), run(b)]);
    expect(ra).toEqual(['realm-a', 'realm-a', 'realm-a', 'access-realm-a']);
    expect(rb).toEqual(['realm-b', 'realm-b', 'realm-b', 'access-realm-b']);
    // The env client was never needed.
    expect(dotenvConfig).not.toHaveBeenCalled();
  });

  it('stdio mode without a context uses the env client (current behaviour)', async () => {
    const { QuickbooksClient, getEnvClient, quickbooksClient } = mods();
    process.env.QUICKBOOKS_CLIENT_ID = 'env-client-id';
    process.env.QUICKBOOKS_CLIENT_SECRET = 'env-client-secret';
    process.env.QUICKBOOKS_REFRESH_TOKEN = 'env-refresh';
    process.env.QUICKBOOKS_REALM_ID = 'env-realm';
    process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';

    const envClient = getEnvClient();
    expect(dotenvConfig).toHaveBeenCalledTimes(1);
    // Memoized: one env client per process, and the legacy export is it.
    expect(getEnvClient()).toBe(envClient);
    expect(dotenvConfig).toHaveBeenCalledTimes(1);

    // Seed a fresh access token through the legacy export so no refresh runs.
    (quickbooksClient as unknown as { accessToken?: string }).accessToken = 'env-access';
    (quickbooksClient as unknown as { accessTokenExpiry?: Date }).accessTokenExpiry = new Date(
      Date.now() + 60 * 60 * 1000,
    );
    expect((envClient as unknown as { accessToken?: string }).accessToken).toBe('env-access');

    const qb = (await QuickbooksClient.getInstance()) as unknown as { realmId: string };
    expect(qb.realmId).toBe('env-realm');
    expect(quickbooksClient.getQuickbooks()).toBe(qb);
    const creds = await QuickbooksClient.getAuthCredentials();
    expect(creds).toEqual({ accessToken: 'env-access', realmId: 'env-realm', isSandbox: true });
  });

  it('hosted mode: a client without an explicit tokenStore is a hard error', () => {
    const { enterHostedMode, QuickbooksClient } = mods();
    enterHostedMode();
    expect(
      () =>
        new QuickbooksClient({
          clientId: 'cid',
          clientSecret: 'secret',
          realmId: 'r',
          environment: 'sandbox',
          redirectUri: 'http://localhost:8000/callback',
        }),
    ).toThrow(/tokenStore/);
    // With an explicit store it is fine.
    expect(freshClient('ok')).toBeInstanceOf(QuickbooksClient);
  });

  it('hosted context never falls back to the env client', async () => {
    const { enterHostedMode, QuickbooksClient, QboNotConnectedError, getEnvClient, runWithQboContext } = mods();
    enterHostedMode(); // idempotent
    dotenvConfig.mockClear();

    await expect(QuickbooksClient.getInstance()).rejects.toBeInstanceOf(QboNotConnectedError);
    await expect(QuickbooksClient.getAuthCredentials()).rejects.toBeInstanceOf(QboNotConnectedError);
    expect(() => getEnvClient()).toThrow(QboNotConnectedError);
    expect(dotenvConfig).not.toHaveBeenCalled();

    const err = new QboNotConnectedError();
    expect(err.name).toBe('QboNotConnectedError');
    expect(err.message).toMatch(/not connected/i);

    // A context still works in hosted mode.
    const qb = (await runWithQboContext({ client: freshClient('hosted-realm') }, () =>
      QuickbooksClient.getInstance(),
    )) as unknown as { realmId: string };
    expect(qb.realmId).toBe('hosted-realm');
  });
});
