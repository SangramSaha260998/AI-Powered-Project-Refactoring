import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Search,
  Settings,
  LogOut,
  UserCog,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/admin-users", label: "Admin Users", icon: UserCog },
] as const;

export function AdminShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="px-5 pt-6 pb-8 flex items-center gap-2">
          <div className="size-9 rounded-xl gradient-rose grid place-items-center font-display text-xl text-white shadow-lg shadow-primary/30">
            L
          </div>
          <div>
            <div className="font-display text-xl leading-none">Lollyz</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-1">
              Admin Console
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {nav.map(({ to, label, icon: Icon }) => {
            const active = pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent/60",
                )}
              >
                <Icon
                  className={cn(
                    "size-4",
                    active
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                <span>{label}</span>
                {active && (
                  <span className="ml-auto size-1.5 rounded-full bg-primary" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-sidebar-accent/60 transition-colors cursor-pointer">
            <div className="size-8 rounded-full gradient-rose grid place-items-center text-xs font-medium text-white">
              A
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">Admin</div>
              <div className="text-[11px] text-muted-foreground truncate">
                ops@lollyz.app
              </div>
            </div>
            <LogOut className="size-4 text-muted-foreground" />
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b border-border bg-background/80 backdrop-blur sticky top-0 z-10 flex items-center px-8 gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              placeholder="Search admin users…"
              className="w-full h-9 pl-9 pr-3 rounded-lg bg-muted/60 border border-transparent text-sm placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:bg-muted transition-colors"
            />
          </div>
          <button className="size-9 grid place-items-center rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors relative">
            <Bell className="size-4" />
            <span className="absolute top-2 right-2 size-1.5 rounded-full bg-primary" />
          </button>
          <button className="size-9 grid place-items-center rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <Settings className="size-4" />
          </button>
        </header>

        <div className="flex-1 px-8 py-8">
          <div className="flex items-start justify-between gap-6 mb-8">
            <div>
              <h1 className="font-display text-3xl tracking-tight">{title}</h1>
              {description && (
                <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
                  {description}
                </p>
              )}
            </div>
            {actions && (
              <div className="flex items-center gap-2 shrink-0">{actions}</div>
            )}
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}

