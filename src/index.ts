// Portfulo Push — Cloudflare Worker entry point.
//
// Fires once per Supabase Database Webhook invocation. Each invocation
// represents one row event on `portfolio_data` (INSERT, with future
// scope for UPDATE in Phase D). The worker decides whether to push,
// to whom, and what content — see `processWebhook` for the orchestration.
//
// Phase B + C scope (current):
//   • INSERT + UPDATE handling. iOS uploadData() does an UPSERT keyed
//     on (portfolio_id, data_type); the first write for each pair is
//     an INSERT, every subsequent write is an UPDATE. Watching only
//     INSERT would silence all post-first-sync activity.
//   • 30s coalescing window (Phase C) — KV-backed front-edge fire,
//     back-edge suppress. First event in a (user, portfolio,
//     dataType) burst pushes; everything else within 30s is silent.
//     Stops a 50-row Plaid import from generating 50 banners.
//   • Source-device exclusion via the existing `updated_by_device`
//     column on portfolio_data rows.
//   • Generic payload — portfolio name + "1 new <dataType>". No
//     amounts, no encrypted content.
//   • Dead-token cleanup on APNS 410 + 400 BadDeviceToken.
//
// Future phases bolt on without rewriting this orchestration:
//   • Phase C → coalescing via Cloudflare KV between the prefs check
//     and the per-token loop.
//   • Phase D → respect cross_portfolio / shared_portfolio / plaid
//     toggles + quiet_hours.
//   • Phase E → push_log + rate-limiting + retry queue.

