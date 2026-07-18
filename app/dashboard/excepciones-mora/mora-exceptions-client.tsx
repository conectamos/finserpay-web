"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

type ExceptionItem = {
  id: number;
  documento: string;
  motivo: string;
  fechaFin: string | null;
  createdAt: string;
  creadoPor: string;
  cliente: {
    nombre: string;
    telefono: string | null;
  } | null;
  creditosActivos: number;
  bloqueosMoraActivos: number;
};

type ApiMessage = {
  error?: string;
  message?: string;
  sync?: {
    checked: number;
    unlocked: number;
    failed: number;
  };
};

function formatDate(value: string | null) {
  if (!value) {
    return "Sin vencimiento";
  }

  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(new Date(value));
}

export default function MoraExceptionsClient() {
  const [items, setItems] = useState<ExceptionItem[]>([]);
  const [documento, setDocumento] = useState("");
  const [motivo, setMotivo] = useState("");
  const [fechaFin, setFechaFin] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadItems = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/excepciones-mora", {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        error?: string;
        excepciones?: ExceptionItem[];
      };

      if (!response.ok) {
        throw new Error(data.error || "No se pudieron cargar las excepciones");
      }

      setItems(Array.isArray(data.excepciones) ? data.excepciones : []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No se pudieron cargar las excepciones"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function submitException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/excepciones-mora", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documento, motivo, fechaFin }),
      });
      const data = (await response.json()) as ApiMessage;

      if (!response.ok) {
        throw new Error(data.error || "No se pudo activar la excepcion");
      }

      const syncDetail = data.sync
        ? ` Revisados: ${data.sync.checked}. Desbloqueados: ${data.sync.unlocked}.`
        : "";
      const failureDetail = data.sync?.failed
        ? ` ${data.sync.failed} equipo(s) requieren revision manual.`
        : "";
      setMessage(`${data.message || "Excepcion activada"}.${syncDetail}${failureDetail}`);
      setDocumento("");
      setMotivo("");
      setFechaFin("");
      await loadItems();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "No se pudo activar la excepcion"
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeException(item: ExceptionItem) {
    const confirmed = window.confirm(
      `Retirar la excepcion de ${item.documento}? Si conserva mora, volvera a evaluarse en la sincronizacion nocturna.`
    );

    if (!confirmed) {
      return;
    }

    setRemoving(item.documento);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/excepciones-mora", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documento: item.documento }),
      });
      const data = (await response.json()) as ApiMessage;

      if (!response.ok) {
        throw new Error(data.error || "No se pudo retirar la excepcion");
      }

      setMessage(data.message || "Excepcion retirada");
      await loadItems();
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "No se pudo retirar la excepcion"
      );
    } finally {
      setRemoving(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#edf2f6] px-4 py-6 text-[#111318] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="rounded-lg bg-[#111318] px-6 py-6 text-white shadow-[0_18px_50px_rgba(17,19,24,0.12)] sm:px-8">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
            <div>
              <p className="text-[11px] font-black uppercase text-[#82d9c9]">
                FINSER PAY CENTRAL
              </p>
              <h1 className="mt-2 text-3xl font-black sm:text-4xl">
                Excepciones de bloqueo
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#d9dee5]">
                La mora y la cartera siguen visibles. Esta lista solamente evita
                el bloqueo tecnologico mientras el acuerdo este vigente.
              </p>
            </div>
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center justify-center rounded-lg border border-white/20 px-5 text-sm font-black text-white transition hover:bg-white/10"
            >
              Volver al dashboard
            </Link>
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-[#efb0ad] bg-[#fff2f1] px-5 py-4 text-sm font-bold text-[#a6221f]">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-lg border border-[#99e5c9] bg-[#ecfff6] px-5 py-4 text-sm font-bold text-[#075f4f]">
            {message}
          </div>
        )}

        <section className="rounded-lg border border-[#d7dde4] bg-white p-5 shadow-[0_14px_38px_rgba(17,19,24,0.06)] sm:p-7">
          <div className="mb-5">
            <p className="text-[11px] font-black uppercase text-[#0f766e]">
              NUEVO ACUERDO
            </p>
            <h2 className="mt-2 text-2xl font-black">Proteger una cedula</h2>
            <p className="mt-2 text-sm text-[#667080]">
              Si ya tiene un bloqueo por mora, el sistema intentara desbloquearla
              al guardar. Los bloqueos por robo nunca se modifican.
            </p>
          </div>

          <form
            onSubmit={submitException}
            className="grid gap-4 lg:grid-cols-[0.8fr_1.5fr_0.8fr_auto] lg:items-end"
          >
            <label className="grid gap-2 text-xs font-black uppercase text-[#454d59]">
              Cedula
              <input
                required
                inputMode="numeric"
                value={documento}
                onChange={(event) =>
                  setDocumento(event.target.value.replace(/\D/g, "").slice(0, 20))
                }
                placeholder="Numero de documento"
                className="h-12 rounded-lg border border-[#ccd4de] bg-white px-4 text-sm font-bold text-[#111318] outline-none transition focus:border-[#0f766e]"
              />
            </label>
            <label className="grid gap-2 text-xs font-black uppercase text-[#454d59]">
              Motivo del acuerdo
              <input
                required
                value={motivo}
                onChange={(event) => setMotivo(event.target.value.slice(0, 500))}
                placeholder="Ej: acuerdo de pago autorizado"
                className="h-12 rounded-lg border border-[#ccd4de] bg-white px-4 text-sm font-bold text-[#111318] outline-none transition focus:border-[#0f766e]"
              />
            </label>
            <label className="grid gap-2 text-xs font-black uppercase text-[#454d59]">
              Vigente hasta
              <input
                type="date"
                value={fechaFin}
                onChange={(event) => setFechaFin(event.target.value)}
                className="h-12 rounded-lg border border-[#ccd4de] bg-white px-4 text-sm font-bold text-[#111318] outline-none transition focus:border-[#0f766e]"
              />
            </label>
            <button
              type="submit"
              disabled={saving}
              className="h-12 rounded-lg bg-[#0f766e] px-6 text-sm font-black text-white transition hover:bg-[#0a5b55] disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? "Guardando..." : "Activar excepcion"}
            </button>
          </form>
        </section>

        <section className="overflow-hidden rounded-lg border border-[#d7dde4] bg-white shadow-[0_14px_38px_rgba(17,19,24,0.06)]">
          <div className="flex flex-col justify-between gap-2 border-b border-[#e2e7ec] px-5 py-5 sm:flex-row sm:items-end sm:px-7">
            <div>
              <p className="text-[11px] font-black uppercase text-[#0f766e]">
                ACUERDOS VIGENTES
              </p>
              <h2 className="mt-2 text-2xl font-black">Cedulas protegidas</h2>
            </div>
            <p className="text-sm font-bold text-[#667080]">
              {items.length} activas
            </p>
          </div>

          {loading ? (
            <p className="px-7 py-12 text-center text-sm font-bold text-[#667080]">
              Cargando excepciones...
            </p>
          ) : items.length === 0 ? (
            <p className="px-7 py-12 text-center text-sm font-bold text-[#667080]">
              No hay cedulas excluidas del bloqueo por mora.
            </p>
          ) : (
            <div className="divide-y divide-[#e2e7ec]">
              {items.map((item) => (
                <article
                  key={item.id}
                  className="grid gap-4 px-5 py-5 sm:px-7 lg:grid-cols-[1fr_1.5fr_0.8fr_auto] lg:items-center"
                >
                  <div>
                    <p className="text-xs font-black uppercase text-[#778190]">
                      Cedula
                    </p>
                    <p className="mt-1 text-xl font-black">{item.documento}</p>
                    <p className="mt-1 text-sm font-bold text-[#4f5865]">
                      {item.cliente?.nombre || "Sin credito asociado"}
                    </p>
                    {item.cliente?.telefono && (
                      <p className="text-xs text-[#778190]">
                        {item.cliente.telefono}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-black uppercase text-[#778190]">
                      Motivo
                    </p>
                    <p className="mt-1 text-sm font-bold leading-6 text-[#2f3640]">
                      {item.motivo}
                    </p>
                    <p className="mt-1 text-xs text-[#778190]">
                      Registrado por {item.creadoPor}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-black uppercase text-[#778190]">
                      Vigencia
                    </p>
                    <p className="mt-1 text-sm font-black text-[#075f4f]">
                      {formatDate(item.fechaFin)}
                    </p>
                    <p className="mt-1 text-xs text-[#778190]">
                      {item.creditosActivos} credito(s) activo(s)
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={removing === item.documento}
                    onClick={() => void removeException(item)}
                    className="h-11 rounded-lg border border-[#e8a8a5] px-5 text-sm font-black text-[#a6221f] transition hover:bg-[#fff2f1] disabled:cursor-wait disabled:opacity-60"
                  >
                    {removing === item.documento ? "Retirando..." : "Retirar"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
