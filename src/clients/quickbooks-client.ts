import dotenv from "dotenv";
import QuickBooks from "node-quickbooks";
import OAuthClient from "intuit-oauth";
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { decryptSecret } from '../helpers/token-crypto.js';
import { EnvFileTokenStore } from './env-file-token-store.js';
import { QboReauthRequiredError, QboTokenPersistError, type TokenStore } from './token-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where the server reads .env at startup and persists rotated refresh tokens.
// Defaults to the installed module's ../../.env (dist/clients/ -> package root)
// so a host-spawned server with an unrelated cwd still finds it. Override with
// QUICKBOOKS_TOKEN_STORE_PATH (an absolute path) to point at a WRITABLE location.
// This is required whenever the module itself lives on a read-only filesystem —
// containers with a read-only root, Nix/immutable installs (see #63, where the
// default path can't be written) — and lets a per-tenant host keep each
// connection's rotated token in its own isolated path.
//
// NOTE: this value is resolved BEFORE dotenv loads the file below, so the
// override only takes effect when set in the host process env (e.g. the MCP
// server config's env block) — setting it inside .env has no effect. It must
// be absolute: a relative path would resolve against the host app's working
// directory, which is unpredictable (the exact failure the module-relative
// default exists to avoid).
const tokenStorePathOverride = process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim();
if (tokenStorePathOverride && !path.isAbsolute(tokenStorePathOverride)) {
  throw Error(
    `QUICKBOOKS_TOKEN_STORE_PATH must be an absolute path, got "${tokenStorePathOverride}"`
  );
}
const TOKEN_STORE_PATH =
  tokenStorePathOverride || path.join(__dirname, '..', '..', '.env');

// Use override: true so that values from the token store always win over any
// empty-string placeholders a host app (e.g. Claude Desktop) may inject via
// its env config. This prevents the server from starting with blank
// REFRESH_TOKEN / REALM_ID even when the host config has those keys set to "".
dotenv.config({ path: TOKEN_STORE_PATH, override: true });

// Register once at module level — registering inside startOAuthFlow() would
// accumulate duplicate handlers on every OAuth call.
process.on('uncaughtException', (err) => {
  console.error('[auth-server] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[auth-server] unhandledRejection:', reason);
});

const client_id = process.env.QUICKBOOKS_CLIENT_ID;
// Fork: secrets may be stored DPAPI-encrypted (`dpapi:` prefix) — see token-crypto.ts.
const client_secret = decryptSecret(process.env.QUICKBOOKS_CLIENT_SECRET);
const refresh_token = decryptSecret(process.env.QUICKBOOKS_REFRESH_TOKEN);
const realm_id = process.env.QUICKBOOKS_REALM_ID;
const environment = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox';
// Fix for Issue #5: Use env var with underscore (QUICKBOOKS_REDIRECT_URI)
const redirect_uri = process.env.QUICKBOOKS_REDIRECT_URI || 'http://localhost:8000/callback';

// Only throw error if client_id or client_secret is missing
if (!client_id || !client_secret || !redirect_uri) {
  throw Error("Client ID, Client Secret and Redirect URI must be set in environment variables");
}

// ── QuickbooksClient ─────────────────────────────────────────────────────────
// Exported so handlers can call QuickbooksClient.getInstance() directly,
// which checks token freshness on every invocation rather than only at startup.

