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

function collectorName(item: PaymentReportItem) {
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

export default function ReporteAbonosPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<SedeItem[]>([]);
  const [aliados, setAliados] = useState<AliadoItem[]>([]);
  const [items, setItems] = useState<PaymentReportItem[]>([]);
  const [byDay, setByDay] = useState<PaymentByDay[]>([]);
  const [summary, setSummary] = useState<PaymentReportResponse["summary"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [annullingId, setAnnullingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [aliadoId, setAliadoId] = useState("");
  const [sedeId, setSedeId] = useState("");
  const isAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
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

  const loadReport = async () => {
    try {
      setLoading(true);
      setMessage("");

      const params = new URLSearchParams();

      if (search.trim()) params.set("search", search.trim());
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (aliadoId) params.set("aliadoId", aliadoId);
      if (sedeId) params.set("sedeId", sedeId);

      const res = await fetch(`/api/reportes/abonos-credito?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as PaymentReportResponse & { error?: string };

      if (!res.ok) {
        setMessage(data.error || "No se pudo cargar el reporte de abonos");
        setItems([]);
        setByDay([]);
        setSummary(null);
        return;
      }

      setItems(Array.isArray(data.items) ? data.items : []);
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

  return (
    <div className="min-h-screen bg-[#eef2f7] px-3 py-6 lg:px-6 lg:py-8">
      <div className="mx-auto w-full max-w-[1680px]">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-teal-100 bg-teal-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#145a5a]">
              {isAdmin ? "Reportes admin" : "Reportes de sede"}
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-tight text-slate-950">
              Tabla de abonos
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {isAdmin
                ? "Consulta recaudo dia a dia, quien recibio cada pago y cuanto sigue pendiente por cobrar en la cartera."
                : "Consulta recaudo dia a dia solo para tu sede asignada."}
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

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <SummaryCard
            label="Abonos del periodo"
            value={loading ? "..." : String(summary?.totalAbonos || 0)}
            tone="teal"
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

        <section className="mt-6 rounded-[30px] bg-white p-4 shadow-sm ring-1 ring-slate-200 lg:p-6">
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(260px,1.45fr)_150px_150px_minmax(175px,0.8fr)_minmax(175px,0.85fr)_150px_150px]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por cliente, documento, folio, sede o vendedor"
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
              <>
                <select
                  value={aliadoId}
                  onChange={(event) => {
                    setAliadoId(event.target.value);
                    setSedeId("");
                  }}
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
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
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
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
              onClick={() => exportPaymentsToExcel(items, byDay)}
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

          <div className="mt-6 grid gap-4">
            <div className="rounded-[24px] border border-slate-200 bg-slate-50/70 p-4 lg:max-w-3xl">
              <h2 className="text-lg font-black tracking-tight text-slate-950">
                Recaudo dia a dia
              </h2>

              <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-100 text-slate-700">
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

            <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white">
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
                <thead className="bg-[#111318] text-white">
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
                              "inline-flex rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em]",
                              isAnnulled
                                ? "border-rose-200 bg-rose-100 text-rose-700"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700",
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
                          {isAdmin && !isAnnulled ? (
                            <button
                              type="button"
                              onClick={() => void annulPayment(item)}
                              disabled={annullingId === item.id}
                              className="inline-flex max-w-full items-center justify-center rounded-xl border border-rose-200 bg-white px-3 py-2 text-[11px] font-black text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {annullingId === item.id ? "Anulando..." : "Anular"}
                            </button>
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
      </div>
    </div>
  );
}
