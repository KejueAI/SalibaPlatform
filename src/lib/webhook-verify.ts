// Kejue webhook signature verification.
//
// HMAC-SHA256 over `${timestamp}.${rawBody}` with the shared secret.
// Header format: `X-Kejue-Signature: sha256=<hex>` and `X-Kejue-Timestamp: <unix-ms>`.
//
// IMPORTANT: pass the raw request body string — do NOT re-serialize parsed JSON,
// or the byte-level signature will not match.

import crypto from "crypto";

export interface VerifyResult {
  ok: boolean;
  reason?:
    | "missing_secret"
    | "missing_signature"
    | "missing_timestamp"
    | "bad_timestamp"
    | "stale_timestamp"
    | "bad_signature";
}

/**
 * Verifies a Kejue webhook signature in constant time and rejects stale
 * requests. `maxAgeMs` defaults to 5 minutes per the Kejue best-practices guide.
 */
export function verifyKejueWebhook(
  rawBody: string,
  signature: string | null | undefined,
  timestamp: string | null | undefined,
  secret: string | undefined,
  maxAgeMs: number = 5 * 60 * 1000
): VerifyResult {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!timestamp) return { ok: false, reason: "missing_timestamp" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(Date.now() - ts) > maxAgeMs) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const expected = `sha256=${expectedHex}`;

  // Length-mismatched buffers throw in timingSafeEqual, so guard first.
  if (expected.length !== signature.length) {
    return { ok: false, reason: "bad_signature" };
  }

  try {
    const equal = crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
    return equal ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
