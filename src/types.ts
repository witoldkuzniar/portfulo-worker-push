// Shared types for the push worker.
//
// The worker is invoked by a Supabase Database Webhook configured on the
// `portfolio_data` table. Supabase posts a JSON envelope whose `record`
// field mirrors the row that triggered the event.

/** Worker environment — populated by `wrangler secret put`. */
export interface Env {
  /** Same value as iOS uses, e.g. https://<project>.supabase.co */
  SUPABASE_URL: string;
  /** Service-role key (NOT the anon key) — needed to read across users
   *  and to flip is_active on dead tokens. Never expose to clients. */
  SUPABASE_SERVICE_ROLE_KEY: string;

  /** Apple Developer Team ID (10 chars, e.g. "WXYZ123456") */
  APNS_TEAM_ID: string;
  /** APNS Auth Key ID (10 chars, e.g. "ABCD1234EF") */
  APNS_KEY_ID: string;
  /** Full PEM body of the .p8 file. Multi-line; the Worker secret
   *  storage accepts newlines via stdin. */
  APNS_PRIVATE_KEY: string;
  /** App bundle identifier, e.g. "com.witold.portfulo". Used as the
   *  apns-topic header on every push. */
  APNS_BUNDLE_ID: string;

  /** Shared HMAC secret with the Supabase Database Webhook. Sent as
   *  the `x-portfulo-webhook-secret` header on every invocation. */
  WEBHOOK_SECRET: string;
}

/** Subset of the Supabase webhook envelope we actually care about.
 *  Full schema reference:
 *  https://supabase.com/docs/guides/database/webhooks#webhook-payload
 */
export interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: PortfolioDataRow | null;
  old_record: PortfolioDataRow | null;
}

/** Mirror of the columns we read off a `portfolio_data` row. The
 *  table has many more columns (encrypted_payload etc.) — we ignore
 *  them; the push worker has no business decrypting user data. */
export interface PortfolioDataRow {
  id: string;
  portfolio_id: string;
  data_type: string;
  updated_by_device: string | null;
  updated_at: string;
}

/** Mirror of `notification_preferences`. */
export interface NotificationPreferencesRow {
  user_id: string;
  master_enabled: boolean;
  cross_portfolio_enabled: boolean;
  shared_portfolio_enabled: boolean;
  plaid_enabled: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
}

/** Mirror of `device_tokens`. */
export interface DeviceTokenRow {
  id: string;
  user_id: string;
  device_id: string;
  apns_token: string;
  platform: string;
  app_env: "sandbox" | "production";
  device_name: string | null;
  is_active: boolean;
}

/** Mirror of `portfolios` (only the columns the worker reads). */
export interface PortfolioRow {
  id: string;
  owner_id: string;
  name: string | null;
}

/** APNS response classification — drives our per-token cleanup logic. */
export type ApnsOutcome =
  | { kind: "ok"; status: 200 }
  | { kind: "gone"; status: 410; reason?: string }          // token dead — deactivate
  | { kind: "badDeviceToken"; status: 400; reason?: string } // token format invalid — deactivate
  | { kind: "rateLimited"; status: 429 }                     // back off
  | { kind: "serverError"; status: number; body?: string }   // 5xx — retry later
  | { kind: "otherClientError"; status: number; reason?: string }; // 4xx
