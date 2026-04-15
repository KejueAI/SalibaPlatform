"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message || "Invalid credentials");
      } else {
        router.push("/dashboard");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen dot-grid flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in-scale">
        <div className="glass-card rounded-2xl p-8">
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-1">
              <div className="status-dot available" />
              <span className="text-xs text-muted-foreground font-mono tracking-wider uppercase">
                Online
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight mt-4">
              J&S AutoHaus
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Inventory Platform
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-xs text-muted-foreground uppercase tracking-wider">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@kejue.co"
                required
                className="bg-background/50 border-border/50 focus:border-foreground/20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-xs text-muted-foreground uppercase tracking-wider">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="bg-background/50 border-border/50 focus:border-foreground/20"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive animate-fade-in">{error}</p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full mt-2"
            >
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground/50 mt-6 font-mono">
          Built by Kejue
        </p>
      </div>
    </div>
  );
}
