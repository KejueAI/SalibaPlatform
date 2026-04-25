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
    throw new Error("DriveCentric auth response missing idToken");
  }
  // Default to 1h if the server didn't tell us, with a 60s safety buffer applied at read time.
  const ttl = (data.expiresInSeconds ?? 3600) * 1000;
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

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  // If the cached token was rejected, drop it and retry once.
  if (res.status === 401 && retryOn401) {
    cachedToken = null;
    return dcFetch(path, opts, false);
  }

  return res;
}

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 400);
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
  const res = await dcFetch(`/api/stores/${STORE_ID}/customers`, {
    query: params,
  });
  if (!res.ok) {
    throw new Error(
      `DriveCentric searchCustomers failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  const data = (await res.json()) as { customers?: DcCustomerSummary[] };
  return data.customers ?? [];
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
  const res = await dcFetch(
    `/api/stores/${STORE_ID}/customers/${customerId}/note`,
    { method: "POST", body: note }
  );
  if (!res.ok) {
    throw new Error(
      `DriveCentric createNote failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  return (await res.json()) as DcCreateNoteResponse;
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
  const res = await dcFetch(
    `/api/stores/${STORE_ID}/customers/${customerId}/appointment`,
    { method: "POST", body: appt }
  );
  if (!res.ok) {
    throw new Error(
      `DriveCentric createAppointment failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  return (await res.json()) as DcCreateAppointmentResponse;
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
  const res = await dcFetch(`/api/stores/${STORE_ID}/deal/upsert`, {
    method: "POST",
    body: payload,
  });
  if (!res.ok) {
    throw new Error(
      `DriveCentric upsertDeal failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  return (await res.json()) as DcUpsertDealResponse;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function findIdentifier(
  identifiers: DcIdentifier[] | undefined,
  type: DcIdentifierType
): string | null {
  return identifiers?.find((i) => i.type === type)?.value ?? null;
}
