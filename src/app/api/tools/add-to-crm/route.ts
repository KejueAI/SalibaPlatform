// POST /api/tools/add-to-crm
//
// Webhook receiver for the Kejue voice agent. On `call.analyzed`, syncs the
// caller into DriveCentric: finds-or-creates the customer (via deal upsert),
// attaches a note containing the call summary + a link back to the Kejue log,
// and optionally schedules an appointment if the agent extracted one.
//
// Other event types (`call.started`, `call.ended`, campaign.*) are accepted
// and acknowledged with 204 — we only act on `call.analyzed` so we have the
// LLM-derived summary, outcome, and structured_data.
//
// Auth: HMAC-SHA256 signature in `X-Kejue-Signature` over
// `${X-Kejue-Timestamp}.${rawBody}` using KEJUE_WEBHOOK_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cars, events } from "@/db/schema";
import type { Car } from "@/db/schema";
import { verifyKejueWebhook } from "@/lib/webhook-verify";
import {
  createAppointment,
  createNote,
  findIdentifier,
  searchCustomers,
  upsertDeal,
  type DcAppointmentType,
  type DcDealPayload,
} from "@/lib/drivecentric";

// ─── Types ───────────────────────────────────────────────────────────────────

// Kejue's `call.analyzed` envelope. The shape that arrives from the test-webhook
// button on the Kejue dashboard is a superset of what the public docs describe,
// so we accept both:
//   - `call.structured_data` (docs) OR `call.extracted_data` (test webhook)
//   - `contact.name` (docs) OR `contact.first_name`/`last_name`/`full_name` (test webhook)
//   - `contact.status` may be a string (docs) or a nested object (test webhook)
interface KejueContact {
  id: string;
  name?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  status?: string | { status?: string; score?: number };
}

interface KejueCallAnalyzedData {
  call: {
    id: string;
    status?: string;
    summary?: string;
    outcome_id?: string;
    score?: number;
    duration_seconds?: number;
    structured_data?: Record<string, unknown>;
    extracted_data?: Record<string, unknown>;
  };
  contact: KejueContact;
  conversation?: {
    id: string;
    started_at?: string;
    ended_at?: string;
  };
}

interface KejueWebhookEnvelope {
  event: string;
  event_id: string;
  workspace_id?: string;
  timestamp: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALLOWED_APPOINTMENT_TYPES: ReadonlySet<DcAppointmentType> = new Set([
  "Sales",
  "Delivery",
  "Service",
  "General",
  "TestDrive",
]);

const LEAD_QUALITY_TO_STAGE: Record<string, NonNullable<DcDealPayload["deal"]["stage"]>> = {
  hot: "Engaged",
  warm: "Engaged",
  cold: "Lead",
  not_interested: "Dead",
};

const NOTE_MAX_LEN = 1000; // per DriveCentric Notes API
const ACTIVITY_CONTENT_MAX_LEN = 2000;
const COMMENTS_MAX_LEN = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|1)$/i.test(v.trim());
  return false;
}

function splitName(full: string | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Unknown", lastName: "Unknown" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "Unknown" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function callLogUrl(callId: string): string {
  return `https://app.kejue.co/logs?call=${encodeURIComponent(callId)}`;
}

// DriveCentric's Customer Phones validator only accepts 10 raw digits
// (`xxxxxxxxxx`) — Kejue sends E.164 (`+15551234567`). Strip everything
// non-numeric and keep the last 10 digits. Returns null if we can't form
// a valid 10-digit number, in which case we omit the phone entirely
// (better than failing the whole upsert).
function normalizePhoneForDc(phone: string | undefined): string | null {
  if (!phone) return null;
  const last10 = phone.replace(/\D/g, "").slice(-10);
  return last10.length === 10 ? last10 : null;
}

