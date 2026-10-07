"use client";
import {useEffect,useState} from "react";
import {creditDisplayNumber} from "@/lib/credit-display-number";
import {paymentReportMoney as formatMoney,type SessionUser,type SedeItem,type AliadoItem,type PaymentReportItem,type PaymentByDay,type PaymentReportResponse} from "@/lib/payment-report";
import PaymentReportView from "./payment-report-view";
function isFinserPayCentral(codigo:string|null|undefined){return String(codigo||" ").trim().toUpperCase()==="FINSERPAY";}

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
  const [loadError,setLoadError]=useState(false);
  const [exporting,setExporting]=useState(false);
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

  const exportReport=async()=>{
    if(loading||exporting||!items.length)return;
    setExporting(true);setMessage('');
    try{const {buildPaymentReportWorkbook}=await import('@/lib/payment-report-excel');
      const buffer=await buildPaymentReportWorkbook(items,byDay).xlsx.writeBuffer();
      const url=URL.createObjectURL(new Blob([new Uint8Array(buffer)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const anchor=document.createElement('a');anchor.href=url;anchor.download='recaudos-finserpay-'+new Date().toISOString().slice(0,10)+'.xlsx';
      try{document.body.appendChild(anchor);anchor.click();}finally{anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
    }catch{setMessage('No se pudo generar el Excel. Intenta nuevamente.');}finally{setExporting(false);}
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
      setLoadError(false);
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
        setLoadError(true);
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
      setLoadError(true);setItems([]);setByDay([]);setSummary(null);
      setMessage("Error cargando el reporte de abonos");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try{await loadContext();await loadReport();}catch{setLoadError(true);setMessage("No se pudo cargar el reporte de recaudos");setLoading(false);}
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
      `Motivo de anulacion del recaudo ${formatMoney(item.valor)} del crédito ${creditDisplayNumber(item.credito)}:`,
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
      `Vas a ELIMINAR este recaudo de ${formatMoney(item.valor)} del crédito ${creditDisplayNumber(item.credito)}. Se borrara el abono local, caja asociada y enlaces digitales relacionados, y se quitara este registro del reporte.`
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

  return <PaymentReportView items={items} byDay={byDay} summary={summary} loading={loading} error={loadError} exporting={exporting} message={message} isAdmin={isAdmin} isCentralAdmin={isCentralAdmin} sedeNombre={user?.sedeNombre||sedes[0]?.nombre||''} search={search} from={from} to={to} aliadoId={aliadoId} sedeId={sedeId} aliados={aliados} sedes={sedesFiltradas} setSearch={setSearch} setFrom={setFrom} setTo={setTo} setAliado={value=>{setAliadoId(value);setSedeId('');}} setSede={setSedeId} apply={()=>void loadReport()} exportExcel={()=>void exportReport()} annul={item=>void annulPayment(item)} remove={item=>void deletePayment(item)} annullingId={annullingId} deletingId={deletingId}/>;
}
