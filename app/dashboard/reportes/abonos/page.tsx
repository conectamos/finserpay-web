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

type PaymentReportItem = {
  id: number;
  valor: number;
  metodoPago: string;
  observacion: string | null;
  fechaAbono: string;
  credito: {
    id: number;
    folio: string;
    clienteNombre: string;
    clienteDocumento: string | null;
  };
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
  const [items, setItems] = useState<PaymentReportItem[]>([]);
  const [byDay, setByDay] = useState<PaymentByDay[]>([]);
  const [summary, setSummary] = useState<PaymentReportResponse["summary"] | null>(null);
  const [loading, setLoading] = useState(true);
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

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-8">
      <div className="mx-auto max-w-7xl">
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

        <section className="mt-6 rounded-[30px] bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.7fr_0.7fr_0.7fr_180px]">
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
          </div>

          {message && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {message}
            </div>
          )}

          <div className="mt-6 grid gap-4 xl:grid-cols-[0.95fr_1.35fr]">
            <div className="rounded-[24px] border border-slate-200 bg-slate-50/70 p-4">
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
              <table className="min-w-full text-sm">
                <thead className="bg-[#111318] text-white">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Fecha</th>
                    <th className="px-4 py-3 text-left font-semibold">Cliente</th>
                    <th className="px-4 py-3 text-left font-semibold">Folio</th>
                    <th className="px-4 py-3 text-left font-semibold">Sede</th>
                    <th className="px-4 py-3 text-left font-semibold">Vendedor</th>
                    <th className="px-4 py-3 text-left font-semibold">Metodo</th>
                    <th className="px-4 py-3 text-left font-semibold">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-t border-slate-100">
                      <td className="px-4 py-3">{formatDateTime(item.fechaAbono)}</td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-950">{item.credito.clienteNombre}</div>
                        <div className="text-xs text-slate-500">
                          {item.credito.clienteDocumento || "-"}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-950">{item.credito.folio}</td>
                      <td className="px-4 py-3">{item.sede.nombre}</td>
                      <td className="px-4 py-3">{item.usuario.nombre}</td>
                      <td className="px-4 py-3">{item.metodoPago}</td>
                      <td className="px-4 py-3">{formatMoney(item.valor)}</td>
                    </tr>
                  ))}
                  {!loading && items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
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
