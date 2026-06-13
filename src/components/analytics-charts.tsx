"use client";

// Dependency-free SVG charts for the analytics dashboard. Everything is drawn in
// a fixed viewBox coordinate space and scaled to the container via `width=100%`,
// so the charts stay crisp and responsive without a charting library. Colors are
// pulled from the app's CSS chart tokens (--chart-1 … --chart-5).

import { useState } from "react";
import { format, parseISO } from "date-fns";

const LEADS_COLOR = "var(--chart-2)"; // blue  — leads called
const BOOKINGS_COLOR = "var(--chart-1)"; // emerald — bookings created

export interface SeriesPoint {
  day: string; // YYYY-MM-DD
  leadsCalled: number;
  bookings: number;
}

// ─── Combined trend chart (the centerpiece) ──────────────────────────────────
// Leads called as soft bars, bookings created as an emerald line on top — both
// on the same time axis so the booking rate reads at a glance.

const W = 860;
const H = 320;
const PAD = { top: 24, right: 16, bottom: 32, left: 36 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function TrendChart({ data }: { data: SeriesPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const maxLeads = Math.max(1, ...data.map((d) => d.leadsCalled));
  const yMax = niceMax(maxLeads);
  const n = data.length;

  const colW = PLOT_W / Math.max(n, 1);
  const barW = Math.max(2, Math.min(colW * 0.6, 26));

  const x = (i: number) => PAD.left + colW * i + colW / 2;
  const y = (v: number) => PAD.top + PLOT_H - (v / yMax) * PLOT_H;

  const gridLines = 4;
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) =>
    Math.round((yMax / gridLines) * i)
  );

  // Booking line path.
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(d.bookings).toFixed(1)}`)
    .join(" ");

  // X-axis labels: ~7 evenly spaced ticks.
  const labelEvery = Math.max(1, Math.ceil(n / 7));

  const active = hover !== null ? data[hover] : null;

  return (
    <div className="w-full">
      {/* Legend */}
      <div className="flex items-center gap-5 mb-3 text-xs">
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: LEADS_COLOR }} />
          Leads called
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-block w-3 h-[3px] rounded-full" style={{ background: BOOKINGS_COLOR }} />
          Bookings created
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Leads called and bookings created over time">
        {/* Horizontal gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="currentColor"
              className="text-foreground/8"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {t}
            </text>
          </g>
        ))}

        {/* Leads-called bars */}
        {data.map((d, i) => (
          <rect
            key={d.day}
            x={x(i) - barW / 2}
            y={y(d.leadsCalled)}
            width={barW}
            height={Math.max(0, PAD.top + PLOT_H - y(d.leadsCalled))}
            rx={2}
            fill={LEADS_COLOR}
            opacity={hover === null || hover === i ? 0.55 : 0.25}
          />
        ))}

        {/* Bookings line + dots */}
        <path d={linePath} fill="none" stroke={BOOKINGS_COLOR} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle
            key={d.day}
            cx={x(i)}
            cy={y(d.bookings)}
            r={hover === i ? 4 : 2.5}
            fill={BOOKINGS_COLOR}
          />
        ))}

        {/* X-axis labels */}
        {data.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text
              key={d.day}
              x={x(i)}
              y={H - 10}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {format(parseISO(d.day), "MMM d")}
            </text>
          ) : null
        )}

        {/* Hover guide */}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke="currentColor"
            className="text-foreground/20"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}

        {/* Invisible hit areas */}
        {data.map((d, i) => (
          <rect
            key={d.day}
            x={PAD.left + colW * i}
            y={PAD.top}
            width={colW}
            height={PLOT_H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {/* Tooltip (HTML, below chart — avoids SVG clipping) */}
      <div className="h-5 mt-1 text-xs text-center">
        {active ? (
          <span className="text-muted-foreground font-mono">
            {format(parseISO(active.day), "EEE, MMM d")} —{" "}
            <span style={{ color: LEADS_COLOR }}>{active.leadsCalled} called</span>
            {" · "}
            <span style={{ color: BOOKINGS_COLOR }}>{active.bookings} booked</span>
          </span>
        ) : (
          <span className="text-muted-foreground/40">Hover a day for detail</span>
        )}
      </div>
    </div>
  );
}

// ─── Conversion funnel ───────────────────────────────────────────────────────

export interface FunnelData {
  leadsCalled: number;
  wantedAppointment: number;
  booked: number;
}

export function Funnel({ data }: { data: FunnelData }) {
  const stages = [
    { label: "Leads called", value: data.leadsCalled, color: "var(--chart-2)" },
    { label: "Wanted appointment", value: data.wantedAppointment, color: "var(--chart-4)" },
    { label: "Booking created", value: data.booked, color: "var(--chart-1)" },
  ];
  const top = Math.max(1, data.leadsCalled);

  return (
    <div className="space-y-3">
      {stages.map((s) => {
        const pct = top > 0 ? (s.value / top) * 100 : 0;
        return (
          <div key={s.label}>
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-mono">
                {s.value}
                <span className="text-muted-foreground/60 ml-1.5">
                  {pct.toFixed(0)}%
                </span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-foreground/5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.max(pct, s.value > 0 ? 2 : 0)}%`, background: s.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── New vs returning donut ──────────────────────────────────────────────────

export function SplitDonut({
  parts,
}: {
  parts: { label: string; value: number; color: string }[];
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 120 120" className="w-28 h-28 shrink-0 -rotate-90">
        <circle cx={60} cy={60} r={R} fill="none" stroke="currentColor" className="text-foreground/8" strokeWidth={14} />
        {total > 0 &&
          parts.map((p) => {
            const frac = p.value / total;
            const dash = frac * C;
            const seg = (
              <circle
                key={p.label}
                cx={60}
                cy={60}
                r={R}
                fill="none"
                stroke={p.color}
                strokeWidth={14}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return seg;
          })}
      </svg>
      <div className="space-y-2">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-2 text-sm">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.label}</span>
            <span className="font-mono ml-auto pl-3">{p.value}</span>
          </div>
        ))}
        {total === 0 && <p className="text-xs text-muted-foreground/50">No data yet</p>}
      </div>
    </div>
  );
}
