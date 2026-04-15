"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Plus, ChevronLeft, ChevronRight, Video } from "lucide-react";
import type { Car } from "@/db/schema";
import type { VideoObject } from "@/db/schema";
import { useSession } from "@/lib/auth-client";

export default function InventoryPageWrapper() {
  return (
    <Suspense fallback={<div className="animate-pulse h-96 rounded-xl bg-foreground/5" />}>
      <InventoryPage />
    </Suspense>
  );
}

function InventoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const [cars, setCars] = useState<Car[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const page = parseInt(searchParams.get("page") || "1");
  const search = searchParams.get("search") || "";
  const status = searchParams.get("status") || "";

  const fetchCars = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("perPage", "20");
    if (search) params.set("search", search);
    if (status) params.set("status", status);

    const res = await fetch(`/api/cars?${params}`);
    const data = await res.json();
    setCars(data.cars || []);
    setTotal(data.total || 0);
    setTotalPages(data.totalPages || 1);
    setLoading(false);
  }, [page, search, status]);

  useEffect(() => {
    fetchCars();
  }, [fetchCars]);

  function updateParams(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    if (key !== "page") params.set("page", "1");
    router.push(`/dashboard/inventory?${params}`);
  }

  const statusColor = (s: string) => {
    switch (s) {
      case "available":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "pending":
        return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
      case "sold":
        return "bg-muted text-muted-foreground border-border";
      default:
        return "";
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {total} vehicles total
          </p>
        </div>
        {isAdmin && (
          <Link href="/dashboard/inventory/new">
            <Button size="sm" className="gap-2">
              <Plus size={14} /> Add Car
            </Button>
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search make, model, stock ID..."
            defaultValue={search}
            onChange={(e) => {
              const timeout = setTimeout(() => {
                updateParams("search", e.target.value);
              }, 400);
              return () => clearTimeout(timeout);
            }}
            className="pl-10 bg-background/50"
          />
        </div>
        <Select
          value={status || "all"}
          onValueChange={(v) => updateParams("status", v === "all" ? "" : v ?? "")}
        >
          <SelectTrigger className="w-[140px] bg-background/50">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="sold">Sold</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="glass-card rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-14 rounded-lg bg-foreground/5 animate-pulse"
              />
            ))}
          </div>
        ) : cars.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-muted-foreground">No cars found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    Stock
                  </th>
                  <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    Vehicle
                  </th>
                  <th className="text-left p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground hidden md:table-cell">
                    Color
                  </th>
                  <th className="text-right p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                    Mileage
                  </th>
                  <th className="text-right p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    Price
                  </th>
                  <th className="text-center p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground hidden lg:table-cell">
                    Videos
                  </th>
                  <th className="text-center p-4 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {cars.map((car, i) => {
                  const videos = (car.videos as VideoObject[]) || [];
                  return (
                    <tr
                      key={car.id}
                      className="border-b border-border/30 hover:bg-foreground/[0.02] transition-colors cursor-pointer"
                      style={{ animationDelay: `${i * 30}ms` }}
                      onClick={() =>
                        router.push(`/dashboard/inventory/${car.id}`)
                      }
                    >
                      <td className="p-4">
                        <span className="text-sm font-mono text-muted-foreground">
                          {car.stockId}
                        </span>
                      </td>
                      <td className="p-4">
                        <div>
                          <span className="text-sm font-medium">
                            {car.year} {car.make} {car.model}
                          </span>
                          {car.trim && (
                            <span className="text-sm text-muted-foreground ml-1">
                              {car.trim}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-4 hidden md:table-cell">
                        <span className="text-sm text-muted-foreground">
                          {car.color || "—"}
                        </span>
                      </td>
                      <td className="p-4 text-right hidden sm:table-cell">
                        <span className="text-sm font-mono text-muted-foreground">
                          {car.mileage
                            ? car.mileage.toLocaleString() + " mi"
                            : "—"}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <span className="text-sm font-mono">
                          {car.price
                            ? "$" + car.price.toLocaleString()
                            : "—"}
                        </span>
                      </td>
                      <td className="p-4 text-center hidden lg:table-cell">
                        {videos.length > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Video size={12} /> {videos.length}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">
                            —
                          </span>
                        )}
                      </td>
                      <td className="p-4 text-center">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${statusColor(car.status)}`}
                        >
                          {car.status}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
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
