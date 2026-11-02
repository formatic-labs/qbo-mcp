/**
 * TokenStore — where a QuickBooks company's OAuth tokens live between requests.
 *
 * Fork addition (formatic-labs/qbo-mcp). QuickBooks refresh tokens ROTATE:
 * every refresh may return a new refresh token and invalidate the old one, so
 * the newest must be saved after every refresh, and two refreshers must never
 * spend the same refresh token at once. QuickbooksClient therefore refreshes
 * inside `withRefreshLock`, re-reads the store inside the lock (another
 * process may have refreshed while it waited), and saves what Intuit returned.
 *
 * Implementations:
 * - EnvFileTokenStore (env-file-token-store.ts): the stdio server's `.env`
 *   (DPAPI-aware), in-process lock. Today's behaviour.
 * - The hosted store (built in ProjectPix): Supabase Vault, with a Postgres
 *   row lock per company behind `withRefreshLock` so serverless instances
 *   serialize their refreshes.
 */

/** Tokens persisted for one QuickBooks company. Secret values — never log them. */
export interface StoredQboTokens {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: Date;
  /**
   * QuickBooks company id. Only passed by the interactive `npm run auth`
   * sign-in, which learns it alongside the first refresh token;
   * EnvFileTokenStore writes it to QUICKBOOKS_REALM_ID. Stores keyed by
   * company may ignore it. Refresh-path saves never set it.
   */
  realmId?: string;
}

export interface TokenStore {
  /** Latest persisted tokens, or undefined when nothing usable is stored. */
  read(): Promise<StoredQboTokens | undefined>;
  /** Persist tokens after a refresh (the refresh token may have rotated). */
  save(tokens: StoredQboTokens): Promise<void>;
  /** Run `fn` while holding the per-company refresh lock (across processes where the store supports it). */
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Record that the company must reconnect QuickBooks (refresh token dead). `reason` holds no secrets. */
  markReauthRequired(reason: string): Promise<void>;
}

/**
 * Thrown when the refresh token is dead (revoked, expired, rotated out) or
 * missing and cannot be renewed without a person reconnecting QuickBooks.
 * The message is the actionable instruction shown to the operator.
 */
export class QboReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QboReauthRequiredError';
  }
}

/**
 * Thrown (only with the client option `strictPersistence: true`) when a
 * refreshed, ROTATED refresh token could not be saved to the store after
 * retries. The old token is already spent, so the company may have to
 * reconnect. The message never contains token values.
 */
export class QboTokenPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QboTokenPersistError';
  }
}

/**
 * Thrown in hosted mode when a QuickbooksClient is built without its company
 * (`realmId`). A configuration error in the host, not a dead token: the
 * company is never flagged for reconnect because of it (ruling R9). The host
 * must pass `realmId` from its integration row (TokenStore.read() does not
 * return one).
 */
export class QboConfigError extends Error {
  static readonly MISSING_REALM =
    'QuickBooks client is missing its company (realmId); pass realmId from the integration row.';
  constructor(message: string = QboConfigError.MISSING_REALM) {
    super(message);
    this.name = 'QboConfigError';
  }
}
