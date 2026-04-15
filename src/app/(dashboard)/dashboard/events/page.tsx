"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Activity } from "lucide-react";

interface EventItem {
  id: string;
  type: string;
  status: string;
  summary: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export default function EventsPageWrapper() {
  return (
    <Suspense fallback={<div className="animate-pulse h-96 rounded-xl bg-foreground/5" />}>
      <EventsPage />
    </Suspense>
  );
}

function EventsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const page = parseInt(searchParams.get("page") || "1");
  const type = searchParams.get("type") ?? "";

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("perPage", "20");
    if (type) params.set("type", type);

    const res = await fetch(`/api/events?${params}`);
    const data = await res.json();
    setEvents(data.events || []);
    setTotal(data.total || 0);
    setTotalPages(data.totalPages || 1);
    setLoading(false);
  }, [page, type]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function updateParams(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.set("page", "1");
    router.push(`/dashboard/events?${params}`);
  }

  const typeLabel = (t: string) => {
    switch (t) {
      case "instagram_poll":
        return "Instagram Poll";
      case "vauto_import":
        return "vAuto Import";
      default:
        return t;
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "completed":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "failed":
        return "bg-red-500/10 text-red-400 border-red-500/20";
      case "running":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
      default:
        return "";
    }
  };

  function formatDuration(start: string, end: string | null) {
    if (!end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Event Log</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {total} events total
          </p>
        </div>
        <Select
          value={type || "all"}
          onValueChange={(v) => updateParams("type", v === "all" ? "" : v ?? "")}
        >
          <SelectTrigger className="w-[160px] bg-background/50">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="instagram_poll">Instagram Poll</SelectItem>
            <SelectItem value="vauto_import">vAuto Import</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="glass-card rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-foreground/5 animate-pulse" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="p-12 text-center">
            <Activity size={32} className="mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No events recorded yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {events.map((event, i) => (
              <div
                key={event.id}
                className="p-4 hover:bg-foreground/[0.02] transition-colors"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">
                        {typeLabel(event.type)}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${statusColor(event.status)}`}
                      >
                        {event.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDuration(event.startedAt, event.completedAt)}
                      </span>
                    </div>

                    {event.summary && (
                      <div className="flex gap-3 mt-2 flex-wrap">
                        {Object.entries(event.summary)
                          .filter(([k]) => k !== "errors")
                          .map(([key, val]) => (
                            <span
                              key={key}
                              className="text-xs text-muted-foreground"
                            >
                              <span className="text-muted-foreground/50">
                                {key}:
                              </span>{" "}
                              {String(val)}
                            </span>
                          ))}
                      </div>
                    )}

                    {event.errorMessage && (
                      <p className="text-xs text-destructive mt-2 font-mono">
                        {event.errorMessage}
                      </p>
                    )}
                  </div>

                  <span className="text-xs text-muted-foreground font-mono shrink-0">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => updateParams("page", String(page - 1))}
            >
              <ChevronLeft size={14} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => updateParams("page", String(page + 1))}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
