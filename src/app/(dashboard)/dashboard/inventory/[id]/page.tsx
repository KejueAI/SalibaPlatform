"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Save,
  Trash2,
  ExternalLink,
  Video,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { toast } from "sonner";
import type { Car, VideoObject } from "@/db/schema";

export default function CarDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const [car, setCar] = useState<Car | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<Car>>({});

  useEffect(() => {
    fetch(`/api/cars/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setCar(data);
        setForm(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/cars/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stockId: form.stockId,
          make: form.make,
          model: form.model,
          year: form.year ? Number(form.year) : undefined,
          trim: form.trim,
          color: form.color,
          mileage: form.mileage ? Number(form.mileage) : undefined,
          price: form.price ? Number(form.price) : undefined,
          bodyType: form.bodyType,
          drivetrain: form.drivetrain,
          engine: form.engine,
          transmission: form.transmission,
          vin: form.vin,
          status: form.status,
          description: form.description,
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCar(updated);
        toast.success("Car updated");
      } else {
        toast.error("Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!confirm("Delete this car permanently?")) return;
    const res = await fetch(`/api/cars/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Car deleted");
      router.push("/dashboard/inventory");
    } else {
      toast.error("Failed to delete");
    }
  }

  function updateField(field: string, value: string | number | null) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="h-8 w-48 rounded bg-foreground/5 animate-pulse" />
        <div className="h-96 rounded-xl bg-foreground/5 animate-pulse" />
      </div>
    );
  }

  if (!car) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">Car not found</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push("/dashboard/inventory")}
        >
          Back to Inventory
        </Button>
      </div>
    );
  }

  const videos = (car.videos as VideoObject[]) || [];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/dashboard/inventory")}
          >
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {car.year} {car.make} {car.model}
            </h1>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm text-muted-foreground font-mono">
                #{car.stockId}
              </span>
              <Badge
                variant="outline"
                className={`text-[10px] ${
                  car.status === "available"
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : car.status === "pending"
                      ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {car.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Source: {car.source}
              </span>
            </div>
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              className="gap-1"
            >
              <Trash2 size={14} /> Delete
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
              <Save size={14} /> {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2 glass-card rounded-xl p-6">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
            Vehicle Details
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Stock ID" value={form.stockId || ""} onChange={(v) => updateField("stockId", v)} disabled={!isAdmin} />
            <Field label="VIN" value={form.vin || ""} onChange={(v) => updateField("vin", v)} disabled={!isAdmin} />
            <Field label="Make" value={form.make || ""} onChange={(v) => updateField("make", v)} disabled={!isAdmin} />
            <Field label="Model" value={form.model || ""} onChange={(v) => updateField("model", v)} disabled={!isAdmin} />
            <Field label="Year" value={String(form.year || "")} onChange={(v) => updateField("year", v)} disabled={!isAdmin} type="number" />
            <Field label="Trim" value={form.trim || ""} onChange={(v) => updateField("trim", v)} disabled={!isAdmin} />
            <Field label="Color" value={form.color || ""} onChange={(v) => updateField("color", v)} disabled={!isAdmin} />
            <Field label="Mileage" value={String(form.mileage || "")} onChange={(v) => updateField("mileage", v)} disabled={!isAdmin} type="number" />
            <Field label="Price ($)" value={String(form.price || "")} onChange={(v) => updateField("price", v)} disabled={!isAdmin} type="number" />
            <Field label="Engine" value={form.engine || ""} onChange={(v) => updateField("engine", v)} disabled={!isAdmin} />

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Status</Label>
              <Select value={form.status || "available"} onValueChange={(v) => updateField("status", v)} disabled={!isAdmin}>
                <SelectTrigger className="bg-background/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Available</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="sold">Sold</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Drivetrain</Label>
              <Select value={form.drivetrain || ""} onValueChange={(v) => updateField("drivetrain", v)} disabled={!isAdmin}>
                <SelectTrigger className="bg-background/50"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="AWD">AWD</SelectItem>
                  <SelectItem value="RWD">RWD</SelectItem>
                  <SelectItem value="FWD">FWD</SelectItem>
                  <SelectItem value="4WD">4WD</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Transmission</Label>
              <Select value={form.transmission || ""} onValueChange={(v) => updateField("transmission", v)} disabled={!isAdmin}>
                <SelectTrigger className="bg-background/50"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">Automatic</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Body Type</Label>
              <Select value={form.bodyType || ""} onValueChange={(v) => updateField("bodyType", v)} disabled={!isAdmin}>
                <SelectTrigger className="bg-background/50"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sedan">Sedan</SelectItem>
                  <SelectItem value="suv">SUV</SelectItem>
                  <SelectItem value="coupe">Coupe</SelectItem>
                  <SelectItem value="convertible">Convertible</SelectItem>
                  <SelectItem value="truck">Truck</SelectItem>
                  <SelectItem value="van">Van</SelectItem>
                  <SelectItem value="wagon">Wagon</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Description</Label>
            <Textarea
              value={form.description || ""}
              onChange={(e) => updateField("description", e.target.value)}
              disabled={!isAdmin}
              className="bg-background/50 min-h-[80px]"
              placeholder="Voice-agent-friendly description..."
            />
          </div>
        </div>

        {/* Videos */}
        <div className="glass-card rounded-xl p-6">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
            Videos ({videos.length})
          </h2>
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No videos linked</p>
          ) : (
            <div className="space-y-3">
              {videos.map((v, i) => (
                <div
                  key={i}
                  className="p-3 rounded-lg bg-background/30 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Video size={14} className="text-muted-foreground" />
                      <span className="text-xs font-mono text-muted-foreground">
                        {v.platform}
                      </span>
                    </div>
                    {v.permalink && (
                      <a
                        href={v.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {v.caption}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50 font-mono">
                    {new Date(v.posted_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground uppercase tracking-wider">
        {label}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="bg-background/50"
      />
    </div>
  );
}
