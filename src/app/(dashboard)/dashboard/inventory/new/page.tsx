"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Plus } from "lucide-react";
import { toast } from "sonner";

export default function NewCarPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    stockId: "",
    make: "",
    model: "",
    year: "",
    trim: "",
    color: "",
    mileage: "",
    price: "",
    bodyType: "",
    drivetrain: "",
    engine: "",
    transmission: "",
    vin: "",
    status: "available",
    description: "",
  });

  function update(field: string, value: string | null) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.stockId || !form.make || !form.model || !form.year) {
      toast.error("Stock ID, make, model, and year are required");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/cars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          year: parseInt(form.year),
          mileage: form.mileage ? parseInt(form.mileage) : undefined,
          price: form.price ? parseInt(form.price) : undefined,
        }),
      });

      if (res.ok) {
        const car = await res.json();
        toast.success("Car added");
        router.push(`/dashboard/inventory/${car.id}`);
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to create");
      }
    } catch {
      toast.error("Failed to create");
    }
    setSaving(false);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/dashboard/inventory")}
        >
          <ArrowLeft size={18} />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Add Car</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manually add a vehicle to inventory
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="glass-card rounded-xl p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Stock ID *" value={form.stockId} onChange={(v) => update("stockId", v)} />
            <Field label="VIN" value={form.vin} onChange={(v) => update("vin", v)} />
            <Field label="Make *" value={form.make} onChange={(v) => update("make", v)} />
            <Field label="Model *" value={form.model} onChange={(v) => update("model", v)} />
            <Field label="Year *" value={form.year} onChange={(v) => update("year", v)} type="number" />
            <Field label="Trim" value={form.trim} onChange={(v) => update("trim", v)} />
            <Field label="Color" value={form.color} onChange={(v) => update("color", v)} />
            <Field label="Mileage" value={form.mileage} onChange={(v) => update("mileage", v)} type="number" />
            <Field label="Price ($)" value={form.price} onChange={(v) => update("price", v)} type="number" />
            <Field label="Engine" value={form.engine} onChange={(v) => update("engine", v)} />

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Body Type</Label>
              <Select value={form.bodyType} onValueChange={(v) => update("bodyType", v)}>
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

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Drivetrain</Label>
              <Select value={form.drivetrain} onValueChange={(v) => update("drivetrain", v)}>
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
              <Select value={form.transmission} onValueChange={(v) => update("transmission", v)}>
                <SelectTrigger className="bg-background/50"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">Automatic</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              className="bg-background/50 min-h-[80px]"
              placeholder="Voice-agent-friendly description..."
            />
          </div>

          <div className="mt-6 flex justify-end">
            <Button type="submit" disabled={saving} className="gap-2">
              <Plus size={14} /> {saving ? "Creating..." : "Add Car"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground uppercase tracking-wider">{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-background/50"
      />
    </div>
  );
}
