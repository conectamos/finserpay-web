"use client";

import { useState, type FormEvent } from "react";
import { Badge, Button, Card, DataTable, Input, Select } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";

export type ApprovalAnalystAccount = {
  id: number;
  nombre: string;
  usuario: string;
  activo: boolean;
  sede: { id: number; nombre: string };
  updatedAt: string;
};

type Props = {
  accounts: ApprovalAnalystAccount[];
  sedes: Array<{ id: number; nombre: string; aliado?: { codigo: string | null } | null }>;
  onUpdated: () => Promise<void>;
};

type AccountAction = {
  account: ApprovalAnalystAccount;
  action: "SET_ACTIVE" | "RESET_PASSWORD";
  clave?: string;
};

export default function ApprovalAnalystAccounts({ accounts, sedes, onUpdated }: Props) {
  const [draft, setDraft] = useState({ nombre: "", usuario: "", clave: "", sedeId: "" });
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<AccountAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const centralSedes = sedes.filter((sede) => sede.aliado?.codigo?.trim().toUpperCase() === "FINSERPAY");

  async function save(method: "POST" | "PATCH", body: object) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/usuarios/admin", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo guardar el acceso");
      await onUpdated();
      setMessage(data.mensaje || "Acceso actualizado");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar el acceso");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (await save("POST", { ...draft, sedeId: Number(draft.sedeId), tipoPerfil: "ANALISTA_APROBACION" })) {
      setDraft({ nombre: "", usuario: "", clave: "", sedeId: "" });
    }
  }

  async function confirmAction() {
    if (!pending) return;
    const { account, action, clave } = pending;
    if (await save("PATCH", {
      tipoPerfil: "ANALISTA_APROBACION", analistaId: account.id,
      expectedUpdatedAt: account.updatedAt, action,
      ...(action === "RESET_PASSWORD" ? { clave } : { activo: !account.activo }),
    })) {
      setPasswords((current) => ({ ...current, [account.id]: "" }));
      setPending(null);
    }
  }

  return (
    <Card className="mt-4 p-5">
      <h2 className="text-xl font-bold">Analistas de aprobación</h2>
      <p className="mt-2 text-sm text-[var(--fp-muted)]">
        Cuentas personales para revisar créditos y autorizar su liquidación a aliados.
        Cada analista accede únicamente a Aprobaciones.
      </p>
      {message && <p className="mt-4 text-sm" role="status">{message}</p>}
      <form onSubmit={(event) => void create(event)} className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold">
          Nombre completo
          <Input required maxLength={120} value={draft.nombre} disabled={busy}
            onChange={(event) => setDraft({ ...draft, nombre: event.target.value })} />
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          Usuario personal
          <Input required minLength={3} maxLength={80} autoComplete="off" value={draft.usuario} disabled={busy}
            pattern="[a-zA-Z0-9._@-]{3,80}"
            onChange={(event) => setDraft({ ...draft, usuario: event.target.value.replace(/\s/g, "").toLowerCase() })} />
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          Clave inicial
          <Input required type="password" minLength={8} maxLength={128} autoComplete="new-password"
            value={draft.clave} disabled={busy}
            onChange={(event) => setDraft({ ...draft, clave: event.target.value })} />
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          Sede central
          <Select required value={draft.sedeId} disabled={busy}
            onChange={(event) => setDraft({ ...draft, sedeId: event.target.value })}>
            <option value="">Seleccionar sede central</option>
            {centralSedes.map((sede) => <option key={sede.id} value={sede.id}>{sede.nombre}</option>)}
          </Select>
        </label>
        <div className="md:col-span-2 flex justify-end">
          <Button type="submit" disabled={busy || !centralSedes.length}>
            {busy ? "Guardando..." : "Crear analista"}
          </Button>
        </div>
        {!centralSedes.length && <p className="text-sm text-[var(--fp-muted)] md:col-span-2">Se necesita una sede central activa para crear este acceso.</p>}
      </form>
      <div className="mt-6">
        {accounts.length ? (
          <DataTable>
            <table className="w-full text-left text-sm">
              <thead><tr>
                <th className="p-3" scope="col">Analista</th>
                <th className="p-3" scope="col">Estado</th>
                <th className="p-3" scope="col">Restablecer clave</th>
                <th className="p-3" scope="col">Acceso</th>
              </tr></thead>
              <tbody>{accounts.map((account) => (
                <tr key={account.id} className="border-t border-[var(--fp-border)]">
                  <td className="p-3"><p className="font-semibold">{account.nombre}</p><p className="text-[var(--fp-muted)]">{account.usuario} · {account.sede.nombre}</p></td>
                  <td className="p-3"><Badge>{account.activo ? "Activo" : "Inactivo"}</Badge></td>
                  <td className="p-3">
                    <div className="flex min-w-64 flex-wrap gap-2">
                      <Input type="password" autoComplete="new-password" minLength={8} maxLength={128}
                        aria-label={"Nueva clave para " + account.nombre} placeholder="Nueva clave (8 caracteres mínimo)"
                        value={passwords[account.id] || ""} disabled={busy}
                        onChange={(event) => setPasswords({ ...passwords, [account.id]: event.target.value })} />
                      <Button type="button" variant="secondary" disabled={busy || (passwords[account.id] || "").trim().length < 8}
                        onClick={() => setPending({ account, action: "RESET_PASSWORD", clave: passwords[account.id] })}>
                        Restablecer
                      </Button>
                    </div>
                  </td>
                  <td className="p-3">
                    <Button type="button" variant={account.activo ? "danger" : "secondary"} disabled={busy}
                      onClick={() => setPending({ account, action: "SET_ACTIVE" })}>
                      {account.activo ? "Desactivar" : "Activar"}
                    </Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </DataTable>
        ) : <p className="text-sm text-[var(--fp-muted)]">Todavía no hay analistas de aprobación.</p>}
      </div>
      <ConfirmDialog open={Boolean(pending)} busy={busy}
        title={pending?.action === "RESET_PASSWORD" ? "Restablecer clave del analista" : pending?.account.activo ? "Desactivar analista" : "Activar analista"}
        description={(pending?.account.nombre || "") + ": se cerrará el acceso de sus sesiones anteriores."}
        confirmLabel="Confirmar cambio"
        danger={pending?.action === "SET_ACTIVE" && pending.account.activo}
        onCancel={() => { if (!busy) setPending(null); }}
        onConfirm={() => void confirmAction()} />
    </Card>
  );
}
