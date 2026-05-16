// APNS HTTP/2 client + JWT signer.
//
// Apple's APNS provider API expects an ES256 JWT in the Authorization
// header on every push, signed with the private key from the .p8 file
// generated in Apple Developer portal. Tokens are valid for up to 60
// minutes; we cache + reuse within an isolate to avoid re-signing on
// every invocation. Per-isolate caching is good enough for our scale
// (Workers recycle isolates frequently but not on every request).
//
// Everything here uses the platform's Web Crypto API (`crypto.subtle`)
// — no external dependencies needed, no Node built-ins.

import type { Env, ApnsOutcome } from "./types";

/** APNS hosts. Production tokens vs sandbox tokens hit different
 *  endpoints; sending a sandbox token to production returns 400
 *  BadDeviceToken (and vice versa), which is why the iOS app stamps
 *  `app_env` on every device_tokens row. */
const APNS_HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

/** A signed APNS provider JWT plus its issued-at timestamp. We refresh
 *  ~50 min before expiry so concurrent invocations don't all race to
 *  re-sign at the moment of expiry. */
interface CachedJWT {
  token: string;
  issuedAt: number;
}

let cachedJWT: CachedJWT | null = null;

/** Refresh threshold in seconds. Apple's docs say tokens live 60 min;
 *  we treat anything older than 50 min as stale. */
const JWT_TTL_SECONDS = 50 * 60;

/** Construct (or return cached) APNS provider JWT.
 *
 *  Header: { alg: "ES256", kid: <APNS_KEY_ID>, typ: "JWT" }
 *  Claims: { iss: <APNS_TEAM_ID>, iat: <now> }
 *  Signature: ECDSA P-256 over base64url(header) + "." + base64url(claims)
 */
export async function getProviderJWT(env: Env): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedJWT && nowSec - cachedJWT.issuedAt < JWT_TTL_SECONDS) {
    return cachedJWT.token;
  }

  const header = base64UrlJson({
    alg: "ES256",
    kid: env.APNS_KEY_ID,
    typ: "JWT",
  });
  const claims = base64UrlJson({
    iss: env.APNS_TEAM_ID,
    iat: nowSec,
  });
  const signingInput = `${header}.${claims}`;

  const key = await importApnsPrivateKey(env.APNS_PRIVATE_KEY);
  const signatureBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    key,
    new TextEncoder().encode(signingInput),
  );

  const signature = base64UrlBytes(new Uint8Array(signatureBuf));
  const token = `${signingInput}.${signature}`;
  cachedJWT = { token, issuedAt: nowSec };
  return token;
}

/** Parse the .p8 PEM into a CryptoKey usable with WebCrypto ECDSA.
 *
 *  The .p8 file Apple ships is PKCS#8-encoded P-256 private key in
 *  PEM. WebCrypto's `importKey` accepts that format directly once
 *  we strip the PEM header/footer + base64-decode the body. */
async function importApnsPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** APNS payload as sent to Apple. `aps` is reserved by Apple; the
 *  other top-level keys travel through to the client's userInfo. */
export interface ApnsPayload {
  aps: {
    alert: { title: string; body: string };
    sound: "default";
    "thread-id": string;
    "mutable-content"?: 1;
  };
  portfolio_id: string;
  data_type: string;
  event_count: number;
}

/** Single APNS push. Caller decides which host to target (sandbox vs
 *  production) and provides the device token. Returns a structured
 *  outcome so the orchestrator can deactivate dead tokens, retry on
 *  5xx, etc. */
export async function sendPush(
  env: Env,
  jwt: string,
  appEnv: "sandbox" | "production",
  apnsToken: string,
  payload: ApnsPayload,
): Promise<ApnsOutcome> {
  const url = `${APNS_HOSTS[appEnv]}/3/device/${apnsToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": env.APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 200) {
    return { kind: "ok", status: 200 };
  }
  // APNS returns JSON like {"reason":"BadDeviceToken"} on errors.
  let reason: string | undefined;
  try {
    const json = (await res.json()) as { reason?: string };
    reason = json.reason;
  } catch {
    /* response body absent or unparseable */
  }
  if (res.status === 410 || reason === "Unregistered") {
    return { kind: "gone", status: 410, reason };
  }
  if (res.status === 400 && reason === "BadDeviceToken") {
    return { kind: "badDeviceToken", status: 400, reason };
  }
  if (res.status === 429) {
    return { kind: "rateLimited", status: 429 };
  }
  if (res.status >= 500) {
    return { kind: "serverError", status: res.status, body: reason };
  }
  return { kind: "otherClientError", status: res.status, reason };
}

// MARK: - Base64 / base64url helpers
//
// Workers' built-in `atob` / `btoa` work on raw byte strings, not
// arbitrary Unicode — fine for our use here since headers, claims,
// and signatures are all ASCII/binary. We avoid importing a base64
// library to keep the bundle tiny.

function base64UrlJson(obj: unknown): string {
  return base64UrlString(JSON.stringify(obj));
}

function base64UrlString(s: string): string {
  return base64UrlBytes(new TextEncoder().encode(s));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
