/**
 * handleQboMcpRequest (src/hosted/handle-request.ts): the web-standard entry a
 * Next.js route calls after authenticating. Drives real JSON-RPC over
 * Request/Response, with a fake resolveContext + fake QuickBooks client.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { handleQboMcpRequest } from '../../../src/hosted/handle-request';
import { HOSTED_TOOL_ALLOWLIST } from '../../../src/tools/catalog';
import { isHostedMode } from '../../../src/context/qbo-context';
import type { QboCallContext } from '../../../src/context/qbo-context';

const authInfo: AuthInfo = { token: 'tok', clientId: 'c1', scopes: [], extra: { tenant: 't1' } };

const rpc = (body: unknown) =>
  new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

function fakeContext(createEstimate = jest.fn((_p: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, { Id: '77' }))) {
  const qb = { createEstimate };
  const client = {
    accessToken: 'a',
    refreshToken: 'r',
    isTokenExpiredOrExpiringSoon: () => false,
    authenticate: async () => qb,
    quickbooksInstance: qb,
  } as unknown as QboCallContext['client'];
  return { ctx: { client, actor: { tenantId: 't1', userId: 'u', canWrite: true } } as QboCallContext, createEstimate };
}

describe('handleQboMcpRequest', () => {
  it('initialize then tools/list returns the allowlist', async () => {
    const { ctx } = fakeContext();
    const resolveContext = jest.fn(async () => ctx);
    const init = await handleQboMcpRequest(rpc(initBody), authInfo, { resolveContext });
    expect(init.status).toBe(200);
    expect(isHostedMode()).toBe(true);

    const list = await handleQboMcpRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), authInfo, {
      resolveContext,
    });
    const body: any = await list.json();
    const names = body.result.tools.map((t: any) => t.name).sort();
    // Deletes are never hosted, so the allowlist (which has none) is what is listed.
    expect(names).toEqual([...HOSTED_TOOL_ALLOWLIST].sort());
  });

  it('honours an explicit tools list', async () => {
    const { ctx } = fakeContext();
    const res = await handleQboMcpRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), authInfo, {
      resolveContext: async () => ctx,
      tools: ['get_company_info'],
    });
    const body: any = await res.json();
    expect(body.result.tools.map((t: any) => t.name)).toEqual(['get_company_info']);
  });

  it('tools/call create_estimate reaches the context client and passes authInfo to resolveContext', async () => {
    const { ctx, createEstimate } = fakeContext();
    const resolveContext = jest.fn(async (_extra: { authInfo?: AuthInfo }) => ctx);
    const res = await handleQboMcpRequest(
      rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_estimate',
          arguments: { params: { estimate: { CustomerRef: { value: '1' }, Line: [] } } },
        },
      }),
      authInfo,
      { resolveContext },
    );
    expect(res.status).toBe(200);
    expect(createEstimate).toHaveBeenCalledTimes(1);
    expect(resolveContext.mock.calls[0][0].authInfo).toEqual(authInfo);
  });

  it('is stateless: no session id header is issued', async () => {
    const { ctx } = fakeContext();
    const res = await handleQboMcpRequest(rpc(initBody), authInfo, { resolveContext: async () => ctx });
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });
});

describe('package entry', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const libJs = path.join(root, 'dist', 'lib.js');

  it('importing @formatic-labs/qbo-mcp (dist/lib.js) has no side effects', () => {
    expect(existsSync(libJs)).toBe(true); // run `npm run build` first
    // Fresh process: record stdio/process listeners, env reads and dotenv before/after import.
    const script = `
      const before = { stdin: process.stdin.listenerCount('data'), unc: process.listenerCount('uncaughtException'),
        unh: process.listenerCount('unhandledRejection'), env: Object.keys(process.env).sort().join('|') };
      const lib = await import(${JSON.stringify(pathToFileURL(libJs).href)});
      const after = { stdin: process.stdin.listenerCount('data'), unc: process.listenerCount('uncaughtException'),
        unh: process.listenerCount('unhandledRejection'), env: Object.keys(process.env).sort().join('|') };
      const names = Object.keys(lib).sort();
      console.log(JSON.stringify({ same: JSON.stringify(before) === JSON.stringify(after), names }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.trim());
    expect(parsed.same).toBe(true);
    expect(parsed.names).toEqual(
      expect.arrayContaining([
        'handleQboMcpRequest', 'registerQboTools', 'HOSTED_TOOL_ALLOWLIST', 'ALL_TOOLS', 'QuickbooksClient',
        'EnvFileTokenStore', 'runWithQboContext', 'QboNotConnectedError', 'QboReauthRequiredError',
        'QboTokenPersistError', 'QBO_MESSAGES', 'enterHostedMode', 'isHostedMode',
      ]),
    );
  });
});
