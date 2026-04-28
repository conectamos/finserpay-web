"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

type SedeItem = {
  id: number;
  nombre: string;
};

type CreditReportItem = {
  id: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  creditoAutorizado: number;
  montoCredito: number;
  cuotaInicial: number;
  valorCuota: number;
  plazoMeses: number | null;
  estado: string;
  deliverableReady: boolean;
  deliverableLabel: string | null;
  totalAbonado: number;
  saldoPendiente: number;
  totalRecaudado: number;
  abonosCount: number;
  fechaCredito: string;
  fechaPrimerPago: string | null;
  fechaProximoPago: string | null;
  usuario: {
    id: number;
    nombre: string;
    usuario: string;
  };
  sede: {
    id: number;
    nombre: string;
  };
};

type CreditReportResponse = {
  ok: boolean;
  summary: {
    totalCreditos: number;
    totalMontoCredito: number;
    totalCreditoAutorizado?: number;
    totalInicial?: number;
    totalSaldoCredito?: number;
    totalAbonado: number;
    totalRecaudado: number;
    totalPendiente: number;
    creditosPagados: number;
    entregables: number;
  };
  items: CreditReportItem[];
};

type CreditCommandResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
};

function formatMoney(value: number) {
  return `$ ${Number(value || 0).toLocaleString("es-CO")}`;
}

function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  try {
    return new Date(value).toLocaleDateString("es-CO");
  } catch {
    return value;
  }
}

