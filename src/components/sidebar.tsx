"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "@/lib/auth-client";
import {
  LayoutDashboard,
  Car,
  Camera,
  FileSpreadsheet,
  Activity,
  BarChart3,
  Users,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const navigation = [
  { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { name: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { name: "Inventory", href: "/dashboard/inventory", icon: Car },
  { name: "Instagram", href: "/dashboard/sources/instagram", icon: Camera },
  { name: "vAuto", href: "/dashboard/sources/vauto", icon: FileSpreadsheet },
  { name: "Events", href: "/dashboard/events", icon: Activity },
];

const adminNavigation = [
  { name: "Users", href: "/dashboard/settings/users", icon: Users },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isAdmin = session?.user?.role === "admin";

  function NavContent() {
    return (
      <div className="flex flex-col h-full">
        {/* Logo */}
        <div className="p-6 pb-4">
          <div className="flex items-center gap-2">
            <div className="status-dot available" />
            <span className="text-xs text-muted-foreground font-mono tracking-wider uppercase">
              Live
            </span>
          </div>
          <h2 className="text-lg font-semibold tracking-tight mt-3">
            J&S AutoHaus
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Inventory Platform
          </p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 space-y-1">
          {navigation.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 ${
                  isActive
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                }`}
              >
                <item.icon size={16} strokeWidth={1.5} />
                {item.name}
              </Link>
            );
          })}

          {isAdmin && (
            <>
              <div className="pt-4 pb-2 px-3">
                <span className="text-[10px] text-muted-foreground/50 font-mono uppercase tracking-widest">
                  Admin
                </span>
              </div>
              {adminNavigation.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 ${
                      isActive
                        ? "bg-foreground/10 text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                    }`}
                  >
                    <item.icon size={16} strokeWidth={1.5} />
                    {item.name}
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        {/* User */}
        <div className="p-4 border-t border-border/50">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-sm truncate">{session?.user?.name || "User"}</p>
              <p className="text-xs text-muted-foreground truncate">
                {session?.user?.email}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await signOut();
                router.push("/login");
              }}
            >
              <LogOut size={16} />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg glass-card"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 border-r border-border/50 bg-sidebar transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <NavContent />
      </aside>
    </>
  );
}
