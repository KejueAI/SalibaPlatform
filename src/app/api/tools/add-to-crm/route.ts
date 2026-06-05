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
  getStore,
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
// (`xxxxxxxxxx`) — Kejue often sends E.164 (`+15551234567`) or the agent may
// extract a formatted phone_number. Strip everything non-numeric and keep the
// last 10 digits. Returns null if we can't form a valid 10-digit number, in
// which case we omit the phone entirely (better than failing the whole upsert).
function last10Digits(phone: string): string | null {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  return last10.length === 10 ? last10 : null;
}

function normalizePhoneForDc(phone: string | undefined): string | null {
  return phone ? last10Digits(phone) : null;
}

function resolvePhoneForDc(
  contact: KejueContact,
  structured: Record<string, unknown>
): string | null {
  return (
    normalizePhoneForDc(str(structured.phone_number)) ??
    normalizePhoneForDc(contact.phone)
  );
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

async function findCustomerIdByPhone(phone: string): Promise<string | null> {
  let hits = await searchCustomers({ phone });
  if (hits.length > 0) return hits[0].id;

  const last10 = last10Digits(phone);
  if (last10 && last10 !== phone) {
    hits = await searchCustomers({ phone: last10 });
    if (hits.length > 0) return hits[0].id;
  }

  return null;
}

async function findExistingCustomerId(
  contact: KejueContact,
  structured: Record<string, unknown>
): Promise<string | null> {
  // 1) Phone: prefer the agent-extracted `phone_number`, then Kejue's
  //    contact.phone. Search the raw value first, then last-10 as a fallback.
  const extractedPhone = str(structured.phone_number);
  if (extractedPhone) {
    const id = await findCustomerIdByPhone(extractedPhone);
    if (id) return id;
  }

  const contactPhone = str(contact.phone);
  if (contactPhone && contactPhone !== extractedPhone) {
    const id = await findCustomerIdByPhone(contactPhone);
    if (id) return id;
  }

  // 2) Email.
  const email = str(structured.customer_email) ?? str(contact.email);
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

// ─── Vehicle interest resolution ─────────────────────────────────────────────

// A vehicle interest ready to drop into the deal payload. Resolved either from
// our local inventory (matched by stock #) or from agent-extracted fields when
// the caller's vehicle isn't in our `cars` table.
interface ResolvedVehicleInterest {
  stockType: "New" | "Used";
  matchedStockId: string | null; // set only when a `cars` row was found
  vehicle: {
    vin: string | null;
    stockNumber: string | null;
    year: number;
    make: string;
    model: string;
    trim: string | null;
    mileage: number | null;
    exteriorColor: string | null;
    interiorColor: string | null;
  };
}

// Normalize the agent's free-form new/used signal. Our `cars` table doesn't
// track condition, so without an explicit signal we default to Used (the
// dealership's primary inventory) — overridable later in the dashboard.
function normalizeStockType(raw: string | undefined): "New" | "Used" {
  const cleaned = (raw ?? "").replace(/[\s_-]/g, "").toLowerCase();
  if (cleaned === "new") return "New";
  return "Used"; // used / preowned / cpo / unspecified
}

// Resolve the caller's single vehicle of interest into a payload-ready vehicle.
// When `interested_stock_id` matches our local inventory (cars table) that row
// supplies year/make/model/etc.; otherwise we fall back to the agent's flat
// `interested_*` fields so a vehicle that isn't in our lot still reaches the
// CRM. Returns null when we can't form the API-required year/make/model rather
// than failing the whole upsert.
async function resolveVehicleInterest(
  structured: Record<string, unknown>
): Promise<ResolvedVehicleInterest | null> {
  const stockId = str(structured.interested_stock_id)?.toUpperCase();
  let car: Car | null = null;
  if (stockId) {
    car =
      (await db.query.cars.findFirst({
        where: eq(cars.stockId, stockId),
      })) ?? null;
  }

  const year = car?.year ?? num(structured.interested_year);
  const make = car?.make ?? str(structured.interested_make);
  const model = car?.model ?? str(structured.interested_model);
  // DriveCentric requires year/make/model — bail if we can't form a vehicle.
  if (!year || !make || !model) return null;

  return {
    stockType: normalizeStockType(str(structured.interested_stock_type)),
    matchedStockId: car ? car.stockId : null,
    vehicle: {
      vin: car?.vin ?? str(structured.interested_vin) ?? null,
      // Keep the stock # even when it didn't match our table — DriveCentric's
      // own inventory is a superset of our mirror, so it may still match there.
      stockNumber: car?.stockId ?? stockId ?? null,
      year,
      make,
      model,
      trim: car?.trim ?? str(structured.interested_trim) ?? null,
      mileage: car?.mileage ?? num(structured.interested_mileage) ?? null,
      exteriorColor: car?.color ?? str(structured.interested_exterior_color) ?? null,
      interiorColor: str(structured.interested_interior_color) ?? null,
    },
  };
}

// ─── Deal payload construction ───────────────────────────────────────────────

function buildDealPayload(opts: {
  partnerKey: string;
  existingCustomerCrmId: string | null;
  contact: KejueContact;
  structured: Record<string, unknown>;
  resolvedInterest: ResolvedVehicleInterest | null;
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
    resolvedInterest,
    callId,
    callSummary,
    callEndedAt,
    salespersonCrmId,
  } = opts;

  // Customer name — prefer agent-extracted fields, then Kejue's split contact
  // fields, then split contact.full_name / contact.name.
  const { firstName, lastName } = resolveName(contact, structured);
  const email = str(structured.customer_email) ?? str(contact.email);

  // All inbound callers enter the pipeline as a plain Lead — we don't auto-
  // advance to Engaged off the agent's lead_quality read. (lead_quality still
  // drives note pinning below.)
  const stage = "Lead" as const;

  // Customer identifiers: include CrmId when known so DriveCentric updates
  // the existing record instead of creating a new one.
  const customerIdentifiers: DcDealPayload["deal"]["customers"][number]["identifiers"] = [
    { type: "PartnerId", value: `cust_${partnerKey}` },
  ];
  if (existingCustomerCrmId) {
    customerIdentifiers.unshift({ type: "CrmId", value: existingCustomerCrmId });
  }

  // DriveCentric requires phones in 10-digit format (xxxxxxxxxx). Prefer the
  // agent-extracted phone_number, fall back to contact.phone, and drop the phone
  // if neither can normalize cleanly rather than failing the whole upsert.
  const dcPhone = resolvePhoneForDc(contact, structured);
  const phones: NonNullable<DcDealPayload["deal"]["customers"][number]["phones"]> =
    dcPhone ? [{ type: "Mobile", value: dcPhone }] : [];
  const emails: NonNullable<DcDealPayload["deal"]["customers"][number]["emails"]> =
    email ? [{ type: "Home", value: email }] : [];

  // Vehicle interest — resolved upstream from inventory and/or agent-extracted
  // fields. Stable PartnerId so retries update rather than duplicate.
  const vehicleInterests: NonNullable<DcDealPayload["deal"]["vehicleInterests"]> = [];
  if (resolvedInterest) {
    vehicleInterests.push({
      priority: 1,
      stockType: resolvedInterest.stockType,
      vehicle: {
        identifiers: [{ type: "PartnerId", value: `vi_${partnerKey}` }],
        vin: resolvedInterest.vehicle.vin,
        stockNumber: resolvedInterest.vehicle.stockNumber,
        year: resolvedInterest.vehicle.year,
        make: resolvedInterest.vehicle.make,
        model: resolvedInterest.vehicle.model,
        trim: resolvedInterest.vehicle.trim,
        mileage: resolvedInterest.vehicle.mileage,
        exteriorColor: resolvedInterest.vehicle.exteriorColor,
        interiorColor: resolvedInterest.vehicle.interiorColor,
      },
    });
  }

  // Trade-in (only if the agent extracted enough of the basics).
  const tradeIns: NonNullable<DcDealPayload["deal"]["tradeIns"]> = [];
  const tradeYear = num(structured.trade_year);
  const tradeMake = str(structured.trade_make);
  const tradeModel = str(structured.trade_model);
  if (bool(structured.has_trade_in) && tradeYear && tradeMake && tradeModel) {
    const lienholderName = str(structured.trade_lienholder);
    tradeIns.push({
      vehicle: {
        identifiers: [{ type: "PartnerId", value: `ti_${partnerKey}` }],
        vin: str(structured.trade_vin) ?? null,
        year: tradeYear,
        make: tradeMake,
        model: tradeModel,
        trim: str(structured.trade_trim) ?? null,
        mileage: num(structured.trade_mileage) ?? null,
        exteriorColor: str(structured.trade_exterior_color) ?? null,
      },
      payoffAmount: num(structured.trade_payoff) ?? null,
      // Caller-stated lienholder ("I still owe Chase"); other lienholder fields
      // (account, payoff date, etc.) aren't something a voice caller provides.
      lienholder: lienholderName ? { name: lienholderName } : undefined,
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

type AppointmentPlan =
  | { ok: true; appointment: PlannedAppointment }
  | { ok: false; reason: string };

// Match the agent's free-form appointment_type (e.g. "sales", "test drive")
// to a DriveCentric enum value case-insensitively, falling back to TestDrive.
function normalizeAppointmentType(raw: string | undefined): DcAppointmentType {
  if (!raw) return "TestDrive";
  const cleaned = raw.replace(/[\s_-]/g, "").toLowerCase();
  for (const allowed of ALLOWED_APPOINTMENT_TYPES) {
    if (allowed.toLowerCase() === cleaned) return allowed;
  }
  return "TestDrive";
}

// Store timezone — the dealership is in Ewing, New Jersey. The caller speaks
// times in the store's local day ("5pm their time"), so every appointment
// wall-clock is interpreted here. America/New_York observes DST, so we resolve
// the offset per-instant rather than assuming a fixed one.
const APPOINTMENT_TZ = process.env.DRIVECENTRIC_TZ || "America/New_York";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Today's calendar date (year/0-based month/day) in the given timezone.
function todayInTz(tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  return { year: m.year, month: m.month - 1, day: m.day };
}

// Offset (ms) of `tz` from UTC at the given instant, DST-aware.
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return asUTC - at.getTime();
}

// Format `instant` as an ISO-8601 string in `tz` WITH an explicit offset
// (e.g. "2026-06-01T13:00:00-04:00"). DriveCentric reads the literal clock in
// the string rather than converting from UTC, so we must send the store-local
// wall-clock, not a "Z" UTC time. The offset keeps it unambiguous for any
// parser (literal readers and converting readers both land on the same time).
function toZonedIso(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  const offMs = tzOffsetMs(instant, tz); // negative west of UTC
  const sign = offMs <= 0 ? "-" : "+";
  const abs = Math.abs(offMs);
  const oh = String(Math.floor(abs / 3_600_000)).padStart(2, "0");
  const om = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, "0");
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:${m.second}${sign}${oh}:${om}`;
}

// Treat (year, month, day, hour, minute) as a wall-clock time in `tz` and
// return the corresponding UTC instant. Two passes settle the DST offset.
function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): Date {
  const guess = Date.UTC(year, month, day, hour, minute, 0);
  let offset = tzOffsetMs(new Date(guess), tz);
  offset = tzOffsetMs(new Date(guess - offset), tz);
  return new Date(guess - offset);
}

interface WallClock {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  hadTime: boolean;
}

// Pull the literal wall-clock the model typed, ignoring any trailing Z/offset.
// The model is unreliable about timezones (it appends "Z" to local times), so
// we trust only the digits and re-bind them to the store timezone ourselves.
function parseWallClock(raw: string): WallClock | null {
  const m = raw
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?/);
  if (!m) return null;
  const hadTime = m[4] !== undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]) - 1,
    day: Number(m[3]),
    hour: hadTime ? Number(m[4]) : 12, // default to noon if no time given
    minute: hadTime ? Number(m[5]) : 0,
    hadTime,
  };
}

function planAppointment(
  structured: Record<string, unknown>
): AppointmentPlan {
  if (!bool(structured.wants_appointment)) {
    return { ok: false, reason: "wants_appointment is not true" };
  }

  const raw = str(structured.appointment_datetime);
  if (!raw) {
    return { ok: false, reason: "wants_appointment=true but appointment_datetime is missing" };
  }
  const wall = parseWallClock(raw);
  if (!wall) {
    return { ok: false, reason: `appointment_datetime is unparseable: ${raw}` };
  }

  // The model's absolute date is unreliable (training-era year bias means it
  // emits e.g. 2024-05-20 — a Monday in 2024, but the wrong year now). What it
  // DOES get right is the weekday the caller asked for. So we trust the
  // weekday, not the date: take the day-of-week from the model's date and snap
  // to the next occurrence of that weekday from today, keeping the time.
  const targetDow = new Date(
    Date.UTC(wall.year, wall.month, wall.day)
  ).getUTCDay();

  const today = todayInTz(APPOINTMENT_TZ);
  // Iterate forward over calendar days (UTC midnight is a safe cursor for
  // date-only math; the real instant is resolved per-day in the store tz).
  const cursor = Date.UTC(today.year, today.month, today.day);
  let fixed: Date | null = null;
  for (let i = 0; i < 8; i++) {
    const day = new Date(cursor + i * 86_400_000);
    if (day.getUTCDay() !== targetDow) continue;
    const instant = wallClockToInstant(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      wall.hour,
      wall.minute,
      APPOINTMENT_TZ
    );
    // Skip today's slot if its time has already passed — take next week's.
    if (instant.getTime() > Date.now()) {
      fixed = instant;
      break;
    }
  }
  if (!fixed) {
    return {
      ok: false,
      reason: `could not resolve a future ${WEEKDAYS[targetDow]} from "${raw}"`,
    };
  }

  const appointmentDate = toZonedIso(fixed, APPOINTMENT_TZ);
  console.log(
    `[add-to-crm] appointment: caller asked for ${WEEKDAYS[targetDow]} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")} (from model date "${raw}")` +
      (wall.hadTime ? "" : " — no time given, defaulted to noon") +
      ` -> next ${WEEKDAYS[targetDow]} ${appointmentDate} (${APPOINTMENT_TZ})`
  );

  return {
    ok: true,
    appointment: {
      type: normalizeAppointmentType(str(structured.appointment_type)),
      appointmentDate,
      notes: str(structured.appointment_notes),
    },
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

  // Resolve the caller's vehicle of interest — matched against our inventory by
  // stock # where possible, otherwise built from the agent's extracted fields
  // so a vehicle that isn't in our lot still reaches DriveCentric.
  const resolvedInterest = await resolveVehicleInterest(structured);
  const matchedStockId = resolvedInterest?.matchedStockId ?? null;

  const existingCustomerCrmId = await findExistingCustomerId(data.contact, structured);

  const dealPayload = buildDealPayload({
    partnerKey,
    existingCustomerCrmId,
    contact: data.contact,
    structured,
    resolvedInterest,
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
  if (planned.ok) {
    console.log(
      `[add-to-crm] appointment: creating ${planned.appointment.type} for customer ${customerId} at ${planned.appointment.appointmentDate}`
    );
    try {
      // Assign the appointment to the default salesperson. DriveCentric
      // validates appointment times against the assigned user's working hours,
      // so an unassigned appointment can be rejected as "outside business
      // hours" even for a normal slot.
      const salespersonCrmId = process.env.DRIVECENTRIC_DEFAULT_SALESPERSON_CRM_ID;
      const appt = await createAppointment(customerId, {
        ...planned.appointment,
        ...(salespersonCrmId
          ? { scheduledForUserId: salespersonCrmId, createdByUserId: salespersonCrmId }
          : {}),
      });
      appointmentId = appt.id;
    } catch (err) {
      // Don't fail the whole sync if only the appointment leg failed —
      // the customer + note are already in CRM.
      appointmentSkippedReason = (err as Error).message;
      console.error(
        `[add-to-crm] appointment: creation failed for customer ${customerId}: ${appointmentSkippedReason}`
      );
      // Diagnostic: dump the store's configured timezone + business hours so we
      // can see why a normal slot is rejected as "outside business hours".
      try {
        const store = await getStore();
        console.log(
          `[add-to-crm] appointment: store config for diagnosis -> ${JSON.stringify(store)}`
        );
      } catch (storeErr) {
        console.error(
          `[add-to-crm] appointment: could not fetch store config: ${(storeErr as Error).message}`
        );
      }
    }
  } else {
    appointmentSkippedReason = planned.reason;
    // Only worth flagging loudly when the agent actually wanted an appointment.
    if (bool(structured.wants_appointment)) {
      console.warn(
        `[add-to-crm] appointment: skipped for customer ${customerId} — ${planned.reason}`
      );
    }
  }

  return {
    customerId,
    dealId,
    noteId,
    noteSkippedReason,
    appointmentId,
    matchedStockId,
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
