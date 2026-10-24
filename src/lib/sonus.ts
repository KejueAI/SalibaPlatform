// Minimal Sonus REST client for the bits this app talks to.
//
// API key auth: Authorization: Bearer <SONUS_API_KEY>. Every POST carries an
// Idempotency-Key (Sonus requires one).
// Base URL defaults to https://api.sonus.ws/v1, override via SONUS_API_BASE.

const SONUS_BASE = process.env.SONUS_API_BASE || "https://api.sonus.ws/v1";

// api.sonus.ws advertises an AAAA record that some networks can't reach; cap
// each request so a dead route fails fast instead of hanging the webhook.
const REQUEST_TIMEOUT_MS = 8000;

function authHeaders(): HeadersInit {
  const key = process.env.SONUS_API_KEY;
  if (!key) throw new Error("SONUS_API_KEY is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export function isSonusConfigured(): boolean {
  return Boolean(process.env.SONUS_API_KEY);
}

export interface SonusCallSummary {
  id: string;
}

// The caller's in-progress call, matched on exact caller number (E.164).
export async function findLiveCallByCaller(
  callerNumber: string,
): Promise<SonusCallSummary | null> {
  const u = new URL(`${SONUS_BASE}/calls`);
  u.searchParams.set("caller_number", callerNumber);
  u.searchParams.set("caller_match", "is");
  u.searchParams.set("status", "live");
  u.searchParams.set("limit", "1");

  const res = await fetch(u, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Sonus calls lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: SonusCallSummary[] };
  return json.data?.[0] ?? null;
}

export type InjectUrgency = "immediate" | "soon" | "later";

// Queues a system message the agent sees mid-call. `idempotencyKey` should be
// stable per source event (e.g. the Twilio MessageSid) so a retried webhook
// can't inject the same text twice.
export async function injectContextIntoCall(
  callId: string,
  content: string,
  idempotencyKey: string,
  urgency: InjectUrgency = "soon",
): Promise<{ ok: boolean; status: number; body?: string }> {
  const res = await fetch(`${SONUS_BASE}/calls/${callId}/context`, {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ content, urgency }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, body: await res.text() };
}
