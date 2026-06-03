// DriveCentric Partner API client.
// - Caches the bearer token in-process and refreshes lazily.
// - All write helpers throw on non-2xx with a truncated body for diagnostics.

const BASE = process.env.DRIVECENTRIC_BASE_URL ?? "";
const STORE_ID = process.env.DRIVECENTRIC_STORE_ID ?? "";
const API_VERSION = process.env.DRIVECENTRIC_API_VERSION || "2";

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cachedToken: TokenCache | null = null;

function ensureConfig() {
  if (!BASE) throw new Error("DRIVECENTRIC_BASE_URL not set");
  if (!STORE_ID) throw new Error("DRIVECENTRIC_STORE_ID not set");
  if (!process.env.DRIVECENTRIC_CLIENT_ID)
    throw new Error("DRIVECENTRIC_CLIENT_ID not set");
  if (!process.env.DRIVECENTRIC_CLIENT_SECRET)
    throw new Error("DRIVECENTRIC_CLIENT_SECRET not set");
}

async function fetchToken(): Promise<TokenCache> {
  ensureConfig();
  console.log("[drivecentric] auth token: requesting new token");
  const res = await fetch(
    `${BASE}/api/authentication/token?api-version=${API_VERSION}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: process.env.DRIVECENTRIC_CLIENT_ID,
        clientSecret: process.env.DRIVECENTRIC_CLIENT_SECRET,
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[drivecentric] auth token: failed (${res.status})`);
    throw new Error(
      `DriveCentric auth failed (${res.status}): ${body.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as {
    idToken?: string;
    tokenType?: string;
    expiresInSeconds?: number;
  };
  if (!data.idToken) {
    console.error("[drivecentric] auth token: response missing idToken");
    throw new Error("DriveCentric auth response missing idToken");
  }
  // Default to 1h if the server didn't tell us, with a 60s safety buffer applied at read time.
  const ttl = (data.expiresInSeconds ?? 3600) * 1000;
  console.log(
    `[drivecentric] auth token: acquired (expires in ${Math.round(ttl / 1000)}s)`
  );
  return { token: data.idToken, expiresAt: Date.now() + ttl };
}

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token;
  }
  cachedToken = await fetchToken();
  return cachedToken.token;
}

interface DcFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
}

// Per-request timeout (ms). DriveCentric occasionally returns 504s when a
// request hangs upstream; cap how long we wait so a stuck request fails fast
// and can be retried rather than blocking the whole sync.
const REQUEST_TIMEOUT_MS = Number(process.env.DRIVECENTRIC_TIMEOUT_MS) || 30_000;
// Gateway-class statuses that are worth retrying — they're transient/upstream,
// not a problem with our payload.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = Number(process.env.DRIVECENTRIC_MAX_RETRIES) || 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dcFetch(
  path: string,
  opts: DcFetchOptions = {},
  retryOn401 = true
): Promise<Response> {
  const token = await getToken();
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api-version", API_VERSION);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const method = opts.method ?? "GET";
  const bodyStr =
    opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  // Only log the path + querystring (no host/token) for diagnostics.
  const label = `${method} ${url.pathname}${url.search}`;

  // Retry loop for transient gateway errors (502/503/504) and timeouts.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: bodyStr,
        signal: controller.signal,
      });
      const ms = Date.now() - startedAt;
      console.log(
        `[drivecentric] http: ${label} -> ${res.status} in ${ms}ms` +
          (bodyStr ? ` (req ${bodyStr.length}B)` : "") +
          (attempt > 0 ? ` [attempt ${attempt + 1}/${MAX_RETRIES + 1}]` : "")
      );

      // If the cached token was rejected, drop it and retry once.
      if (res.status === 401 && retryOn401) {
        clearTimeout(timeout);
        cachedToken = null;
        return dcFetch(path, opts, false);
      }

      // Retry transient gateway errors with linear backoff.
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const backoff = 500 * (attempt + 1);
        const errBody = await res.text().catch(() => "");
        console.warn(
          `[drivecentric] http: ${label} got ${res.status}, retrying in ${backoff}ms` +
            (errBody ? ` — body: ${errBody.slice(0, 200)}` : "")
        );
        clearTimeout(timeout);
        await sleep(backoff);
        continue;
      }

      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      const ms = Date.now() - startedAt;
      const aborted = (err as Error).name === "AbortError";
      const reason = aborted
        ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
        : (err as Error).message;
      if (attempt < MAX_RETRIES) {
        const backoff = 500 * (attempt + 1);
        console.warn(
          `[drivecentric] http: ${label} ${reason} (${ms}ms), retrying in ${backoff}ms`
        );
        await sleep(backoff);
        continue;
      }
      console.error(
        `[drivecentric] http: ${label} ${reason} (${ms}ms), giving up after ${MAX_RETRIES + 1} attempts`
      );
      throw err;
    }
  }

  // Unreachable: the loop either returns a Response or throws.
  throw new Error(`DriveCentric request to ${label} exhausted retries`);
}

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 400);
}

// ─── Store (diagnostics) ───────────────────────────────────────────────────────

// Fetch the raw store record — used to inspect the store's configured timezone
// and business hours when appointments are rejected as "outside business hours".
export async function getStore(): Promise<unknown> {
  const res = await dcFetch(`/api/stores/${STORE_ID}`);
  if (!res.ok) {
    throw new Error(
      `DriveCentric getStore failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  return res.json();
}

// ─── Store hours ───────────────────────────────────────────────────────────────

// One day of store hours. `date` is the store-local calendar date; open/close
// are UTC instants (null on days the store is closed).
export interface DcStoreHoursDay {
  storeId?: string | null;
  date: string; // YYYY-MM-DD
  openTimeUtc?: string | null;
  closeTimeUtc?: string | null;
  isHolidayHours: boolean;
  modifiedAtUtc?: string | null;
}

interface DcStoreHoursResponse {
  data?: DcStoreHoursDay[] | null;
  meta?: { nextPageUrl?: string | null } | null;
}

// Fetch store hours for a date range, following pagination. The page cap is a
// safety net — a month of daily rows should never span 10 pages.
export async function getStoreHours(params: {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
}): Promise<DcStoreHoursDay[]> {
  const all: DcStoreHoursDay[] = [];
  let nextPageToken: string | undefined;

  for (let page = 0; page < 10; page++) {
    const res = await dcFetch(`/api/stores/${STORE_ID}/store-hours`, {
      query: {
        startDate: params.startDate,
        endDate: params.endDate,
        nextPageToken,
      },
    });
    if (!res.ok) {
      console.error(`[drivecentric] store hours: failed (${res.status})`);
      throw new Error(
        `DriveCentric getStoreHours failed (${res.status}): ${await readErrorBody(res)}`
      );
    }
    const body = (await res.json()) as DcStoreHoursResponse;
    all.push(...(body.data ?? []));

    const nextUrl = body.meta?.nextPageUrl;
    if (!nextUrl) break;
    try {
      nextPageToken =
        new URL(nextUrl, BASE).searchParams.get("nextPageToken") ?? undefined;
    } catch {
      break;
    }
    if (!nextPageToken) break;
  }

  console.log(`[drivecentric] store hours: ${all.length} day(s)`);
  return all;
}

// ─── Customers ───────────────────────────────────────────────────────────────

export interface DcCustomerSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phones?: { value: string | null; type: string }[] | null;
  emails?: { value: string | null; type: string }[] | null;
  deal?: { id: string } | null;
}

