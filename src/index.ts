// Portfulo Push — Cloudflare Worker entry point.
//
// Fires once per Supabase Database Webhook invocation. Each invocation
// represents one row event on `portfolio_data` (INSERT or UPDATE).
// The worker decides whether to push, to whom, and what content —
// see `processWebhook` for the orchestration.
//
// Phase B + C + D + E scope (current):
//   • INSERT + UPDATE handling. iOS uploadData() does an UPSERT keyed
//     on (portfolio_id, data_type); the first write for each pair is
//     an INSERT, every subsequent write is an UPDATE. Watching only
//     INSERT would silence all post-first-sync activity.
//   • 30s coalescing window (Phase C) — KV-backed front-edge fire,
//     back-edge suppress. First event in a (user, portfolio,
//     dataType) burst pushes; everything else within 30s is silent.
//     Stops a 50-row Plaid import from generating 50 banners.
//   • Per-category preference gates (Phase D) — currently only
//     cross_portfolio_enabled is consulted; shared_portfolio and
//     plaid hooks land when those event sources ship.
//   • Quiet hours (Phase D) — TZ-aware window check via
//     `quietHours.inQuietHours`. Suppresses banners only; the
//     in-app inbox + app-icon badge still update.
//   • Per-user daily rate cap (Phase E) — default 20/day, counted
//     against push_log rows with outcomes that hit APNS. Backstop
//     for runaway feeds; the in-app inbox always records.
//   • push_log audit row written at every decision point (Phase E)
//     — sent, coalesced, quiet_hours, rate_limited, errors all land
//     as a single PostgREST insert via `writePushLog`. The log feeds
//     the rate-limit query + future debugging.
//   • Sentry capture for uncaught errors (Phase E) — events tagged
//     `service: push-worker` route to the same project iOS/web use.
//   • Source-device exclusion via the existing `updated_by_device`
//     column on portfolio_data rows.
//   • Generic payload — portfolio name + "1 new <dataType>". No
//     amounts, no encrypted content.
//   • Dead-token cleanup on APNS 410 + 400 BadDeviceToken.

import * as Sentry from "@sentry/cloudflare";

import type { Env, WebhookPayload, ApnsOutcome } from "./types";
import { getProviderJWT, sendPush, type ApnsPayload } from "./apns";
import {
  fetchPortfolioOwner,
  fetchNotificationPreferences,
  fetchActiveDeviceTokens,
  deactivateDeviceToken,
} from "./supabase";
import { shouldSendThisEvent } from "./coalesce";
import { inQuietHours } from "./quietHours";
import { writePushLog, type PushOutcome } from "./pushLog";
import { isRateLimited } from "./rateLimit";

// Sentry's `withSentry` wraps the export so any error thrown inside
// the handler is captured automatically. Explicit captureException
// calls still work for caught errors that we want to record without
// rethrowing.
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0,      // tracing off — pure error capture
    sampleRate: 1.0,          // 100% of errors
    initialScope: { tags: { service: "push-worker" } },
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      if (request.method !== "POST" || url.pathname !== "/webhook") {
        return new Response("Not Found", { status: 404 });
      }

      // Webhook secret check — constant-time compare avoids length
      // oracles on the shared secret.
      const presented = request.headers.get("x-portfulo-webhook-secret") ?? "";
      if (!constantTimeEqual(presented, env.WEBHOOK_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: WebhookPayload;
      try {
        payload = (await request.json()) as WebhookPayload;
      } catch (err) {
        console.error("[push] Failed to parse webhook body:", err);
        Sentry.captureException(err);
        return new Response("Bad Request", { status: 400 });
      }

      // Always 200 to Supabase — push delivery is best-effort, the
      // in-app inbox is the source of truth. Errors inside
      // processWebhook are captured to Sentry, not bubbled back to
      // Supabase's retry-bomb logic.
      ctx.waitUntil(processWebhook(payload, env).catch((err) => {
        console.error("[push] processWebhook threw:", err);
        Sentry.captureException(err);
      }));
      return new Response("ok", { status: 200 });
    },
  } satisfies ExportedHandler<Env>,
);

