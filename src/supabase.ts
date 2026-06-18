// Supabase service-role queries.
//
// All reads + writes here use the SERVICE-ROLE key, which bypasses RLS
// — needed because the worker has no end-user session and needs to
// see rows across users (look up which user owns the portfolio being
// edited, load their active device tokens, mark dead tokens). The
// service-role key NEVER leaves the Cloudflare secret store.
//
// We use raw PostgREST HTTP rather than @supabase/supabase-js to keep
// the Worker bundle small and the cold-start fast.

import type {
  Env,
  NotificationPreferencesRow,
  DeviceTokenRow,
  PortfolioRow,
} from "./types";

function authHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
}

// Hard timeout on every PostgREST call so a slow/hung Supabase can't pin a
// Worker invocation until the platform CPU limit kills it. AbortSignal.timeout
// is supported on the Workers runtime; on fire the fetch rejects with a
// TimeoutError, which the callers already turn into a thrown Error (→ Sentry).
const SUPABASE_TIMEOUT_MS = 5000;

function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
}

/** Normalize `SUPABASE_URL` so callers can construct PostgREST paths
 *  without worrying about the secret's exact shape. Strips any trailing
 *  slash and an optional `/rest/v1` suffix the user might have included
 *  by accident — that lookup path is appended by every query below,
 *  so doubling it produces PGRST125 "Invalid path specified" errors. */
function restRoot(env: Env): string {
  return env.SUPABASE_URL
    .replace(/\/+$/, "")        // strip trailing slash(es)
    .replace(/\/rest\/v1$/, ""); // strip "/rest/v1" if pasted
}

/** Look up the portfolio's owner. Returns null when the row no longer
 *  exists (deleted between the webhook firing and the worker reading
 *  — possible in a race; we just drop the push). */
export async function fetchPortfolioOwner(
  env: Env,
  portfolioId: string,
): Promise<PortfolioRow | null> {
  const url = `${restRoot(env)}/rest/v1/portfolios?id=eq.${encodeURIComponent(
    portfolioId,
  )}&select=id,owner_id,name&limit=1`;
  const res = await timedFetch(url, { headers: authHeaders(env) });
  if (!res.ok) {
    throw new Error(`fetchPortfolioOwner failed (${res.status}): ${await res.text()}`);
  }
  const rows = (await res.json()) as PortfolioRow[];
  return rows[0] ?? null;
}

/** Load the user's notification_preferences row. Returns null when
 *  the user has never opened the Notifications card — orchestrator
 *  treats null as "all defaults", which means master_enabled = false
 *  (the SQL default), which means no push. */
export async function fetchNotificationPreferences(
  env: Env,
  userId: string,
): Promise<NotificationPreferencesRow | null> {
  const url = `${restRoot(env)}/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(
    userId,
  )}&limit=1`;
  const res = await timedFetch(url, { headers: authHeaders(env) });
  if (!res.ok) {
    throw new Error(`fetchNotificationPreferences failed (${res.status}): ${await res.text()}`);
  }
  const rows = (await res.json()) as NotificationPreferencesRow[];
  return rows[0] ?? null;
}

/** Load active device tokens for a user. The orchestrator further
 *  filters by `device_id != updated_by_device` to skip the device
 *  that just wrote the row. */
export async function fetchActiveDeviceTokens(
  env: Env,
  userId: string,
): Promise<DeviceTokenRow[]> {
  const url = `${restRoot(env)}/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(
    userId,
  )}&is_active=eq.true&select=*`;
  const res = await timedFetch(url, { headers: authHeaders(env) });
  if (!res.ok) {
    throw new Error(`fetchActiveDeviceTokens failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as DeviceTokenRow[];
}

/** Flip is_active = false on a token row. Used on APNS 410 Gone +
 *  400 BadDeviceToken — both indicate the token is no longer
 *  receivable (app uninstalled, restored from backup with a fresh
 *  token, etc.). Idempotent. */
export async function deactivateDeviceToken(
  env: Env,
  tokenRowId: string,
): Promise<void> {
  const url = `${restRoot(env)}/rest/v1/device_tokens?id=eq.${encodeURIComponent(
    tokenRowId,
  )}`;
  const res = await timedFetch(url, {
    method: "PATCH",
    headers: authHeaders(env),
    body: JSON.stringify({ is_active: false }),
  });
  if (!res.ok) {
    throw new Error(`deactivateDeviceToken failed (${res.status}): ${await res.text()}`);
  }
}
