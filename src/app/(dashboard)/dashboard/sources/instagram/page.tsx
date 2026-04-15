"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Camera, Plus, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Source {
  id: string;
  accountHandle: string;
  displayName: string | null;
  pollingInterval: number;
  lastPolledAt: string | null;
  lastReelTimestamp: string | null;
  isActive: boolean;
}

export default function InstagramSourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const [newName, setNewName] = useState("");
  const [newInterval, setNewInterval] = useState("60");

  async function fetchSources() {
    const res = await fetch("/api/sources/instagram");
    const data = await res.json();
    setSources(data);
    setLoading(false);
  }

  useEffect(() => {
    fetchSources();
  }, []);

  async function addSource() {
    if (!newHandle) return;
    const res = await fetch("/api/sources/instagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountHandle: newHandle.replace("@", ""),
        displayName: newName || null,
        pollingInterval: parseInt(newInterval),
      }),
    });
    if (res.ok) {
      toast.success("Source added");
      setShowAdd(false);
      setNewHandle("");
      setNewName("");
      fetchSources();
    } else {
      toast.error("Failed to add source");
    }
  }

  async function toggleActive(source: Source) {
    const res = await fetch("/api/sources/instagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: source.id, isActive: !source.isActive }),
    });
    if (res.ok) fetchSources();
  }

  async function pollNow(source: Source) {
    setPolling(source.id);
    try {
      const res = await fetch("/api/sources/instagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "poll", accountHandle: source.accountHandle }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(
          `Poll complete: ${data.matched || 0} matched, ${data.new_cars || 0} new`
        );
        fetchSources();
      } else {
        toast.error(data.error || "Poll failed");
      }
    } catch {
      toast.error("Poll failed");
    }
    setPolling(null);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Instagram Sources
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage Instagram accounts for reel scraping
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setShowAdd(!showAdd)}>
          <Plus size={14} /> Add Account
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="glass-card rounded-xl p-6 animate-fade-in-scale">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">
            New Instagram Source
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                Handle
              </Label>
              <Input
                value={newHandle}
                onChange={(e) => setNewHandle(e.target.value)}
                placeholder="georgejsaliba"
                className="bg-background/50"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                Display Name
              </Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="George Saliba"
                className="bg-background/50"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                Poll Interval (min)
              </Label>
              <Input
                type="number"
                value={newInterval}
                onChange={(e) => setNewInterval(e.target.value)}
                className="bg-background/50"
              />
            </div>
          </div>
          <div className="mt-4 flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={addSource}>
              Add Source
            </Button>
          </div>
        </div>
      )}

      {/* Sources list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-foreground/5 animate-pulse" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <div className="glass-card rounded-xl p-12 text-center">
          <Camera size={32} className="mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">No Instagram sources configured</p>
          <p className="text-sm text-muted-foreground/60 mt-1">
            Add an account to start scraping reels
          </p>
        </div>
      ) : (
        <div className="space-y-3 stagger-children">
          {sources.map((source) => (
            <div
              key={source.id}
              className="glass-card rounded-xl p-5 hover-lift"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-foreground/5 flex items-center justify-center">
                    <Camera size={18} className="text-muted-foreground" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        @{source.accountHandle}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${
                          source.isActive
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {source.isActive ? "Active" : "Paused"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                      {source.displayName && <span>{source.displayName}</span>}
                      <span>Every {source.pollingInterval}m</span>
                      {source.lastPolledAt && (
                        <span>
                          Last polled:{" "}
                          {new Date(source.lastPolledAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={polling === source.id}
                    onClick={() => pollNow(source)}
                  >
                    {polling === source.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Poll Now
                  </Button>
                  <Switch
                    checked={source.isActive}
                    onCheckedChange={() => toggleActive(source)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
