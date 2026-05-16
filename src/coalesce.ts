// 60-second coalescing — the spam-prevention layer.
//
// Why this matters: iOS `uploadData()` does an UPSERT per data type,
// so a single user action that touches N transactions still fires the
// Supabase webhook N times (well, 1 actually — same row updated N
// times means N UPDATE events). A future Plaid integration that
// imports 50 transactions in a burst would generate 50 separate
// "1 new transaction" banners over a few seconds. That's the
// failure mode this module exists to prevent.
//
// Implementation pattern — *front-edge fire, back-edge suppress*:
//
//   • First event in a (user, portfolio, dataType) window → KV miss
//     → we write a marker with 60s TTL and return `true` (push it).
//   • Subsequent events while the marker is alive → KV hit → return
//     `false` (suppress; the in-app inbox already records the row).
//   • After 60s the marker expires and the next event starts a fresh
//     window.
//
// Why 60s and not 30s: Cloudflare KV enforces a minimum `expirationTtl`
// of 60 seconds and rejects shorter values with a 400 error. A previous
// 30s value made every webhook throw before reaching the push step —
// effectively breaking pushes silently.
//
// Trade-off worth knowing: the banner the user sees says "1 new X"
// even when the window actually carried 5 of them. That's a known
// limitation of the suppress-based approach — preserving the precise
// count would require deferring the push (Cloudflare Queues with a
// 30s delivery delay, or a Durable Object alarm). Suppress ships
// in a few lines, kills the spam case, and is good enough for v1.
// Phase E can swap in count-based coalescing if users want the exact
// number.
//
// KV consistency caveat: Cloudflare KV is eventually consistent across
// regions (writes can take up to ~60s to propagate everywhere). For
// our "is there a marker?" check the worst case is one extra push
// during the propagation window — acceptable, not catastrophic.

import type { Env } from "./types";

const COALESCE_TTL_SECONDS = 60;

/** Decide whether to send the push for this event. Side effect: on
 *  the first event in a window, writes the marker so subsequent
 *  events return false. Returns true on the first event, false
 *  thereafter (until TTL expires).
 *
 *  Callers must check this AFTER all other skip-conditions (prefs
 *  off, no target tokens, source-device-only) — coalescing keys
 *  occupy KV space, so we only want to consume one when we'd
 *  actually have sent something. */
export async function shouldSendThisEvent(
  env: Env,
  userId: string,
  portfolioId: string,
  dataType: string,
): Promise<boolean> {
  const key = `coalesce:${userId}:${portfolioId}:${dataType}`;
  const existing = await env.PUSH_COALESCE.get(key);
  if (existing !== null) {
    return false;
  }
  // Race note: two concurrent webhook fires can both miss KV and
  // both decide to push. Worst case is a duplicate banner within
  // the same second, which the user perceives as a single event.
  // Cloudflare KV doesn't offer atomic compare-and-set; a Durable
  // Object would. Living with this for now.
  await env.PUSH_COALESCE.put(key, "1", {
    expirationTtl: COALESCE_TTL_SECONDS,
  });
  return true;
}
