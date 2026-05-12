// Twilio webhook signature verification.
//
// Twilio signs requests as: base64(HMAC-SHA1(authToken, URL + concat(sorted(key+value))))
// where `URL` is the full webhook URL including query string, and the form
// fields are sorted by key (lexicographically) and concatenated as `key+value`
// pairs with no separators.
//
// Spec: https://www.twilio.com/docs/usage/webhooks/webhooks-security

import crypto from "crypto";

export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join("");
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");

  const sigBuf = Buffer.from(signature, "utf-8");
  const expBuf = Buffer.from(expected, "utf-8");
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
