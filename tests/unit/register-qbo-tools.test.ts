/**
 * Behavioral tests for registerQboTools (src/register-qbo-tools.ts): which
 * tools get registered (stdio vs hosted), and the per-call wrapper — resolve
 * the caller's context, gate writes on actor.canWrite, run the unchanged
 * handler inside that context, and audit every create/update.
 *
 * The real catalog tools and handlers run. The "company" is a fake
 * QuickbooksClient whose node-quickbooks instance answers createEstimate /
 * getEstimate in memory, so QuickbooksClient.getInstance() inside the handler
 * resolves to it through the request context.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerQboTools,
  QBO_MESSAGES,
  type QboWriteAuditEvent,
  type RegisterQboToolsOptions,
} from '../../src/register-qbo-tools';
import { ALL_TOOLS, HOSTED_TOOL_ALLOWLIST } from '../../src/tools/catalog';
import { currentQboContext, QboNotConnectedError, type QboCallContext } from '../../src/context/qbo-context';
import { QboReauthRequiredError, QboTokenPersistError } from '../../src/clients/token-store';
import { knownParamKeys } from '../../src/helpers/register-tool';

type Handler = (args: unknown, extra?: unknown) => Promise<any>;

/** Minimal McpServer stand-in that records every server.tool() registration. */
function fakeServer() {
  const tools = new Map<string, { shape: Record<string, unknown>; handler: Handler }>();
  const server = {
    tool: jest.fn((name: string, _desc: string, shape: Record<string, unknown>, handler: Handler) => {
      tools.set(name, { shape, handler });
    }),
  };
  return { server: server as unknown as McpServer, tools };
}

const SECRET_ACCESS = 'secret-access-token-abc';
const SECRET_REFRESH = 'secret-refresh-token-xyz';

/** A fake company: getInstance() returns `qb` while the token is "fresh". */
function fakeClient(qb: Record<string, unknown>, authenticate?: () => Promise<unknown>) {
  return {
    accessToken: SECRET_ACCESS,
    refreshToken: SECRET_REFRESH,
    isTokenExpiredOrExpiringSoon: () => Boolean(authenticate),
    authenticate: authenticate ?? (async () => qb),
    quickbooksInstance: qb,
  } as unknown as QboCallContext['client'];
}

const owner = { tenantId: 't1', userId: 'u-owner', canWrite: true };
const crew = { tenantId: 't1', userId: 'u-crew', canWrite: false };

function hosted(ctx: QboCallContext | (() => Promise<QboCallContext>), extra: Partial<RegisterQboToolsOptions> = {}) {
  const { server, tools } = fakeServer();
  const onWrite = jest.fn<(e: QboWriteAuditEvent) => void>();
  const impl = typeof ctx === 'function' ? ctx : async () => ctx;
  const resolveContext = jest.fn<NonNullable<RegisterQboToolsOptions['resolveContext']>>((_extra) => impl());
  registerQboTools(server, { hosted: true, tools: HOSTED_TOOL_ALLOWLIST, resolveContext, onWrite, ...extra });
  return { tools, onWrite, resolveContext };
}

const text = (result: any) => result.content.map((c: any) => c.text);

afterEach(() => {
  delete process.env.QUICKBOOKS_DISABLE_DELETE;
  delete process.env.QUICKBOOKS_DISABLE_WRITE;
});

describe('registration', () => {
  it('hosted registers exactly the allowlist', () => {
    const { tools } = hosted({ client: fakeClient({}), actor: owner });
    expect([...tools.keys()].sort()).toEqual([...HOSTED_TOOL_ALLOWLIST].sort());
  });

  it('hosted defaults to the allowlist when no tools are passed', () => {
    const { server, tools } = fakeServer();
    registerQboTools(server, { hosted: true, resolveContext: async () => ({ client: fakeClient({}) }) });
    expect([...tools.keys()].sort()).toEqual([...HOSTED_TOOL_ALLOWLIST].sort());
  });

  it('hosted never registers delete tools even if the allowlist names one', () => {
    const { tools } = hosted({ client: fakeClient({}), actor: owner }, {
      tools: ['get_estimate', 'delete_estimate', 'delete_invoice'],
    });
    expect([...tools.keys()]).toEqual(['get_estimate']);
  });

  it('hosted without resolveContext is a hard error', () => {
    const { server } = fakeServer();
    expect(() => registerQboTools(server, { hosted: true })).toThrow(/resolveContext/);
  });

  it('an unknown tool name is a hard error', () => {
    const { server } = fakeServer();
    expect(() => registerQboTools(server, { tools: ['get_estimate', 'no_such_tool'] })).toThrow(/no_such_tool/);
  });

  it('stdio default registers all tools and respects QUICKBOOKS_DISABLE_DELETE', () => {
    const all = fakeServer();
    registerQboTools(all.server);
    expect([...all.tools.keys()]).toEqual(ALL_TOOLS.map((t) => t.name));

    process.env.QUICKBOOKS_DISABLE_DELETE = 'true';
    const noDelete = fakeServer();
    registerQboTools(noDelete.server);
    const names = [...noDelete.tools.keys()];
    expect(names.some((n) => n.startsWith('delete_') || n.startsWith('delete-'))).toBe(false);
    expect(names).toEqual(ALL_TOOLS.map((t) => t.name).filter((n) => !/^delete[_-]/.test(n)));
  });

  it('hosted still honours QUICKBOOKS_DISABLE_WRITE', () => {
    process.env.QUICKBOOKS_DISABLE_WRITE = 'true';
    const { tools } = hosted({ client: fakeClient({}), actor: owner });
    expect(tools.has('create_estimate')).toBe(false);
    expect(tools.has('update_estimate')).toBe(true);
  });

  it('hosted tool schemas declare no realm key', () => {
    for (const name of HOSTED_TOOL_ALLOWLIST) {
      const tool = ALL_TOOLS.find((t) => t.name === name)!;
      const keys = knownParamKeys(tool.schema) ?? new Set<string>();
      expect([...keys].filter((k) => /realm/i.test(k))).toEqual([]);
    }
  });
});

