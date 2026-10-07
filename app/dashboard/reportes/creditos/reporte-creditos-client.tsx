"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { creditDisplayNumber } from "@/lib/credit-display-number";
import { MoreHorizontal } from "lucide-react";
import CreditReportView from "./credit-report-view";

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

export type SedeItem = {
  id: number;
  nombre: string;
  aliadoId?: number | null;
  aliado?: {
    id: number;
    nombre: string;
    codigo: string | null;
  } | null;
};

export type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
};

export type CreditReportItem = {
  id: number;
  folio: string;
  numeroCreditoVisible?: string | null;
  numeroSadmin?: string | null;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  valorEquipoTotal: number;
  creditoAutorizado: number;
  montoCredito: number;
  cuotaInicial: number;
  valorCuota: number;
  plazoMeses: number | null;
  estado: string;
  estadoReporte?: string;
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

export type CreditReportResponse = {
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

function isFinserPayCentral(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === "FINSERPAY";
}

async function exportCreditsToExcel(items: CreditReportItem[]) {
  const { buildCreditReportWorkbook } = await import("@/lib/credit-report-excel");
  const workbook = buildCreditReportWorkbook(items);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `creditos-finserpay-${new Date().toISOString().slice(0, 10)}.xlsx`;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
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
  const [exporting, setExporting] = useState(false);
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

  const exportReport = async () => {
    if (exporting || loading || !items.length) return;
    setExporting(true);
    setMessage("");
    try {
      await exportCreditsToExcel(items);
    } catch {
      setMessage("No se pudo generar el Excel. Intenta descargarlo nuevamente.");
    } finally {
      setExporting(false);
    }
  };

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
      `Motivo de anulacion del credito ${creditDisplayNumber(item)}:`,
      "Anulacion administrativa"
    );

    if (reason === null) {
      return;
    }

    const confirmed = window.confirm(
      `Vas a anular el credito ${creditDisplayNumber(item)}. Esta accion dejara trazabilidad y liberara la cedula/IMEI para una nueva venta.`
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
      `Vas a ELIMINAR el credito ${creditDisplayNumber(item)}. Se borraran sus recaudos locales, movimientos de caja asociados, intents Wompi locales y enlaces Efecty, y se quitara este registro del reporte. Esta accion no es una anulacion.`
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



    return (
      <details name="credit-report-actions" className="relative ml-auto w-fit">
        <summary
          className="grid h-10 w-10 cursor-pointer list-none place-items-center rounded-md border border-[#d0d5dd] bg-white text-[#344054] transition hover:border-[#98a2b3] hover:bg-[#f8fafb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a8f34a] [&::-webkit-details-marker]:hidden"
          aria-label={`Gestionar credito ${creditDisplayNumber(item)}`}
          title="Gestionar credito"
        >
          <MoreHorizontal className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
        </summary>
        <div className="absolute right-0 z-30 mt-1 w-48 rounded-md border border-[#d0d5dd] bg-white p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.16)]">
          <Link href={`/dashboard/clientes?selected=${item.id}`}>Ver detalle</Link>
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

  return <CreditReportView
    items={items} summary={summary} totalAuthorized={totalAuthorized}
    loading={loading} exporting={exporting} message={message} isAdmin={isAdmin} sedeNombre={user?.sedeNombre || sedes[0]?.nombre || ""}
    search={search} from={from} to={to} aliadoId={aliadoId} sedeId={sedeId}
    aliados={aliados} sedes={sedesFiltradas}
    setSearch={setSearch} setFrom={setFrom} setTo={setTo}
    setAliado={value => {setAliadoId(value);setSedeId("");}} setSede={setSedeId}
    apply={() => void loadReport()} exportExcel={() => void exportReport()} actions={renderCreditActions}
  />;
}
