"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  FileText,
  Plus,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";

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
    <main className="px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <div className="mx-auto max-w-[1680px] space-y-5">
        <header className="flex flex-col gap-4 border-b border-[#d8dee5] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase text-[#6d8c19]">
              Control de cartera
            </p>
            <h1 className="mt-2 text-3xl font-black text-[#151a21] sm:text-4xl">
              Excepciones por mora
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#667085]">
              Administra los acuerdos que suspenden temporalmente el bloqueo
              tecnologico sin ocultar la mora ni alterar la cartera.
            </p>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[#c9df91] bg-[#f7fbe9] px-4 py-2 text-sm font-black text-[#4f6f0c]">
            <ShieldCheck className="h-4 w-4" strokeWidth={2} />
            {loading ? "Consultando acuerdos" : `${items.length} acuerdos activos`}
          </div>
        </header>

        <div className="flex items-start gap-3 rounded-lg border border-[#d8dee5] bg-white px-4 py-3 text-sm text-[#475467] shadow-[0_4px_14px_rgba(16,24,40,0.04)]">
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#6d8c19]" strokeWidth={1.8} />
          <p>
            La excepcion solo evita el bloqueo por mora mientras este vigente.
            Los bloqueos por robo no se modifican y el saldo continua visible.
          </p>
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-[#f1b5b2] bg-[#fff3f2] px-5 py-4 text-sm font-bold text-[#a6221f]">
            {error}
          </div>
        ) : null}
        {message ? (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-[#c9df91] bg-[#f7fbe9] px-5 py-4 text-sm font-bold text-[#4f6f0c]">
            <CheckCircle2 className="h-5 w-5 shrink-0" strokeWidth={2} />
            {message}
          </div>
        ) : null}

        <section className="rounded-lg border border-[#d8dee5] bg-white p-5 shadow-[0_5px_18px_rgba(16,24,40,0.04)] sm:p-6">
          <div className="mb-5 flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#151a21] text-[#dafa70]">
              <Plus className="h-5 w-5" strokeWidth={2} />
            </span>
            <div>
              <h2 className="text-xl font-black text-[#151a21]">Crear excepcion</h2>
              <p className="mt-1 text-sm text-[#667085]">
                Registra el documento, el motivo autorizado y la fecha limite del acuerdo.
              </p>
            </div>
          </div>

          <form
            onSubmit={submitException}
            className="grid gap-4 xl:grid-cols-[minmax(190px,0.8fr)_minmax(320px,1.5fr)_minmax(190px,0.8fr)_auto] xl:items-end"
          >
            <label className="grid gap-2 text-xs font-black text-[#344054]">
              Cedula
              <input
                required
                inputMode="numeric"
                value={documento}
                onChange={(event) =>
                  setDocumento(event.target.value.replace(/\D/g, "").slice(0, 20))
                }
                placeholder="Numero de documento"
                className="h-12 rounded-lg border border-[#cfd6dd] bg-white px-4 text-sm font-semibold text-[#151a21] outline-none transition focus:border-[#7ca613] focus:ring-4 focus:ring-[#b7e63d]/20"
              />
            </label>
            <label className="grid gap-2 text-xs font-black text-[#344054]">
              Motivo del acuerdo
              <input
                required
                value={motivo}
                onChange={(event) => setMotivo(event.target.value.slice(0, 500))}
                placeholder="Ej: acuerdo de pago autorizado"
                className="h-12 rounded-lg border border-[#cfd6dd] bg-white px-4 text-sm font-semibold text-[#151a21] outline-none transition focus:border-[#7ca613] focus:ring-4 focus:ring-[#b7e63d]/20"
              />
            </label>
            <label className="grid gap-2 text-xs font-black text-[#344054]">
              Vigente hasta (opcional)
              <input
                type="date"
                value={fechaFin}
                onChange={(event) => setFechaFin(event.target.value)}
                className="h-12 rounded-lg border border-[#cfd6dd] bg-white px-4 text-sm font-semibold text-[#151a21] outline-none transition focus:border-[#7ca613] focus:ring-4 focus:ring-[#b7e63d]/20"
              />
            </label>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-[#151a21] px-6 text-sm font-black text-white transition hover:bg-[#272e38] disabled:cursor-wait disabled:opacity-60"
            >
              <ShieldCheck className="h-4 w-4 text-[#dafa70]" strokeWidth={2} />
              {saving ? "Activando..." : "Activar excepcion"}
            </button>
          </form>
        </section>

        <section className="overflow-hidden rounded-lg border border-[#d8dee5] bg-white shadow-[0_5px_18px_rgba(16,24,40,0.04)]">
          <div className="flex flex-col gap-3 border-b border-[#e4e7ec] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <h2 className="text-xl font-black text-[#151a21]">Acuerdos vigentes</h2>
              <p className="mt-1 text-sm text-[#667085]">
                Cedulas protegidas temporalmente contra el bloqueo por mora.
              </p>
            </div>
            <span className="text-sm font-bold text-[#667085]">{items.length} registros</span>
          </div>

          {loading ? (
            <p className="px-6 py-14 text-center text-sm font-bold text-[#667085]">
              Cargando excepciones...
            </p>
          ) : items.length === 0 ? (
            <div className="grid place-items-center px-6 py-14 text-center">
              <ShieldCheck className="h-9 w-9 text-[#98a2b3]" strokeWidth={1.5} />
              <p className="mt-3 text-sm font-bold text-[#475467]">
                No hay cedulas excluidas del bloqueo por mora.
              </p>
            </div>
          ) : (
            <div>
              <div className="hidden grid-cols-[1.15fr_1.5fr_0.9fr_0.8fr_auto] gap-5 bg-[#f8fafb] px-6 py-3 text-[11px] font-black uppercase text-[#667085] lg:grid">
                <span>Cliente</span>
                <span>Motivo y registro</span>
                <span>Vigencia</span>
                <span>Impacto</span>
                <span className="sr-only">Acciones</span>
              </div>
              <div className="divide-y divide-[#e4e7ec]">
                {items.map((item) => (
                  <article
                    key={item.id}
                    className="grid gap-5 px-5 py-5 transition hover:bg-[#fbfcf8] sm:px-6 lg:grid-cols-[1.15fr_1.5fr_0.9fr_0.8fr_auto] lg:items-center"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#f2f9df] text-[#4f6f0c]">
                        <UserRound className="h-5 w-5" strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-black text-[#151a21]">CC {item.documento}</p>
                        <p className="mt-1 truncate text-sm font-bold text-[#344054]">
                          {item.cliente?.nombre || "Sin credito asociado"}
                        </p>
                        {item.cliente?.telefono ? (
                          <p className="mt-0.5 text-xs text-[#667085]">{item.cliente.telefono}</p>
                        ) : null}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <p className="mb-1 text-[10px] font-black uppercase text-[#98a2b3] lg:hidden">Motivo</p>
                      <p className="text-sm font-bold leading-5 text-[#344054]">{item.motivo}</p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-[#667085]">
                        <FileText className="h-3.5 w-3.5" strokeWidth={1.8} />
                        Registrado por {item.creadoPor}
                      </p>
                    </div>

                    <div>
                      <p className="mb-1 text-[10px] font-black uppercase text-[#98a2b3] lg:hidden">Vigencia</p>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#c9df91] bg-[#f7fbe9] px-2.5 py-1 text-xs font-black text-[#4f6f0c]">
                        <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.8} />
                        {formatDate(item.fechaFin)}
                      </span>
                    </div>

                    <div>
                      <p className="mb-1 text-[10px] font-black uppercase text-[#98a2b3] lg:hidden">Impacto</p>
                      <p className="text-sm font-black text-[#151a21]">
                        {item.creditosActivos} credito(s)
                      </p>
                      <p className="mt-1 text-xs text-[#667085]">
                        {item.bloqueosMoraActivos} bloqueo(s) por mora
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={removing === item.documento}
                      onClick={() => void removeException(item)}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#efb0ad] bg-white px-4 text-sm font-black text-[#a6221f] transition hover:bg-[#fff3f2] disabled:cursor-wait disabled:opacity-60"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                      {removing === item.documento ? "Retirando..." : "Retirar"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