export async function searchCustomers(params: {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  phone?: string;
  email?: string;
  vin?: string;
  offset?: number;
}): Promise<DcCustomerSummary[]> {
  console.log(
    `[drivecentric] search customers: querying ${JSON.stringify(params)}`
  );
  const res = await dcFetch(`/api/stores/${STORE_ID}/customers`, {
    query: params,
  });
  if (!res.ok) {
    console.error(`[drivecentric] search customers: failed (${res.status})`);
    throw new Error(
      `DriveCentric searchCustomers failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  const data = (await res.json()) as { customers?: DcCustomerSummary[] };
  const customers = data.customers ?? [];
  console.log(`[drivecentric] search customers: ${customers.length} match(es)`);
  return customers;
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export interface DcCreateNoteResponse {
  noteId: string;
  description: string | null;
}

export async function createNote(
  customerId: string,
  note: { description: string; pinned?: boolean; url?: string }
): Promise<DcCreateNoteResponse> {
  console.log(
    `[drivecentric] create note: customer ${customerId} (${note.description.length} chars, pinned=${note.pinned ?? false})`
  );
  const res = await dcFetch(
    `/api/stores/${STORE_ID}/customers/${customerId}/note`,
    { method: "POST", body: note }
  );
  if (!res.ok) {
    const body = await readErrorBody(res);
    console.error(`[drivecentric] create note: failed (${res.status}) — ${body}`);
    throw new Error(
      `DriveCentric createNote failed (${res.status}): ${body}`
    );
  }
  const created = (await res.json()) as DcCreateNoteResponse;
  console.log(`[drivecentric] create note: created noteId=${created.noteId}`);
  return created;
}

// ─── Appointments ────────────────────────────────────────────────────────────

export type DcAppointmentType =
  | "Sales"
  | "Delivery"
  | "Service"
  | "General"
  | "TestDrive";

export interface DcCreateAppointmentResponse {
  id: string;
  type: DcAppointmentType;
  appointmentDate: string;
  notes: string | null;
  confirmed: boolean;
  show: boolean;
  cancelled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function createAppointment(
  customerId: string,
  appt: {
    type: DcAppointmentType;
    appointmentDate: string; // ISO-8601, must be in the future
    notes?: string;
    scheduledForUserId?: string;
    createdByUserId?: string;
  }
): Promise<DcCreateAppointmentResponse> {
  console.log(
    `[drivecentric] create appointment: customer ${customerId}, type=${appt.type}, date=${appt.appointmentDate}`
  );
  const res = await dcFetch(
    `/api/stores/${STORE_ID}/customers/${customerId}/appointment`,
    { method: "POST", body: appt }
  );
  if (!res.ok) {
    console.error(`[drivecentric] create appointment: failed (${res.status})`);
    throw new Error(
      `DriveCentric createAppointment failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  const created = (await res.json()) as DcCreateAppointmentResponse;
  console.log(
    `[drivecentric] create appointment: created id=${created.id}`
  );
  return created;
}

// ─── Deals (upsert) ──────────────────────────────────────────────────────────

export type DcIdentifierType =
  | "CrmId"
  | "FuseId"
  | "CdkDmsId"
  | "LotPopId"
  | "PartnerId";

export interface DcIdentifier {
  type: DcIdentifierType;
  value: string;
}

export interface DcDealPayload {
  deal: {
    identifiers: DcIdentifier[];
    source: { type: "Internet" | "Showroom" | "Phone" | "Campaign"; description: string };
    stage?:
      | "Lead"
      | "Engaged"
      | "Visit"
      | "Proposal"
      | "Sold"
      | "Delivered"
      | "Dead"
      | "Open";
    customers: Array<{
      identifiers: DcIdentifier[];
      isPrimaryBuyer: boolean;
      type: "Individual" | "Company";
      firstName: string;
      lastName: string;
      companyName?: string | null;
      phones?: { type: "Home" | "Mobile" | "Work"; value: string }[];
      emails?: { type: "Home" | "Work"; value: string }[];
    }>;
    salesperson1?: { identifiers: DcIdentifier[] };
    salesperson2?: { identifiers: DcIdentifier[] };
    vehicleInterests?: Array<{
      priority?: number;
      stockType: "New" | "Used";
      vehicle: {
        identifiers: DcIdentifier[];
        vin?: string | null;
        stockNumber?: string | null;
        year: number;
        make: string;
        model: string;
        trim?: string | null;
        mileage?: number | null;
        exteriorColor?: string | null;
        interiorColor?: string | null;
      };
    }> | null;
    tradeIns?: Array<{
      vehicle: {
        identifiers: DcIdentifier[];
        vin?: string | null;
        year: number;
        make: string;
        model: string;
        trim?: string | null;
        mileage?: number | null;
      };
      payoffAmount?: number | null;
      allowance?: number | null;
      actualCashValue?: number | null;
    }> | null;
    activities?: Array<{
      identifiers: DcIdentifier[];
      when: string;
      user: { identifiers: DcIdentifier[] };
      title: string;
      content?: string | null;
    }> | null;
    comments?: string | null;
  };
}

export interface DcUpsertDealResponse {
  store?: { identifiers: DcIdentifier[] };
  deal?: {
    identifiers: DcIdentifier[];
    customers?: Array<{ identifiers: DcIdentifier[] }>;
    salesperson1?: { identifiers: DcIdentifier[] };
    salesperson2?: { identifiers: DcIdentifier[] };
    tradeIns?: Array<{ identifiers: DcIdentifier[] }>;
    vehicleInterests?: Array<{ identifiers: DcIdentifier[] }>;
    activities?: Array<{ identifiers: DcIdentifier[] }>;
  };
}

export async function upsertDeal(
  payload: DcDealPayload
): Promise<DcUpsertDealResponse> {
  const dealCrmId = findIdentifier(payload.deal.identifiers, "CrmId");
  console.log(
    `[drivecentric] upsert deal: ${payload.deal.customers.length} customer(s), stage=${payload.deal.stage ?? "n/a"}, crmId=${dealCrmId ?? "new"}`
  );
  const res = await dcFetch(`/api/stores/${STORE_ID}/deal/upsert`, {
    method: "POST",
    body: payload,
  });
  if (!res.ok) {
    console.error(`[drivecentric] upsert deal: failed (${res.status})`);
    throw new Error(
      `DriveCentric upsertDeal failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  const result = (await res.json()) as DcUpsertDealResponse;
  console.log(
    `[drivecentric] upsert deal: ok, dealId=${findIdentifier(result.deal?.identifiers, "CrmId") ?? "unknown"}`
  );
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function findIdentifier(
  identifiers: DcIdentifier[] | undefined,
  type: DcIdentifierType
): string | null {
  return identifiers?.find((i) => i.type === type)?.value ?? null;
}
