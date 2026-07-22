"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Ban,
  Building2,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  Download,
  Filter,
  MoreHorizontal,
  Search,
  WalletCards,
} from "lucide-react";
import {
  Button,
  Card,
  DataTable,
  Input,
  MetricCard,
  PageHeader,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";

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
    aliadoId?: number | null;
    aliado?: {
      id: number;
      nombre: string;
      codigo: string | null;
    } | null;
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
    creditosAnulados?: number;
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

function isFinserPayCentral(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === "FINSERPAY";
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
    "Aliado",
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
    item.sede.aliado?.nombre || "",
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

function creditStatusTone(status: string) {
  const normalized = String(status || "").toUpperCase();
  if (normalized.includes("ANUL")) return "danger" as const;
  if (normalized.includes("PAG") || normalized.includes("ENTREG")) return "positive" as const;
  if (normalized.includes("PEND") || normalized.includes("PROCES")) return "warning" as const;
  return "neutral" as const;
}

export default function ReporteCreditosPage({
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
  const [items, setItems] = useState<CreditReportItem[]>([]);
  const [summary, setSummary] = useState<CreditReportResponse["summary"] | null>(null);
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

      const res = await fetch(`/api/reportes/creditos?${params.toString()}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
        },
      });
      const data = (await res.json()) as CreditReportResponse & { error?: string };

      if (!res.ok) {
        setMessage(data.error || "No se pudo cargar el reporte de creditos");
        setItems([]);
        setSummary(null);
        return;
      }

      const excluded = new Set(excludeIds);
      const nextItems = Array.isArray(data.items) ? data.items : [];

      setItems(
        excluded.size ? nextItems.filter((item) => !excluded.has(item.id)) : nextItems
      );
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

  const deleteCredit = async (item: CreditReportItem) => {
    if (!isCentralAdmin || deletingId) {
      return;
    }

    const confirmed = window.confirm(
      `Vas a ELIMINAR el credito ${item.folio}. Se borraran sus recaudos locales, movimientos de caja asociados, intents Wompi locales y enlaces Efecty, y se quitara este registro del reporte. Esta accion no es una anulacion.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeletingId(item.id);
      setMessage("");

      const res = await fetch(`/api/creditos/${item.id}/command`, {
        method: "DELETE",
      });
      const data = (await res.json()) as CreditCommandResponse;

      if (!res.ok) {
        throw new Error(data.error || "No se pudo eliminar el credito");
      }

      await loadReport([item.id]);
      setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
      setMessage(data.message || "Credito eliminado");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo eliminar el credito"
      );
    } finally {
      setDeletingId(null);
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

  const totalAuthorized =
    summary?.totalCreditoAutorizado ||
    summary?.totalSaldoCredito ||
    summary?.totalMontoCredito ||
    0;

  const renderCreditActions = (item: CreditReportItem) => {
    const canAnnul = isAdmin && item.estado !== "ANULADO";
    const canDelete = isCentralAdmin;

    if (!canAnnul && !canDelete) {
      return <span className="text-xs font-medium text-[#98a2b3]">Solo lectura</span>;
    }

    return (
      <details className="relative ml-auto w-fit">
        <summary
          className="grid h-10 w-10 cursor-pointer list-none place-items-center rounded-md border border-[#d0d5dd] bg-white text-[#344054] transition hover:border-[#98a2b3] hover:bg-[#f8fafb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a8f34a] [&::-webkit-details-marker]:hidden"
          aria-label={`Gestionar credito ${item.folio}`}
          title="Gestionar credito"
        >
          <MoreHorizontal className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
        </summary>
        <div className="absolute right-0 z-30 mt-1 w-48 rounded-md border border-[#d0d5dd] bg-white p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.16)]">
          {canAnnul ? (
            <button
              type="button"
              onClick={() => void annulCredit(item)}
              disabled={annullingId === item.id || deletingId === item.id}
              className="min-h-10 w-full rounded px-3 py-2 text-left text-xs font-semibold text-[#b54708] transition hover:bg-[#fffaeb] disabled:opacity-50"
            >
              {annullingId === item.id ? "Anulando..." : "Anular credito"}
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              onClick={() => void deleteCredit(item)}
              disabled={deletingId === item.id || annullingId === item.id}
              className="min-h-10 w-full rounded px-3 py-2 text-left text-xs font-semibold text-[#b42318] transition hover:bg-[#fff1f0] disabled:opacity-50"
            >
              {deletingId === item.id ? "Eliminando..." : "Eliminar registro"}
            </button>
          ) : null}
        </div>
      </details>
    );
  };

  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <PageHeader
        eyebrow={isAdmin ? "Operacion financiera" : "Operacion de sede"}
        title="Reporte de creditos"
        description="Consulta cada venta, su financiacion autorizada y el estado operativo del credito."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard/reportes" className="fp-ui-button is-secondary">
              <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              Centro de reportes
            </Link>
            <Button
              variant="primary"
              onClick={() => exportCreditsToExcel(items)}
              disabled={!items.length || loading}
            >
              <Download className="h-4 w-4" strokeWidth={1.8} />
              Exportar Excel
            </Button>
          </div>
        }
      />

      <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          className="!rounded-lg !p-4"
          label={<span className="flex items-center gap-2"><CreditCard className="h-4 w-4 text-[#5c7a13]" /> Creditos</span>}
          value={<span className="!text-2xl">{loading ? "..." : summary?.totalCreditos || 0}</span>}
          detail="Registros del periodo"
        />
        <MetricCard
          className="!rounded-lg !p-4"
          label={<span className="flex items-center gap-2"><WalletCards className="h-4 w-4 text-[#5c7a13]" /> Autorizado</span>}
          value={<span className="!text-2xl">{loading ? "..." : formatMoney(totalAuthorized)}</span>}
          detail="Capital financiado"
        />
        <MetricCard
          className="!rounded-lg !p-4"
          label={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-[#4d7c0f]" /> Pagados</span>}
          value={<span className="!text-2xl">{loading ? "..." : summary?.creditosPagados || 0}</span>}
          detail="Creditos cerrados"
        />
        <MetricCard
          className="!rounded-lg !border-[#fecdca] !bg-[#fff8f7] !p-4"
          label={<span className="flex items-center gap-2"><Ban className="h-4 w-4 text-[#b42318]" /> Anulados</span>}
          value={<span className="!text-2xl text-[#b42318]">{loading ? "..." : summary?.creditosAnulados || 0}</span>}
          detail="Fuera de la operacion"
        />
        <MetricCard
          className="!rounded-lg !p-4"
          label="Inicial recibida"
          value={<span className="!text-2xl">{loading ? "..." : formatMoney(summary?.totalInicial || 0)}</span>}
          detail="Total del periodo"
        />
      </section>

      <Card className="mt-4 !rounded-lg !p-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(260px,1.4fr)_160px_160px_minmax(180px,.8fr)_minmax(180px,.8fr)_auto]">
          <label className="relative md:col-span-2 xl:col-span-1">
            <span className="sr-only">Buscar credito</span>
            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cliente, documento, folio, IMEI o vendedor"
              className="!pl-10"
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadReport();
              }}
            />
          </label>
          <label className="relative">
            <span className="sr-only">Desde</span>
            <CalendarDays className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="!pl-10" />
          </label>
          <label className="relative">
            <span className="sr-only">Hasta</span>
            <CalendarDays className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="!pl-10" />
          </label>
          {isAdmin ? (
            <>
              <Select
                value={aliadoId}
                onChange={(event) => {
                  setAliadoId(event.target.value);
                  setSedeId("");
                }}
                aria-label="Filtrar por aliado"
              >
                <option value="">Todos los aliados</option>
                {aliados.map((aliado) => <option key={aliado.id} value={aliado.id}>{aliado.nombre}</option>)}
              </Select>
              <Select value={sedeId} onChange={(event) => setSedeId(event.target.value)} aria-label="Filtrar por sede">
                <option value="">Todas las sedes</option>
                {sedesFiltradas.map((sede) => <option key={sede.id} value={sede.id}>{sede.nombre}</option>)}
              </Select>
            </>
          ) : (
            <div className="flex min-h-11 items-center gap-2 rounded-md border border-[#d0d5dd] bg-[#f8fafb] px-3 text-sm font-semibold text-[#475467] md:col-span-2">
              <Building2 className="h-4 w-4" strokeWidth={1.8} />
              {user?.sedeNombre || sedes[0]?.nombre || "Sede asignada"}
            </div>
          )}
          <Button variant="primary" onClick={() => void loadReport()} disabled={loading}>
            <Filter className="h-4 w-4" strokeWidth={1.8} />
            {loading ? "Consultando" : "Aplicar"}
          </Button>
        </div>
      </Card>

      {message ? (
        <div className="mt-3 rounded-lg border border-[#d0d5dd] bg-white px-4 py-3 text-sm font-medium text-[#344054]" role="status">
          {message}
        </div>
      ) : null}

      <Card className="mt-4 overflow-hidden !rounded-lg !p-0">
        <div className="flex flex-col gap-3 border-b border-[#e4e7ec] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h2 className="text-lg font-black text-[#151a21]">Detalle de creditos</h2>
            <p className="mt-1 text-sm text-[#667085]">
              {loading
                ? "Actualizando informacion..."
                : "Identidad, equipo, operacion y valores de cada credito."}
            </p>
          </div>
          <StatusPill tone={loading ? "neutral" : "positive"}>
            {loading ? "Consultando" : `${items.length} creditos`}
          </StatusPill>
        </div>

        {/* Both responsive views expose the same report fields and credit actions. */}
        <div className="divide-y divide-[#e4e7ec] lg:hidden" aria-busy={loading}>
          {loading ? (
            <div className="px-4 py-12 text-center text-sm text-[#667085]">
              Consultando creditos...
            </div>
          ) : items.length ? (
            items.map((item) => (
              <article key={item.id} className="px-4 py-5 sm:px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-black text-[#151a21]">
                      {item.folio}
                    </p>
                    <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-[#667085]">
                      <CalendarDays className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                      {formatDate(item.fechaCredito)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill tone={creditStatusTone(item.estado)}>{item.estado}</StatusPill>
                    {renderCreditActions(item)}
                  </div>
                </div>

                <div className="mt-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#667085]">
                    Cliente
                  </p>
                  <p className="mt-1 text-base font-black text-[#151a21]">
                    {item.clienteNombre}
                  </p>
                  <p className="mt-0.5 text-sm text-[#667085]">
                    {item.clienteDocumento || "Sin documento"}
                  </p>
                </div>

                <div className="mt-4 grid gap-4 border-t border-[#eef0f2] pt-4 sm:grid-cols-2">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#667085]">
                      Equipo
                    </p>
                    <p className="mt-1 text-sm font-bold text-[#344054]">
                      {item.referenciaEquipo ||
                        [item.equipoMarca, item.equipoModelo].filter(Boolean).join(" ") ||
                        "Sin referencia"}
                    </p>
                    <p className="mt-1 break-all font-mono text-[11px] text-[#667085]">
                      IMEI {item.imei || "Sin IMEI"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#667085]">
                      Operacion
                    </p>
                    <p className="mt-1 text-sm font-bold text-[#344054]">
                      {item.sede.aliado?.nombre || "Sin aliado"}
                    </p>
                    <p className="mt-1 text-xs text-[#667085]">
                      {item.sede.nombre} / {item.usuario.nombre}
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 rounded-md bg-[#f7f8f8] px-3 py-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#667085]">
                      Inicial
                    </p>
                    <p className="mt-1 whitespace-nowrap text-sm font-semibold tabular-nums text-[#344054]">
                      {formatMoney(item.cuotaInicial)}
                    </p>
                  </div>
                  <div className="border-l border-[#dfe3e7] pl-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#667085]">
                      Autorizado
                    </p>
                    <p className="mt-1 whitespace-nowrap text-sm font-black tabular-nums text-[#151a21]">
                      {formatMoney(item.creditoAutorizado)}
                    </p>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="px-4 py-12 text-center text-sm text-[#667085]">
              No hay creditos para los filtros seleccionados.
            </div>
          )}
        </div>

        <DataTable className="hidden !rounded-none !border-0 lg:block">
          <table
            className="w-full min-w-[1230px] table-fixed text-[13px]"
            aria-busy={loading}
          >
            <caption className="sr-only">
              Detalle de creditos encontrados con los filtros seleccionados
            </caption>
            <colgroup>
              <col className="w-[170px]" />
              <col className="w-[220px]" />
              <col className="w-[235px]" />
              <col className="w-[230px]" />
              <col className="w-[180px]" />
              <col className="w-[135px]" />
              <col className="w-[60px]" />
            </colgroup>
            <thead className="bg-[#151a21] text-white">
              <tr>
                <th scope="col" className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]">Credito</th>
                <th scope="col" className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]">Cliente</th>
                <th scope="col" className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]">Equipo / IMEI</th>
                <th scope="col" className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]">Operacion</th>
                <th scope="col" className="px-4 py-3.5 text-right text-[11px] font-bold uppercase tracking-[0.08em]">Valores</th>
                <th scope="col" className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]">Estado</th>
                <th scope="col" className="px-3 py-3.5 text-right"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4e7ec]">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-14 text-center text-sm text-[#667085]">
                    Consultando creditos...
                  </td>
                </tr>
              ) : items.length ? (
                items.map((item) => (
                  <tr
                    key={item.id}
                    className="bg-white transition-colors even:bg-[#fbfcfa] hover:bg-[#f6f9ef]"
                  >
                    <td className="px-4 py-4 align-top">
                      <p className="break-all font-black leading-5 text-[#151a21]">
                        {item.folio}
                      </p>
                      <p className="mt-2 inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-[#667085]">
                        <CalendarDays className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                        {formatDate(item.fechaCredito)}
                      </p>
                    </td>
                    <td className="px-4 py-4 align-top">
                      <p className="font-bold leading-5 text-[#151a21]">{item.clienteNombre}</p>
                      <p className="mt-1 text-xs text-[#667085]">
                        {item.clienteDocumento || "Sin documento"}
                      </p>
                    </td>
                    <td className="px-4 py-4 align-top">
                      <p className="font-semibold leading-5 text-[#344054]">
                        {item.referenciaEquipo ||
                          [item.equipoMarca, item.equipoModelo].filter(Boolean).join(" ") ||
                          "Sin referencia"}
                      </p>
                      <p className="mt-1.5 break-all font-mono text-[11px] text-[#667085]">
                        IMEI {item.imei || "Sin IMEI"}
                      </p>
                    </td>
                    <td className="px-4 py-4 align-top">
                      <p className="font-bold leading-5 text-[#344054]">
                        {item.sede.aliado?.nombre || "Sin aliado"}
                      </p>
                      <dl className="mt-2 grid grid-cols-[62px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                        <dt className="text-[#98a2b3]">Sede</dt>
                        <dd className="font-medium text-[#475467]">{item.sede.nombre}</dd>
                        <dt className="text-[#98a2b3]">Vendedor</dt>
                        <dd className="font-medium text-[#475467]">{item.usuario.nombre}</dd>
                      </dl>
                    </td>
                    <td className="px-4 py-4 text-right align-top tabular-nums">
                      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#98a2b3]">
                        Inicial
                      </p>
                      <p className="mt-1 whitespace-nowrap font-semibold text-[#475467]">
                        {formatMoney(item.cuotaInicial)}
                      </p>
                      <div className="my-2 ml-auto h-px w-24 bg-[#e4e7ec]" />
                      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#98a2b3]">
                        Autorizado
                      </p>
                      <p className="mt-1 whitespace-nowrap font-black text-[#151a21]">
                        {formatMoney(item.creditoAutorizado)}
                      </p>
                    </td>
                    <td className="px-4 py-4 align-top">
                      <StatusPill tone={creditStatusTone(item.estado)}>{item.estado}</StatusPill>
                    </td>
                    <td className="px-3 py-4 text-right align-top">
                      {renderCreditActions(item)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="py-14 text-center text-sm text-[#667085]">
                    No hay creditos para los filtros seleccionados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </DataTable>
      </Card>
    </main>
  );
}
