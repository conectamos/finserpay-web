"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Button, Card, Input } from "@/app/_components/finser-ui";

export default function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const inFlight = useRef(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    setSuccess("");
    if (newPassword !== confirmPassword) {
      setError("La confirmación de la nueva contraseña no coincide.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("La nueva contraseña debe ser diferente a la actual.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/usuarios/contrasena", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await response.json() as { error?: string; mensaje?: string };
      if (!response.ok) {
        setError(data.error || "No se pudo actualizar la contraseña.");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(data.mensaje || "Contraseña actualizada correctamente. Se cerraron las demás sesiones.");
    } catch {
      setError("No se pudo conectar con el servidor. Inténtalo nuevamente.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Card className="p-6 sm:p-8">
      <form onSubmit={save} className="space-y-6" aria-busy={saving}>
        <p className="text-sm text-[var(--fp-muted)]">Al guardar, se cerrarán tus otras sesiones. Esta sesión permanecerá abierta.</p>
        <fieldset disabled={saving} className="space-y-5">
          <legend className="sr-only">Contraseña de ingreso</legend>
          <div className="space-y-2">
            <label htmlFor="current-password" className="block text-sm font-semibold text-[var(--fp-graphite)]">Contraseña actual</label>
            <Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required maxLength={1024} className="w-full" />
          </div>
          <div className="space-y-2">
            <label htmlFor="new-password" className="block text-sm font-semibold text-[var(--fp-graphite)]">Nueva contraseña</label>
            <Input id="new-password" name="newPassword" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={8} maxLength={128} aria-describedby="password-help" className="w-full" />
            <p id="password-help" className="text-sm text-[var(--fp-muted)]">Usa entre 8 y 128 caracteres y una contraseña diferente a la actual.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="confirm-password" className="block text-sm font-semibold text-[var(--fp-graphite)]">Confirmar nueva contraseña</label>
            <Input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} maxLength={128} className="w-full" />
          </div>
        </fieldset>
        {error && <p role="alert" className="rounded-[var(--fp-radius-md)] bg-[var(--fp-danger-soft)] p-4 text-sm text-[var(--fp-danger)]">{error}</p>}
        {success && <p role="status" className="rounded-[var(--fp-radius-md)] bg-[var(--fp-lime-soft)] p-4 text-sm text-[var(--fp-graphite)]">{success}</p>}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={saving}>{saving ? "Guardando..." : "Guardar contraseña"}</Button>
          <Link href="/dashboard" className="fp-ui-button is-ghost">Volver al dashboard</Link>
        </div>
      </form>
    </Card>
  );
}
