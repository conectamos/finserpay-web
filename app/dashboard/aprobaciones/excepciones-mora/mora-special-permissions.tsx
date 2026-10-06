"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";

type Data = {
  users: Array<{ id: number; nombre: string }>;
  grants: Array<{ userId: number; active: boolean; reason: string; updatedAt: string }>;
  history: Array<{ id: string; userId: number; active: boolean; actorName: string; reason: string; createdAt: string }>;
};
async function request(options?: RequestInit): Promise<Data> {
  const response = await fetch("/api/aprobaciones/excepciones-mora/permisos", { cache: "no-store", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "No se pudo consultar el permiso especial.");
  return payload as Data;
}
export default function MoraSpecialPermissions({ onUpdated }: { onUpdated: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [userId, setUserId] = useState("");
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const key = useRef<string | null>(null);
  useEffect(() => { key.current = null; }, [userId, active, reason]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setLoading(true); setError("");
    request({ signal: controller.signal }).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, reload]);
  function review(event: FormEvent) { event.preventDefault(); if (userId && reason.trim().length >= 10 && !saving) setConfirm(true); }
  async function save() {
    if (saving) return;
    setSaving(true); setError(""); setNotice(""); key.current ??= crypto.randomUUID();
    try {
      await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: Number(userId), active, reason, idempotencyKey: key.current }) });
      key.current = null; setConfirm(false); setReason(""); setNotice("Permiso actualizado con historial de autorización."); setReload(value => value + 1); onUpdated();
    } catch (e) { setConfirm(false); setError(e instanceof Error ? e.message : "No se pudo guardar el permiso."); }
    finally { setSaving(false); }
  }
  const target = data?.users.find(item => item.id === Number(userId));
  return <Card className="p-4">
    <Button variant="ghost" aria-expanded={open} disabled={saving} onClick={() => setOpen(value => !value)}>Administrar permiso especial de enfriamiento</Button>
    {open && <div className="mt-3 space-y-4">
      <p className="text-sm text-[var(--fp-muted)]">Este permiso se asigna únicamente a administradores centrales. Cada omisión del enfriamiento seguirá exigiendo su motivo.</p>
      {error && <p role="alert" className="text-sm text-[var(--fp-danger)]">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
      {loading ? <LoadingState label="Consultando permisos…" /> : data && <>
        <form onSubmit={review} className="grid items-end gap-3 lg:grid-cols-[minmax(180px,1fr)_180px_minmax(200px,2fr)_auto]">
          <label className="text-sm font-semibold">Administrador<Select value={userId} required disabled={saving} onChange={e => setUserId(e.target.value)}><option value="">Seleccionar</option>{data.users.map(item => <option key={item.id} value={item.id}>{item.nombre}</option>)}</Select></label>
          <label className="text-sm font-semibold">Acción<Select value={active ? "grant" : "revoke"} disabled={saving} onChange={e => setActive(e.target.value === "grant")}><option value="grant">Otorgar permiso</option><option value="revoke">Revocar permiso</option></Select></label>
          <label className="text-sm font-semibold">Motivo de autorización<Input value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1000} required disabled={saving} /></label>
          <Button type="submit" variant="secondary" disabled={saving || !userId || reason.trim().length < 10}>Revisar cambio</Button>
        </form>
        <ul className="space-y-2 text-sm">{data.grants.map(item => <li key={item.userId} className="flex flex-wrap gap-2"><strong>{data.users.find(user => user.id === item.userId)?.nombre || `Usuario ${item.userId}`}</strong><Badge tone={item.active ? "positive" : "neutral"}>{item.active ? "Permiso activo" : "Revocado"}</Badge><span>{item.reason}</span></li>)}</ul>
        <details><summary className="cursor-pointer text-sm font-semibold">Historial de autorizaciones</summary><ol className="mt-3 max-h-64 space-y-3 overflow-y-auto text-sm">{data.history.map(item => <li key={item.id} className="border-l-2 border-[var(--fp-border)] pl-3"><strong>{item.active ? "Permiso otorgado" : "Permiso revocado"} · {data.users.find(user => user.id === item.userId)?.nombre || `Usuario ${item.userId}`}</strong><p>{new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota" }).format(new Date(item.createdAt))} · {item.actorName}</p><p>{item.reason}</p></li>)}</ol></details>
      </>}
    </div>}
    <ConfirmDialog open={confirm} title={active ? "Otorgar permiso especial" : "Revocar permiso especial"} description={`${target?.nombre || "El administrador seleccionado"}: ${reason}`} confirmLabel={active ? "Confirmar autorización" : "Confirmar revocación"} busy={saving} danger={!active} onCancel={() => setConfirm(false)} onConfirm={() => void save()} />
  </Card>;
}
