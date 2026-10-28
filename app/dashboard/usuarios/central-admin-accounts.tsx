"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";

export type CentralAdminAccount = {
  id: number;
  nombre: string;
  usuario: string;
  activo: boolean;
  rolNombre: string;
  sede: { id: number; nombre: string };
  updatedAt: string;
};

type Draft = {
  account: CentralAdminAccount;
  nombre: string;
  usuario: string;
  activo: boolean;
};

function edit(account: CentralAdminAccount): Draft {
  return { account, nombre: account.nombre, usuario: account.usuario, activo: account.activo };
}

export default function CentralAdminAccounts({ accounts, currentUserId, loadError = "", onReload }: {
  accounts: CentralAdminAccount[];
  currentUserId: number;
  loadError?: string;
  onReload: () => Promise<CentralAdminAccount[]>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);

  async function reload() {
    if (inFlight.current) return;
    inFlight.current = true;
    setReloading(true);
    setError("");
    try {
      const updated = await onReload();
      if (draft) {
        const account = updated.find(item => item.id === draft.account.id);
        setDraft(account ? edit(account) : null);
      }
      setPending(null);
      setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar la lista.");
    } finally {
      inFlight.current = false;
      setReloading(false);
    }
  }

  async function save(value: Draft) {
    if (inFlight.current) return;
    if (value.account.id === currentUserId && !value.activo) {
      setError("No puedes desactivar tu propia cuenta.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    let persisted = false;
    try {
      const response = await fetch("/api/usuarios/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipoPerfil: "ADMIN_CENTRAL", administradorId: value.account.id,
          nombre: value.nombre.trim(), usuario: value.usuario.trim().toLowerCase(), activo: value.activo,
          expectedUpdatedAt: value.account.updatedAt,
        }),
      });
      const data = await response.json() as { error?: string; mensaje?: string };
      if (!response.ok) {
        setConflict(response.status === 409);
        setPending(null);
        throw new Error(data.error || "No se pudieron guardar los cambios.");
      }
      persisted = true;
      setDraft(null);
      setPending(null);
      setConflict(false);
      setMessage(data.mensaje || "Administrador central actualizado.");
      await onReload();
    } catch (cause) {
      setError(persisted
        ? "Los cambios se guardaron, pero no se pudo actualizar la lista. Vuelve a cargarla."
        : cause instanceof Error ? cause.message : "No se pudo conectar con el servidor.");
      setPending(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || inFlight.current) return;
    setError("");
    setMessage("");
    if (!/^[a-z0-9._@-]{3,80}$/.test(draft.usuario.trim().toLowerCase())) {
      setError("El usuario debe tener entre 3 y 80 caracteres: letras, números, punto, guion, guion bajo o @.");
      return;
    }
    if (draft.account.activo && !draft.activo) setPending({ ...draft });
    else void save(draft);
  }

  const disabled = busy || reloading;
  const accountIsCurrent = draft?.account.id === currentUserId;

  return <Card className="mt-4 p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-bold">Administradores centrales</h2>
        <p className="mt-2 text-sm text-[var(--fp-muted)]">Cuentas de Admin Central FINSER, disponibles independientemente del aliado seleccionado.</p>
      </div>
      <Button variant="secondary" onClick={() => void reload()} disabled={disabled}>Actualizar lista</Button>
    </div>
    {(error || loadError) && <p role="alert" className="mt-4 rounded-[var(--fp-radius-md)] bg-[var(--fp-danger-soft)] p-4 text-sm text-[var(--fp-danger)]">{error || loadError}</p>}
    {message && <p role="status" className="mt-4 text-sm text-[var(--fp-graphite)]">{message}</p>}
    {reloading && <LoadingState label="Actualizando administradores centrales..." />}
    {!loadError && accounts.length === 0 && <EmptyState title="No hay administradores centrales disponibles" description="Crea una cuenta con el perfil Admin Central FINSER desde Nuevo usuario." />}
    {accounts.length > 0 && <DataTable className="mt-5">
      <table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:py-3 [&_th]:font-semibold [&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_thead]:bg-[var(--fp-bg)] [&_tbody_tr]:border-t [&_tbody_tr]:border-[var(--fp-border)]">
        <thead><tr><th scope="col">Nombre</th><th scope="col">Usuario de ingreso</th><th scope="col">Sede</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
        <tbody>{accounts.map(account => <tr key={account.id}>
          <td><strong>{account.nombre}</strong>{account.id === currentUserId && <span className="ml-2 text-sm text-[var(--fp-muted)]">Tu cuenta</span>}</td>
          <td>{account.usuario}</td><td>{account.sede.nombre}</td>
          <td><Badge tone={account.activo ? "positive" : "neutral"}>{account.activo ? "Activo" : "Inactivo"}</Badge></td>
          <td><Button variant="secondary" disabled={disabled} aria-label={`Editar ${account.nombre}`}
            onClick={() => { setDraft(edit(account)); setError(""); setMessage(""); setConflict(false); }}>Editar</Button></td>
        </tr>)}</tbody>
      </table>
    </DataTable>}
    {draft && <form onSubmit={submit} className="mt-6 border-t border-[var(--fp-border)] pt-5" aria-busy={busy}>
      <h3 className="text-lg font-bold">Editar administrador central</h3>
      <fieldset disabled={disabled} className="mt-4 grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Datos de {draft.account.nombre}</legend>
        <label className="grid gap-2 text-sm font-semibold">Nombre completo
          <Input required maxLength={120} value={draft.nombre} onChange={event => setDraft({ ...draft, nombre: event.target.value })} />
        </label>
        <label className="grid gap-2 text-sm font-semibold">Usuario de ingreso
          <Input required minLength={3} maxLength={80} autoComplete="off"
            value={draft.usuario} onChange={event => setDraft({ ...draft, usuario: event.target.value.replace(/\s/g, "").toLowerCase() })} />
        </label>
        <div className="text-sm"><p className="font-semibold">Perfil</p><p className="mt-2 text-[var(--fp-muted)]">Admin Central FINSER</p></div>
        <div className="text-sm"><p className="font-semibold">Sede asignada</p><p className="mt-2 text-[var(--fp-muted)]">{draft.account.sede.nombre}</p></div>
        <div className="sm:col-span-2">
          <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
            <input type="checkbox" className="h-4 w-4 accent-[var(--fp-graphite)]" checked={draft.activo} disabled={accountIsCurrent}
              onChange={event => setDraft({ ...draft, activo: event.target.checked })} aria-describedby={accountIsCurrent ? "central-own-status-help" : undefined} />
            Cuenta activa
          </label>
          {accountIsCurrent && <p id="central-own-status-help" className="text-sm text-[var(--fp-muted)]">Tu cuenta debe permanecer activa mientras administras los accesos.</p>}
        </div>
      </fieldset>
      {accountIsCurrent && <Link className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold underline" href="/dashboard/contrasena">Cambiar mi contraseña</Link>}
      {conflict && <p className="mt-4 text-sm text-[var(--fp-muted)]">Revisa el mensaje antes de reintentar. Si otra persona modificó la cuenta, Actualizar lista cargará su versión vigente y descartará esta edición.</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button type="submit" disabled={disabled || !draft.nombre.trim()}>{busy ? "Guardando..." : "Guardar cambios"}</Button>
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => { setDraft(null); setConflict(false); setError(""); }}>Cancelar edición</Button>
      </div>
    </form>}
    <ConfirmDialog open={pending !== null} title="Desactivar administrador central" danger
      description={`La cuenta ${pending?.account.usuario || ""} dejará de tener acceso a FINSER PAY. Los cambios de nombre y usuario también se guardarán.`}
      confirmLabel="Desactivar y guardar" busy={busy}
      onCancel={() => { if (!inFlight.current) setPending(null); }}
      onConfirm={() => { if (pending) void save(pending); }} />
  </Card>;
}
