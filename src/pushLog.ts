// Push-log writer.
//
// Every code path that resolves an event — sent, skipped, failed —
// writes a row to `push_log` via this module. The log is:
//
//   • The substrate for the daily rate cap (Phase E counts rows
//     where outcome IN ('delivered','apns_error','token_dead')
//     in the last 24h).
//   • A debugging tool — answering "why didn't user X get a
//     banner at 14:32?" via one SELECT.
//   • A future analytics source (delivery rate, p99 latency,
//     coalescing efficiency) — same row populates all of these.
//
// Writes use the SERVICE-ROLE key (same auth pattern as the rest
// of supabase.ts). Failures are caught + logged but never rethrown
// — the audit log is best-effort, not load-bearing for the push
// itself. We'd rather miss an audit row than drop a banner.

import type { Env } from "./types";

export type PushOutcome =
  | "delivered"
  | "coalesced"
  | "quiet_hours"
  | "rate_limited"
  | "token_dead"
  | "apns_error"
  | "no_target_tokens"
  | "prefs_off"
  | "portfolio_not_found";

export interface PushLogEntry {
  user_id:      string;
  portfolio_id?: string | null;
  data_type?:    string | null;
  device_id?:    string | null;
  apns_status?:  number | null;
  outcome:      PushOutcome;
  detail?:      Record<string, unknown>;
}

/** Single push-log row insert. Catches its own errors so callers
 *  never have to await success — fire-and-forget is fine for an
 *  audit log. */
export async function writePushLog(env: Env, entry: PushLogEntry): Promise<void> {
  const url = `${restRoot(env.SUPABASE_URL)}/rest/v1/push_log`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        // PostgREST: don't return the inserted row — saves a few
        // bytes of response payload we don't need.
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id:      entry.user_id,
        portfolio_id: entry.portfolio_id ?? null,
        data_type:    entry.data_type    ?? null,
        device_id:    entry.device_id    ?? null,
        apns_status:  entry.apns_status  ?? null,
        outcome:      entry.outcome,
        detail:       entry.detail       ?? null,
      }),
    });
    if (!res.ok) {
      console.warn(
        `[push-log] insert failed (${res.status}): ${await res.text().catch(() => "")}`,
      );
    }
  } catch (err) {
    console.warn("[push-log] insert threw:", err);
  }
}

/** Local mirror of supabase.ts `restRoot` — keeping pushLog
 *  decoupled from the rest of the Supabase helpers so a future
 *  refactor (e.g. moving to @supabase/supabase-js) doesn't have
 *  to touch this audit path. */
function restRoot(supabaseUrl: string): string {
  return supabaseUrl.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}
