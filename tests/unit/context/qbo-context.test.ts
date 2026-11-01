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

// Programmable refresh response (used by the hosted reauth test).
const refreshDispatch = jest.fn<(token: string) => Promise<unknown>>();
const openMock = jest.fn(async () => undefined);
const createServerMock = jest.fn(() => ({ listen: jest.fn(), close: jest.fn(), on: jest.fn() }));

jest.unstable_mockModule('intuit-oauth', () => {
  class MockOAuthClient {
    static scopes = { Accounting: 'com.intuit.quickbooks.accounting' };
    refreshUsingToken = jest.fn((token: string) => refreshDispatch(token));
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
jest.unstable_mockModule('open', () => ({ default: openMock }));
jest.unstable_mockModule('http', () => ({ default: { createServer: createServerMock } }));

// Importing the library must not register process-level listeners (those are
// installed only by the stdio entries via installProcessErrorLogging()).
const listenersBefore = {
  uncaught: process.listenerCount('uncaughtException'),
  unhandled: process.listenerCount('unhandledRejection'),
};

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
const listenersAfter = {
  uncaught: process.listenerCount('uncaughtException'),
  unhandled: process.listenerCount('unhandledRejection'),
};

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

// Built while still in stdio mode, with no realmId (allowed there: the
// interactive sign-in learns it). The last test enters hosted mode and uses it,
// to prove the hosted OAuth path never flags reconnect for a missing realm.
const earlyStore = memoryStore();
const earlyNoRealmClient = importResult.ok
  ? new importResult.mods[1].QuickbooksClient({
      clientId: 'cid',
      clientSecret: 'secret',
      refreshToken: 'early-refresh',
      environment: 'sandbox',
      redirectUri: 'http://localhost:8000/callback',
      tokenStore: earlyStore,
    })
  : undefined;


describe('qbo-context', () => {
  it('importing the client and context without QUICKBOOKS_* env does not throw', () => {
    expect(importResult.ok).toBe(true);
    expect(dotenvCallsAtImport).toBe(0);
    expect(listenersAfter).toEqual(listenersBefore);
  });

  it('the lazy quickbooksClient passes instanceof and is not thenable (neither builds the env client)', async () => {
    const { quickbooksClient, QuickbooksClient } = mods();
    expect(quickbooksClient instanceof QuickbooksClient).toBe(true);
    expect((quickbooksClient as unknown as { then?: unknown }).then).toBeUndefined();
    // Awaiting / returning it from an async function must not try to build it.
    const awaited = await Promise.resolve(quickbooksClient);
    expect(awaited).toBe(quickbooksClient);
    expect(dotenvConfig).not.toHaveBeenCalled();
  });

  it('installProcessErrorLogging registers the stdio error loggers once (idempotent)', () => {
    const { installProcessErrorLogging } = mods();
    const before = process.listenerCount('uncaughtException');
    const beforeRej = process.listenerCount('unhandledRejection');
    installProcessErrorLogging();
    installProcessErrorLogging();
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRej + 1);

    const onUncaught = process.listeners('uncaughtException').at(-1)!;
    const onRejection = process.listeners('unhandledRejection').at(-1)!;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (onUncaught as (e: Error) => void)(new Error('boom'));
      (onRejection as (r: unknown) => void)('nope');
      expect(errSpy).toHaveBeenCalledWith('[auth-server] uncaughtException:', expect.any(Error));
      expect(errSpy).toHaveBeenCalledWith('[auth-server] unhandledRejection:', 'nope');
    } finally {
      // Leave jest's own process listeners as they were.
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
    }
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
    expect(createServerMock).not.toHaveBeenCalled();
    const qb = (await runWithQboContext({ client: freshClient('hosted-realm') }, () =>
      QuickbooksClient.getInstance(),
    )) as unknown as { realmId: string };
    expect(qb.realmId).toBe('hosted-realm');
  });

  it('hosted: a rejected sandbox refresh token flags reconnect and never starts the OAuth flow', async () => {
    const { QuickbooksClient, runWithQboContext, enterHostedMode } = mods();
    const { QboReauthRequiredError } = await import('../../../src/clients/token-store');
    enterHostedMode();
    refreshDispatch.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), { error: 'invalid_grant' }),
    );
    const store = memoryStore();
    const client = new QuickbooksClient({
      clientId: 'cid',
      clientSecret: 'secret',
      refreshToken: 'dead-refresh',
      realmId: 'hosted-dead',
      environment: 'sandbox',
      redirectUri: 'http://localhost:8000/callback',
      tokenStore: store,
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runWithQboContext({ client }, () => QuickbooksClient.getInstance())).rejects.toBeInstanceOf(
      QboReauthRequiredError,
    );
    expect(store.markReauthRequired).toHaveBeenCalledWith('QuickBooks refresh token missing or rejected');
    expect(createServerMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('hosted: a context client with no stored tokens is a reconnect, not an OAuth flow', async () => {
    const { QuickbooksClient, runWithQboContext } = mods();
    const { QboReauthRequiredError } = await import('../../../src/clients/token-store');
    const store = memoryStore();
    const client = new QuickbooksClient({
      clientId: 'cid',
      clientSecret: 'secret',
      realmId: 'hosted-empty',
      environment: 'sandbox',
      redirectUri: 'http://localhost:8000/callback',
      tokenStore: store,
    });
    await expect(runWithQboContext({ client }, () => QuickbooksClient.getAuthCredentials())).rejects.toBeInstanceOf(
      QboReauthRequiredError,
    );
    expect(store.markReauthRequired).toHaveBeenCalledTimes(1);
    expect(createServerMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });
  it('hosted: a client built without realmId is a QboConfigError at construction, never a reconnect (ruling R9)', async () => {
    const { QuickbooksClient, enterHostedMode } = mods();
    const { QboConfigError } = await import('../../../src/clients/token-store');
    enterHostedMode();
    const store = memoryStore();
    let err: unknown;
    try {
      new QuickbooksClient({
        clientId: 'cid',
        clientSecret: 'secret',
        refreshToken: 'healthy-refresh',
        environment: 'production',
        redirectUri: 'https://example.test/callback',
        tokenStore: store,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QboConfigError);
    expect((err as Error).name).toBe('QboConfigError');
    expect((err as Error).message).toBe(
      'QuickBooks client is missing its company (realmId); pass realmId from the integration row.',
    );
    expect(store.markReauthRequired).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
  });

  it('hosted: a realm-less client built before hosted mode fails as QboConfigError, not reauth', async () => {
    const { QuickbooksClient, runWithQboContext, enterHostedMode } = mods();
    const { QboConfigError } = await import('../../../src/clients/token-store');
    // stdio was unchanged: building it without realmId did not throw.
    expect(earlyNoRealmClient).toBeInstanceOf(QuickbooksClient);
    enterHostedMode();
    await expect(
      runWithQboContext({ client: earlyNoRealmClient! }, () => QuickbooksClient.getInstance()),
    ).rejects.toBeInstanceOf(QboConfigError);
    expect(earlyStore.markReauthRequired).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });
});
