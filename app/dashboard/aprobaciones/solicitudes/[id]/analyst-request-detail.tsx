import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  FileCheck2,
  FileText,
  FolderOpen,
  History,
  LockKeyholeOpen,
  Smartphone,
} from "lucide-react";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  ProgressBar,
} from "@/app/_components/finser-ui";
import type { AnalystRequestDetail } from "@/lib/approval-request-detail-types";
import styles from "./analyst-request-detail.module.css";

const requestsHref = "/dashboard/aprobaciones/solicitudes";
const steps = ["Cliente", "Equipo", "Identidad", "Identidad y firma", "Enrolamiento y entrega"];
const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

export function analystRequestReturnHref(value: string | string[] | undefined) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\\#\u0000-\u001f\u007f]/.test(value) ||
    value.includes("//") ||
    (value !== requestsHref && !value.startsWith(`${requestsHref}?`))
  ) return requestsHref;

  try {
    const url = new URL(value, "https://finserpay.invalid");
    return url.origin === "https://finserpay.invalid" && url.pathname === requestsHref
      ? value
      : requestsHref;
  } catch {
    return requestsHref;
  }
}

function display(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "Sin registrar" : value;
}

function formatMoney(value: number | null) {
  return value === null || !Number.isFinite(value) ? "Sin registrar" : money.format(value);
}

function formatDate(value: string | null, withTime = false) {
  if (!value) return "Sin registrar";
  const dateValue = withTime ? value : `${value.slice(0, 10)}T12:00:00Z`;
  const date = new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return "Sin registrar";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } as const : {}),
    timeZone: "America/Bogota",
  }).format(date);
}

function formatStatus(status: string | null) {
  if (!status) return "Sin registrar";
  const labels: Record<string, string> = {
    APPROVED: "Aprobada", SIGNED: "Firmada", COMPLETED: "Completada",
    PENDING: "Pendiente", SENT: "Enviada", CREATED: "Creada",
    FAILED: "Error", ERROR: "Error", REJECTED: "Rechazada", DECLINED: "Rechazada",
    EXPIRED: "Vencida", IN_PROGRESS: "En proceso", CANCELLED: "Cancelada",
  };
  return labels[status.toUpperCase()] || status;
}

function statusTone(status: string): "neutral" | "positive" | "warning" | "danger" {
  if (/CANCEL|DESIST|RECHAZ|ERROR|FAILED|DECLINED|NOT_APPROVED|NO_APROB/i.test(status)) return "danger";
  if (/FINALIZ|ENTREG|APROB|ACTIVO|COMPLET|APPROVED|SIGNED/i.test(status)) return "positive";
  if (/PROCESO|ABIERT|PENDIENT|PENDING|IN_PROGRESS|SENT/i.test(status)) return "warning";
  return "neutral";
}