/** Decide whether and how to push for one webhook event. */
async function processWebhook(payload: WebhookPayload, env: Env): Promise<void> {
  if (payload.table !== "portfolio_data") {
    console.log(`[push] Skip — unexpected table ${payload.table}`);
    return;
  }
  if (payload.type !== "INSERT" && payload.type !== "UPDATE") {
    // DELETE on portfolio_data is the user clearing data; no banner.
    return;
  }
  const row = payload.record;
  if (!row) {
    console.error(`[push] ${payload.type} payload missing record`);
    return;
  }
  const { portfolio_id: portfolioId, data_type: dataType, updated_by_device: sourceDeviceId } = row;
  if (!portfolioId || !dataType) {
    console.error("[push] row missing required columns", row);
    return;
  }

  // ── Step 1: portfolio → owner_id ─────────────────────────────────
  const portfolio = await fetchPortfolioOwner(env, portfolioId);
  if (!portfolio) {
    // Can't write push_log without a user_id; just console-log.
    console.log(`[push] Skip — portfolio ${portfolioId} not found (deleted?)`);
    return;
  }

  // ── Step 2: prefs gates ──────────────────────────────────────────
  const prefs = await fetchNotificationPreferences(env, portfolio.owner_id);
  if (!prefs || !prefs.master_enabled) {
    console.log(`[push] Skip — master_enabled false for user ${portfolio.owner_id}`);
    await logSkip(env, portfolio.owner_id, portfolioId, dataType, "prefs_off", {
      reason: "master_enabled=false",
    });
    return;
  }
  if (!prefs.cross_portfolio_enabled) {
    console.log(`[push] Skip — cross_portfolio_enabled false for user ${portfolio.owner_id}`);
    await logSkip(env, portfolio.owner_id, portfolioId, dataType, "prefs_off", {
      reason: "cross_portfolio_enabled=false",
    });
    return;
  }

  // ── Step 3: quiet hours ──────────────────────────────────────────
  if (inQuietHours(prefs)) {
    console.log(
      `[push] Skip — quiet hours active for user ${portfolio.owner_id} ` +
        `(${prefs.quiet_hours_start} → ${prefs.quiet_hours_end} ${prefs.timezone})`,
    );
    await logSkip(env, portfolio.owner_id, portfolioId, dataType, "quiet_hours", {
      start:    prefs.quiet_hours_start,
      end:      prefs.quiet_hours_end,
      timezone: prefs.timezone,
    });
    return;
  }

  // ── Step 4: load tokens, drop the source device ──────────────────
  const allTokens = await fetchActiveDeviceTokens(env, portfolio.owner_id);
  const targetTokens = allTokens.filter((t) => t.device_id !== sourceDeviceId);
  if (targetTokens.length === 0) {
    console.log(
      `[push] Skip — no target tokens for user ${portfolio.owner_id} ` +
        `(${allTokens.length} active, source=${sourceDeviceId})`,
    );
    await logSkip(env, portfolio.owner_id, portfolioId, dataType, "no_target_tokens", {
      active_count:      allTokens.length,
      source_device_id:  sourceDeviceId,
    });
    return;
  }

  // ── Step 5: coalesce ─────────────────────────────────────────────
  // Inside the source-device filter so we don't burn a KV write on
  // events that have no recipients anyway. Counted before the
  // rate-limit check so a coalesced suppression doesn't consume
  // a slot against the daily cap.
  const fresh = await shouldSendThisEvent(env, portfolio.owner_id, portfolioId, dataType);
  if (!fresh) {
    console.log(
      `[push] Coalesced — within 30s window for ` +
        `(user=${portfolio.owner_id}, portfolio=${portfolioId}, dataType=${dataType})`,
    );
    await logSkip(env, portfolio.owner_id, portfolioId, dataType, "coalesced");
    return;
  }

  // ── Step 6: rate limit ───────────────────────────────────────────
  // Backstop against runaway feeds. Counted AFTER coalescing so
  // bursts that the window already collapses don't eat the cap.
  if (await isRateLimited(env, portfolio.owner_id)) {
    console.warn(`[push] Rate-limited (daily cap) for user ${portfolio.owner_id}`);
    await logSkip(env, portfolio.owner_id, portfolioId, dataType, "rate_limited", {
      cap: env.RATE_LIMIT_PER_DAY ?? "20",
    });
    return;
  }

  // ── Step 7: build payload + sign JWT ─────────────────────────────
  const apnsPayload: ApnsPayload = {
    aps: {
      alert: {
        title: portfolio.name ?? "Portfolio",
        body: locKeyFor(dataType),
      },
      sound: "default",
      "thread-id": portfolioId,
      "mutable-content": 1,
    },
    portfolio_id: portfolioId,
    data_type: dataType,
    event_count: 1,
  };
  const jwt = await getProviderJWT(env);

  // ── Step 8: parallel send ────────────────────────────────────────
  const results = await Promise.allSettled(
    targetTokens.map(async (token) => {
      const outcome = await sendPush(env, jwt, token.app_env, token.apns_token, apnsPayload);
      await handleOutcome(env, portfolio.owner_id, portfolioId, dataType, token.id, token.device_id, outcome);
      return outcome;
    }),
  );

  const stats = summarise(results);
  console.log(
    `[push] Sent to ${stats.ok}/${targetTokens.length} ` +
      `(portfolio=${portfolioId} dataType=${dataType} ` +
      `gone=${stats.gone} bad=${stats.bad} server=${stats.server} other=${stats.other})`,
  );
}