describe('per-call wrapper (hosted)', () => {
  it('each call runs inside the resolved context and passes authInfo to resolveContext', async () => {
    let seen: QboCallContext | undefined;
    const qb = {
      getEstimate: (_id: string, cb: (e: unknown, r: unknown) => void) => {
        seen = currentQboContext();
        cb(null, { Id: '7' });
      },
    };
    const ctx = { client: fakeClient(qb), actor: crew };
    const { tools, resolveContext } = hosted(ctx);
    const authInfo = { token: 'host-token', clientId: 'c', scopes: [] };
    await tools.get('get_estimate')!.handler({ params: { id: '7' } }, { authInfo });
    expect(seen).toBe(ctx);
    expect(resolveContext).toHaveBeenCalledWith({ authInfo });
  });

  it('read tool allowed when canWrite is false', async () => {
    const qb = { getEstimate: (_id: string, cb: (e: unknown, r: unknown) => void) => cb(null, { Id: '7' }) };
    const { tools, onWrite } = hosted({ client: fakeClient(qb), actor: crew });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '7' } }, {});
    expect(text(result)).toEqual(['Estimate:', JSON.stringify({ Id: '7' })]);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('write tool refused when actor.canWrite is false', async () => {
    const createEstimate = jest.fn();
    const { tools, onWrite } = hosted({ client: fakeClient({ createEstimate }), actor: crew });
    const result = await tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {});
    expect(result.content).toEqual([{ type: 'text', text: QBO_MESSAGES.writeRefused }]);
    expect(createEstimate).not.toHaveBeenCalled();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('write tool refused when the context has no actor', async () => {
    const createEstimate = jest.fn();
    const { tools } = hosted({ client: fakeClient({ createEstimate }) });
    const result = await tools.get('update_estimate')!.handler({ params: { estimate: {} } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.writeRefused]);
  });

  it('uses the exact user-facing copy', () => {
    expect(QBO_MESSAGES).toEqual({
      notConnected:
        "QuickBooks isn't connected for this company. An owner or admin can connect it in ProjectPix → Settings → Integrations.",
      reauth:
        'QuickBooks needs to be reconnected for this company. An owner or admin can reconnect it in ProjectPix → Settings → Integrations.',
      writeRefused: 'Only an owner or admin with QuickBooks access can create or change records in QuickBooks.',
      persistFailed:
        "QuickBooks couldn't save its updated sign-in for this company. Please try again; if it keeps happening, reconnect QuickBooks in ProjectPix → Settings → Integrations.",
      generic: 'Something went wrong reaching QuickBooks. Please try again.',
    });
  });

  it('resolveContext throwing QboNotConnectedError returns the not-connected text', async () => {
    const { tools } = hosted(async () => {
      throw new QboNotConnectedError();
    });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '1' } }, {});
    expect(result.content).toEqual([{ type: 'text', text: QBO_MESSAGES.notConnected }]);
  });

  it('resolveContext throwing QboReauthRequiredError returns the reauth text', async () => {
    const { tools } = hosted(async () => {
      throw new QboReauthRequiredError('refresh token dead');
    });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '1' } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.reauth]);
  });

  it('resolveContext throwing QboTokenPersistError returns the persist text', async () => {
    const { tools } = hosted(async () => {
      throw new QboTokenPersistError('db down');
    });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '1' } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.persistFailed]);
  });

  it('resolveContext throwing anything else returns the generic text with no detail', async () => {
    const { tools } = hosted(async () => {
      throw new Error(`boom ${SECRET_ACCESS}`);
    });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '1' } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.generic]);
  });

  it('a reauth needed mid-call (token refresh) returns the reauth text, not the handler error', async () => {
    const client = fakeClient({ getEstimate: jest.fn() }, async () => {
      throw new QboReauthRequiredError('rejected');
    });
    const { tools } = hosted({ client, actor: owner });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '1' } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.reauth]);
  });

  it('a persist failure mid-write returns the persist text and audits ok:false', async () => {
    const createEstimate = jest.fn();
    const client = fakeClient({ createEstimate }, async () => {
      throw new QboTokenPersistError(`could not save ${SECRET_REFRESH}`);
    });
    const { tools, onWrite } = hosted({ client, actor: owner });
    const result = await tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.persistFailed]);
    expect(createEstimate).not.toHaveBeenCalled();
    expect(onWrite).toHaveBeenCalledWith({
      tool: 'create_estimate',
      category: 'WRITE',
      entityType: 'Estimate',
      actor: owner,
      ok: false,
      error: 'QboTokenPersistError',
    });
    expect(JSON.stringify(onWrite.mock.calls)).not.toContain(SECRET_REFRESH);
  });

  it('an unexpected throw inside the call returns the generic text', async () => {
    const client = fakeClient({}, async () => {
      throw new Error(`socket hang up ${SECRET_ACCESS}`);
    });
    const { tools, onWrite } = hosted({ client, actor: owner });
    const result = await tools.get('update_customer')!.handler({ params: { customer: {} } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.generic]);
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ tool: 'update_customer', category: 'UPDATE', ok: false, error: 'Error' }));
    expect(JSON.stringify(onWrite.mock.calls)).not.toContain(SECRET_ACCESS);
  });

  it('onWrite receives tool, entityType, entityId on success', async () => {
    const createEstimate = jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { Id: '1042', SyncToken: '0', TotalAmt: 100 })
    );
    const { tools, onWrite } = hosted({ client: fakeClient({ createEstimate }), actor: owner });
    const result = await tools.get('create_estimate')!.handler({ params: { estimate: { Line: [] } } }, {});
    expect(text(result)[0]).toBe('Estimate created:');
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith({
      tool: 'create_estimate',
      category: 'WRITE',
      entityType: 'Estimate',
      entityId: '1042',
      actor: owner,
      ok: true,
    });
    const record = JSON.stringify(onWrite.mock.calls);
    expect(record).not.toContain(SECRET_ACCESS);
    expect(record).not.toContain(SECRET_REFRESH);
  });

  it('onWrite records ok:false, the error and the intuit_tid on a QuickBooks failure', async () => {
    const fault = {
      response: {
        status: 400,
        headers: { intuit_tid: 'tid-123' },
        data: { Fault: { type: 'ValidationFault', Error: [{ Message: 'Bad line', code: '2020' }] } },
      },
    };
    const updateEstimate = jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) => cb(fault, null));
    const { tools, onWrite } = hosted({ client: fakeClient({ updateEstimate }), actor: owner });
    const result = await tools.get('update_estimate')!.handler({ params: { estimate: { Id: '5' } } }, {});
    expect(text(result)[0]).toMatch(/^Error updating estimate:/);
    const event = onWrite.mock.calls[0][0];
    expect(event).toMatchObject({ tool: 'update_estimate', category: 'UPDATE', entityType: 'Estimate', ok: false, intuitTid: 'tid-123' });
    expect(event.error).toMatch(/Bad line/);
    expect(event.entityId).toBeUndefined();
    const record = JSON.stringify(onWrite.mock.calls);
    expect(record).not.toContain(SECRET_ACCESS);
    expect(record).not.toContain(SECRET_REFRESH);
  });

  it('onWrite failures never alter the tool response', async () => {
    const createEstimate = jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, { Id: '9' }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { tools } = hosted({ client: fakeClient({ createEstimate }), actor: owner }, {
      onWrite: async () => {
        throw new TypeError(`audit db down ${SECRET_ACCESS}`);
      },
    });
    const result = await tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {});
    expect(text(result)).toEqual(['Estimate created:', JSON.stringify({ Id: '9' })]);
    expect(errSpy).toHaveBeenCalledWith('[qbo-mcp] write audit hook failed: TypeError');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(SECRET_ACCESS);
  });

  it('a failure without an intuit_tid audits no intuitTid', async () => {
    const updateEstimate = jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) => cb(new Error('nope'), null));
    const { tools, onWrite } = hosted({ client: fakeClient({ updateEstimate }), actor: owner });
    await tools.get('update_estimate')!.handler({ params: { estimate: { Id: '5' } } }, {});
    expect(onWrite).toHaveBeenCalledWith({
      tool: 'update_estimate',
      category: 'UPDATE',
      entityType: 'Estimate',
      actor: owner,
      ok: false,
      error: 'Error updating estimate: Error: nope',
    });
  });

  it('a non-Error thrown by onWrite or mid-call is reported by a fixed name', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = fakeClient({}, async () => {
      throw 'raw string failure';
    });
    const onWrite = jest.fn<(e: QboWriteAuditEvent) => void>(() => {
      throw 'audit string failure';
    });
    const { tools } = hosted({ client, actor: owner }, { onWrite });
    const result = await tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {});
    expect(text(result)).toEqual([QBO_MESSAGES.generic]);
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Error' }));
    expect(errSpy).toHaveBeenCalledWith('[qbo-mcp] write audit hook failed: Error');
  });

  it('the unsupported-parameter warning still works inside the wrapper', async () => {
    const getEstimate = jest.fn((_id: string, cb: (e: unknown, r: unknown) => void) => cb(null, { Id: '7' }));
    const { tools } = hosted({ client: fakeClient({ getEstimate }), actor: crew });
    const result = await tools.get('get_estimate')!.handler({ params: { id: '7', realmId: 'other' } }, {});
    expect(text(result)[0]).toMatch(/^WARNING: get_estimate does not support this parameter: realmId/);
  });

  it('a success response with no parseable entity audits without an entityId', async () => {
    const createCustomer = jest.fn((_c: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, 'not-json-object'));
    const { tools, onWrite } = hosted({ client: fakeClient({ createCustomer }), actor: owner });
    await tools.get('create_customer')!.handler({ params: { customer: { DisplayName: 'A' } } }, {});
    expect(onWrite).toHaveBeenCalledWith({ tool: 'create_customer', category: 'WRITE', entityType: 'Customer', actor: owner, ok: true });
  });
});