function DetailFields({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return <dl className={styles.fields}>
    {items.map((item) => <div key={item.label}>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
    </div>)}
  </dl>;
}

function ActionIcon({ kind }: { kind: AnalystRequestDetail["actions"][number]["kind"] }) {
  const props = { size: 18, "aria-hidden": true as const };
  if (kind === "imei") return <Smartphone {...props} />;
  if (kind === "signature") return <FileCheck2 {...props} />;
  if (kind === "release") return <LockKeyholeOpen {...props} />;
  return <FolderOpen {...props} />;
}

export default function AnalystRequestDetailView({
  detail,
  returnHref = requestsHref,
}: {
  detail: AnalystRequestDetail;
  returnHref?: string;
}) {
  const currentStep = detail.step !== null && detail.step >= 1 && detail.step <= 5
    ? Math.trunc(detail.step)
    : null;
  const completed = detail.source === "CREDIT" || /FINALIZ|ENTREG/i.test(detail.status);

  return <div className={styles.detail}>
    <PageHeader
      eyebrow="Solicitudes"
      title={detail.number}
      description="Consulta el avance, los documentos y el historial de esta solicitud."
      actions={<Link href={returnHref} prefetch={false} className="fp-ui-button is-secondary">
        <ArrowLeft size={18} aria-hidden="true" />Volver al muro
      </Link>}
    />

    <Card className={styles.identity}>
      <div className={styles.identityHeading}>
        <div>
          <h2>{detail.clientName || "Cliente sin nombre registrado"}</h2>
          <p>{detail.client.documentType || "Cédula"}: <strong>{display(detail.document)}</strong></p>
        </div>
        <div className={styles.identityStatus}>
          <Badge tone={statusTone(detail.status)}>{detail.statusLabel}</Badge>
          {currentStep !== null ? <span className={styles.stepMeta}>Paso {currentStep} de 5</span> : null}
        </div>
      </div>
      {currentStep !== null ? <div className={styles.progress}>
        <ProgressBar value={(completed ? 5 : currentStep) * 20} label="Avance de la solicitud" />
        <ol className={styles.steps} aria-label="Pasos de la solicitud">
          {steps.map((label, index) => <li
            key={label}
            className={completed || index + 1 <= currentStep ? styles.reachedStep : undefined}
            aria-current={!completed && index + 1 === currentStep ? "step" : undefined}
          >
            <span aria-hidden="true">{index + 1}</span>{label}
          </li>)}
        </ol>
      </div> : null}
      <DetailFields items={[
        { label: "Fecha de solicitud", value: formatDate(detail.createdAt, true) },
        { label: "Última actualización", value: formatDate(detail.updatedAt, true) },
        ...(detail.closedAt ? [{ label: "Fecha de cierre", value: formatDate(detail.closedAt, true) }] : []),
        ...(detail.expiresAt ? [{ label: "Vigencia de solicitud", value: formatDate(detail.expiresAt, true) }] : []),
      ]} />
    </Card>

    {detail.actions.length > 0 ? <nav className={styles.actions} aria-label="Gestión de la solicitud">
      {detail.actions.map((action) => <Link
        href={action.href}
        prefetch={false}
        key={action.kind}
        className={`fp-ui-button ${action.kind === "approval" ? "is-primary" : "is-secondary"}`}
      ><ActionIcon kind={action.kind} />{action.label}</Link>)}
    </nav> : null}

    <div className={styles.twoColumns}>
      <Card className={styles.section}>
        <h2>Datos del cliente</h2>
        <DetailFields items={[
          { label: "Teléfono", value: display(detail.client.phone) },
          { label: "Correo", value: display(detail.client.email) },
          { label: "Departamento", value: display(detail.client.department) },
          { label: "Ciudad o municipio", value: display(detail.client.city) },
          { label: "Dirección", value: display(detail.client.address) },
          { label: "Fecha de nacimiento", value: formatDate(detail.client.birthDate) },
        ]} />
      </Card>
      <Card className={styles.section}>
        <h2>Origen y equipo</h2>
        <DetailFields items={[
          { label: "Aliado", value: display(detail.assignment.ally) },
          { label: "Sede", value: display(detail.assignment.site) },
          { label: "Asesor responsable", value: display(detail.assignment.advisor) },
          { label: "Registrada por", value: display(detail.assignment.createdBy) },
          { label: "Referencia del equipo", value: display(detail.equipment.reference) },
          { label: "Plataforma", value: display(detail.equipment.platform) },
          { label: "IMEI", value: display(detail.equipment.imei) },
        ]} />
      </Card>
    </div>

    <Card className={styles.section}>
      <h2>Condiciones del crédito</h2>
      <DetailFields items={[
        { label: "Valor de venta", value: formatMoney(detail.financial.saleValue) },
        { label: "Inicial", value: formatMoney(detail.financial.downPayment) },
        { label: "Monto autorizado", value: formatMoney(detail.financial.authorizedAmount) },
        { label: "Número de cuotas", value: display(detail.financial.installments) },
        { label: "Valor de cuota", value: formatMoney(detail.financial.installment) },
        { label: "Frecuencia", value: display(detail.financial.frequency) },
        { label: "Primer pago", value: formatDate(detail.financial.firstPayment) },
      ]} />
    </Card>

    {detail.validations.length > 0 ? <Card className={styles.section}>
      <h2>Validaciones</h2>
      <ul className={styles.validations}>
        {detail.validations.map((validation) => <li key={validation.label}>
          <span>{validation.label}</span>
          <Badge tone={statusTone(validation.status || "")}>{formatStatus(validation.status)}</Badge>
        </li>)}
      </ul>
    </Card> : null}

    <Card className={styles.section}>
      <h2>Documentos y evidencias</h2>
      {detail.documents.length === 0 ? <EmptyState
        title="Sin documentos registrados"
        description="Los documentos y fotografías disponibles aparecerán aquí."
      /> : <ul className={styles.documents}>
        {detail.documents.map((document) => <li key={document.key}>
          <div className={styles.documentHeading}>
            <span><FileText size={18} aria-hidden="true" />{document.label}</span>
            <Badge tone={document.available && document.href ? "positive" : "neutral"}>
              {document.available && document.href ? "Disponible" : "Sin adjunto"}
            </Badge>
          </div>
          {document.available && document.href ? <>
            {!document.pdf ? <a href={document.href} target="_blank" rel="noopener noreferrer" className={styles.imageLink} aria-label={`Abrir ${document.label}`}>
              <Image
                src={document.href}
                alt={document.label}
                width={640}
                height={400}
                unoptimized
                className={styles.evidenceImage}
              />
            </a> : null}
            <a href={document.href} target="_blank" rel="noopener noreferrer" className="fp-ui-button is-secondary">
              <FolderOpen size={17} aria-hidden="true" />{document.pdf ? "Abrir documento" : "Abrir fotografía"}
            </a>
          </> : <p className={styles.missingDocument}>No hay un archivo disponible en esta solicitud.</p>}
        </li>)}
      </ul>}
    </Card>

    <Card className={styles.section}>
      <h2 className={styles.iconHeading}><History size={20} aria-hidden="true" />Historial de la solicitud</h2>
      {detail.timeline.length === 0 ? <EmptyState
        title="Sin movimientos adicionales"
        description="Las actualizaciones registradas aparecerán en este historial."
      /> : <ol className={styles.timeline}>
        {detail.timeline.map((event) => <li key={event.id}>
          <div className={styles.eventHeading}>
            <strong>{event.label}</strong>
            <span>{formatDate(event.at, true)}</span>
          </div>
          {event.status ? <Badge tone={statusTone(event.status)}>{formatStatus(event.status)}</Badge> : null}
          {event.detail ? <p>{event.detail}</p> : null}
          {event.actor ? <small>Usuario: {event.actor}</small> : null}
        </li>)}
      </ol>}
    </Card>
  </div>;
}