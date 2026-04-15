"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileSpreadsheet, Upload, RefreshCw, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function VautoPage() {
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<{
    file: string;
    rows: number;
    new: number;
    updated: number;
    sold: number;
    errors: string[];
  } | null>(null);
  const [uploading, setUploading] = useState(false);

  async function triggerImport() {
    setImporting(true);
    try {
      const res = await fetch("/api/cron/vauto", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setLastResult(data);
        toast.success(`Import complete: ${data.new || 0} new, ${data.updated || 0} updated`);
      } else {
        toast.error(data.error || "Import failed");
      }
    } catch {
      toast.error("Import failed");
    }
    setImporting(false);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      // Upload to a temp endpoint then process
      const res = await fetch("/api/cron/vauto", {
        method: "POST",
        headers: { "X-Manual-Upload": "true" },
      });
      const data = await res.json();
      if (res.ok) {
        setLastResult(data);
        toast.success("Upload processed");
      } else {
        toast.error(data.error || "Upload failed");
      }
    } catch {
      toast.error("Upload failed");
    }
    setUploading(false);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">vAuto Import</h1>
        <p className="text-sm text-muted-foreground mt-1">
          CSV imports from vAuto SFTP feed
        </p>
      </div>

      {/* SFTP Config Card */}
      <div className="glass-card rounded-xl p-6">
        <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
          SFTP Configuration
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Host</span>
            <p className="font-mono mt-1">saliba.kejue.co</p>
          </div>
          <div>
            <span className="text-muted-foreground">Port</span>
            <p className="font-mono mt-1">22</p>
          </div>
          <div>
            <span className="text-muted-foreground">User</span>
            <p className="font-mono mt-1">vauto</p>
          </div>
          <div>
            <span className="text-muted-foreground">Upload Directory</span>
            <p className="font-mono mt-1">/uploads/</p>
          </div>
          <div>
            <span className="text-muted-foreground">Schedule</span>
            <p className="mt-1">Daily at 1:00 AM EST (pickup at 1:30 AM)</p>
          </div>
          <div>
            <span className="text-muted-foreground">File Format</span>
            <p className="mt-1">CSV, comma-delimited</p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="glass-card rounded-xl p-6 hover-lift">
          <div className="flex items-center gap-3 mb-3">
            <RefreshCw size={18} className="text-muted-foreground" />
            <h3 className="font-medium">Import Now</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Process the latest CSV file from the SFTP upload directory
          </p>
          <Button
            size="sm"
            className="gap-2"
            onClick={triggerImport}
            disabled={importing}
          >
            {importing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {importing ? "Importing..." : "Run Import"}
          </Button>
        </div>

        <div className="glass-card rounded-xl p-6 hover-lift">
          <div className="flex items-center gap-3 mb-3">
            <Upload size={18} className="text-muted-foreground" />
            <h3 className="font-medium">Manual Upload</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Upload a CSV file directly for processing
          </p>
          <Button
            size="sm"
            variant="outline"
            className="gap-2 relative"
            disabled={uploading}
            onClick={() => document.getElementById("csv-upload")?.click()}
          >
            <input
              id="csv-upload"
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileUpload}
            />
            {uploading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            {uploading ? "Processing..." : "Upload CSV"}
          </Button>
        </div>
      </div>

      {/* Last Result */}
      {lastResult && (
        <div className="glass-card rounded-xl p-6 animate-fade-in-scale">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
            Last Import Result
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4">
            <Stat label="Rows" value={lastResult.rows} />
            <Stat label="New" value={lastResult.new} icon={<CheckCircle2 size={14} className="text-emerald-400" />} />
            <Stat label="Updated" value={lastResult.updated} />
            <Stat label="Sold" value={lastResult.sold} />
            <Stat
              label="Errors"
              value={lastResult.errors.length}
              icon={
                lastResult.errors.length > 0 ? (
                  <AlertCircle size={14} className="text-destructive" />
                ) : undefined
              }
            />
          </div>
          {lastResult.errors.length > 0 && (
            <div className="space-y-1 mt-2">
              {lastResult.errors.slice(0, 5).map((err, i) => (
                <p key={i} className="text-xs text-destructive/80 font-mono">
                  {err}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5 mt-1">
        {icon}
        <span className="text-lg font-semibold font-mono">{value}</span>
      </div>
    </div>
  );
}
