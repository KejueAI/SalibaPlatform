// POST /api/twilio/send-message
//
// Sends a preset SMS to a customer's phone number. We call this when a caller
// gets frustrated with — or hangs up on — the AI voice agent, so a human can
// follow up over text. The request only carries the destination number; the
// message body is preset server-side (not caller-controlled), so this endpoint
// can't be used to send arbitrary SMS.
//
// Request:  { "to": "+15551234567" }   // E.164
// Response: { "ok": true, "sid": "SM…", "status": "queued", "to": "+1…" }
//
// Auth: Bearer TOOL_API_KEY (same scheme as the /api/tools/* voice-agent tools).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isTwilioConfigured, sendSms } from "@/lib/twilio";

export const runtime = "nodejs";

// The message texted to a frustrated / dropped-off caller. Overridable via env
// so it can be tuned without a redeploy; the default below is the fallback.
const DEFAULT_MESSAGE =
  "Hi! Sorry we couldn't wrap things up on the phone. A member of our team " +
  "would be happy to help — just reply to this text and we'll take it from here.";

const PRESET_MESSAGE = process.env.TWILIO_FRUSTRATED_MESSAGE || DEFAULT_MESSAGE;

// E.164: a leading + followed by 1–15 digits, first digit non-zero.
const SendMessageSchema = z.object({
  to: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, "must be a phone number in E.164 format (e.g. +15551234567)"),
});

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: issue.code,
    message: issue.message,
  }));
}

export async function POST(request: NextRequest) {
  // API key auth (same scheme as /api/tools/*).
  const authHeader = request.headers.get("authorization");
  const apiKey = process.env.TOOL_API_KEY;
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isTwilioConfigured()) {
    console.error("[twilio/send-message] Twilio is not configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  // Parse JSON body.
  let rawBody: unknown;
  const text = await request.text();
  try {
    rawBody = JSON.parse(text);
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON body",
        details: [
          {
            field: "(body)",
            code: "invalid_json",
            message: "Request body must be valid JSON",
          },
        ],
      },
      { status: 400 }
    );
  }

  const parsed = SendMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: formatZodError(parsed.error) },
      { status: 400 }
    );
  }

  const { to } = parsed.data;

  try {
    const result = await sendSms(to, PRESET_MESSAGE);
    console.info("[twilio/send-message] sent", {
      to,
      sid: result.sid,
      status: result.status,
    });
    return NextResponse.json({
      ok: true,
      sid: result.sid,
      status: result.status,
      to: result.to,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error("[twilio/send-message] send failed", { to, error: message });
    // 502: the upstream (Twilio) rejected or was unreachable. The request
    // itself was well-formed, so this isn't a 4xx.
    return NextResponse.json(
      { error: "Failed to send message", detail: message },
      { status: 502 }
    );
  }
}
