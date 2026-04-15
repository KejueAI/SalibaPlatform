"use client";

import { useEffect, useState } from "react";
import { Car, TrendingUp, Clock, AlertCircle } from "lucide-react";

interface Stats {
  total: number;
  available: number;
  pending: number;
  sold: number;
  recentEvents: {
    id: string;
    type: string;
    status: string;
    summary: Record<string, unknown> | null;
    createdAt: string;
  }[];
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [carsRes, eventsRes] = await Promise.all([
          fetch("/api/cars?perPage=1000"),
          fetch("/api/events?perPage=5"),
        ]);
        const carsData = await carsRes.json();
        const eventsData = await eventsRes.json();

        const allCars = carsData.cars || [];
        setStats({
          total: carsData.total || 0,
          available: allCars.filter((c: { status: string }) => c.status === "available").length,
          pending: allCars.filter((c: { status: string }) => c.status === "pending").length,
          sold: allCars.filter((c: { status: string }) => c.status === "sold").length,
          recentEvents: eventsData.events || [],
        });
      } catch {
        // Handle error silently — stats will be null
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const statCards = [
    {
      label: "Total Inventory",
      value: stats?.total ?? "—",
      icon: Car,
      color: "text-foreground",
    },
    {
      label: "Available",
      value: stats?.available ?? "—",
      icon: TrendingUp,
      color: "text-emerald",
    },
    {
      label: "Pending",
      value: stats?.pending ?? "—",
      icon: Clock,
      color: "text-yellow-400",
    },
    {
      label: "Sold",
      value: stats?.sold ?? "—",
      icon: AlertCircle,
      color: "text-muted-foreground",
    },
  ];

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          J&S AutoHaus inventory at a glance
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
        {statCards.map((stat) => (
          <div
            key={stat.label}
            className="glass-card rounded-xl p-5 hover-lift"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                {stat.label}
              </span>
              <stat.icon size={16} className={`${stat.color} opacity-60`} />
            </div>
            <p className={`text-3xl font-semibold tracking-tight ${stat.color}`}>
              {loading ? (
                <span className="inline-block w-12 h-8 rounded bg-foreground/5 animate-pulse" />
              ) : (
                stat.value
              )}
            </p>
          </div>
        ))}
      </div>

      {/* Recent Events */}
      <div className="glass-card rounded-xl p-6">
        <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
          Recent Events
        </h2>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-12 rounded-lg bg-foreground/5 animate-pulse"
              />
            ))}
          </div>
        ) : stats?.recentEvents && stats.recentEvents.length > 0 ? (
          <div className="space-y-2">
            {stats.recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center justify-between p-3 rounded-lg bg-background/30 hover:bg-background/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`status-dot ${
                      event.status === "completed"
                        ? "available"
                        : event.status === "failed"
                          ? "bg-destructive"
                          : "pending"
                    }`}
                  />
                  <div>
                    <span className="text-sm">
                      {event.type === "instagram_poll"
                        ? "Instagram Poll"
                        : event.type === "vauto_import"
                          ? "vAuto Import"
                          : event.type}
                    </span>
                    {event.summary && (
                      <p className="text-xs text-muted-foreground">
                        {Object.entries(event.summary)
                          .filter(([k]) => k !== "errors")
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground font-mono">
                  {new Date(event.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No events yet</p>
        )}
      </div>
    </div>
  );
}
