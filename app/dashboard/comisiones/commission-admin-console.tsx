"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, FileCheck2, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, MetricCard, PageHeader, Select } from "@/app/_components/finser-ui";
import { COMMISSION_RECEIPT_MAX_BYTES, COMMISSION_TIME_ZONE, type AdminCommissionBag, type AdminCommissionRequest } from "@/lib/commissions";
import styles from "./commission-admin.module.css";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: COMMISSION_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });
const months = new Intl.DateTimeFormat("es-CO", { timeZone: COMMISSION_TIME_ZONE, month: "long", year: "numeric" });
const statusLabels = { PENDING: "En trámite", PAID: "Pagada", REJECTED: "Rechazada" } as const;
const auditLabels: Record<string, string> = {
  REQUEST_CREATED: "Solicitud de cobro creada",
  REQUEST_REJECTED: "Solicitud rechazada · reserva liberada",
  PAYMENT_CONFIRMED: "Pago confirmado",
  RATE_CHANGED: "Cambio de tarifa mensual",
  CREDIT_COUNTED: "Crédito contabilizado",
  CREDIT_REMOVED: "Crédito excluido del cálculo",
  CREDIT_CHANGED: "Cambio en un crédito de respaldo",
  CREDIT_REASSIGNED: "Cambio de vendedor asignado al crédito",
  PERIOD_RECALCULATED: "Comisión mensual recalculada",
  CREDITS_RECALCULATED: "Créditos y comisión mensual recalculados",
  REQUEST_ADJUSTED: "Reserva liberada por un ajuste de créditos",
  RECEIPT_UPLOADED: "Comprobante adjuntado",
  ADJUSTMENT: "Ajuste de comisión",
};

function periodLabel(period: string) {
  return /^\d{4}-\d{2}$/.test(period) ? months.format(new Date(`${period}-01T12:00:00-05:00`)) : period;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dates.format(date);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible completar la operación. Intenta de nuevo.";
}

async function readResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || payload?.message || "No fue posible consultar las comisiones.");
  return payload;
}

function RequestStatus({ status }: { status: AdminCommissionRequest["status"] }) {
  return <Badge tone={status === "PAID" ? "positive" : status === "REJECTED" ? "danger" : "warning"}>{statusLabels[status]}</Badge>;
}

export function CommissionBagsTable({ bags, loading }: { bags: AdminCommissionBag[]; loading: boolean }) {
  return (
    <Card className={styles.inbox}>
      <div className={styles.sectionHeader}>
        <div><h2>Bolsas de comisiones por aliado</h2><p>La bolsa se pausa cuando la cartera en mora del aliado es igual o superior al 8% de su cartera total.</p></div>
        <Badge>{bags.length} aliados</Badge>
      </div>
      <p className={styles.bagHelp}>La pausa impide nuevas solicitudes. Las reservas anteriores se conservan y los pagos ya consignados se pueden confirmar. Se incluyen aliados sin solicitudes de cobro.</p>
      {loading && !bags.length ? <LoadingState label="Consultando cartera de los aliados..." /> : !bags.length ? (
        <EmptyState title="No hay bolsas de aliados para mostrar" description="Las bolsas aparecerán cuando existan aliados registrados." />
      ) : (
        <DataTable className={`${styles.tableWrap} ${styles.bagTableWrap}`}>
          <table className={styles.table}>
            <thead><tr><th>Aliado</th><th className={styles.numeric}>Cartera en mora</th><th className={styles.numeric}>Cartera total</th><th className={styles.numeric}>Indicador de mora</th><th>Estado de la bolsa</th></tr></thead>
            <tbody>{bags.map((bag) => <tr key={bag.allyId}>
              <td><strong>{bag.allyName}</strong></td>
              <td className={styles.numeric}>{money.format(bag.overdueBalance)}</td>
              <td className={styles.numeric}>{money.format(bag.totalBalance)}</td>
              <td className={styles.numeric}><strong>{percent.format(bag.overduePercent)}%</strong></td>
              <td><Badge tone={bag.paused ? "warning" : "positive"}>{bag.paused ? "En pausa" : "Habilitada"}</Badge></td>
            </tr>)}</tbody>
          </table>
        </DataTable>
      )}
    </Card>
  );
}

