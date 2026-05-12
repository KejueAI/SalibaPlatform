// Minimal Kejue Platform REST client for the bits this app talks to.
//
// API key auth: Authorization: Bearer <KEJUE_API_KEY>.
// Base URL defaults to https://api.kejue.co/api/v1, override via KEJUE_API_BASE.

const KEJUE_BASE = process.env.KEJUE_API_BASE || "https://api.kejue.co/api/v1";

function authHeaders(): HeadersInit {
  const key = process.env.KEJUE_API_KEY;
  if (!key) throw new Error("KEJUE_API_KEY is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export interface KejueContact {
  id: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface KejueCallSummary {
  id: string;
  status: string;
}

export async function findContactByPhone(
  phone: string,
): Promise<KejueContact | null> {
  const u = new URL(`${KEJUE_BASE}/contacts`);
  u.searchParams.set("search", phone);
  u.searchParams.set("limit", "5");

  const res = await fetch(u, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Kejue contacts lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { contacts?: KejueContact[] };
  const list = json.contacts ?? [];
  return list.find((c) => c.phone === phone) ?? list[0] ?? null;
}

export async function findActiveCallForContact(
  contactId: string,
): Promise<KejueCallSummary | null> {
  const u = new URL(`${KEJUE_BASE}/calls`);
  u.searchParams.set("contact_id", contactId);
  u.searchParams.set("status", "in_progress");
  u.searchParams.set("limit", "1");

  const res = await fetch(u, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Kejue calls lookup failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { calls?: KejueCallSummary[] };
  return json.calls?.[0] ?? null;
}

export type InjectUrgency = "immediate" | "soon" | "later";

export async function injectContextIntoCall(
  callId: string,
  text: string,
  urgency: InjectUrgency = "soon",
): Promise<{ ok: boolean; status: number; body?: string }> {
  const res = await fetch(`${KEJUE_BASE}/calls/${callId}/inject-context`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ text, urgency }),
  });
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, body: await res.text() };
}