// Best-effort first/last name resolution that prefers, in order:
//   1. agent-extracted fields (structured_data.customer_first_name / _last_name)
//   2. Kejue's split contact fields (contact.first_name / contact.last_name)
//   3. splitting contact.full_name or contact.name
function resolveName(
  contact: KejueContact,
  structured: Record<string, unknown>
): { firstName: string; lastName: string } {
  const fn =
    str(structured.customer_first_name) ?? str(contact.first_name);
  const ln =
    str(structured.customer_last_name) ?? str(contact.last_name);
  if (fn && ln) return { firstName: fn, lastName: ln };

  const split = splitName(contact.full_name ?? contact.name);
  return {
    firstName: fn ?? split.firstName,
    lastName: ln ?? split.lastName,
  };
}

// ─── Customer lookup ─────────────────────────────────────────────────────────

async function findExistingCustomerId(
  contact: KejueContact,
  structured: Record<string, unknown>
): Promise<string | null> {
  // 1) Phone (E.164 from Kejue), then last-10 as a fallback.
  const phone = contact.phone;
  if (phone) {
    let hits = await searchCustomers({ phone });
    if (hits.length > 0) return hits[0].id;

    const last10 = phone.replace(/\D/g, "").slice(-10);
    if (last10.length === 10 && last10 !== phone) {
      hits = await searchCustomers({ phone: last10 });
      if (hits.length > 0) return hits[0].id;
    }
  }

  // 2) Email.
  const email = str(structured.customer_email) ?? contact.email;
  if (email) {
    const hits = await searchCustomers({ email });
    if (hits.length > 0) return hits[0].id;
  }

  // 3) First + last name. Prefer Kejue's split fields, then fall back to
  //    splitting contact.full_name / contact.name.
  const { firstName, lastName } = resolveName(contact, structured);
  if (firstName !== "Unknown" && lastName !== "Unknown") {
    const hits = await searchCustomers({ firstName, lastName });
    if (hits.length > 0) return hits[0].id;
  }

  return null;
}

// ─── Deal payload construction ───────────────────────────────────────────────

