/**
 * Fork tests: DPAPI at-rest encryption helper (src/helpers/token-crypto.ts).
 * child_process is mocked — the real PowerShell/DPAPI round trip is verified
 * manually on Windows (see CHANGELOG), not in CI.
 */
import { jest } from '@jest/globals';

const execFileSync = jest.fn<(...args: any[]) => string>();
jest.unstable_mockModule('child_process', () => ({ execFileSync }));

const { DPAPI_PREFIX, isEncrypted, decryptSecret, encryptSecret, encryptionEnabled } = await import(
  '../../../src/helpers/token-crypto'
);

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });

afterEach(() => {
  setPlatform(realPlatform);
  delete process.env.QUICKBOOKS_TOKEN_ENCRYPTION;
});

describe('isEncrypted', () => {
  it('detects the dpapi prefix only on strings', () => {
    expect(isEncrypted('dpapi:abc')).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});

describe('decryptSecret', () => {
  it('passes plaintext and undefined through untouched', () => {
    expect(decryptSecret('plain-token')).toBe('plain-token');
    expect(decryptSecret(undefined)).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('unprotects a dpapi value via PowerShell, sending the blob on stdin', () => {
    setPlatform('win32');
    execFileSync.mockReturnValue('secret-value');
    expect(decryptSecret(`${DPAPI_PREFIX}QkxPQg==`)).toBe('secret-value');
    const [cmd, args, opts] = execFileSync.mock.calls[0];
    expect(cmd).toBe('powershell.exe');
    expect(args.join(' ')).toContain('Unprotect');
    expect(args.join(' ')).not.toContain('QkxPQg=='); // secret never on the command line
    expect(opts.input).toBe('QkxPQg==');
  });

  it('wraps DPAPI failures with guidance', () => {
    setPlatform('win32');
    execFileSync.mockImplementation(() => {
      throw new Error('The parameter is incorrect.');
    });
    expect(() => decryptSecret('dpapi:AAAA')).toThrow(/Windows user and machine that encrypted it.*parameter is incorrect/s);
  });

  it('reports non-Error throwables too', () => {
    setPlatform('win32');
    execFileSync.mockImplementation(() => {
      throw 'boom';
    });
    expect(() => decryptSecret('dpapi:AAAA')).toThrow(/\(boom\)/);
  });

  it('refuses on non-Windows hosts', () => {
    setPlatform('linux');
    expect(() => decryptSecret('dpapi:AAAA')).toThrow(/only available on Windows/);
  });
});

describe('encryptSecret', () => {
  it('protects plaintext and prefixes the base64 blob', () => {
    setPlatform('win32');
    execFileSync.mockReturnValue('QkxPQg==\r\n');
    expect(encryptSecret('my-secret')).toBe('dpapi:QkxPQg==');
    const [, args, opts] = execFileSync.mock.calls[0];
    expect(args.join(' ')).toContain('::Protect');
    expect(opts.input).toBe('my-secret');
  });

  it('leaves already-encrypted values alone', () => {
    expect(encryptSecret('dpapi:XYZ')).toBe('dpapi:XYZ');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('refuses on non-Windows hosts instead of storing plaintext', () => {
    setPlatform('darwin');
    expect(() => encryptSecret('x')).toThrow(/only available on Windows/);
  });
});

describe('encryptionEnabled', () => {
  it('is on only for QUICKBOOKS_TOKEN_ENCRYPTION=dpapi (case/space-insensitive)', () => {
    expect(encryptionEnabled()).toBe(false);
    process.env.QUICKBOOKS_TOKEN_ENCRYPTION = ' DPAPI ';
    expect(encryptionEnabled()).toBe(true);
    process.env.QUICKBOOKS_TOKEN_ENCRYPTION = 'aes';
    expect(encryptionEnabled()).toBe(false);
  });
});
