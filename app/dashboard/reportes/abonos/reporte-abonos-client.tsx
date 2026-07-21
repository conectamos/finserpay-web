"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  aliadoAccesoCodigo?: string | null;
  rolId: number;
  rolNombre: string;
};

type SedeItem = {
  id: number;
  nombre: string;
  codigo?: string | null;
  aliadoId?: number | null;
  aliado?: {
    id: number;
    nombre: string;
    codigo: string | null;
  } | null;
};

type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
};

type PaymentReportItem = {
  id: number;
  valor: number;
  metodoPago: string;
  observacion: string | null;
  estado: string;
  anuladoAt: string | null;
  anulacionMotivo: string | null;
  fechaAbono: string;
  credito: {
    id: number;
    folio: string;
    clienteNombre: string;
    clienteDocumento: string | null;
    sede?: {
      id: number;
      nombre: string;
      codigo?: string | null;
      aliadoId?: number | null;
      aliado?: {
        id: number;
        nombre: string;
        codigo: string | null;
      } | null;
    };
  };
  usuario: {
    id: number;
    nombre: string;
    usuario: string;
  };
  vendedor: {
    id: number;
    nombre: string;
    usuario: string;
  };
  sede: {
    id: number;
    nombre: string;
    codigo?: string | null;
    aliadoId?: number | null;
    aliado?: {
      id: number;
      nombre: string;
      codigo: string | null;
    } | null;
  };
};

type PaymentByDay = {
  fecha: string;
  total: number;
  cantidad: number;
};

