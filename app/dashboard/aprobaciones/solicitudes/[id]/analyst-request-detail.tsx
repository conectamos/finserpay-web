import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Building2, Calculator, Check, ChevronRight, FileCheck2, FileText, FolderOpen, History, Home, LockKeyholeOpen, Mail, MapPin, Phone, ShieldCheck, Smartphone, UserRound } from "lucide-react";
import { Badge, Card, EmptyState } from "@/app/_components/finser-ui";
import type { AnalystRequestDetail } from "@/lib/approval-request-detail-types";
import AnalystRequestDataEditor from "./analyst-request-data-editor";
import AnalystRequestFinancialEditor from "./analyst-request-financial-editor";
import AnalystRequestEvidenceEditor from "./analyst-request-evidence-editor";
import AnalystRequestTabs from "./analyst-request-tabs";
import styles from "./analyst-request-detail.module.css";

const requestsHref = "/dashboard/aprobaciones/solicitudes";
const steps = [
  { id: 1, label: "Cliente" }, { id: 2, label: "Equipo" }, { id: 3, label: "Identidad" },
  { id: 4, label: "Identidad y firma" }, { id: 5, label: "Enrolamiento y entrega" },
];
const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0, minimumFractionDigits: 0 });

export function analystRequestReturnHref(value: string | string[] | undefined) {
  if (typeof value !== "string" || value.length > 2000 || /[\\#\u0000-\u001f\u007f]/.test(value) || value.includes("//") ||
    (value !== requestsHref && !value.startsWith(`${requestsHref}?`))) return requestsHref;
  try {
    const url = new URL(value, "https://finserpay.invalid");
    return url.origin === "https://finserpay.invalid" && url.pathname === requestsHref ? value : requestsHref;
  } catch { return requestsHref; }
}

function display(value: string | number | null | undefined) { return value === null || value === undefined || value === "" ? "Pendiente" : value; }
function formatMoney(value: number | null) { return value === null || !Number.isFinite(value) ? "—" : money.format(value); }
function formatDate(value: string | null, withTime = false) {
  if (!value) return "Pendiente";
  const date = new Date(withTime ? value : `${value.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "Pendiente";
  return new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } as const : {}), timeZone: "America/Bogota" }).format(date);
}
function formatStatus(status: string | null) {
  if (!status) return "Pendiente";
  const labels: Record<string, string> = {
    APPROVED: "Aprobada", SIGNED: "Firmada", COMPLETED: "Completada", PENDING: "Pendiente", SENT: "Enviada", CREATED: "Creada",
    FAILED: "Error técnico: requiere revisión", ERROR: "Error técnico: requiere revisión", TECHNICAL_ERROR: "Error técnico: requiere revisión",
    REJECTED: "Rechazada", DECLINED: "Rechazada", EXPIRED: "Vencida", IN_PROGRESS: "En proceso", CANCELLED: "Cancelada",
    DATA_CORRECTED: "Datos actualizados", FINANCIAL_CORRECTED: "Condiciones actualizadas", EVIDENCE_CORRECTED: "Evidencia actualizada",
  };
  return labels[status.toUpperCase()] || status;
}
function statusTone(status: string): "neutral" | "positive" | "warning" | "danger" {
  if (/CANCEL|DESIST|RECHAZ|ERROR|FAILED|DECLINED|NOT_APPROVED|NO_APROB/i.test(status)) return "danger";
  if (/FINALIZ|ENTREG|APROB|ACTIVO|COMPLET|APPROVED|SIGNED|CORRECTED/i.test(status)) return "positive";
  if (/PROCESO|ABIERT|PENDIENT|PENDING|IN_PROGRESS|SENT/i.test(status)) return "warning";
  return "neutral";
}
function frequency(value: string | null) { return value ? ({ QUINCENAL: "Quincenal", MENSUAL: "Mensual", SEMANAL: "Semanal" }[value.toUpperCase()] || value) : "Pendiente"; }
function DetailFields({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return <dl className={styles.fields}>{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
function ActionIcon({ kind }: { kind: AnalystRequestDetail["actions"][number]["kind"] }) {
  const props = { size: 18, "aria-hidden": true as const };
  return kind === "imei" ? <Smartphone {...props} /> : kind === "signature" ? <FileCheck2 {...props} />
    : kind === "release" ? <LockKeyholeOpen {...props} /> : <FolderOpen {...props} />;
}

export default function AnalystRequestDetailView({ detail, returnHref = requestsHref }: { detail: AnalystRequestDetail; returnHref?: string }) {
  const isDraft = detail.source === "DRAFT";
  const completed = detail.source === "CREDIT" || /FINALIZ|ENTREG/i.test(detail.status);
  const workflow = /IPHONE|IOS/i.test(detail.equipment.platform || "") ? steps.filter(step => step.id !== 3) : steps;
  const current = detail.step === null ? -1 : workflow.findIndex(step => step.id >= (detail.step || 1));
  const attachedCount = detail.documents.filter(doc => doc.available && doc.href).length;
  const summary = <>
    <Card className={styles.section}>
      <header className={styles.sectionHeading}><div><h2><Calculator size={20} aria-hidden="true" />Condiciones del crédito</h2><p>Los valores del plan de esta solicitud.</p></div>{isDraft && <AnalystRequestFinancialEditor key={detail.id} requestId={detail.id} />}</header>
      <dl className={styles.financial}>
        {[{ label: "Valor de venta", value: formatMoney(detail.financial.saleValue) }, { label: "Inicial", value: formatMoney(detail.financial.downPayment) },
          { label: "Monto financiado", value: formatMoney(detail.financial.authorizedAmount) }, { label: "Valor de cuota", value: formatMoney(detail.financial.installment) }]
          .map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
      </dl>
      <div className={styles.planMeta}><span><strong>{display(detail.financial.installments)}</strong> cuotas</span><span>{frequency(detail.financial.frequency)}</span><span>Primer pago: <strong>{detail.financial.firstPayment ? formatDate(detail.financial.firstPayment) : "Al activar el crédito"}</strong></span></div>
    </Card>
    <div className={styles.twoColumns}>
      <Card className={styles.section}>
        <header className={styles.sectionHeading}><div><h2><UserRound size={20} aria-hidden="true" />Datos del cliente</h2></div>{isDraft && <AnalystRequestDataEditor key={detail.id} requestId={detail.id} />}</header>
        <DetailFields items={[
          { label: "Celular", value: display(detail.client.phone) }, { label: "Correo", value: display(detail.client.email) },
          { label: "Departamento", value: display(detail.client.department) }, { label: "Ciudad o municipio", value: display(detail.client.city) },
          { label: "Dirección", value: display(detail.client.address) }, { label: "Fecha de nacimiento", value: formatDate(detail.client.birthDate) },
        ]} />
      </Card>
      <Card className={styles.section}>
        <header className={styles.sectionHeading}><h2><Smartphone size={20} aria-hidden="true" />Equipo y operación</h2></header>
        <div className={styles.equipment}><span className={styles.equipmentIcon}><Smartphone size={28} aria-hidden="true" /></span><div><strong>{display(detail.equipment.reference)}</strong><p>{display(detail.equipment.platform)} · IMEI {display(detail.equipment.imei)}</p></div></div>
        <DetailFields items={[
          { label: "Aliado", value: display(detail.assignment.ally) }, { label: "Sede", value: display(detail.assignment.site) },
          { label: "Asesor responsable", value: display(detail.assignment.advisor) }, { label: "Registrada por", value: display(detail.assignment.createdBy) },
        ]} />
      </Card>
    </div>
    {detail.validations.length > 0 && <Card className={styles.section}>
      <header className={styles.sectionHeading}><h2><ShieldCheck size={20} aria-hidden="true" />Validaciones</h2></header>
      <ul className={styles.validations}>{detail.validations.map(validation => <li key={validation.label}><span>{validation.label}</span><Badge tone={statusTone(validation.status || "")}>{formatStatus(validation.status)}</Badge></li>)}</ul>
    </Card>}
  </>;
  const documents = <Card className={styles.section}>
    <header className={styles.sectionHeading}><div><h2><FileText size={20} aria-hidden="true" />Documentos y evidencias</h2><p>{attachedCount} de {detail.documents.length} documentos disponibles.</p></div>{isDraft && <AnalystRequestEvidenceEditor key={detail.id} requestId={detail.id} />}</header>
    {detail.documents.length === 0 ? <EmptyState title="Sin documentos registrados" description="Los documentos disponibles aparecerán aquí." />
      : <ul className={styles.documents}>{detail.documents.map(doc => <li key={doc.key}>
        <span className={`${styles.documentIcon} ${doc.available ? styles.available : ""}`}>{doc.pdf ? <FileCheck2 size={23} aria-hidden="true" /> : <FileText size={23} aria-hidden="true" />}</span>
        <div className={styles.documentTitle}><strong>{doc.label}</strong><small>{doc.pdf ? "Contrato generado por FirmaSeguro" : doc.available ? "Fotografía adjunta a la solicitud" : "Pendiente de adjuntar"}</small></div>
        <Badge tone={doc.available && doc.href ? "positive" : "neutral"}>{doc.available && doc.href ? "Disponible" : "Pendiente"}</Badge>
        {doc.available && doc.href ? <a href={doc.href} target="_blank" rel="noopener noreferrer" className="fp-ui-button is-secondary" aria-label={`Abrir ${doc.label}`}><FolderOpen size={17} aria-hidden="true" />Abrir</a> : <span className={styles.emptyAction}>—</span>}
      </li>)}</ul>}
  </Card>;
  const history = <Card className={styles.section}>
    <header className={styles.sectionHeading}><div><h2><History size={20} aria-hidden="true" />Historial de la solicitud</h2><p>Acciones, correcciones y estados del caso.</p></div></header>
    {detail.timeline.length === 0 ? <EmptyState title="Sin movimientos adicionales" description="Las actualizaciones aparecerán en este historial." />
      : <ol className={styles.timeline}>{detail.timeline.map(event => <li key={event.id}>
        <div className={styles.eventHeading}><strong>{event.label}</strong><time>{formatDate(event.at, true)}</time></div>
        {event.status && <Badge tone={statusTone(event.status)}>{formatStatus(event.status)}</Badge>}
        {event.detail && <p>{event.detail}</p>}{event.actor && <small>Por {event.actor}</small>}
      </li>)}</ol>}
  </Card>;
  return <div className={styles.detail}>
    <nav className={styles.breadcrumb} aria-label="Ruta de navegación"><Link href="/dashboard/aprobaciones/centro" aria-label="Centro del analista"><Home size={16} aria-hidden="true" /></Link><ChevronRight size={14} aria-hidden="true" /><Link href={returnHref} prefetch={false}>Solicitudes</Link><ChevronRight size={14} aria-hidden="true" /><strong>{detail.number}</strong></nav>
    <header className={styles.heading}><div><h1>Detalle de solicitud</h1><p>Revisa y gestiona el caso desde un solo lugar.</p></div><Link href={returnHref} prefetch={false} className="fp-ui-button is-secondary"><ArrowLeft size={17} aria-hidden="true" />Volver a solicitudes</Link></header>
    <Card className={styles.identity}>
      <div className={styles.identityHeading}>
        <div className={styles.identityName}><span className={styles.avatar}><UserRound size={26} aria-hidden="true" /></span><div><span className={styles.requestNumber}>{detail.number}</span><h2>{detail.clientName || "Cliente pendiente de registrar"}</h2><p>{detail.client.documentType || "CC"} {display(detail.document)}</p></div></div>
        <div className={styles.identityStatus}><Badge tone={statusTone(detail.status)}>{detail.statusLabel}</Badge>{current >= 0 && <span>{completed ? "Venta completada" : `Paso ${current + 1} de ${workflow.length}`}</span>}</div>
      </div>
      <div className={styles.quickDetails}>
        <span><Building2 size={16} aria-hidden="true" />{display(detail.assignment.ally)}</span><span><MapPin size={16} aria-hidden="true" />{display(detail.assignment.site)}</span>
        {detail.client.phone && <span><Phone size={16} aria-hidden="true" />{detail.client.phone}</span>}{detail.client.email && <span><Mail size={16} aria-hidden="true" />{detail.client.email}</span>}
      </div>
      {current >= 0 && <ol className={styles.steps} aria-label="Pasos de la solicitud" style={{ gridTemplateColumns: `repeat(${workflow.length}, minmax(0, 1fr))` }}>{workflow.map((step, index) => <li key={step.id} className={completed || index <= current ? styles.reachedStep : undefined} aria-current={!completed && index === current ? "step" : undefined}><span aria-hidden="true">{completed || index < current ? <Check size={16} /> : index + 1}</span>{step.label}</li>)}</ol>}
      <div className={styles.requestMeta}><span>Creada {formatDate(detail.createdAt, true)}</span><span>Actualizada {formatDate(detail.updatedAt, true)}</span>{detail.closedAt ? <span>Cierre {formatDate(detail.closedAt, true)}</span> : detail.expiresAt && <span>Vigente hasta {formatDate(detail.expiresAt)}</span>}</div>
    </Card>
    {detail.actions.length > 0 && <nav className={styles.actions} aria-label="Gestión de la solicitud">{detail.actions.map(action => <Link href={action.href} prefetch={false} key={action.kind} className={`fp-ui-button ${action.kind === "approval" ? "is-primary" : "is-secondary"}`}><ActionIcon kind={action.kind} />{action.label}</Link>)}</nav>}
    <AnalystRequestTabs summary={summary} documents={documents} history={history} />
  </div>;
}