import type { Env, WebhookPayload, ApnsOutcome } from "./types";
import { getProviderJWT, sendPush, type ApnsPayload } from "./apns";
import {
  fetchPortfolioOwner,
  fetchNotificationPreferences,
  fetchActiveDeviceTokens,
  deactivateDeviceToken,
} from "./supabase";
import { shouldSendThisEvent } from "./coalesce";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Health check — handy when verifying the deploy + DNS without
    // having to wire the webhook end-to-end first.
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    // Webhook secret check — Supabase Database Webhooks support custom
    // headers in the request config; we add `x-portfulo-webhook-secret`
    // there. Constant-time compare to avoid timing oracles on the
    // length of the secret.
    const presented = request.headers.get("x-portfulo-webhook-secret") ?? "";
    if (!constantTimeEqual(presented, env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: WebhookPayload;
    try {
      payload = (await request.json()) as WebhookPayload;
    } catch (err) {
      console.error("[push] Failed to parse webhook body:", err);
      return new Response("Bad Request", { status: 400 });
    }

    // We deliberately respond 200 even on internal failures so Supabase
    // doesn't retry-bomb us — push delivery is best-effort, the in-app
    // inbox is the source of truth. Log loudly so failures show up in
    // the wrangler tail / Cloudflare logs.
    ctx.waitUntil(processWebhook(payload, env).catch((err) => {
      console.error("[push] processWebhook threw:", err);
    }));
    return new Response("ok", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

/** Decide whether and how to push for one webhook event. */
async function processWebhook(payload: WebhookPayload, env: Env): Promise<void> {
  if (payload.table !== "portfolio_data") {
    console.log(`[push] Skip — unexpected table ${payload.table}`);
    return;
  }
  if (payload.type !== "INSERT" && payload.type !== "UPDATE") {
    // DELETE-on-portfolio_data is the user clearing a portfolio's
    // data; no banner makes sense for that. Anything else (e.g. a
    // future TRUNCATE) is unexpected — bail.
    return;
  }
  const row = payload.record;
  if (!row) {
    console.error(`[push] ${payload.type} payload missing record`);
    return;
  }
  const { portfolio_id: portfolioId, data_type: dataType, updated_by_device: sourceDeviceId } = row;
  if (!portfolioId || !dataType) {
    console.error("[push] INSERT row missing required columns", row);
    return;
  }

  // Step 1: portfolio → owner_id
  const portfolio = await fetchPortfolioOwner(env, portfolioId);
  if (!portfolio) {
    console.log(`[push] Skip — portfolio ${portfolioId} not found (deleted?)`);
    return;
  }

  // Step 2: notification_preferences gate.
  const prefs = await fetchNotificationPreferences(env, portfolio.owner_id);
  if (!prefs || !prefs.master_enabled) {
    console.log(`[push] Skip — master_enabled false for user ${portfolio.owner_id}`);
    return;
  }
  // Phase B only honours master + cross_portfolio. Per-category +
  // quiet hours land in Phase D.
  if (!prefs.cross_portfolio_enabled) {
    console.log(`[push] Skip — cross_portfolio_enabled false for user ${portfolio.owner_id}`);
    return;
  }

  // Step 3: load all active tokens, drop the source device.
  const allTokens = await fetchActiveDeviceTokens(env, portfolio.owner_id);
  const targetTokens = allTokens.filter((t) => t.device_id !== sourceDeviceId);
  if (targetTokens.length === 0) {
    console.log(
      `[push] Skip — no target tokens for user ${portfolio.owner_id} ` +
        `(${allTokens.length} active, source=${sourceDeviceId})`,
    );
    return;
  }

  // Step 3b: coalesce. Check 30s window — if a marker for this
  // (user, portfolio, dataType) exists, suppress the push. The
  // marker write happens INSIDE shouldSendThisEvent so a returning
  // `true` consumes the slot for the rest of the window.
  // Done AFTER the source-device filter so we don't burn a KV
  // write on events that have no recipients anyway.
  const fresh = await shouldSendThisEvent(env, portfolio.owner_id, portfolioId, dataType);
  if (!fresh) {
    console.log(
      `[push] Coalesced — within 30s window for ` +
        `(user=${portfolio.owner_id}, portfolio=${portfolioId}, dataType=${dataType})`,
    );
    return;
  }

  // Step 4: build payload + sign JWT.
  const apnsPayload: ApnsPayload = {
    aps: {
      alert: {
        title: portfolio.name ?? "Portfolio",
        body: bodyFor(dataType),
      },
      sound: "default",
      "thread-id": portfolioId,
    },
    portfolio_id: portfolioId,
    data_type: dataType,
    event_count: 1,
  };
  const jwt = await getProviderJWT(env);

  // Step 5: send + handle each outcome. We don't await Promise.all so
  // one failing token (e.g. APNS 5xx) doesn't block the others.
  const results = await Promise.allSettled(
    targetTokens.map(async (token) => {
      const outcome = await sendPush(env, jwt, token.app_env, token.apns_token, apnsPayload);
      await handleOutcome(env, token.id, token.device_id, outcome);
      return outcome;
    }),
  );

  // Summary log — one line per webhook is plenty for the wrangler tail.
  const stats = summarise(results);
  console.log(
    `[push] Sent to ${stats.ok}/${targetTokens.length} ` +
      `(portfolio=${portfolioId} dataType=${dataType} ` +
      `gone=${stats.gone} bad=${stats.bad} server=${stats.server} other=${stats.other})`,
  );
}

/** Human-readable body for a given dataType. Kept in English on the
 *  server — the iOS recipient has the full localized inbox; the push
 *  banner is the tease, not the source of truth. */
function bodyFor(dataType: string): string {
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

/** Per-token cleanup based on APNS response. */
async function handleOutcome(
  env: Env,
  tokenRowId: string,
  deviceId: string,
  outcome: ApnsOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case "ok":
      return;
    case "gone":
    case "badDeviceToken":
      console.log(
        `[push] Token dead (${outcome.kind}, reason=${outcome.reason ?? "?"}) — deactivating ${deviceId}`,
      );
      await deactivateDeviceToken(env, tokenRowId);
      return;
    case "rateLimited":
      // APNS asked us to back off. With per-event pushes we can't
      // realistically retry from inside a single Worker invocation;
      // Phase E moves this onto a retry queue.
      console.warn(`[push] Rate-limited by APNS for ${deviceId}`);
      return;
    case "serverError":
      console.warn(`[push] APNS ${outcome.status} for ${deviceId}: ${outcome.body ?? ""}`);
      return;
    case "otherClientError":
      console.warn(
        `[push] APNS ${outcome.status} (${outcome.reason ?? "?"}) for ${deviceId}`,
      );
      return;
  }
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