export class QuickbooksClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken?: string;
  private realmId?: string;
  private readonly environment: string;
  private accessToken?: string;
  private accessTokenExpiry?: Date;
  private quickbooksInstance?: QuickBooks;
  private oauthClient: OAuthClient;
  private isAuthenticating: boolean = false;
  private redirectUri: string;

  // Fork: when false, a dead refresh token produces an actionable error instead
  // of starting the interactive browser flow. The MCP stdio server sets this to
  // false — the flow prints to stdout, which corrupts the MCP protocol stream
  // and kills the connection. `npm run auth` (auth-server.ts) leaves it true.
  static interactiveAuthAllowed = true;

  // Refresh 5 minutes before actual expiry to avoid edge cases
  private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  // Shared in-flight refresh promise so that concurrent callers all await the
  // same network request rather than racing to use (and rotate) the refresh
  // token simultaneously.
  private refreshInFlight?: Promise<{ access_token: string; expires_in: number }>;

  // Shared in-flight authenticate promise. Guards the cold-start path so two
  // concurrent first callers cannot both pass the freshness check and both
  // invoke startOAuthFlow() / rebuild the QuickBooks instance.
  private authInFlight?: Promise<QuickBooks>;

  // Fork: where tokens are persisted and how refreshes are serialized. The
  // stdio default is the .env token store; the hosted connector passes a
  // Supabase-backed store whose lock spans serverless instances.
  private readonly tokenStore: TokenStore;

  // Fork (ruling R3): when true, a rotated refresh token that cannot be saved
  // after SAVE_ATTEMPTS tries fails the refresh with QboTokenPersistError
  // (hosted: the store is the only durable copy). False (stdio default) keeps
  // the log-only behaviour; the in-memory token still serves this process.
  private readonly strictPersistence: boolean;
  private static readonly SAVE_ATTEMPTS = 3;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
    realmId?: string;
    environment: string;
    redirectUri: string;
    /** Defaults to an EnvFileTokenStore at the token-store path (.env / QUICKBOOKS_TOKEN_STORE_PATH). */
    tokenStore?: TokenStore;
    /** Seed with a stored access token so a fresh one is used without a refresh. */
    accessToken?: string;
    accessTokenExpiresAt?: Date;
    /** Throw QboTokenPersistError when a rotated refresh token can't be saved (hosted). Default false. */
    strictPersistence?: boolean;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.realmId = config.realmId;
    this.environment = config.environment;
    this.redirectUri = config.redirectUri;
    this.tokenStore = config.tokenStore ?? new EnvFileTokenStore(TOKEN_STORE_PATH);
    this.accessToken = config.accessToken;
    this.accessTokenExpiry = config.accessTokenExpiresAt;
    this.strictPersistence = config.strictPersistence ?? false;
    this.oauthClient = new OAuthClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: this.redirectUri,
    });
  }

  private isTokenExpiredOrExpiringSoon(): boolean {
    return !QuickbooksClient.isFresh(this.accessToken, this.accessTokenExpiry);
  }

  private static isFresh(accessToken?: string, expiresAt?: Date): boolean {
    if (!accessToken || !expiresAt) return false;
    return expiresAt > new Date(Date.now() + QuickbooksClient.TOKEN_REFRESH_BUFFER_MS);
  }

  // Distinguish a genuinely dead refresh token (revoked, expired, or rotated
  // out — Intuit answers HTTP 400 invalid_grant, or 401) from a transient
  // failure (5xx, 429, network timeout). Only the former warrants telling the
  // operator to re-authorize; a transient failure must stay retryable so it
  // self-heals. Conservative: anything not clearly an auth-invalidation is
  // treated as transient, so an outage never produces a false "re-authorize"
  // alarm.
  //
  // NOTE on shape: intuit-oauth 4.x does NOT surface invalid_grant in a tidy
  // field. Verified empirically against v4.2.1 — on a rejected refresh token
  // the error's message/error is the axios string "Request failed with status
  // code 400", error_description is "", authResponse.response is "" and
  // authResponse.status is a function returning undefined. So the reliably
  // available signal is the HTTP status embedded in that message; we also check
  // any structured fields in case a future version populates them.
  private isAuthInvalidation(error: unknown): boolean {
    // Walk the error's cause chain (bounded) so a wrapped error still classifies
    // correctly regardless of how many layers deep the real signal sits — our
    // own wrapper adds one level, and some axios versions attach a `cause`.
    let cur: unknown = error;
    for (let depth = 0; depth < 4 && cur != null; depth++) {
      if (this.classifyOneError(cur)) return true;
      cur = (cur as { cause?: unknown }).cause;
    }
    return false;
  }

  // Classify a SINGLE error object (no cause traversal — the caller walks the
  // chain). Returns true only for a genuine auth-invalidation.
  private classifyOneError(raw: unknown): boolean {
    const asObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;

    // Explicit OAuth error fields, when populated.
    const errField = String(asObj?.error ?? "").toLowerCase();
    const errDesc = String(asObj?.error_description ?? "").toLowerCase();
    if (errField.includes("invalid_grant") || errDesc.includes("invalid_grant")) return true;

    // Numeric HTTP status from whichever field carries it (incl. intuit-oauth's
    // authResponse.status() accessor).
    let status: number | undefined;
    const ar = asObj?.authResponse as { status?: unknown; response?: { status?: unknown } } | undefined;
    if (ar) {
      if (typeof ar.status === "function") {
        try {
          const s = Number((ar.status as () => unknown)());
          if (!Number.isNaN(s)) status = s;
        } catch {
          /* accessor threw — fall through to message parsing */
        }
      } else if (typeof ar.status === "number") {
        status = ar.status;
      }
      if (status === undefined && ar.response && typeof ar.response.status === "number") {
        status = ar.response.status;
      }
    }
    if (status === undefined && typeof asObj?.status === "number") status = asObj.status as number;

    // Fallback: parse the axios-style message ("Request failed with status code
    // NNN") — the only signal intuit-oauth 4.x reliably exposes on invalid_grant
    // (its response body is discarded). The \b prevents a 4-digit number from
    // matching its 3-digit prefix.
    const message = (raw instanceof Error ? raw.message : String(raw ?? "")).toLowerCase();
    if (message.includes("invalid_grant")) return true;
    if (status === undefined) {
      const m = message.match(/status code (\d{3})\b/);
      if (m) status = Number(m[1]);
    }

    return status === 400 || status === 401;
  }

  // Single refresh network call. Returns the widened token object — the
  // intuit-oauth type declarations omit refresh_token, x_refresh_token_expires_in,
  // token_type, realmId, etc.
  private async performRefresh(refreshToken: string): Promise<{
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    x_refresh_token_expires_in?: number;
  }> {
    const authResponse = await this.oauthClient.refreshUsingToken(refreshToken);
    return authResponse.token as unknown as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      x_refresh_token_expires_in?: number;
    };
  }

  // The actionable error surfaced when a production server's refresh token is
  // dead. The interactive localhost flow cannot recover it — Intuit rejects the
  // localhost redirect for production apps, and no human is present to complete
  // a browser login in a host-spawned stdio subprocess — so we fail with
  // instructions instead of opening a browser window that can never succeed.
  private reauthError(cause?: string): QboReauthRequiredError {
    const msg =
      'QuickBooks authorization is invalid or expired and cannot be renewed automatically in ' +
      'production. Re-authorize this company using a public HTTPS redirect (see the "Production ' +
      'Setup" section of the README), then restart the server. Note: an HTTP 401 from the token ' +
      'endpoint usually means invalid_client — verify QUICKBOOKS_CLIENT_ID and ' +
      'QUICKBOOKS_CLIENT_SECRET before re-authorizing.';
    return new QboReauthRequiredError(cause ? `${msg} (cause: ${cause})` : msg);
  }

  // Fork: tell the token store the company must reconnect (the hosted store
  // flags it for the UI; the .env store does nothing), then hand back the error
  // to throw. A failure to record the flag must never mask the reauth error.
  private async reauthRequired(err: QboReauthRequiredError, reason: string): Promise<QboReauthRequiredError> {
    try {
      await this.tokenStore.markReauthRequired(reason);
    } catch {
      console.error('[qbo-client] Failed to record that QuickBooks must be reconnected');
    }
    return err;
  }

  private async startOAuthFlow(): Promise<void> {
    // The interactive flow below binds a localhost callback server, but Intuit
    // rejects localhost redirect URIs for production apps — so this can only
    // ever succeed in sandbox. Fail fast with guidance rather than opening a
    // doomed browser window on a production server.
    // Fork: QUICKBOOKS_AUTH_REDIRECT_URI is a public HTTPS URL (Cloudflare /
    // ngrok / Tailscale Funnel) that tunnels to this machine's port 8000. When
    // set, the interactive flow authorizes and exchanges with it — which is
    // what makes a production sign-in possible from `npm run auth`.
    const publicRedirect = process.env.QUICKBOOKS_AUTH_REDIRECT_URI?.trim();
    if (publicRedirect && !publicRedirect.startsWith('https://')) {
      throw new Error(`QUICKBOOKS_AUTH_REDIRECT_URI must be an https:// URL, got "${publicRedirect}"`);
    }

    if (this.environment === 'production' && !publicRedirect) {
      throw await this.reauthRequired(this.reauthError(), 'QuickBooks refresh token missing or rejected');
    }

    if (!QuickbooksClient.interactiveAuthAllowed) {
      throw await this.reauthRequired(
        new QboReauthRequiredError(
          'QuickBooks is not connected (the authorization was disconnected, revoked, or expired). ' +
            'Reconnect by running `npm run auth` in the qbo-mcp folder, then retry the request.'
        ),
        'QuickBooks refresh token missing or rejected'
      );
    }

    if (this.isAuthenticating) {
      return;
    }

    this.isAuthenticating = true;
    const port = 8000;

    // The local server below receives the callback, so the authorize/exchange
    // pair must use the localhost redirect even when QUICKBOOKS_REDIRECT_URI
    // points elsewhere (e.g. the OAuth playground used for manual token
    // generation). Intuit rejects the exchange if the redirect_uri does not
    // match the one used in the authorize request.
    const flowClient = new OAuthClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: publicRedirect || `http://localhost:${port}/callback`,
    });

    return new Promise((resolve, reject) => {
      // Guard against duplicate /callback requests for the same authorization
      // code. Browsers resolve `localhost` to both 127.0.0.1 and ::1, and the
      // server binds dual-stack (`::`), so the redirect frequently lands twice.
      // Exchanging a one-time auth code a second time trips Intuit's replay
      // protection, which REVOKES the tokens issued by the first exchange
      // (RFC 6749 §4.1.2). Only the first callback may exchange the code.
      let codeExchangeStarted = false;

      // Random per-run value, not guessable from the public repo. Bound to this
      // authorize request and checked against every callback before we exchange
      // anything, so a stranger who gets their own valid code for this client_id
      // (client IDs aren't secret) can't hijack the callback and have their
      // tokens written into our .env instead of ours.
      const expectedState = crypto.randomBytes(24).toString('hex');

      // Create temporary server for OAuth callback
      const server = http.createServer(async (req, res) => {
        console.log(`[auth-server] ${req.method} ${req.url}`);

        // Respond to anything that isn't /callback so diagnostic probes (curl,
        // ngrok health checks, favicon requests, etc.) don't hang the server.
        if (!req.url?.startsWith('/callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found. Waiting for QuickBooks OAuth callback at /callback');
          return;
        }

        // Reject any callback whose state doesn't match this run's authorize
        // request, before touching codeExchangeStarted, so a spoofed/scanner
        // hit can't consume the one-shot exchange lock and lock out the real
        // callback that follows it.
        const incomingState = new URL(req.url, `http://localhost:${port}`).searchParams.get('state');
        if (incomingState !== expectedState) {
          console.log(`[auth-server] Rejected callback with mismatched state (got: ${incomingState ?? 'none'})`);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid or missing state parameter.');
          return;
        }

        // A duplicate callback for the same code must NOT be exchanged again, or
        // Intuit revokes the token minted by the first hit. `codeExchangeStarted`
        // is set synchronously before the first `await`, so the second request's
        // handler observes it and bails out here.
        if (codeExchangeStarted) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:Arial;text-align:center;margin-top:20vh"><h2>Processing… you can close this window.</h2></body></html>');
          return;
        }
        codeExchangeStarted = true;

        {
          try {
            const response = await flowClient.createToken(req.url);
            const tokens = response.token;

            // Save tokens (the .env store also records the realm id).
            this.refreshToken = tokens.refresh_token;
            this.realmId = tokens.realmId;
            await this.tokenStore.save({ refreshToken: tokens.refresh_token, realmId: tokens.realmId });

            // Send success response
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="
                  display: flex;
                  flex-direction: column;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  font-family: Arial, sans-serif;
                  background-color: #f5f5f5;
                ">
                  <h2 style="color: #2E8B57;">✓ Successfully connected to QuickBooks!</h2>
                  <p>You can close this window now.</p>
                </body>
              </html>
            `);

            // Close server after a short delay
            setTimeout(() => {
              server.close();
              this.isAuthenticating = false;
              resolve();
            }, 1000);
          } catch (error) {
            console.error('Error during token creation:', error);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="
                  display: flex;
                  flex-direction: column;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  font-family: Arial, sans-serif;
                  background-color: #fff0f0;
                ">
                  <h2 style="color: #d32f2f;">Error connecting to QuickBooks</h2>
                  <p>Please check the console for more details.</p>
                </body>
              </html>
            `);
            this.isAuthenticating = false;
            reject(error);
          }
        }
      });

      // Start server — bind to all interfaces (IPv4 + IPv6) so ngrok can reach it
      // regardless of whether it resolves `localhost` to 127.0.0.1 or ::1
      server.listen(port, '::', async () => {
        const addr = server.address();
        console.log(`[auth-server] Listening on ${typeof addr === 'string' ? addr : `${addr?.address}:${addr?.port}`} (family: ${typeof addr === 'object' ? addr?.family : 'n/a'})`);

        // Generate authorization URL with proper type assertion
        const authUri = flowClient.authorizeUri({
          scope: [OAuthClient.scopes.Accounting as string],
          state: expectedState
        }).toString();

        console.log('\n=== QuickBooks Authorization ===');
        console.log('Open this URL in a browser to authorize:\n');
        console.log(authUri);
        console.log('\nWaiting for callback...\n');

        // Attempt to open the browser automatically; ignore failures on headless systems
        try {
          await open(authUri);
        } catch {
          // Headless environment — user will open the URL manually
        }
      });

      // Handle server errors
      server.on('error', (error) => {
        console.error('Server error:', error);
        this.isAuthenticating = false;
        reject(error);
      });
    });
  }

  // Runs while holding the store's refresh lock. Re-reads the store first:
  // whoever held the lock before us may already have refreshed.
  private async refreshUnderLock(): Promise<{ access_token: string; expires_in: number }> {
    const latest = await this.tokenStore.read();

    // A sibling already refreshed and saved a still-fresh access token: use it.
    if (latest && QuickbooksClient.isFresh(latest.accessToken, latest.accessTokenExpiresAt)) {
      this.refreshToken = latest.refreshToken;
      this.accessToken = latest.accessToken;
      this.accessTokenExpiry = latest.accessTokenExpiresAt;
      return {
        access_token: latest.accessToken!,
        expires_in: Math.floor((latest.accessTokenExpiresAt!.getTime() - Date.now()) / 1000),
      };
    }

    // Multi-process rotation-race fix. Try the store's (newest persisted)
    // refresh token first; if it is REJECTED and our in-memory token differs,
    // retry once with the in-memory one — so a valid in-memory token (e.g. one
    // this process rotated but could not persist) is never discarded, and a
    // sibling's rotation never produces a spurious "token dead". The in-memory
    // token is only replaced after a refresh succeeds.
    const candidates = [latest?.refreshToken, this.refreshToken].filter(
      (t, i, all): t is string => !!t && all.indexOf(t) === i
    );
    let used = candidates[0];
    let token;
    try {
      token = await this.performRefresh(used);
    } catch (firstErr) {
      // A transient error (5xx/429/network) says nothing about token validity:
      // rethrow so the caller retries with both tokens intact.
      if (!this.isAuthInvalidation(firstErr) || candidates.length < 2) {
        throw firstErr;
      }
      used = candidates[1];
      token = await this.performRefresh(used);
    }

    this.accessToken = token.access_token;
    const expiresIn = token.expires_in || 3600;
    this.accessTokenExpiry = new Date(Date.now() + expiresIn * 1000);

    // Intuit rotates the refresh token (typically every ~24h). The newest MUST
    // be persisted — the old one stops working. The access token is saved too
    // so other instances can reuse it instead of refreshing again.
    const rotated = !!token.refresh_token && token.refresh_token !== used;
    this.refreshToken = token.refresh_token || used;
    // A rotated token is the only copy once the old one is spent, so retry its
    // save (still inside the lock) before giving up (ruling R3).
    const attempts = rotated ? QuickbooksClient.SAVE_ATTEMPTS : 1;
    let persistErr: unknown;
    let saved = false;
    for (let attempt = 1; attempt <= attempts && !saved; attempt++) {
      try {
        await this.tokenStore.save({
          refreshToken: this.refreshToken,
          accessToken: this.accessToken,
          accessTokenExpiresAt: this.accessTokenExpiry,
        });
        saved = true;
      } catch (err) {
        persistErr = err;
      }
    }
    if (saved) {
      if (rotated) console.error('[qbo-client] Refresh token rotated and persisted to the token store');
    } else {
      if (rotated && this.strictPersistence) {
        throw new QboTokenPersistError(
          `Could not save the rotated QuickBooks refresh token after ${attempts} attempts; ` +
            'this company may need to reconnect QuickBooks.'
        );
      }
      // Log-only (stdio default): the in-memory token is still valid for this
      // process. Fixed text plus the error's name only: never its message
      // (a store could put anything there) and never token values.
      const errName = persistErr instanceof Error ? persistErr.name : typeof persistErr;
      console.error(`[qbo-client] Failed to persist refreshed QuickBooks tokens (${errName})`);
    }

    // Surface the refresh token's own remaining lifetime for observability.
    // Intuit's refresh tokens last 100 days; warn when under 14 days.
    const refreshExpiresIn = token.x_refresh_token_expires_in;
    if (typeof refreshExpiresIn === 'number' && refreshExpiresIn < 14 * 24 * 3600) {
      const days = Math.round(refreshExpiresIn / 86400);
      const renewHint = this.environment === 'production'
        ? 'Re-authorize before it expires (see README "Production Setup").'
        : 'Re-run `npm run auth` before it expires.';
      console.error(`[qbo-client] WARNING: refresh token expires in ~${days} day(s). ${renewHint}`);
    }

    return {
      access_token: this.accessToken,
      expires_in: expiresIn,
    };
  }

  // Fork: a client built with only a tokenStore (the hosted connector) starts
  // with no in-memory refresh token. Load it (and a stored access token, if
  // any) before treating the company as unauthenticated, so a valid stored
  // token is never mistaken for "reconnect required".
  private async seedFromStore(): Promise<void> {
    if (this.refreshToken) return;
    const stored = await this.tokenStore.read();
    if (!stored) return;
    this.refreshToken = stored.refreshToken;
    if (stored.accessToken && stored.accessTokenExpiresAt) {
      this.accessToken = stored.accessToken;
      this.accessTokenExpiry = stored.accessTokenExpiresAt;
    }
  }

  async refreshAccessToken() {
    await this.seedFromStore();
    if (!this.refreshToken) {
      await this.startOAuthFlow();

      // Verify we have a refresh token after OAuth flow
      if (!this.refreshToken) {
        throw new Error('Failed to obtain refresh token from OAuth flow');
      }
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      try {
        // Fork: refresh under the token store's lock so two refreshers (other
        // clients, other processes, other serverless instances) never spend the
        // same rotating refresh token at once. refreshInFlight above still
        // dedupes callers within this client.
        return await this.tokenStore.withRefreshLock(() => this.refreshUnderLock());
      } catch (error: unknown) {
        // A persistence failure is not a refresh failure: surface it as-is.
        if (error instanceof QboTokenPersistError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        // Preserve the original error as `cause` so the caller can classify it
        // (auth-invalidation vs transient) without re-parsing the message.
        // Assigned rather than passed to the constructor so this compiles
        // regardless of the configured TS lib target.
        const wrapped = new Error(`Failed to refresh Quickbooks token: ${message}`);
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
      } finally {
        this.refreshInFlight = undefined;
      }
    })();

    return this.refreshInFlight;
  }

  async authenticate(): Promise<QuickBooks> {
    if (this.authInFlight) {
      return this.authInFlight;
    }

    this.authInFlight = (async () => {
      try {
        await this.seedFromStore();
        if (!this.refreshToken || !this.realmId) {
          await this.startOAuthFlow();

          // Verify we have both tokens after OAuth flow
          if (!this.refreshToken || !this.realmId) {
            throw new Error('Failed to obtain required tokens from OAuth flow');
          }
        }

        // Silently refresh if token is expired or expiring soon
        if (this.isTokenExpiredOrExpiringSoon()) {
          try {
            await this.refreshAccessToken();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A transient failure (Intuit 5xx/429, network blip) says nothing
            // about token validity. In BOTH environments, rethrow it as-is so
            // the caller sees a retryable error and the preserved in-memory
            // token self-heals on the next request. Never discard a valid token
            // or launch a browser flow over a temporary outage.
            if (!this.isAuthInvalidation(error)) {
              throw error;
            }
            // Past here the refresh token is genuinely dead (revoked, expired
            // past the 100-day window, or rotated out).
            if (this.environment === 'production') {
              // The interactive fallback cannot help (localhost redirect is
              // rejected, and nobody is watching a host-spawned subprocess to
              // complete a browser login). Surface an actionable error.
              throw await this.reauthRequired(this.reauthError(message), 'QuickBooks refresh token rejected');
            }
            // Sandbox: recoverable via the localhost interactive OAuth flow.
            console.error(`[qbo-client] Refresh token rejected (${message}); falling back to interactive OAuth`);
            this.refreshToken = undefined;
            this.accessToken = undefined;
            this.accessTokenExpiry = undefined;
            // Start the OAuth flow directly (refreshAccessToken() would re-seed
            // the dead token from the store), then exchange the new token.
            await this.startOAuthFlow();
            if (!this.refreshToken) {
              throw new Error('Failed to obtain refresh token from OAuth flow');
            }
            await this.refreshAccessToken();
          }
        }

        // Always rebuild with the current fresh access token
        this.quickbooksInstance = new QuickBooks(
          this.clientId,
          this.clientSecret,
          this.accessToken!,
          false, // no token secret for OAuth 2.0
          this.realmId!,
          this.environment === 'sandbox',
          false, // debug?
          null,  // minor version
          '2.0', // oauth version
          this.refreshToken
        );

        return this.quickbooksInstance;
      } finally {
        this.authInFlight = undefined;
      }
    })();

    return this.authInFlight;
  }

  // ── Called by every handler on every request ─────────────────────────────
  // Checks token freshness on each invocation so handlers stay functional
  // across 60-minute token boundaries without server restarts.
  static async getInstance(): Promise<QuickBooks> {
    if (quickbooksClient.isTokenExpiredOrExpiringSoon()) {
      await quickbooksClient.authenticate();
    }
    if (!quickbooksClient.quickbooksInstance) {
      await quickbooksClient.authenticate();
    }
    return quickbooksClient.quickbooksInstance!;
  }

  // Static counterpart to getInstance() — returns raw OAuth credentials for
  // handlers that need to call QBO endpoints not wrapped by node-quickbooks
  // (e.g. POST /upload for binary attachments). Ensures token freshness on
  // every invocation, same as getInstance().
  static async getAuthCredentials(): Promise<{ accessToken: string; realmId: string; isSandbox: boolean }> {
    if (quickbooksClient.isTokenExpiredOrExpiringSoon() || !quickbooksClient.accessToken) {
      await quickbooksClient.authenticate();
    }
    if (!quickbooksClient.accessToken || !quickbooksClient.realmId) {
      throw new Error('Quickbooks not authenticated');
    }
    return {
      accessToken: quickbooksClient.accessToken,
      realmId: quickbooksClient.realmId,
      isSandbox: quickbooksClient.environment === 'sandbox',
    };
  }

  getQuickbooks() {
    if (!this.quickbooksInstance) {
      throw new Error('Quickbooks not authenticated. Call authenticate() first');
    }
    return this.quickbooksInstance;
  }
}

export const quickbooksClient = new QuickbooksClient({
  clientId: client_id,
  clientSecret: client_secret,
  refreshToken: refresh_token,
  realmId: realm_id,
  environment: environment,
  redirectUri: redirect_uri,
});