/** English fallback body for a given dataType. Sent verbatim in the
 *  push; the iOS Notification Service Extension reads `data_type` from
 *  the payload's top-level fields, looks up the matching key in the
 *  app bundle's `Localizable.strings`, and rewrites `body` in the
 *  user's chosen language. If the NSE fails to run (timeout, low
 *  memory), iOS shows this English string as a fallback — same
 *  behavior the app had before localization was attempted. The
 *  returned strings are valid keys in both `en.lproj` and `pl.lproj`
 *  Localizable.strings files. */
function locKeyFor(dataType: string): string {
  switch (dataType) {
    case "assets":            return "1 new asset";
    case "liabilities":       return "1 new liability";
    case "transactions":      return "1 new transaction";
    case "accounts":          return "1 new account";
    case "recurringPayments": return "1 new recurring payment";
    case "budgets":           return "1 new budget";
    case "goals":             return "1 new goal";
    case "pendingImports":    return "1 new pending import";
    default:                  return "1 new update";
  }
}

/** Per-token cleanup + audit log based on APNS response. Writes a
 *  push_log row per token (delivered / token_dead / apns_error). */
async function handleOutcome(
  env: Env,
  userId: string,
  portfolioId: string,
  dataType: string,
  tokenRowId: string,
  deviceId: string,
  outcome: ApnsOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case "ok":
      await writePushLog(env, {
        user_id:      userId,
        portfolio_id: portfolioId,
        data_type:    dataType,
        device_id:    deviceId,
        apns_status:  200,
        outcome:      "delivered",
      });
      return;
    case "gone":
    case "badDeviceToken":
      console.log(
        `[push] Token dead (${outcome.kind}, reason=${outcome.reason ?? "?"}) — deactivating ${deviceId}`,
      );
      await deactivateDeviceToken(env, tokenRowId);
      await writePushLog(env, {
        user_id:      userId,
        portfolio_id: portfolioId,
        data_type:    dataType,
        device_id:    deviceId,
        apns_status:  outcome.status,
        outcome:      "token_dead",
        detail:       { reason: outcome.reason ?? null, kind: outcome.kind },
      });
      return;
    case "rateLimited":
      console.warn(`[push] Rate-limited by APNS for ${deviceId}`);
      await writePushLog(env, {
        user_id:      userId,
        portfolio_id: portfolioId,
        data_type:    dataType,
        device_id:    deviceId,
        apns_status:  outcome.status,
        outcome:      "apns_error",
        detail:       { kind: "apns_rate_limited" },
      });
      return;
    case "serverError":
      console.warn(`[push] APNS ${outcome.status} for ${deviceId}: ${outcome.body ?? ""}`);
      await writePushLog(env, {
        user_id:      userId,
        portfolio_id: portfolioId,
        data_type:    dataType,
        device_id:    deviceId,
        apns_status:  outcome.status,
        outcome:      "apns_error",
        detail:       { kind: "server_error", body: outcome.body ?? null },
      });
      return;
    case "otherClientError":
      console.warn(
        `[push] APNS ${outcome.status} (${outcome.reason ?? "?"}) for ${deviceId}`,
      );
      await writePushLog(env, {
        user_id:      userId,
        portfolio_id: portfolioId,
        data_type:    dataType,
        device_id:    deviceId,
        apns_status:  outcome.status,
        outcome:      "apns_error",
        detail:       { kind: "client_error", reason: outcome.reason ?? null },
      });
      return;
  }
}

/** Single-line helper for skip-paths that need to write a push_log
 *  row. Skip paths don't carry a device_id so they're event-scoped
 *  rather than token-scoped. */
async function logSkip(
  env: Env,
  userId: string,
  portfolioId: string,
  dataType: string,
  outcome: PushOutcome,
  detail?: Record<string, unknown>,
): Promise<void> {
  await writePushLog(env, {
    user_id:      userId,
    portfolio_id: portfolioId,
    data_type:    dataType,
    outcome,
    detail,
  });
}

interface OutcomeSummary {
  ok: number;
  gone: number;
  bad: number;
  server: number;
  other: number;
}

function summarise(results: PromiseSettledResult<ApnsOutcome>[]): OutcomeSummary {
  const acc: OutcomeSummary = { ok: 0, gone: 0, bad: 0, server: 0, other: 0 };
  for (const r of results) {
    if (r.status === "rejected") {
      acc.other += 1;
      continue;
    }
    switch (r.value.kind) {
      case "ok": acc.ok += 1; break;
      case "gone": acc.gone += 1; break;
      case "badDeviceToken": acc.bad += 1; break;
      case "serverError": acc.server += 1; break;
      default: acc.other += 1; break;
    }
  }
  return acc;
}

/** Length-independent constant-time string compare. The Workers
 *  runtime doesn't ship `crypto.timingSafeEqual`; this is the
 *  equivalent over UTF-8 byte length. */
function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}
