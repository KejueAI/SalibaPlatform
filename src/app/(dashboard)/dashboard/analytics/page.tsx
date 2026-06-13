"use client";

import { useEffect, useState, useCallback } from "react";
import { PhoneCall, CalendarCheck, TrendingUp, UserPlus, Car, Flame } from "lucide-react";
import {
  TrendChart,
  Funnel,
  SplitDonut,
  type SeriesPoint,
  type FunnelData,
} from "@/components/analytics-charts";
import { format, parseISO } from "date-fns";

interface Analytics {
  days: number;
  series: SeriesPoint[];
  kpis: {
    leadsCalled: number;
    bookings: number;
    bookingRate: number;
    newCustomers: number;
    returningCustomers: number;
    inventoryMatched: number;
    inventoryMatchRate: number;
    syncedOk: number;
    syncFailed: number;
    busiestDay: string | null;
    busiestDayCount: number;
  };
  funnel: FunnelData;
}

const RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/analytics?days=${days}`);
      setData(await res.json());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const k = data?.kpis;
  const pct = (v: number | undefined) =>
    v === undefined ? "—" : `${(v * 100).toFixed(0)}%`;

  const cards = [
    {
      label: "Leads called",
      value: k?.leadsCalled,
      icon: PhoneCall,
      color: "text-foreground",
      hint: "Calls handled & synced",
    },
    {
      label: "Bookings created",
      value: k?.bookings,
      icon: CalendarCheck,
      color: "text-emerald",
      hint: "Appointments scheduled",
    },
    {
      label: "Booking rate",
      value: k ? pct(k.bookingRate) : undefined,
      icon: TrendingUp,
      color: "text-emerald",
      hint: "Bookings ÷ leads called",
    },
    {
      label: "New customers",
      value: k?.newCustomers,
      icon: UserPlus,
      color: "text-foreground",
      hint: `${k?.returningCustomers ?? "—"} returning`,
    },
    {
      label: "Matched inventory",
      value: k?.inventoryMatched,
      icon: Car,
      color: "text-foreground",
      hint: `${pct(k?.inventoryMatchRate)} of calls`,
    },
    {
      label: "Busiest day",
      value:
        k?.busiestDay != null ? k.busiestDayCount : k ? 0 : undefined,
      icon: Flame,
      color: "text-foreground",
      hint: k?.busiestDay ? format(parseISO(k.busiestDay), "EEE, MMM d") : "—",
    },
  ];

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Voice agent performance — leads called &amp; bookings created
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg glass-card">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`px-3 py-1.5 rounded-md text-xs font-mono transition-colors ${
                days === r.days
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 stagger-children">
        {cards.map((c) => (
          <div key={c.label} className="glass-card rounded-xl p-5 hover-lift">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                {c.label}
              </span>
              <c.icon size={16} className={`${c.color} opacity-60`} />
            </div>
            <p className={`text-3xl font-semibold tracking-tight ${c.color}`}>
              {loading || c.value === undefined ? (
                <span className="inline-block w-12 h-8 rounded bg-foreground/5 animate-pulse" />
              ) : (
                c.value
              )}
            </p>
            <p className="text-xs text-muted-foreground/70 mt-2 truncate">{c.hint}</p>
          </div>
        ))}
      </div>

      {/* Main trend chart */}
      <div className="glass-card rounded-xl p-6">
        <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
          Leads called vs. bookings created
        </h2>
        {loading ? (
          <div className="h-80 rounded-lg bg-foreground/5 animate-pulse" />
        ) : data && data.series.some((d) => d.leadsCalled > 0 || d.bookings > 0) ? (
          <TrendChart data={data.series} />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Secondary charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card rounded-xl p-6">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
            Conversion funnel
          </h2>
          {loading || !data ? (
            <div className="h-32 rounded-lg bg-foreground/5 animate-pulse" />
          ) : (
            <Funnel data={data.funnel} />
          )}
        </div>

        <div className="glass-card rounded-xl p-6">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
            New vs. returning callers
          </h2>
          {loading || !k ? (
            <div className="h-32 rounded-lg bg-foreground/5 animate-pulse" />
          ) : (
            <div className="flex flex-col gap-6">
              <SplitDonut
                parts={[
                  { label: "New", value: k.newCustomers, color: "var(--chart-1)" },
                  { label: "Returning", value: k.returningCustomers, color: "var(--chart-2)" },
                ]}
              />
              <div className="flex items-center justify-between text-xs pt-3 border-t border-border/50">
                <span className="text-muted-foreground">CRM sync health</span>
                <span className="font-mono">
                  <span className="text-emerald">{k.syncedOk} ok</span>
                  {k.syncFailed > 0 && (
                    <span className="text-destructive ml-2">{k.syncFailed} failed</span>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-80 flex flex-col items-center justify-center text-center">
      <PhoneCall size={28} className="text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">No calls in this window yet</p>
      <p className="text-xs text-muted-foreground/50 mt-1">
        Synced calls from the voice agent will appear here.
      </p>
    </div>
  );
}