function excelCell(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function exportCreditsToExcel(items: CreditReportItem[]) {
  const headers = [
    "Fecha",
    "Folio",
    "Cliente",
    "Referencia",
    "IMEI",
    "Sede",
    "Vendedor",
    "Inicial",
    "Credito autorizado",
    "Estado",
  ];
  const rows = items.map((item) => [
    formatDate(item.fechaCredito),
    item.folio,
    item.clienteNombre,
    item.referenciaEquipo || [item.equipoMarca, item.equipoModelo].filter(Boolean).join(" "),
    item.imei,
    item.sede.nombre,
    item.usuario.nombre,
    item.cuotaInicial,
    item.creditoAutorizado,
    item.estado,
  ]);
  const table = [headers, ...rows]
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${excelCell(cell)}</td>`).join("")}</tr>`
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table>${table}</table></body></html>`;
  const blob = new Blob([html], {
    type: "application/vnd.ms-excel;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `creditos-finserpay-${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function SummaryCard({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: "slate" | "teal" | "amber";
}) {
  const toneClasses =
    tone === "teal"
      ? "border-teal-200 bg-teal-50 text-[#145a5a]"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-white text-slate-900";

  return (
    <div className={["rounded-[24px] border px-5 py-5 shadow-sm", toneClasses].join(" ")}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">{label}</p>
      <p className="mt-4 text-3xl font-black tracking-tight">{value}</p>
    </div>
  );
}

export default function ReporteCreditosPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<SedeItem[]>([]);
  const [items, setItems] = useState<CreditReportItem[]>([]);
  const [summary, setSummary] = useState<CreditReportResponse["summary"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [annullingId, setAnnullingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sedeId, setSedeId] = useState("");
  const isAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";

  const loadContext = async () => {
    const [sessionRes, sedesRes] = await Promise.all([
      fetch("/api/session", { cache: "no-store" }),
      fetch("/api/sedes", { cache: "no-store" }),
    ]);

    const sessionData = await sessionRes.json();
    const sedesData = await sedesRes.json();

    if (sessionRes.ok) {
      setUser(sessionData);
    }

    if (sedesRes.ok) {
      setSedes(Array.isArray(sedesData) ? sedesData : []);
    }
  };

  const loadReport = async () => {
    try {
      setLoading(true);
      setMessage("");

      const params = new URLSearchParams();

      if (search.trim()) params.set("search", search.trim());
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (sedeId) params.set("sedeId", sedeId);

      const res = await fetch(`/api/reportes/creditos?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as CreditReportResponse & { error?: string };

      if (!res.ok) {
        setMessage(data.error || "No se pudo cargar el reporte de creditos");
        setItems([]);
        setSummary(null);
        return;
      }

      setItems(Array.isArray(data.items) ? data.items : []);
      setSummary(data.summary);
    } catch {
      setMessage("Error cargando el reporte de creditos");
    } finally {
      setLoading(false);
    }
  };

  const annulCredit = async (item: CreditReportItem) => {
    if (!isAdmin || item.estado === "ANULADO") {
      return;
    }

    const reason = window.prompt(
      `Motivo de anulacion del credito ${item.folio}:`,
      "Anulacion administrativa"
    );

    if (reason === null) {
      return;
    }

    const confirmed = window.confirm(
      `Vas a anular el credito ${item.folio}. Esta accion dejara trazabilidad y liberara la cedula/IMEI para una nueva venta.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setAnnullingId(item.id);
      setMessage("");

      const res = await fetch(`/api/creditos/${item.id}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command: "annul-credit",
          observacionAdmin: reason.trim() || "Anulacion administrativa",
        }),
      });
      const data = (await res.json()) as CreditCommandResponse;

      if (!res.ok) {
        throw new Error(data.error || "No se pudo anular el credito");
      }

      await loadReport();
      setMessage(data.message || "Credito anulado correctamente");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo anular el credito"
      );
    } finally {
      setAnnullingId(null);
    }
  };

  useEffect(() => {
    const init = async () => {
      await loadContext();
      await loadReport();
    };

    void init();
  }, []);

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-teal-100 bg-teal-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#145a5a]">
              {isAdmin ? "Reportes admin" : "Reportes de sede"}
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-tight text-slate-950">
              Tabla de creditos
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {isAdmin
                ? "Vista administrativa de creditos creados, iniciales recibidas y credito autorizado por venta."
                : "Vista de los creditos creados en tu sede asignada, con iniciales y credito autorizado."}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/dashboard/reportes"
              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Volver a reportes
            </Link>
          </div>
        </div>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="Total creditos"
            value={loading ? "..." : String(summary?.totalCreditos || 0)}
            tone="teal"
          />
          <SummaryCard
            label="Inicial dada"
            value={loading ? "..." : formatMoney(summary?.totalInicial || 0)}
          />
          <SummaryCard
            label="Credito autorizado"
            value={
              loading
                ? "..."
                : formatMoney(
                    summary?.totalCreditoAutorizado ||
                      summary?.totalSaldoCredito ||
                      summary?.totalMontoCredito ||
                      0
                  )
            }
            tone="amber"
          />
          <SummaryCard
            label="Creditos pagados"
            value={loading ? "..." : String(summary?.creditosPagados || 0)}
          />
        </section>

        <section className="mt-6 rounded-[30px] bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.7fr_0.7fr_0.7fr_170px_170px]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por cliente, documento, folio, IMEI o vendedor"
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            />

            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            />

            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
            />

            {isAdmin ? (
              <select
                value={sedeId}
                onChange={(event) => setSedeId(event.target.value)}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              >
                <option value="">Todas las sedes</option>
                {sedes.map((sede) => (
                  <option key={sede.id} value={sede.id}>
                    {sede.nombre}
                  </option>
                ))}
              </select>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600">
                {user?.sedeNombre || sedes[0]?.nombre || "Sede asignada"}
              </div>
            )}

            <button
              type="button"
              onClick={() => void loadReport()}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Aplicar filtros
            </button>

            <button
              type="button"
              onClick={() => exportCreditsToExcel(items)}
              disabled={!items.length || loading}
              className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-semibold text-[#145a5a] transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Exportar Excel
            </button>
          </div>

          {message && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {message}
            </div>
          )}

          <div className="mt-6 overflow-x-auto rounded-[24px] border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-[#111318] text-white">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Fecha</th>
                  <th className="px-4 py-3 text-left font-semibold">Folio</th>
                  <th className="px-4 py-3 text-left font-semibold">Cliente</th>
                  <th className="px-4 py-3 text-left font-semibold">Referencia</th>
                  <th className="px-4 py-3 text-left font-semibold">IMEI</th>
                  <th className="px-4 py-3 text-left font-semibold">Sede</th>
                  <th className="px-4 py-3 text-left font-semibold">Vendedor</th>
                  <th className="px-4 py-3 text-left font-semibold">Inicial dada</th>
                  <th className="px-4 py-3 text-left font-semibold">Credito autorizado</th>
                  <th className="px-4 py-3 text-left font-semibold">Estado</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">{formatDate(item.fechaCredito)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-950">{item.folio}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-950">{item.clienteNombre}</div>
                      <div className="text-xs text-slate-500">{item.clienteDocumento || "-"}</div>
                    </td>
                    <td className="px-4 py-3">
                      {item.referenciaEquipo ||
                        [item.equipoMarca, item.equipoModelo].filter(Boolean).join(" ") ||
                        "-"}
                    </td>
                    <td className="px-4 py-3">{item.imei || "-"}</td>
                    <td className="px-4 py-3">{item.sede.nombre}</td>
                    <td className="px-4 py-3">{item.usuario.nombre}</td>
                    <td className="px-4 py-3">{formatMoney(item.cuotaInicial)}</td>
                    <td className="px-4 py-3">{formatMoney(item.creditoAutorizado)}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-950">{item.estado}</div>
                      {isAdmin && item.estado !== "ANULADO" && (
                        <button
                          type="button"
                          onClick={() => void annulCredit(item)}
                          disabled={annullingId === item.id}
                          className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {annullingId === item.id ? "Anulando..." : "Anular"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                      No hay creditos para los filtros seleccionados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
