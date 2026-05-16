// Per-user daily rate cap — Phase E backstop.
//
// Counts the user's push_log rows from the last 24 hours where the
// outcome resulted in an APNS attempt:
//   • delivered    — banner shown
//   • apns_error   — APNS 4xx/5xx, but we tried
//   • token_dead   — APNS 410/400, but we tried (cleanup-only)
//
// Coalesced / quiet_hours / rate_limited / prefs_off are NOT counted
// — they're suppressions, not pushes. The cap counts what reached
// APNS, not what was decided.
//
// The 24h window is rolling, not midnight-anchored — a user who hit
// the cap at 22:00 yesterday will see one slot free up every hour
// starting at 22:00 today rather than 100% reset at midnight. Less
// abrupt, less abuseable.

import type { Env } from "./types";

/** Outcomes that count toward the rate cap. */
const COUNTED_OUTCOMES = ["delivered", "apns_error", "token_dead"] as const;

/** Returns true if the user has already exceeded their daily cap.
 *  Permissive on query failure: if Supabase is unreachable, we
 *  DON'T silence — the cap is a backstop, not a guarantee, and a
 *  Supabase outage shouldn't compound by also blocking notifications. */
export async function isRateLimited(env: Env, userId: string): Promise<boolean> {
  const cap = parseCap(env.RATE_LIMIT_PER_DAY);
  if (cap <= 0) return false;       // 0 / negative = disabled

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // PostgREST: head=true + count=exact returns the row count in the
  // Content-Range header without fetching any rows. Cheapest count
  // query the API supports.
  const filter =
    `user_id=eq.${encodeURIComponent(userId)}` +
    `&sent_at=gte.${encodeURIComponent(since)}` +
    `&outcome=in.(${COUNTED_OUTCOMES.join(",")})`;
  const url = `${restRoot(env.SUPABASE_URL)}/rest/v1/push_log?${filter}&select=id`;

  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        prefer: "count=exact",
        // Range: 0-0 limits the result set to 1 row max so the
        // server can short-circuit instead of materializing
        // potentially thousands of rows just to count them.
        range: "0-0",
      },
    });
    if (!res.ok) {
      console.warn(`[rate-limit] count query failed (${res.status})`);
      return false; // permissive
    }
    // Content-Range looks like "0-0/47" — total is after the slash.
    const range = res.headers.get("content-range") ?? "";
    const total = parseTotal(range);
    if (total === null) return false; // permissive
    return total >= cap;
  } catch (err) {
    console.warn("[rate-limit] count query threw:", err);
    return false; // permissive
  }
}

function parseCap(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20; // sensible default if missing
  return Math.floor(n);
}

function parseTotal(contentRange: string): number | null {
  const idx = contentRange.indexOf("/");
  if (idx === -1) return null;
  const after = contentRange.slice(idx + 1).trim();
  if (after === "*") return null;
  const n = Number(after);
  return Number.isFinite(n) ? n : null;
}

function restRoot(supabaseUrl: string): string {
  return supabaseUrl.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}
