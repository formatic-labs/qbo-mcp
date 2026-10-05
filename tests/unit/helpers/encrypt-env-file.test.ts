/** Fork tests: in-place .env encryption used by `npm run encrypt-env`. */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.unstable_mockModule('../../../src/helpers/token-crypto', () => ({
  isEncrypted: (v: string) => v.startsWith('dpapi:'),
  encryptSecret: (v: string) => `dpapi:<${v}>`,
}));

const { encryptEnvContent, encryptEnvFile } = await import('../../../src/helpers/encrypt-env-file');

describe('encryptEnvContent', () => {
  it('encrypts only the secret keys, skips empty/encrypted ones, and adds the flag', () => {
    const input = [
      '# comment',
      'QUICKBOOKS_CLIENT_ID=abc',
      'QUICKBOOKS_CLIENT_SECRET=s3cret',
      'QUICKBOOKS_REFRESH_TOKEN=dpapi:already',
      'QUICKBOOKS_REALM_ID=',
      '',
    ].join('\n');
    const { content, encrypted } = encryptEnvContent(input);
    expect(encrypted).toEqual(['QUICKBOOKS_CLIENT_SECRET']);
    expect(content).toContain('QUICKBOOKS_CLIENT_SECRET=dpapi:<s3cret>');
    expect(content).toContain('QUICKBOOKS_CLIENT_ID=abc');
    expect(content).toContain('QUICKBOOKS_REFRESH_TOKEN=dpapi:already');
    expect(content.trim().endsWith('QUICKBOOKS_TOKEN_ENCRYPTION=dpapi')).toBe(true);
  });

  it('rewrites an existing encryption flag instead of duplicating it', () => {
    const { content } = encryptEnvContent('QUICKBOOKS_TOKEN_ENCRYPTION=off\nQUICKBOOKS_CLIENT_SECRET=');
    expect(content.match(/QUICKBOOKS_TOKEN_ENCRYPTION=/g)).toHaveLength(1);
    expect(content).toContain('QUICKBOOKS_TOKEN_ENCRYPTION=dpapi');
  });
});

describe('encryptEnvFile', () => {
  it('rewrites the file in place and reports what it encrypted', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-env-')), '.env');
    fs.writeFileSync(file, 'QUICKBOOKS_REFRESH_TOKEN=rt\n');
    expect(encryptEnvFile(file)).toEqual(['QUICKBOOKS_REFRESH_TOKEN']);
    expect(fs.readFileSync(file, 'utf-8')).toContain('QUICKBOOKS_REFRESH_TOKEN=dpapi:<rt>');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['.env']); // no temp file left behind
  });
});
