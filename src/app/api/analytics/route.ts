// GET /api/analytics
//
// Aggregates the `events` log (type='crm_sync') into the numbers the voice-agent
// analytics dashboard charts. Each crm_sync row is one analyzed call synced to
// DriveCentric — i.e. one lead the agent called. A row whose summary carries a
// non-empty `appointment_id` is a booking the agent created.
//
// Days are grouped in the store's local timezone (the dealership is in Ewing,
// NJ) so a "day" on the chart matches a day at the store, not a UTC day.
//
// Query params:
//   - days: lookback window. One of 7 | 30 | 90 | 365 (default 30).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

const ALLOWED_DAYS = new Set([7, 30, 90, 365]);
const STORE_TZ = process.env.DRIVECENTRIC_TZ || "America/New_York";

// `summary->>'appointment_id'` is present and non-empty.
const BOOKED = sql`(summary->>'appointment_id' is not null and summary->>'appointment_id' <> '')`;

interface DailyRow {
  day: string;
  leads_called: number;
  bookings: number;
  new_customers: number;
}

interface AggRow {
  leads_called: number;
  bookings: number;
  new_customers: number;
  inventory_matched: number;
  synced_ok: number;
  sync_failed: number;
  no_appt_wanted: number;
  appt_wanted_failed: number;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requested = parseInt(searchParams.get("days") || "30", 10);
  const days = ALLOWED_DAYS.has(requested) ? requested : 30;

  // Zero-filled daily series so the chart is continuous even on quiet days.
  const dailyResult = await db.execute(sql`
    with span as (
      select generate_series(
        date_trunc('day', (now() at time zone ${STORE_TZ})) - make_interval(days => ${days - 1}),
        date_trunc('day', (now() at time zone ${STORE_TZ})),
        interval '1 day'
      )::date as day
    ),
    ev as (
      select
        date_trunc('day', (created_at at time zone ${STORE_TZ}))::date as day,
        count(*)::int as leads_called,
        count(*) filter (where ${BOOKED})::int as bookings,
        count(*) filter (where (summary->>'new_customer')::boolean)::int as new_customers
      from events
      where type = 'crm_sync'
        and created_at >= now() - make_interval(days => ${days})
      group by 1
    )
    select
      to_char(span.day, 'YYYY-MM-DD') as day,
      coalesce(ev.leads_called, 0)::int as leads_called,
      coalesce(ev.bookings, 0)::int as bookings,
      coalesce(ev.new_customers, 0)::int as new_customers
    from span
    left join ev on ev.day = span.day
    order by span.day
  `);

  // Window totals + funnel inputs in one pass.
  const aggResult = await db.execute(sql`
    with e as (
      select
        status,
        summary,
        ${BOOKED} as booked
      from events
      where type = 'crm_sync'
        and created_at >= now() - make_interval(days => ${days})
    )
    select
      count(*)::int as leads_called,
      count(*) filter (where booked)::int as bookings,
      count(*) filter (where (summary->>'new_customer')::boolean)::int as new_customers,
      count(*) filter (where summary->>'matched_stock_id' is not null and summary->>'matched_stock_id' <> '')::int as inventory_matched,
      count(*) filter (where status = 'completed')::int as synced_ok,
      count(*) filter (where status = 'failed')::int as sync_failed,
      count(*) filter (where summary->>'appointment_skipped_reason' = 'wants_appointment is not true')::int as no_appt_wanted,
      count(*) filter (where not booked and summary->>'appointment_skipped_reason' is not null and summary->>'appointment_skipped_reason' <> 'wants_appointment is not true')::int as appt_wanted_failed
    from e
  `);

  const daily = dailyResult as unknown as DailyRow[];
  const agg = (aggResult as unknown as AggRow[])[0] ?? {
    leads_called: 0,
    bookings: 0,
    new_customers: 0,
    inventory_matched: 0,
    synced_ok: 0,
    sync_failed: 0,
    no_appt_wanted: 0,
    appt_wanted_failed: 0,
  };

  const leadsCalled = agg.leads_called;
  const bookings = agg.bookings;
  // Callers who asked for an appointment: those we booked + those we tried but
  // couldn't place (everyone except the "didn't want one" bucket).
  const wantedAppointment = bookings + agg.appt_wanted_failed;
  const busiest = daily.reduce<DailyRow | null>(
    (best, d) => (best === null || d.leads_called > best.leads_called ? d : best),
    null
  );

  return NextResponse.json({
    days,
    timezone: STORE_TZ,
    series: daily.map((d) => ({
      day: d.day,
      leadsCalled: d.leads_called,
      bookings: d.bookings,
      newCustomers: d.new_customers,
    })),
    kpis: {
      leadsCalled,
      bookings,
      bookingRate: leadsCalled > 0 ? bookings / leadsCalled : 0,
      newCustomers: agg.new_customers,
      returningCustomers: Math.max(leadsCalled - agg.new_customers, 0),
      inventoryMatched: agg.inventory_matched,
      inventoryMatchRate: leadsCalled > 0 ? agg.inventory_matched / leadsCalled : 0,
      syncedOk: agg.synced_ok,
      syncFailed: agg.sync_failed,
      busiestDay: busiest && busiest.leads_called > 0 ? busiest.day : null,
      busiestDayCount: busiest ? busiest.leads_called : 0,
    },
    funnel: {
      leadsCalled,
      wantedAppointment,
      booked: bookings,
    },
  });
}
