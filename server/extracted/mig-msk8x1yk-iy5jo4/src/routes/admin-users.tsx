import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Plus,
  Edit3,
  Power,
  X,
  Eye,
  EyeOff,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { shortDate, initials, gradientFor } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin-users")({
  head: () => ({ meta: [{ title: "Admin Users — Lollyz Admin" }] }),
  component: AdminUsersPage,
});

type AdminUser = {
  id: string;
  name: string;
  email: string;
  password: string;
  active: boolean;
  createdAt: string;
};

const STORAGE_KEY = "lollyz_admin_users_v1";

const INITIAL: AdminUser[] = [
  {
    id: "au_1",
    name: "Olivia Hart",
    email: "olivia@lollyz.app",
    password: "Lollyz!2026",
    active: true,
    createdAt: new Date(Date.now() - 90 * 86400000).toISOString(),
  },
  {
    id: "au_2",
    name: "Marcus Lin",
    email: "marcus@lollyz.app",
    password: "OpsTeam#42",
    active: true,
    createdAt: new Date(Date.now() - 40 * 86400000).toISOString(),
  },
  {
    id: "au_3",
    name: "Priya Mehta",
    email: "priya@lollyz.app",
    password: "Moderate$99",
    active: false,
    createdAt: new Date(Date.now() - 12 * 86400000).toISOString(),
  },
];

function load(): AdminUser[] {
  if (typeof window === "undefined") return INITIAL;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AdminUser[]) : INITIAL;
  } catch {
    return INITIAL;
  }
}

function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>(INITIAL);
  const [hydrated, setHydrated] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(true);

  useEffect(() => {
    setUsers(load());
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
  }, [users, hydrated]);

  const filtered = users.filter((u) => {
    if (!showInactive && !u.active) return false;
    if (q && !`${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()))
      return false;
    return true;
  });

  function save(u: AdminUser) {
    setUsers((xs) =>
      xs.some((x) => x.id === u.id)
        ? xs.map((x) => (x.id === u.id ? u : x))
        : [u, ...xs],
    );
    setEditing(null);
    setCreating(false);
  }
  function toggleActive(id: string) {
    setUsers((xs) =>
      xs.map((u) => (u.id === id ? { ...u, active: !u.active } : u)),
    );
  }

  const activeCount = users.filter((u) => u.active).length;

  return (
    <AdminShell
      title="Admin users"
      description="Manage console operators who can sign in to the admin console."
      actions={
        <button
          onClick={() => setCreating(true)}
          className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 inline-flex items-center gap-2"
        >
          <Plus className="size-4" /> Add admin
        </button>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <StatCard label="Total admins" value={users.length} />
        <StatCard label="Active" value={activeCount} tone="success" />
        <StatCard
          label="Inactive"
          value={users.length - activeCount}
          tone="muted"
        />
      </div>

      <div className="rounded-2xl border border-border bg-card p-3 mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or email…"
          className="h-9 px-3 rounded-lg bg-muted/60 text-sm placeholder:text-muted-foreground focus:outline-none focus:bg-muted min-w-[280px]"
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer ml-2">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="accent-primary"
          />
          Show inactive
        </label>
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} shown
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Admin</th>
              <th className="text-left px-4 py-3 font-medium">Email</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((u) => (
              <tr key={u.id} className="hover:bg-muted/30">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="size-9 rounded-full grid place-items-center text-white text-xs font-medium shrink-0"
                      style={{ background: gradientFor(u.id) }}
                    >
                      {initials(u.name)}
                    </div>
                    <div className="font-medium">{u.name}</div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="size-3.5" />
                    {u.email}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
                      u.active
                        ? "bg-success/15 text-success"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        u.active ? "bg-success" : "bg-muted-foreground",
                      )}
                    />
                    {u.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {shortDate(u.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <IconBtn title="Edit" onClick={() => setEditing(u)}>
                      <Edit3 className="size-4" />
                    </IconBtn>
                    <IconBtn
                      title={u.active ? "Deactivate" : "Activate"}
                      onClick={() => toggleActive(u.id)}
                    >
                      <Power className="size-4" />
                    </IconBtn>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-sm text-muted-foreground"
                >
                  No admin users match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <AdminUserForm
          initial={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSave={save}
        />
      )}
    </AdminShell>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "muted";
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-2xl",
          tone === "success" && "text-success",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="size-8 grid place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-muted-foreground mb-1.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function AdminUserForm({
  initial,
  onClose,
  onSave,
}: {
  initial: AdminUser | null;
  onClose: () => void;
  onSave: (u: AdminUser) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim(),
      em = email.trim().toLowerCase();
    if (!n) return setError("Name is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))
      return setError("Enter a valid email address.");
    if (password.length < 6)
      return setError("Password must be at least 6 characters.");
    onSave({
      id: initial?.id ?? `au_${Date.now().toString(36)}`,
      name: n,
      email: em,
      password,
      active,
      createdAt: initial?.createdAt ?? new Date().toISOString(),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <div className="font-display text-lg">
              {initial ? "Edit admin" : "Add admin user"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="size-8 grid place-items-center rounded-lg hover:bg-muted text-muted-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="form-input"
              placeholder="Jane Doe"
              autoFocus
            />
          </Field>
          <Field label="Email">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              className="form-input"
              placeholder="jane@lollyz.app"
            />
          </Field>
          <Field label="Password">
            <div className="relative">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPw ? "text" : "password"}
                className="form-input pr-10"
                placeholder="Minimum 6 characters"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 size-7 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {showPw ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-primary"
            />
            Active — can sign in to the admin console
          </label>
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-lg text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
          >
            {initial ? "Save changes" : "Create admin"}
          </button>
        </div>

        <style>{`.form-input{width:100%;height:38px;padding:0 12px;border-radius:8px;background:hsl(var(--muted)/0.5);font-size:14px;outline:none;border:1px solid transparent}.form-input:focus{background:hsl(var(--muted));border-color:hsl(var(--ring))}`}</style>
      </form>
    </div>
  );
}
