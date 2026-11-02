/**
 * EnvFileTokenStore — the stdio server's TokenStore: the `.env` token store
 * file (default `<package>/.env`, or QUICKBOOKS_TOKEN_STORE_PATH).
 *
 * Fork addition (formatic-labs/qbo-mcp). This is the `.env` read/write logic
 * that used to live inside QuickbooksClient (readPersistedRefreshToken /
 * saveTokensToEnv), moved here unchanged:
 * - The refresh token is written DPAPI-encrypted when
 *   QUICKBOOKS_TOKEN_ENCRYPTION=dpapi (see helpers/token-crypto.ts).
 * - Writes are atomic (temp file + rename), except through a symlink, which is
 *   written through to its target so persistent-volume mounts keep working.
 * - Access tokens are NOT written to `.env` (they never were); the file is
 *   only rewritten when the refresh token rotates or a realm id is supplied.
 * - The lock is an in-process mutex keyed by file path. A sibling process
 *   sharing the same `.env` is not locked out; the client's retry-with-the-
 *   other-token fallback covers that case, as before.
 * - markReauthRequired is a no-op (ruling R1): the stdio server reports a dead
 *   token through the thrown QboReauthRequiredError's "run `npm run auth`" text.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { decryptSecret, encryptSecret, encryptionEnabled } from '../helpers/token-crypto.js';
import type { StoredQboTokens, TokenStore } from './token-store.js';

// Tail of each path's lock queue. Shared across instances so two stores (or
// two clients) on the same file serialize their refreshes.
const lockTails = new Map<string, Promise<void>>();

export class EnvFileTokenStore implements TokenStore {
  constructor(private readonly tokenPath: string) {}

  async read(): Promise<StoredQboTokens | undefined> {
    const refreshToken = this.readRefreshToken();
    return refreshToken ? { refreshToken } : undefined;
  }

  /**
   * Persist the refresh token, plus `realmId` when the interactive sign-in
   * (`npm run auth`) supplies it. Access tokens are not written.
   */
  async save(tokens: StoredQboTokens): Promise<void> {
    // Only rotations (or a sign-in) rewrite the file, matching the old
    // saveTokensToEnv call sites — the hourly access-token refresh doesn't.
    if (!tokens.realmId && this.readRefreshToken() === tokens.refreshToken) return;
    this.writeEnv(tokens.refreshToken, tokens.realmId);
  }

  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.tokenPath);
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    lockTails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    }
  }

  async markReauthRequired(_reason: string): Promise<void> {
    // No-op for stdio (ruling R1) — see the file header.
  }

  // Read the refresh token currently persisted in the file. Used to pick up a
  // rotation performed by a SIBLING process: a host may spawn this server more
  // than once against the same file (e.g. Claude Desktop and Claude Code), and
  // Intuit invalidates the previous refresh token on every rotation.
  private readRefreshToken(): string | undefined {
    try {
      // Parse with dotenv itself so the value is normalized identically to how
      // the token was loaded at startup — surrounding quotes stripped, inline
      // comments removed, optional `export ` prefix handled.
      const parsed = dotenv.parse(fs.readFileSync(this.tokenPath));
      const value = decryptSecret(parsed.QUICKBOOKS_REFRESH_TOKEN?.trim());
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private writeEnv(refreshToken: string, realmId?: string): void {
    const tokenPath = this.tokenPath;
    const envContent = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8') : '';
    const envLines = envContent.split('\n');

    const updateEnvVar = (name: string, value: string) => {
      const index = envLines.findIndex((line) => line.startsWith(`${name}=`));
      if (index !== -1) {
        envLines[index] = `${name}=${value}`;
      } else {
        envLines.push(`${name}=${value}`);
      }
    };

    // Fork: write the rotated refresh token encrypted when the operator opted in.
    updateEnvVar('QUICKBOOKS_REFRESH_TOKEN', encryptionEnabled() ? encryptSecret(refreshToken) : refreshToken);
    if (realmId) updateEnvVar('QUICKBOOKS_REALM_ID', realmId);

    const newContent = envLines.join('\n');

    if (this.isSymbolicLink(tokenPath)) {
      // Write directly through the symlink to the real target. Using
      // rename on a symlink replaces the link itself rather than writing
      // through it, which breaks persistent-volume mounts in containers.
      // If the symlink target doesn't exist yet (fresh PVC mount), resolve
      // the link target without requiring it to exist, then write directly.
      let realPath: string;
      try {
        realPath = fs.realpathSync(tokenPath);
      } catch (e: any) {
        if (e?.code === 'ENOENT') {
          // Dangling symlink: target doesn't exist yet. readlinkSync returns the
          // link target as stored, which may be RELATIVE — and a relative path is
          // resolved against the process cwd, not the link's own directory. Resolve
          // it against the symlink's directory so we write to the intended location.
          const linkTarget = fs.readlinkSync(tokenPath);
          realPath = path.isAbsolute(linkTarget)
            ? linkTarget
            : path.resolve(path.dirname(tokenPath), linkTarget);
        } else {
          throw e;
        }
      }
      // Deliberate: no temp-file+rename here. Renaming over a symlink replaces the
      // link itself, so we write through to the target directly. This trades
      // atomicity for correct persistent-volume behavior — a crash mid-write
      // could leave the target .env partially written.
      fs.writeFileSync(realPath, newContent, { mode: 0o600 });
    } else {
      // Atomic write: write to a sibling temp file, then rename. On POSIX
      // rename is atomic within the same filesystem, so a crash mid-write
      // cannot leave .env half-written or empty.
      const tmpPath = `${tokenPath}.tmp.${process.pid}`;
      try {
        fs.writeFileSync(tmpPath, newContent, { mode: 0o600 });
        fs.renameSync(tmpPath, tokenPath);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
        throw err;
      }
    }
  }

  private isSymbolicLink(filePath: string): boolean {
    try {
      return fs.lstatSync(filePath).isSymbolicLink();
    } catch {
      return false;
    }
  }
}
