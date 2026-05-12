// POST /api/twilio/sms-inbound
//
// Twilio inbound-SMS webhook. When a customer texts the dealership's Twilio
// number while a Kejue voice call is in progress, we forward the SMS body
// into the live call as injected context — the agent receives it as a
// "data message" and can react to it naturally without breaking the call.
//
// Flow:
//   1. Verify X-Twilio-Signature against TWILIO_AUTH_TOKEN.
//   2. Resolve From → Kejue contact via /contacts?search=<phone>.
//   3. Find that contact's active call via /calls?contact_id=&status=in_progress.
//   4. POST /calls/{call_id}/inject-context with the SMS body.
//   5. Always 200 with empty TwiML — we never auto-reply.
//
// Edge cases (all answered with empty TwiML 200 so Twilio doesn't retry):
//   - No matching contact: log and drop.
//   - No active call: log and drop.
//   - Inject returns 409 (call ended between the lookup and the post): log and drop.

import { NextRequest } from "next/server";
import { validateTwilioSignature } from "@/lib/twilio-verify";
import {
  findActiveCallForContact,
  findContactByPhone,
  injectContextIntoCall,
} from "@/lib/kejue";

export const runtime = "nodejs";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function twimlResponse(status = 200): Response {
  return new Response(EMPTY_TWIML, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[twilio/sms-inbound] TWILIO_AUTH_TOKEN not configured");
    return new Response("Server misconfigured", { status: 500 });
  }

  // Read the raw form-encoded body and parse params for signature + use.
  const rawBody = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;

  // Reconstruct the public URL Twilio used. Trust X-Forwarded-* set by Railway.
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "";
  const fullUrl = `${proto}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`;

  const signature = request.headers.get("x-twilio-signature");
  if (!signature || !validateTwilioSignature(authToken, signature, fullUrl, params)) {
    console.warn("[twilio/sms-inbound] signature check failed", {
      hasSignature: Boolean(signature),
      url: fullUrl,
    });
    return new Response("Forbidden", { status: 403 });
  }

  const from = params.From;
  const body = (params.Body ?? "").trim();
  const messageSid = params.MessageSid;
  const numMedia = Number(params.NumMedia ?? "0") || 0;

  if (!from || !body) {
    console.warn("[twilio/sms-inbound] missing From or Body", { messageSid });
    return twimlResponse();
  }

  try {
    const contact = await findContactByPhone(from);
    if (!contact) {
      console.info("[twilio/sms-inbound] no Kejue contact for phone", {
        from,
        messageSid,
      });
      return twimlResponse();
    }

    const call = await findActiveCallForContact(contact.id);
    if (!call) {
      console.info("[twilio/sms-inbound] no active call for contact", {
        contactId: contact.id,
        from,
        messageSid,
      });
      return twimlResponse();
    }

    const mediaNote = numMedia > 0 ? ` (and sent ${numMedia} attachment${numMedia === 1 ? "" : "s"})` : "";
    const injectText = `The customer just texted you${mediaNote}: "${body}"`;

    const result = await injectContextIntoCall(call.id, injectText, "soon");
    if (!result.ok) {
      console.warn("[twilio/sms-inbound] inject-context failed", {
        callId: call.id,
        status: result.status,
        body: result.body,
        messageSid,
      });
    } else {
      console.info("[twilio/sms-inbound] injected SMS into call", {
        callId: call.id,
        contactId: contact.id,
        messageSid,
      });
    }
  } catch (err) {
    console.error("[twilio/sms-inbound] unexpected error", err);
  }

  return twimlResponse();
}