type PaymentReportResponse = {
  ok: boolean;
  summary: {
    totalAbonos: number;
    totalRecaudadoPeriodo: number;
    totalPendientePorCobrar: number;
    totalRecaudadoGeneral: number;
    totalCreditos: number;
    creditosAlDia: number;
  };
  byDay: PaymentByDay[];
  items: PaymentReportItem[];
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

function formatDateTime(value: string | null) {
  if (!value) {
    return "-";
  }

  try {
    return new Date(value).toLocaleString("es-CO");
  } catch {
    return value;
  }
}

function isFinserPayCentral(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === "FINSERPAY";
}

function excelCell(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlTable(headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  return `<table><thead><tr>${headers
    .map((header) => `<th>${excelCell(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${excelCell(cell)}</td>`).join("")}</tr>`
    )
    .join("")}</tbody></table>`;
}

const DIGITAL_COLLECTION_SEDE_CODE = "RECAUDO_DIGITAL";
const DIGITAL_COLLECTION_SEDE_NAME = "RECAUDO DIGITAL FINSER PAY";
const DIGITAL_COLLECTION_COLLECTOR_NAME = "DIGITAL";

function normalizeText(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function isDigitalCollectionSede(
  sede: { codigo?: string | null; nombre?: string | null } | null | undefined
) {
  const codigo = normalizeText(sede?.codigo).replace(/[\s-]+/g, "_");
  const nombre = normalizeText(sede?.nombre);

  return (
    codigo === DIGITAL_COLLECTION_SEDE_CODE ||
    nombre === DIGITAL_COLLECTION_SEDE_NAME ||
    (nombre.includes("RECAUDO") && nombre.includes("DIGITAL"))
  );
}

function collectorName(item: PaymentReportItem) {
  if (isDigitalCollectionSede(item.sede)) {
    return DIGITAL_COLLECTION_COLLECTOR_NAME;
  }

  return item.vendedor?.nombre || item.usuario?.nombre || item.sede?.nombre || "-";
}

function exportPaymentsToExcel(items: PaymentReportItem[], byDay: PaymentByDay[]) {
  const detailHeaders = [
    "Fecha",
    "Cliente",
    "Documento",
    "Folio",
    "Aliado",
    "Sede",
    "Vendedor/Supervisor",
    "Metodo",
    "Valor",
    "Estado",
    "Anulado el",
    "Motivo anulacion",
    "Observacion",
  ];
  const detailRows = items.map((item) => [
    formatDateTime(item.fechaAbono),
    item.credito.clienteNombre,
    item.credito.clienteDocumento || "",
    item.credito.folio,
    item.sede.aliado?.nombre || "",
    item.sede.nombre,
    collectorName(item),
    item.metodoPago,
    item.valor,
    item.estado || "ACTIVO",
    item.anuladoAt ? formatDateTime(item.anuladoAt) : "",
    item.anulacionMotivo || "",
    item.observacion || "",
  ]);
  const byDayHeaders = ["Fecha", "Abonos", "Total"];
  const byDayRows = byDay.map((item) => [
    formatDate(item.fecha),
    item.cantidad,
    item.total,
  ]);
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      table { border-collapse: collapse; margin-bottom: 24px; }
      th, td { border: 1px solid #cbd5e1; padding: 8px; }
      th { background: #111318; color: #ffffff; font-weight: 700; }
      h2 { font-family: Arial, sans-serif; }
    </style>
  </head>
  <body>
    <h2>Detalle de abonos</h2>
    ${htmlTable(detailHeaders, detailRows)}
    <h2>Recaudo dia a dia</h2>
    ${htmlTable(byDayHeaders, byDayRows)}
  </body>
</html>`;
  const blob = new Blob([html], {
    type: "application/vnd.ms-excel;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `abonos-finserpay-${new Date().toISOString().slice(0, 10)}.xls`;
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
  tone?: "slate" | "green" | "amber";
}) {
  const toneClasses =
    tone === "green"
      ? "border-[#d9e8ad] bg-[#fbfdf5] text-[#3f6212]"
      : tone === "amber"
        ? "border-[#fedf89] bg-[#fffaeb] text-[#b54708]"
        : "border-[#e4e7ec] bg-white text-[#151a21]";

  return (
    <div className={["rounded-lg border px-4 py-4 shadow-[0_3px_12px_rgba(16,24,40,0.04)]", toneClasses].join(" ")}>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em]">{label}</p>
      <p className="mt-3 text-2xl font-black">{value}</p>
    </div>
  );
}

export default function ReporteAbonosPage({
  initialFrom = "",
  initialSedeId = "",
  initialTo = "",
}: {
  initialFrom?: string;
  initialSedeId?: string;
  initialTo?: string;
}) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<SedeItem[]>([]);
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [items, setItems] = useState<PaymentReportItem[]>([]);
  const [byDay, setByDay] = useState<PaymentByDay[]>([]);
  const [summary, setSummary] = useState<PaymentReportResponse["summary"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [annullingId, setAnnullingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [aliadoId, setAliadoId] = useState("");
  const [sedeId, setSedeId] = useState(initialSedeId);
  const isAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const isCentralAdmin = isAdmin && isFinserPayCentral(user?.aliadoAccesoCodigo);
  const sedesFiltradas = aliadoId
    ? sedes.filter((sede) => String(sede.aliadoId || "") === aliadoId)
    : sedes;

  const loadContext = async () => {
    const [sessionRes, sedesRes, aliadosRes] = await Promise.all([
      fetch("/api/session", { cache: "no-store" }),
      fetch("/api/sedes", { cache: "no-store" }),
      fetch("/api/aliados/admin", { cache: "no-store" }),
    ]);

    const sessionData = await sessionRes.json();
    const sedesData = await sedesRes.json();
    const aliadosData = await aliadosRes.json();

    if (sessionRes.ok) {
      setUser(sessionData);
    }

    if (sedesRes.ok) {
      setSedes(Array.isArray(sedesData) ? sedesData : []);
    }

    if (aliadosRes.ok) {
      setAliados(Array.isArray(aliadosData.aliados) ? aliadosData.aliados : []);
    }
  };

  const loadReport = async (excludeIds: number[] = []) => {
    try {
      setLoading(true);
      setMessage("");

      const params = new URLSearchParams();

      if (search.trim()) params.set("search", search.trim());
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (aliadoId) params.set("aliadoId", aliadoId);
      if (sedeId) params.set("sedeId", sedeId);
      params.set("_", String(Date.now()));

      const res = await fetch(`/api/reportes/abonos-credito?${params.toString()}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
        },
      });
      const data = (await res.json()) as PaymentReportResponse & { error?: string };

      if (!res.ok) {
        setMessage(data.error || "No se pudo cargar el reporte de abonos");
        setItems([]);
        setByDay([]);
        setSummary(null);
        return;
      }

      const excluded = new Set(excludeIds);
      const nextItems = Array.isArray(data.items) ? data.items : [];

      setItems(
        excluded.size ? nextItems.filter((item) => !excluded.has(item.id)) : nextItems
      );
      setByDay(Array.isArray(data.byDay) ? data.byDay : []);
      setSummary(data.summary);
    } catch {
      setMessage("Error cargando el reporte de abonos");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      await loadContext();
      await loadReport();
    };

    void init();
    // The route-provided filters are intentionally captured only for the initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const annulPayment = async (item: PaymentReportItem) => {
    if (!isAdmin || item.estado === "ANULADO" || annullingId) {
      return;
    }

    const motivo = window.prompt(
      `Motivo de anulacion del recaudo ${formatMoney(item.valor)} del folio ${item.credito.folio}:`,
      "Anulacion administrativa"
    );

    if (motivo === null) {
      return;
    }

    const confirmed = window.confirm(
      `Vas a anular este recaudo. El valor dejara de contar en saldo, plan de pagos y reportes.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setAnnullingId(item.id);
      setMessage("");

      const res = await fetch(`/api/creditos/${item.credito.id}/abonos/${item.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          motivo: motivo.trim() || "Anulacion administrativa",
        }),
      });
      const data = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        setMessage(data.error || "No se pudo anular el recaudo");
        return;
      }

      await loadReport();
      setMessage(data.message || "Recaudo anulado correctamente");
    } catch {
      setMessage("Error anulando el recaudo");
    } finally {
      setAnnullingId(null);
    }
  };

  const deletePayment = async (item: PaymentReportItem) => {
    if (!isCentralAdmin || deletingId) {
      return;
    }

    const confirmed = window.confirm(
      `Vas a ELIMINAR este recaudo de ${formatMoney(item.valor)} del folio ${item.credito.folio}. Se borrara el abono local, caja asociada y enlaces digitales relacionados, y se quitara este registro del reporte.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeletingId(item.id);
      setMessage("");

      const res = await fetch(`/api/creditos/${item.credito.id}/abonos/${item.id}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        setMessage(data.error || "No se pudo eliminar el recaudo");
        return;
      }

      await loadReport([item.id]);
      setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
      setMessage(data.message || "Recaudo eliminado");
    } catch {
      setMessage("Error eliminando el recaudo");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
        <div className="flex flex-col gap-4 border-b border-[#e4e7ec] pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[#5c7a13]">
              {isAdmin ? "Operacion financiera" : "Operacion de sede"}
            </div>
            <h1 className="mt-2 text-3xl font-black text-[#151a21]">
              Reporte de recaudos
            </h1>
            <p className="mt-1.5 text-sm text-[#667085]">
              {isAdmin
                ? "Consulta pagos registrados, responsables de recaudo y saldos pendientes por cobrar."
                : "Consulta los pagos registrados en tu sede asignada."}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/dashboard/reportes"
              className="fp-ui-button is-secondary"
            >
              Volver a reportes
            </Link>
          </div>
        </div>

        <section className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <SummaryCard
            label="Abonos del periodo"
            value={loading ? "..." : String(summary?.totalAbonos || 0)}
            tone="green"
          />
          <SummaryCard
            label="Recaudado del periodo"
            value={loading ? "..." : formatMoney(summary?.totalRecaudadoPeriodo || 0)}
          />
          <SummaryCard
            label="Pendiente por cobrar"
            value={loading ? "..." : formatMoney(summary?.totalPendientePorCobrar || 0)}
            tone="amber"
          />
          <SummaryCard
            label="Recaudado general"
            value={loading ? "..." : formatMoney(summary?.totalRecaudadoGeneral || 0)}
          />
          <SummaryCard
            label="Creditos al dia"
            value={loading ? "..." : String(summary?.creditosAlDia || 0)}
          />
        </section>

        <section className="mt-4 rounded-lg border border-[#e4e7ec] bg-white p-3 shadow-[0_4px_18px_rgba(16,24,40,0.05)] lg:p-4">
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(260px,1.45fr)_150px_150px_minmax(175px,0.8fr)_minmax(175px,0.85fr)_150px_150px]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por cliente, documento, folio, sede o vendedor"
              className="fp-ui-input"
            />

            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="fp-ui-input"
            />

            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="fp-ui-input"
            />

            {isAdmin ? (
              <>
                <select
                  value={aliadoId}
                  onChange={(event) => {
                    setAliadoId(event.target.value);
                    setSedeId("");
                  }}
                  className="fp-ui-input"
                >
                  <option value="">Todos los aliados</option>
                  {aliados.map((aliado) => (
                    <option key={aliado.id} value={aliado.id}>
                      {aliado.nombre}
                    </option>
                  ))}
                </select>

                <select
                  value={sedeId}
                  onChange={(event) => setSedeId(event.target.value)}
                  className="fp-ui-input"
                >
                  <option value="">Todas las sedes</option>
                  {sedesFiltradas.map((sede) => (
                    <option key={sede.id} value={sede.id}>
                      {sede.nombre}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <div className="flex min-h-11 items-center rounded-md border border-[#d0d5dd] bg-[#f8fafb] px-3 text-sm font-semibold text-[#475467]">
                {user?.sedeNombre || sedes[0]?.nombre || "Sede asignada"}
              </div>
            )}

            <button
              type="button"
              onClick={() => void loadReport()}
              className="fp-ui-button is-primary"
            >
              Aplicar filtros
            </button>

            <button
              type="button"
              onClick={() => exportPaymentsToExcel(items, byDay)}
              disabled={!items.length || loading}
              className="fp-ui-button is-secondary"
            >
              Exportar Excel
            </button>
          </div>

          {message && (
            <div className="mt-4 rounded-lg border border-[#d0d5dd] bg-[#f8fafb] px-4 py-3 text-sm text-[#344054]" role="status">
              {message}
            </div>
          )}

          <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(300px,.34fr)_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-lg border border-[#e4e7ec] bg-white">
              <h2 className="border-b border-[#e4e7ec] px-4 py-3 text-base font-black text-[#151a21]">
                Recaudo dia a dia
              </h2>

              <div className="max-h-[560px] overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 bg-[#f8fafb] text-[#475467]">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold">Fecha</th>
                      <th className="px-4 py-3 text-left font-semibold">Abonos</th>
                      <th className="px-4 py-3 text-left font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byDay.map((item) => (
                      <tr key={item.fecha} className="border-t border-slate-100">
                        <td className="px-4 py-3">{formatDate(item.fecha)}</td>
                        <td className="px-4 py-3">{item.cantidad}</td>
                        <td className="px-4 py-3">{formatMoney(item.total)}</td>
                      </tr>
                    ))}
                    {!loading && byDay.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                          No hay recaudo para los filtros seleccionados.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-[#e4e7ec] bg-white">
              <table className="w-full min-w-[1320px] table-fixed text-[12px] xl:text-[13px]">
                <colgroup>
                  <col className="w-[11%]" />
                  <col className="w-[12%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                </colgroup>
                <thead className="bg-[#f8fafb] text-[#475467]">
                  <tr>
                    <th className="px-3 py-3 text-left font-semibold">Fecha</th>
                    <th className="px-3 py-3 text-left font-semibold">Cliente</th>
                    <th className="px-3 py-3 text-left font-semibold">Folio</th>
                    <th className="px-3 py-3 text-left font-semibold">Aliado</th>
                    <th className="px-3 py-3 text-left font-semibold">Sede</th>
                    <th className="px-3 py-3 text-left font-semibold">Vendedor/Supervisor</th>
                    <th className="px-3 py-3 text-left font-semibold">Metodo</th>
                    <th className="px-3 py-3 text-left font-semibold">Valor</th>
                    <th className="px-3 py-3 text-left font-semibold">Estado</th>
                    <th className="px-3 py-3 text-left font-semibold">Accion</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const isAnnulled = item.estado === "ANULADO";

                    return (
                      <tr
                        key={item.id}
                        className={[
                          "border-t border-slate-100",
                          isAnnulled ? "bg-rose-50/60 text-slate-500" : "",
                        ].join(" ")}
                      >
                        <td className="px-3 py-3 align-top">{formatDateTime(item.fechaAbono)}</td>
                        <td className="px-3 py-3 align-top">
                          <div className="font-semibold text-slate-950">{item.credito.clienteNombre}</div>
                          <div className="text-xs text-slate-500">
                            {item.credito.clienteDocumento || "-"}
                          </div>
                        </td>
                        <td className="break-all px-3 py-3 align-top font-semibold text-slate-950">{item.credito.folio}</td>
                        <td className="break-words px-3 py-3 align-top">
                          {item.sede.aliado?.nombre || "-"}
                        </td>
                        <td className="break-words px-3 py-3 align-top">{item.sede.nombre}</td>
                        <td className="break-words px-3 py-3 align-top">
                          {collectorName(item)}
                        </td>
                        <td className="break-words px-3 py-3 align-top">{item.metodoPago}</td>
                        <td className="px-3 py-3 align-top whitespace-nowrap">{formatMoney(item.valor)}</td>
                        <td className="px-3 py-3 align-top">
                          <span
                            className={[
                              "inline-flex rounded-full border px-2.5 py-1 text-[10px] font-black uppercase",
                              isAnnulled
                                ? "border-[#fecdca] bg-[#fff1f0] text-[#b42318]"
                                : "border-[#c7df8d] bg-[#f2f9df] text-[#3f6212]",
                            ].join(" ")}
                          >
                            {isAnnulled ? "Anulado" : "Activo"}
                          </span>
                          {isAnnulled && (
                            <div className="mt-1 max-w-[180px] text-[11px] text-rose-700">
                              {item.anulacionMotivo || "Sin motivo"} -{" "}
                              {formatDateTime(item.anuladoAt)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top">
                          {(isAdmin && !isAnnulled) || isCentralAdmin ? (
                            <div className="flex flex-wrap gap-2">
                              {isAdmin && !isAnnulled && (
                                <button
                                  type="button"
                                  onClick={() => void annulPayment(item)}
                                  disabled={annullingId === item.id || deletingId === item.id}
                                  className="inline-flex max-w-full items-center justify-center rounded-md border border-[#fedf89] bg-white px-3 py-2 text-[11px] font-bold text-[#b54708] transition hover:bg-[#fffaeb] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {annullingId === item.id ? "Anulando..." : "Anular"}
                                </button>
                              )}
                              {isCentralAdmin && (
                                <button
                                  type="button"
                                  onClick={() => void deletePayment(item)}
                                  disabled={deletingId === item.id || annullingId === item.id}
                                  className="inline-flex max-w-full items-center justify-center rounded-md border border-[#d92d20] bg-[#d92d20] px-3 py-2 text-[11px] font-bold text-white transition hover:bg-[#b42318] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {deletingId === item.id ? "Eliminando..." : "Eliminar"}
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && items.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                        No hay abonos para los filtros seleccionados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
    </main>
  );
}