function buildDealPayload(opts: {
  partnerKey: string;
  existingCustomerCrmId: string | null;
  contact: KejueContact;
  structured: Record<string, unknown>;
  car: Car | null;
  callId: string;
  callSummary: string | undefined;
  callEndedAt: string;
  salespersonCrmId: string | undefined;
}): DcDealPayload {
  const {
    partnerKey,
    existingCustomerCrmId,
    contact,
    structured,
    car,
    callId,
    callSummary,
    callEndedAt,
    salespersonCrmId,
  } = opts;

  // Customer name — prefer agent-extracted fields, then Kejue's split contact
  // fields, then split contact.full_name / contact.name.
  const { firstName, lastName } = resolveName(contact, structured);
  const email = str(structured.customer_email) ?? contact.email;

  const stageKey = String(structured.lead_quality ?? "").toLowerCase();
  const stage = LEAD_QUALITY_TO_STAGE[stageKey] ?? "Lead";

  // Customer identifiers: include CrmId when known so DriveCentric updates
  // the existing record instead of creating a new one.
  const customerIdentifiers: DcDealPayload["deal"]["customers"][number]["identifiers"] = [
    { type: "PartnerId", value: `cust_${partnerKey}` },
  ];
  if (existingCustomerCrmId) {
    customerIdentifiers.unshift({ type: "CrmId", value: existingCustomerCrmId });
  }

  // DriveCentric requires phones in 10-digit format (xxxxxxxxxx). Drop the
  // phone if we can't normalize cleanly rather than failing the whole upsert.
  const dcPhone = normalizePhoneForDc(contact.phone);
  const phones: NonNullable<DcDealPayload["deal"]["customers"][number]["phones"]> =
    dcPhone ? [{ type: "Mobile", value: dcPhone }] : [];
  const emails: NonNullable<DcDealPayload["deal"]["customers"][number]["emails"]> =
    email ? [{ type: "Home", value: email }] : [];

  // Vehicle interest from our local cars table (looked up by stock_id).
  const vehicleInterests: NonNullable<DcDealPayload["deal"]["vehicleInterests"]> = [];
  if (car) {
    vehicleInterests.push({
      priority: 1,
      // We don't track new/used in our schema; default to Used (the dealership's
      // primary inventory). Override later via the dashboard if needed.
      stockType: "Used",
      vehicle: {
        identifiers: [{ type: "PartnerId", value: `vi_${partnerKey}` }],
        vin: car.vin ?? null,
        stockNumber: car.stockId,
        year: car.year,
        make: car.make,
        model: car.model,
        trim: car.trim ?? null,
        mileage: car.mileage ?? null,
        exteriorColor: car.color ?? null,
      },
    });
  }

  // Trade-in (only if the agent extracted enough of the basics).
  const tradeIns: NonNullable<DcDealPayload["deal"]["tradeIns"]> = [];
  const tradeYear = num(structured.trade_year);
  const tradeMake = str(structured.trade_make);
  const tradeModel = str(structured.trade_model);
  if (bool(structured.has_trade_in) && tradeYear && tradeMake && tradeModel) {
    tradeIns.push({
      vehicle: {
        identifiers: [{ type: "PartnerId", value: `ti_${partnerKey}` }],
        vin: str(structured.trade_vin) ?? null,
        year: tradeYear,
        make: tradeMake,
        model: tradeModel,
        mileage: num(structured.trade_mileage) ?? null,
      },
      payoffAmount: num(structured.trade_payoff) ?? null,
    });
  }

  // Call activity (requires a salesperson CrmId — skip if none configured).
  const activities: NonNullable<DcDealPayload["deal"]["activities"]> = [];
  if (salespersonCrmId) {
    activities.push({
      identifiers: [{ type: "PartnerId", value: `act_${callId}` }],
      when: callEndedAt,
      user: { identifiers: [{ type: "CrmId", value: salespersonCrmId }] },
      title: "Inbound voice call (Kejue)",
      content: truncate(callSummary, ACTIVITY_CONTENT_MAX_LEN) ?? "",
    });
  }

  const deal: DcDealPayload["deal"] = {
    identifiers: [{ type: "PartnerId", value: `deal_${partnerKey}` }],
    source: { type: "Phone", description: "Kejue voice agent" },
    stage,
    customers: [
      {
        identifiers: customerIdentifiers,
        isPrimaryBuyer: true,
        type: "Individual",
        firstName,
        lastName,
        phones,
        emails,
      },
    ],
    vehicleInterests: vehicleInterests.length > 0 ? vehicleInterests : null,
    tradeIns: tradeIns.length > 0 ? tradeIns : null,
    activities: activities.length > 0 ? activities : null,
    comments: truncate(callSummary, COMMENTS_MAX_LEN) ?? null,
  };

  if (salespersonCrmId) {
    deal.salesperson1 = { identifiers: [{ type: "CrmId", value: salespersonCrmId }] };
  }

  return { deal };
}

// ─── Note + appointment building ─────────────────────────────────────────────

function buildNoteDescription(call: KejueCallAnalyzedData["call"]): string {
  const parts: string[] = [];
  if (call.summary) parts.push(call.summary);

  const meta: string[] = [];
  if (call.outcome_id) meta.push(`Outcome: ${call.outcome_id}`);
  if (typeof call.score === "number") meta.push(`Score: ${call.score}`);
  if (typeof call.duration_seconds === "number") {
    meta.push(`Duration: ${call.duration_seconds}s`);
  }
  if (meta.length > 0) parts.push(meta.join(" · "));

  parts.push("Call log: {Url}");

  return truncate(parts.filter(Boolean).join("\n\n"), NOTE_MAX_LEN) ?? "{Url}";
}

interface PlannedAppointment {
  type: DcAppointmentType;
  appointmentDate: string;
  notes?: string;
}