describe('per-call wrapper (stdio)', () => {
  it('stdio calls run the handler with no gate and audit when onWrite is given', async () => {
    const { server, tools } = fakeServer();
    const onWrite = jest.fn<(e: QboWriteAuditEvent) => void>();
    registerQboTools(server, { tools: ['create_estimate'], onWrite });
    // Run inside a context so the handler does not reach for the env client.
    const createEstimate = jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, { Id: '3' }));
    const { runWithQboContext } = await import('../../src/context/qbo-context');
    const result = await runWithQboContext({ client: fakeClient({ createEstimate }) }, () =>
      tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {})
    );
    expect(text(result)).toEqual(['Estimate created:', JSON.stringify({ Id: '3' })]);
    expect(onWrite).toHaveBeenCalledWith({ tool: 'create_estimate', category: 'WRITE', entityType: 'Estimate', entityId: '3', ok: true });
  });

  it('stdio rethrows an unexpected handler error (pre-fork behaviour)', async () => {
    const { server, tools } = fakeServer();
    const onWrite = jest.fn<(e: QboWriteAuditEvent) => void>();
    registerQboTools(server, { tools: ['create_estimate'], onWrite });
    const { runWithQboContext } = await import('../../src/context/qbo-context');
    // The handler swallows client errors into text, so force a throw from the
    // response path: a getter that throws when the handler reads the result.
    const createEstimate = jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { get Id() { throw new RangeError('bad'); }, toJSON() { throw new RangeError('bad'); } })
    );
    await expect(
      runWithQboContext({ client: fakeClient({ createEstimate }) }, () =>
        tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {})
      )
    ).rejects.toThrow(RangeError);
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'RangeError' }));
  });

  it('stdio without onWrite returns the handler result untouched (writes and deletes)', async () => {
    const { server, tools } = fakeServer();
    registerQboTools(server, { tools: ['create_estimate', 'delete_estimate'] });
    const { runWithQboContext } = await import('../../src/context/qbo-context');
    const qb = {
      createEstimate: jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, { Id: '4' })),
      deleteEstimate: jest.fn((_e: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, { status: 'Deleted' })),
    };
    const created = await runWithQboContext({ client: fakeClient(qb) }, () =>
      tools.get('create_estimate')!.handler({ params: { estimate: {} } }, {})
    );
    expect(text(created)).toEqual(['Estimate created:', JSON.stringify({ Id: '4' })]);
    const deleted = await runWithQboContext({ client: fakeClient(qb) }, () =>
      tools.get('delete_estimate')!.handler({ params: { idOrEntity: '1' } }, {})
    );
    expect(qb.deleteEstimate).toHaveBeenCalled();
    expect(Array.isArray(deleted.content)).toBe(true);
  });
});
