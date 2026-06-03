// POST /api/tools/get-store-hours
//
// Voice-agent tool: returns the dealership's opening hours for a date range so
// the agent can answer "are you open Sunday?" / "what time do you close?" and
// avoid proposing appointments outside business hours.
//
// DriveCentric returns open/close as UTC instants; the agent speaks store-local
// times, so we convert everything to the store timezone before responding.
//
// Auth: same Bearer TOOL_API_KEY scheme as /api/tools/search-cars.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getStoreHours } from "@/lib/drivecentric";

// Store timezone — the dealership is in Ewing, New Jersey (see add-to-crm).
const STORE_TZ = process.env.DRIVECENTRIC_TZ || "America/New_York";

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 31;

// ─── Request schema ──────────────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD format");

const GetStoreHoursSchema = z
  .object({
    // Both optional: defaults to today (store-local) through the next 6 days.
    start_date: dateString.optional(),
    end_date: dateString.optional(),
  })
  .refine(
    (d) => !d.start_date || !d.end_date || d.start_date <= d.end_date,
    { message: "start_date must be <= end_date", path: ["start_date"] }
  )
  .refine(
    (d) =>
      !d.start_date ||
      !d.end_date ||
      daysBetween(d.start_date, d.end_date) < MAX_RANGE_DAYS,
    {
      message: `date range must be at most ${MAX_RANGE_DAYS} days`,
      path: ["end_date"],
    }
  );

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: issue.code,
    message: issue.message,
  }));
}

// Today's calendar date (YYYY-MM-DD) in the store timezone — "today" for the
// caller is the store's day, not the server's UTC day.
function todayInStoreTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Date-only arithmetic on YYYY-MM-DD strings (UTC midnight is a safe cursor).
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000
  );
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

// Format a UTC instant as a store-local spoken time, e.g. "9:00 AM".
function formatLocalTime(utcIso: string): string | null {
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: STORE_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // API key auth (same scheme as search-cars).
  const authHeader = request.headers.get("authorization");
  const apiKey = process.env.TOOL_API_KEY;
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse JSON — tolerate an empty body, since both params are optional.
  let rawBody: unknown = {};
  const text = await request.text();
  if (text.trim()) {
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
  }

  // Validate
  const parsed = GetStoreHoursSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid parameters",
        details: formatZodError(parsed.error),
      },
      { status: 400 }
    );
  }

  // Defaults: today (store-local) through the next 6 days, so a bare call
  // answers "what are your hours this week?".
  const startDate = parsed.data.start_date ?? todayInStoreTz();
  const endDate =
    parsed.data.end_date ?? addDays(startDate, DEFAULT_RANGE_DAYS - 1);
  if (startDate > endDate || daysBetween(startDate, endDate) >= MAX_RANGE_DAYS) {
    return NextResponse.json(
      {
        error: "Invalid parameters",
        details: [
          {
            field: "end_date",
            code: "invalid_range",
            message: `end_date must be on/after start_date and within ${MAX_RANGE_DAYS} days of it`,
          },
        ],
      },
      { status: 400 }
    );
  }

  let days;
  try {
    days = await getStoreHours({ startDate, endDate });
  } catch (err) {
    console.error(
      `[get-store-hours] DriveCentric lookup failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "Store hours are temporarily unavailable" },
      { status: 502 }
    );
  }

  // Shape for the voice agent: store-local spoken times, explicit closed flag.
  const shaped = days
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const openTime = d.openTimeUtc ? formatLocalTime(d.openTimeUtc) : null;
      const closeTime = d.closeTimeUtc ? formatLocalTime(d.closeTimeUtc) : null;
      const isOpen = openTime !== null && closeTime !== null;
      return {
        date: d.date,
        weekday: weekdayOf(d.date),
        is_open: isOpen,
        open_time: isOpen ? openTime : null,
        close_time: isOpen ? closeTime : null,
        is_holiday_hours: d.isHolidayHours,
      };
    });

  return NextResponse.json({
    timezone: STORE_TZ,
    start_date: startDate,
    end_date: endDate,
    days: shaped,
    total_count: shaped.length,
  });
}