function planAppointment(
  structured: Record<string, unknown>
): PlannedAppointment | null {
  if (!bool(structured.wants_appointment)) return null;

  const raw = str(structured.appointment_datetime);
  if (!raw) return null;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() <= Date.now()) return null; // API rejects past dates

  const requestedType = str(structured.appointment_type) as
    | DcAppointmentType
    | undefined;
  const type: DcAppointmentType =
    requestedType && ALLOWED_APPOINTMENT_TYPES.has(requestedType)
      ? requestedType
      : "TestDrive";

  return {
    type,
    appointmentDate: when.toISOString(),
    notes: str(structured.appointment_notes),
  };
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

async function findProcessedEvent(eventId: string) {
  return db.query.events.findFirst({
    where: and(
      eq(events.type, "crm_sync"),
      sql`summary->>'event_id' = ${eventId}`
    ),
  });
}

// ─── Core sync ───────────────────────────────────────────────────────────────

interface SyncResult {
  customerId: string;
  dealId: string | null;
  noteId: string | null;
  noteSkippedReason?: string;
  appointmentId: string | null;
  matchedStockId: string | null;
  newCustomer: boolean;
  appointmentSkippedReason?: string;
}

async function syncCallToCrm(
  payload: KejueWebhookEnvelope
): Promise<SyncResult> {
  const data = payload.data as KejueCallAnalyzedData;
  if (!data?.call?.id) {
    throw new Error("Missing data.call.id in payload");
  }
  if (!data.contact) {
    throw new Error("Missing data.contact in payload");
  }

  // The Kejue test-webhook payload uses `extracted_data`; the public docs
  // call the same field `structured_data`. Accept either.
  const structured = (data.call.structured_data ??
    data.call.extracted_data ??
    {}) as Record<string, unknown>;
  const callId = data.call.id;
  const conversationId = data.conversation?.id ?? callId;
  const partnerKey = conversationId; // stable key so retries hit the same deal/customer
  const callEndedAt = data.conversation?.ended_at ?? payload.timestamp ?? new Date().toISOString();

  // Look up the interested car in our inventory (by stock_id) so we can
  // populate vehicle interest with year/make/model/vin without re-extracting.
  const stockId = str(structured.interested_stock_id)?.toUpperCase();
  let car: Car | null = null;
  if (stockId) {
    car =
      (await db.query.cars.findFirst({
        where: eq(cars.stockId, stockId),
      })) ?? null;
  }

  const existingCustomerCrmId = await findExistingCustomerId(data.contact, structured);

  const dealPayload = buildDealPayload({
    partnerKey,
    existingCustomerCrmId,
    contact: data.contact,
    structured,
    car,
    callId,
    callSummary: data.call.summary,
    callEndedAt,
    salespersonCrmId: process.env.DRIVECENTRIC_DEFAULT_SALESPERSON_CRM_ID,
  });

  const upsertResp = await upsertDeal(dealPayload);

  const customerId =
    findIdentifier(upsertResp.deal?.customers?.[0]?.identifiers, "CrmId") ??
    existingCustomerCrmId;
  if (!customerId) {
    throw new Error(
      "Deal upsert succeeded but no customer CrmId returned — cannot attach note"
    );
  }
  const dealId = findIdentifier(upsertResp.deal?.identifiers, "CrmId");

  // Note: includes the Kejue call-log URL via the {Url} placeholder.
  // Don't fail the whole sync if the note leg fails (e.g. a DriveCentric 504) —
  // the deal is already committed, and we still want to attempt the appointment.
  let noteId: string | null = null;
  let noteSkippedReason: string | undefined;
  try {
    const note = await createNote(customerId, {
      description: buildNoteDescription(data.call),
      url: callLogUrl(callId),
      pinned: String(structured.lead_quality ?? "").toLowerCase() === "hot",
    });
    noteId = note.noteId;
  } catch (err) {
    noteSkippedReason = (err as Error).message;
    console.error(
      `[add-to-crm] note creation failed for customer ${customerId}, continuing: ${noteSkippedReason}`
    );
  }

  // Appointment, if the agent flagged one.
  let appointmentId: string | null = null;
  let appointmentSkippedReason: string | undefined;
  const planned = planAppointment(structured);
  if (planned) {
    try {
      const appt = await createAppointment(customerId, planned);
      appointmentId = appt.id;
    } catch (err) {
      // Don't fail the whole sync if only the appointment leg failed —
      // the customer + note are already in CRM.
      appointmentSkippedReason = (err as Error).message;
    }
  } else if (bool(structured.wants_appointment)) {
    appointmentSkippedReason = "wants_appointment=true but no valid appointment_datetime";
  }

  return {
    customerId,
    dealId,
    noteId,
    noteSkippedReason,
    appointmentId,
    matchedStockId: stockId ?? null,
    newCustomer: !existingCustomerCrmId,
    appointmentSkippedReason,
  };
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1) Read raw body BEFORE parsing so HMAC matches byte-for-byte.
  const rawBody = await request.text();

  // 2) Verify signature + timestamp freshness.
  const signature = request.headers.get("x-kejue-signature");
  const timestamp = request.headers.get("x-kejue-timestamp");
  const verification = verifyKejueWebhook(
    rawBody,
    signature,
    timestamp,
    process.env.KEJUE_WEBHOOK_SECRET
  );
  if (!verification.ok) {
    // 401 is a permanent failure — Kejue won't retry, which is what we want
    // for bad signatures. Stale timestamps also shouldn't be retried.
    return NextResponse.json(
      { error: "Unauthorized", reason: verification.reason },
      { status: 401 }
    );
  }

  // 3) Parse envelope.
  let payload: KejueWebhookEnvelope;
  try {
    payload = JSON.parse(rawBody) as KejueWebhookEnvelope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload?.event || !payload?.event_id) {
    return NextResponse.json(
      { error: "Missing event or event_id" },
      { status: 400 }
    );
  }

  // 4) Only act on call.analyzed; ack everything else so Kejue doesn't retry.
  if (payload.event !== "call.analyzed") {
    return new NextResponse(null, { status: 204 });
  }

  // 5) Idempotency: short-circuit duplicates without re-hitting DriveCentric.
  const already = await findProcessedEvent(payload.event_id);
  if (already) {
    return NextResponse.json({
      duplicate: true,
      event_id: payload.event_id,
      previous_status: already.status,
    });
  }

  // 6) Record a running event row (audit + visible on /dashboard/events).
  const [eventRow] = await db
    .insert(events)
    .values({
      type: "crm_sync",
      status: "running",
      summary: {
        event_id: payload.event_id,
        conversation_id:
          (payload.data as KejueCallAnalyzedData | undefined)?.conversation?.id ??
          null,
        call_id:
          (payload.data as KejueCallAnalyzedData | undefined)?.call?.id ?? null,
      },
    })
    .returning();

  // 7) Do the sync.
  try {
    const result = await syncCallToCrm(payload);
    await db
      .update(events)
      .set({
        status: "completed",
        summary: {
          event_id: payload.event_id,
          customer_id: result.customerId,
          deal_id: result.dealId,
          note_id: result.noteId,
          note_skipped_reason: result.noteSkippedReason ?? null,
          appointment_id: result.appointmentId,
          matched_stock_id: result.matchedStockId,
          new_customer: result.newCustomer,
          appointment_skipped_reason: result.appointmentSkippedReason ?? null,
        },
        completedAt: new Date(),
      })
      .where(eq(events.id, eventRow.id));

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await db
      .update(events)
      .set({
        status: "failed",
        errorMessage: message,
        completedAt: new Date(),
      })
      .where(eq(events.id, eventRow.id));

    // 5xx so Kejue retries (3 attempts w/ exponential backoff).
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