export default function CommissionAdminConsole() {
  const [requests, setRequests] = useState<AdminCommissionRequest[]>([]);
  const [bags, setBags] = useState<AdminCommissionBag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("PENDING");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"pay" | "reject" | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const loadSequence = useRef(0);
  const selected = requests.find((request) => request.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const payload = await readResponse(await fetch("/api/admin/comisiones", { cache: "no-store" }));
      if (!Array.isArray(payload?.requests) || !Array.isArray(payload?.bags)) throw new Error("La respuesta de comisiones no está disponible.");
      if (sequence === loadSequence.current) {
        setRequests(payload.requests);
        setBags(payload.bags);
        setError("");
      }
    } catch (cause) {
      if (sequence === loadSequence.current) setError(errorMessage(cause));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { loadSequence.current += 1; };
  }, [refresh]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("es-CO");
    return requests.filter((request) => (status === "ALL" || request.status === status)
      && (!term || `${request.sellerName} ${request.branchName} ${request.period} ${request.nequi} ${request.id}`.toLocaleLowerCase("es-CO").includes(term)));
  }, [requests, search, status]);
  const pending = requests.filter((request) => request.status === "PENDING");
  const paid = requests.filter((request) => request.status === "PAID");
  const locked = busy || confirm !== null;

  function selectRequest(request: AdminCommissionRequest) {
    setSelectedId(request.id);
    setReceipt(null);
    setReason("");
    setNotice("");
    requestAnimationFrame(() => {
      detailRef.current?.focus({ preventScroll: true });
      if (window.innerWidth < 1440) detailRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    });
  }

  function chooseReceipt(file: File | null) {
    setReceipt(null);
    if (!file) return;
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) {
      setError("Adjunta un comprobante PDF, PNG o JPG.");
      return;
    }
    if (file.size === 0 || file.size > COMMISSION_RECEIPT_MAX_BYTES) {
      setError("El comprobante debe contener información y pesar máximo 5 MB.");
      return;
    }
    setError("");
    setReceipt(file);
  }

  async function submitAction() {
    if (!selected || selected.status !== "PENDING" || busy || !confirm) return;
    const action = confirm;
    if (action === "pay" && !receipt) { setError("El comprobante de consignación es obligatorio."); setConfirm(null); return; }
    if (action === "reject" && reason.trim().length < 3) { setError("Indica un motivo de rechazo de al menos 3 caracteres."); setConfirm(null); return; }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let response: Response;
      if (action === "pay") {
        const body = new FormData();
        body.set("receipt", receipt!);
        response = await fetch(`/api/admin/comisiones/${encodeURIComponent(selected.id)}/pagar`, { method: "POST", body });
      } else {
        response = await fetch(`/api/admin/comisiones/${encodeURIComponent(selected.id)}/rechazar`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }),
        });
      }
      const result = await readResponse(response);
      if (result?.request?.id === selected.id) {
        setRequests((current) => current.map((item) => item.id === selected.id ? { ...item, ...result.request } : item));
      }
      setReceipt(null);
      setReason("");
      await refresh();
      setNotice(action === "pay" ? "Pago confirmado. El vendedor puede consultar la notificación y descargar el comprobante en su panel." : "Solicitud rechazada. La reserva se liberó y el vendedor puede consultar el motivo.");
    } catch (cause) {
      const message = errorMessage(cause);
      await refresh();
      setError(message);
    } finally {
      setConfirm(null);
      setBusy(false);
    }
  }

  return (
    <main className={styles.main}>
      <PageHeader eyebrow="Administración central" title="Comisiones de vendedores"
        description="Revisa los créditos que respaldan cada solicitud y registra el pago después de consignar."
        actions={<Button variant="secondary" onClick={() => void refresh()} disabled={loading || locked}><RefreshCw size={16} aria-hidden="true" />Actualizar</Button>} />

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={19} aria-hidden="true" />{notice}</div> : null}

      <div className={styles.metrics}>
        <MetricCard label="Solicitudes en trámite" value={loading && !requests.length ? "—" : pending.length} detail="Pendientes de revisión y pago" />
        <MetricCard label="Monto reservado" value={loading && !requests.length ? "—" : money.format(pending.reduce((sum, item) => sum + item.amount, 0))} detail="Respalda las solicitudes en trámite" />
        <MetricCard label="Pagos confirmados" value={loading && !requests.length ? "—" : money.format(paid.reduce((sum, item) => sum + item.amount, 0))} detail={`${paid.length} solicitudes con comprobante`} />
      </div>

      <CommissionBagsTable bags={bags} loading={loading} />

      <div className={`${styles.content} ${selected ? styles.hasDetail : ""}`}>
        <Card className={styles.inbox}>
          <div className={styles.sectionHeader}><div><h2>Solicitudes de cobro</h2><p>Programa vigente desde el 1 de octubre de 2026 · Hora de Colombia</p></div><Badge>{visible.length}</Badge></div>
          <div className={styles.filters}>
            <label className={styles.search}><Search size={17} aria-hidden="true" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar vendedor, sede o periodo" aria-label="Buscar solicitudes" /></label>
            <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Estado de las solicitudes">
              <option value="PENDING">En trámite</option><option value="PAID">Pagadas</option><option value="REJECTED">Rechazadas</option><option value="ALL">Todos los estados</option>
            </Select>
          </div>
          {loading && !requests.length ? <LoadingState label="Consultando solicitudes reales..." /> : !visible.length ? <EmptyState title="No hay solicitudes para mostrar" description={search ? "Prueba con otro vendedor, sede o periodo." : "Las solicitudes de los vendedores aparecerán aquí con su periodo y créditos de respaldo."} /> : (
            <DataTable className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Vendedor / sede</th><th>Periodo / respaldo</th><th className={styles.numeric}>Monto solicitado</th><th>Nequi</th><th>Estado</th><th><span className={styles.srOnly}>Acciones</span></th></tr></thead>
                <tbody>{visible.map((request) => (
                  <tr key={request.id} data-selected={selectedId === request.id || undefined}>
                    <td><strong>{request.sellerName}</strong><small>{request.branchName || "Sin sede registrada"}</small></td>
                    <td><span className={styles.period}>{periodLabel(request.period)}</span><small>{request.credits.length} créditos de respaldo</small></td>
                    <td className={styles.numeric}><strong>{money.format(request.amount)}</strong><small>{dateLabel(request.createdAt)}</small></td>
                    <td className={styles.nequi}>{request.nequi}</td>
                    <td><RequestStatus status={request.status} /></td>
                    <td><Button variant="secondary" disabled={locked} onClick={() => selectRequest(request)} aria-label={`Revisar solicitud de ${request.sellerName}`}>Revisar</Button></td>
                  </tr>
                ))}</tbody>
              </table>
            </DataTable>
          )}
        </Card>

        {selected ? (
          <section ref={detailRef} tabIndex={-1} className={styles.detail} aria-labelledby="commission-review-title">
            <div className={styles.detailHeading}><div><span className={styles.eyebrow}>Revisión de solicitud</span><h2 id="commission-review-title">{selected.sellerName}</h2><p>{selected.branchName} · {periodLabel(selected.period)}</p></div><Button variant="ghost" disabled={locked} aria-label="Cerrar detalle" onClick={() => setSelectedId(null)}><X size={19} aria-hidden="true" /></Button></div>
            <div className={styles.requestAmount}><div><span>Monto solicitado</span><strong>{money.format(selected.amount)}</strong></div><RequestStatus status={selected.status} /></div>
            <dl className={styles.metadata}><div><dt>Nequi de destino</dt><dd className={styles.nequi}>{selected.nequi}</dd></div><div><dt>Fecha de solicitud</dt><dd>{dateLabel(selected.createdAt)}</dd></div><div><dt>Referencia</dt><dd className={styles.reference}>{selected.id}</dd></div>{selected.paidAt ? <div><dt>Pago confirmado</dt><dd>{dateLabel(selected.paidAt)}</dd></div> : null}</dl>

            <details className={styles.disclosure} open><summary><ShieldCheck size={17} aria-hidden="true" />Créditos de respaldo <Badge>{selected.credits.length}</Badge></summary><p>Registro de los créditos que respaldaban la comisión al solicitar el cobro.</p><ul className={styles.credits}>{selected.credits.map((credit) => <li key={credit.id}><strong>{credit.code || `Crédito ${credit.id}`}</strong><span>{dateLabel(credit.finalizedAt)}</span></li>)}</ul></details>

            {selected.status === "PENDING" ? (
              <>
                <div className={styles.payment}><h3><FileCheck2 size={19} aria-hidden="true" />Confirmar consignación</h3><p>Realiza la consignación a Nequi y adjunta el comprobante antes de confirmar el pago.</p><label className={styles.field} htmlFor="commission-receipt">Comprobante obligatorio<Input key={selected.id} id="commission-receipt" type="file" accept="application/pdf,image/png,image/jpeg" disabled={locked} onChange={(event) => chooseReceipt(event.target.files?.[0] ?? null)} /><small>PDF, PNG o JPG · Máximo 5 MB</small></label>{receipt ? <p className={styles.fileReady}><CheckCircle2 size={15} aria-hidden="true" />{receipt.name}</p> : null}<Button disabled={!receipt || locked} onClick={() => setConfirm("pay")}>Confirmar pago de {money.format(selected.amount)}</Button>{!receipt ? <small className={styles.hint}>Adjunta el comprobante para habilitar la confirmación.</small> : null}</div>
                <details className={styles.rejection}><summary>Rechazar solicitud</summary><label className={styles.field} htmlFor="commission-rejection">Motivo del rechazo<textarea id="commission-rejection" className="fp-ui-input" value={reason} disabled={locked} minLength={3} maxLength={1000} rows={3} placeholder="Explica al vendedor por qué se rechaza la solicitud" onChange={(event) => setReason(event.target.value)} /><small>Entre 3 y 1.000 caracteres. El vendedor podrá consultar este motivo.</small></label><Button variant="danger" disabled={reason.trim().length < 3 || locked} onClick={() => setConfirm("reject")}>Rechazar y liberar reserva</Button></details>
              </>
            ) : null}

            {selected.status === "REJECTED" ? <div className={styles.rejected}><strong>Motivo del rechazo</strong><p>{selected.rejectionReason || "Consulta el historial de la solicitud."}</p><small>El monto reservado fue liberado.</small></div> : null}
            {selected.status === "PAID" && selected.receiptFileName ? <a className={`fp-ui-button is-secondary ${styles.download}`} href={`/api/comisiones/solicitudes/${encodeURIComponent(selected.id)}/comprobante`} download><Download size={17} aria-hidden="true" />Descargar comprobante</a> : null}

            <details className={styles.disclosure}><summary>Historial auditable <Badge>{selected.audit.length}</Badge></summary>{selected.audit.length ? <ol className={styles.audit}>{selected.audit.map((event) => <li key={event.id}><strong>{auditLabels[event.action] || event.action.replaceAll("_", " ")}</strong><small>{dateLabel(event.createdAt)} · {event.actorName || "Sistema"}</small>{event.detail ? <p>{typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail)}</p> : null}</li>)}</ol> : <p>Sin eventos adicionales.</p>}</details>
          </section>
        ) : null}
      </div>

      <ConfirmDialog open={confirm !== null} title={confirm === "pay" ? "Confirmar pago de comisión" : "Rechazar solicitud de cobro"} description={confirm === "pay" ? `Confirma que ya consignaste ${money.format(selected?.amount ?? 0)} al Nequi ${selected?.nequi ?? ""}. Se registrará el pago y el vendedor recibirá el comprobante.` : `Se liberarán ${money.format(selected?.amount ?? 0)} reservados y se notificará al vendedor el motivo: ${reason.trim()}`} confirmLabel={confirm === "pay" ? "Confirmar pago" : "Rechazar solicitud"} danger={confirm === "reject"} busy={busy} onCancel={() => { if (!busy) setConfirm(null); }} onConfirm={() => void submitAction()} />
    </main>
  );
}
