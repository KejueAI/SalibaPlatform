// Minimal Twilio REST client for sending outbound SMS.
//
// We call the Messages API directly with fetch (no twilio SDK dependency),
// authenticating with HTTP Basic over Account SID + Auth Token:
//
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//   Authorization: Basic base64(AccountSid:AuthToken)
//   Content-Type: application/x-www-form-urlencoded
//   Body: To=<E.164>&Body=<text>&(MessagingServiceSid=... | From=...)
//
// Sender: prefer TWILIO_MESSAGING_SERVICE_SID (a Messaging Service handles
// number pooling / compliance) and fall back to a single TWILIO_FROM_NUMBER.
//
// Spec: https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface SendSmsResult {
  sid: string;
  status: string;
  to: string;
}

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  fromNumber?: string;
}

// Read + validate the Twilio env config. Throws a clear error (rather than
// letting the API reject the request) when required values are missing so the
// route can return a 500 the operator can act on.
function readConfig(): TwilioConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken) {
    throw new Error(
      "Twilio not configured: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required"
    );
  }
  if (!messagingServiceSid && !fromNumber) {
    throw new Error(
      "Twilio not configured: set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER"
    );
  }
  return { accountSid, authToken, messagingServiceSid, fromNumber };
}

// True when Twilio is configured well enough to send — lets the route surface a
// 500 "misconfigured" before attempting a send.
export function isTwilioConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

// Send a single SMS. `to` must be E.164 (validated by the caller). Returns the
// created message's SID + status, or throws on any Twilio error.
export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const cfg = readConfig();

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("Body", body);
  if (cfg.messagingServiceSid) {
    form.set("MessagingServiceSid", cfg.messagingServiceSid);
  } else {
    form.set("From", cfg.fromNumber!);
  }

  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString(
    "base64"
  );

  const res = await fetch(
    `${TWILIO_API_BASE}/Accounts/${cfg.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    }
  );

  const json = (await res.json().catch(() => null)) as
    | { sid?: string; status?: string; message?: string; code?: number }
    | null;

  if (!res.ok) {
    // Twilio returns { code, message, more_info } on error — surface both the
    // HTTP status and Twilio's own error code/message for debugging.
    const detail = json?.message
      ? `${json.message}${json.code ? ` (code ${json.code})` : ""}`
      : await res.text().catch(() => "");
    throw new Error(`Twilio send failed: ${res.status} ${detail}`.trim());
  }

  return {
    sid: json?.sid ?? "",
    status: json?.status ?? "queued",
    to,
  };
}
