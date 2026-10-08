"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Button, DataTable, EmptyState, LoadingState, Select } from "@/app/_components/finser-ui";
import type { AnalystCenterManagementResponse } from "@/lib/analyst-center-types";
import styles from "./analyst-managements.module.css";

const dateFormat = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota" });
function date(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateFormat.format(parsed) : "Fecha no registrada";
}
function result(value: string | null) {
  if (!value) return "Sin resultado registrado";
  const labels: Record<string, string> = { COMPLETED: "Completado", APPROVED: "Aprobado", REQUESTED: "Solicitado", SIGNED: "Firmado", SENT: "Enviado", PENDING: "Pendiente", PENDING_REAPPROVAL: "Pendiente de nueva aprobación", PENDING_ENROLLMENT: "Pendiente de enrolamiento", ENROLLMENT_APPROVED: "Enrolamiento aprobado", FAILED_SAFE: "Error: acción no completada", UNCERTAIN: "Pendiente de verificación", AUTHORIZED: "Autorizado", CANCELLED: "Cancelado", REJECTED: "Rechazado" };
  return labels[value] || value.replace(/_/g, " ");
}

export default function AnalystManagements() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<AnalystCenterManagementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/aprobaciones/centro/gestiones?page=${page}&pageSize=${pageSize}`, { cache: "no-store", signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || "No se pudieron consultar tus gestiones.");
      if (!signal.aborted) setData(payload);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudieron consultar tus gestiones.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [page, pageSize]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, revision]);

  return <main className={styles.main}>
    <header className={styles.header}><div><h1>Mis gestiones</h1><p>Actuaciones registradas por tu usuario · Fechas y horas de Colombia.</p></div><Button variant="secondary" disabled={loading} onClick={() => setRevision(current => current + 1)}><RefreshCw aria-hidden="true" />Actualizar</Button></header>
    {error ? <div className={styles.error} role="alert"><p>{error}</p><Button variant="secondary" onClick={() => setRevision(current => current + 1)}>Reintentar</Button></div> : loading ? <div className={styles.loading}><LoadingState label="Consultando tus gestiones..." /></div> : data && data.items.length ? <>
      <DataTable className={styles.tableScroll}><table className={styles.table}><caption className="sr-only">Historial de actuaciones del usuario conectado</caption><thead><tr><th>Fecha</th><th>Crédito</th><th>Acción</th><th>Resultado</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td>{date(item.at)}</td><td>{item.creditNumber || (item.kind === "ASSESSMENT" ? "Consulta de DataCrédito" : "Sin número registrado")}{item.kind !== "ASSESSMENT" && <Link href={`/dashboard/aprobaciones/solicitudes/${item.kind === "CREDIT" ? "C" : "D"}-${item.targetId}`}>Consultar solicitud<ChevronRight aria-hidden="true" /></Link>}</td><td>{item.action.replace(/_/g, " ")}</td><td>{result(item.result)}</td></tr>)}</tbody></table></DataTable>
      <footer className={styles.pagination}><p>Mostrando {(data.page - 1) * data.pageSize + 1} – {Math.min(data.page * data.pageSize, data.total)} de {data.total} gestiones</p><div><label>Filas<Select aria-label="Gestiones por página" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10,20,50,100].map(size => <option key={size} value={size}>{size} por página</option>)}</Select></label><Button variant="secondary" aria-label="Página anterior" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}><ChevronLeft aria-hidden="true" /></Button><span>Página {data.page} de {data.totalPages}</span><Button variant="secondary" aria-label="Página siguiente" disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}><ChevronRight aria-hidden="true" /></Button></div></footer>
    </> : <EmptyState title="Aún no hay gestiones" description="Aquí aparecerán las actuaciones que registres con tu cuenta." />}
  </main>;
}
