"use client";

import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  CircleCheckBig,
  FileSearch,
  LockKeyholeOpen,
  Search,
  ShieldCheck,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge,
  Button,
  Card,
  Input,
  LoadingState,
  PageHeader,
  StatusPill,
} from "@/app/_components/finser-ui";
import styles from "./tx06-release-console.module.css";

type ReleaseActor = {
  userName: string | null;
  sellerName: string | null;
  sedeName: string | null;
  aliadoName: string | null;
};

type ReleaseLookupResult = {
  assessmentId: string;
  documentLabel: string;
  eligible: boolean;
  eligibilityMessage: string;
  alreadyAuthorized: boolean;
  status: string;
  errorCode: string | null;
  providerStatus: string | null;
  transactionCode: string | null;
  platform: string;
  createdAt: string | null;
  expiresAt: string | null;
  actor: ReleaseActor;
  draftId: number | null;
  authorizedAt: string | null;
  requiresNewSolicitud: boolean;
};

type ReleaseMutationResult = Partial<ReleaseLookupResult> & {
  actor?: ReleaseActor;
};

type ApiPayload<T> = {
  ok?: boolean;
  result?: T;
  error?: string;
  code?: string;
  correlationId?: string;
};

type PendingAuthorization = {
  assessmentId: string;
  documentLabel: string;
  documentNumber: string;
  firstSurname: string;
  mutationId: string;
  requiresNewSolicitud: boolean;
};

type SuccessNotice = {
  alreadyAuthorized: boolean;
  documentLabel: string;
  requiresNewSolicitud: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;
const LOOKUP_ENDPOINT = "/api/creditos/datacredito/admin/liberaciones/buscar";

function onlyDigits(value: string) {
  return value.replace(/\D/g, "").slice(0, 13);
}

function normalizeSurname(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function displayText(value: string | null | undefined) {
  return String(value || "").trim() || "No informado";
}

function dateTime(value: string | null | undefined) {
  if (!value) return "No informado";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No informado";
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

function humanStatus(value: string | null | undefined) {
  const normalized = String(value || "").trim().toUpperCase();
  const labels: Record<string, string> = {
    APROBADO: "Aprobado",
    RECHAZADO: "Rechazado",
    NO_EVALUADO: "No evaluado",
    PENDING: "En proceso",
  };
  return labels[normalized] || displayText(value);
}

function statusTone(value: string) {
  if (value === "APROBADO") return "positive" as const;
  if (value === "RECHAZADO") return "danger" as const;
  if (value === "NO_EVALUADO" || value === "PENDING") {
    return "warning" as const;
  }
  return "neutral" as const;
}

function transactionLabel(value: string | null | undefined) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "No informado";
  return normalized.startsWith("TX") ? normalized : `TX${normalized}`;
}

function platformLabel(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase() === "IPHONE"
    ? "iPhone"
    : displayText(value);
}

function apiErrorMessage<T>(payload: ApiPayload<T>, fallback: string) {
  const message = String(payload.error || "").trim() || fallback;
  const tracking = String(payload.correlationId || "").trim();
  return tracking ? `${message} Código de seguimiento: ${tracking}.` : message;
}

async function postForResult<T>(
  endpoint: string,
  body: Record<string, unknown>,
  messages: { fallback: string; network: string; timeout: string }
) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(messages.timeout);
    }
    throw new Error(messages.network);
  } finally {
    window.clearTimeout(timeoutId);
  }

  const payload = (await response.json().catch(() => ({}))) as ApiPayload<T>;
  if (!response.ok || payload.ok !== true || !payload.result) {
    throw new Error(apiErrorMessage(payload, messages.fallback));
  }
  return payload.result;
}

function DetailValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.detailValue}>
      <dt>{label}</dt>
      <dd>
        {children}
      </dd>
    </div>
  );
}

export default function Tx06ReleaseConsole({
  mode = "admin",
  initialDocument = "",
}: {
  mode?: "admin" | "analyst";
  initialDocument?: string;
} = {}) {
  const analystMode = mode === "analyst";
  const [documentNumber, setDocumentNumber] = useState(initialDocument);
  const [searchedDocument, setSearchedDocument] = useState("");
  const [firstSurname, setFirstSurname] = useState("");
  const [surnameError, setSurnameError] = useState("");
  const [lookupResult, setLookupResult] =
    useState<ReleaseLookupResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [successNotice, setSuccessNotice] = useState<SuccessNotice | null>(null);
  const [pendingAuthorization, setPendingAuthorization] =
    useState<PendingAuthorization | null>(null);
  const submittingRef = useRef(false);
  const lastMutationRef = useRef<{
    signature: string;
    mutationId: string;
  } | null>(null);
  const lookupSequenceRef = useRef(0);
  const lookupErrorRef = useRef<HTMLDivElement>(null);
  const mutationErrorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (successNotice) {
      successRef.current?.focus();
      return;
    }
    if (mutationError) {
      mutationErrorRef.current?.focus();
      return;
    }
    if (lookupError) lookupErrorRef.current?.focus();
  }, [lookupError, mutationError, successNotice]);

  function resetResultForDocument(nextDocument: string) {
    setDocumentNumber(nextDocument);
    if (nextDocument === searchedDocument) return;
    lookupSequenceRef.current += 1;
    setLookupResult(null);
    setFirstSurname("");
    setSurnameError("");
    setLookupError("");
    setMutationError("");
    setSuccessNotice(null);
    setPendingAuthorization(null);
    lastMutationRef.current = null;
  }

  async function searchDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searching || authorizing) return;

    const normalizedDocument = onlyDigits(documentNumber);
    if (!/^\d{3,13}$/.test(normalizedDocument)) {
      setLookupError("Ingresa una cédula válida de 3 a 13 dígitos.");
      setLookupResult(null);
      return;
    }

    const sequence = ++lookupSequenceRef.current;
    setDocumentNumber(normalizedDocument);
    setSearchedDocument(normalizedDocument);
    setLookupResult(null);
    setFirstSurname("");
    setSurnameError("");
    setLookupError("");
    setMutationError("");
    setSuccessNotice(null);
    setPendingAuthorization(null);
    lastMutationRef.current = null;
    setSearching(true);

    try {
      const result = await postForResult<ReleaseLookupResult>(
        LOOKUP_ENDPOINT,
        { documentNumber: normalizedDocument },
        {
          fallback: "No se pudo buscar la consulta DataCrédito.",
          network: "No fue posible conectar con el servicio de búsqueda.",
          timeout:
            "La búsqueda tardó más de 15 segundos. Intenta nuevamente.",
        }
      );
      if (sequence !== lookupSequenceRef.current) return;
      setLookupResult(result);
    } catch (error) {
      if (sequence !== lookupSequenceRef.current) return;
      setLookupError(
        error instanceof Error
          ? error.message
          : "No se pudo buscar la consulta DataCrédito."
      );
    } finally {
      if (sequence === lookupSequenceRef.current) setSearching(false);
    }
  }

  function prepareAuthorization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookupResult?.eligible || lookupResult.alreadyAuthorized || authorizing) {
      return;
    }

    const normalizedFirstSurname = normalizeSurname(firstSurname);
    if (!normalizedFirstSurname) {
      setSurnameError(
        "Ingresa el primer apellido correcto antes de liberar la consulta."
      );
      return;
    }

    const signature = [
      lookupResult.assessmentId,
      searchedDocument,
      normalizedFirstSurname.toLocaleUpperCase("es-CO"),
    ].join(":");
    if (lastMutationRef.current?.signature !== signature) {
      lastMutationRef.current = {
        signature,
        mutationId: crypto.randomUUID(),
      };
    }

    setFirstSurname(normalizedFirstSurname);
    setSurnameError("");
    setMutationError("");
    setPendingAuthorization({
      assessmentId: lookupResult.assessmentId,
      documentLabel: lookupResult.documentLabel,
      documentNumber: searchedDocument,
      firstSurname: normalizedFirstSurname,
      mutationId: lastMutationRef.current.mutationId,
      requiresNewSolicitud: lookupResult.requiresNewSolicitud,
    });
  }

  async function authorizeRetry() {
    const pending = pendingAuthorization;
    if (!pending || submittingRef.current) return;

    submittingRef.current = true;
    setAuthorizing(true);
    setMutationError("");

    try {
      const result = await postForResult<ReleaseMutationResult>(
        `/api/creditos/datacredito/admin/evaluaciones/${encodeURIComponent(
          pending.assessmentId
        )}/autorizar-reintento`,
        {
          documentNumber: pending.documentNumber,
          firstSurname: pending.firstSurname,
          mutationId: pending.mutationId,
        },
        {
          fallback: "No se pudo autorizar el nuevo intento.",
          network: "No fue posible conectar con el servicio de liberación.",
          timeout:
            "No se recibió confirmación de la liberación en 15 segundos. Reintenta: se conservará el mismo identificador para evitar duplicados.",
        }
      );

      const wasAlreadyAuthorized = result.alreadyAuthorized === true;
      setLookupResult((current) => {
        if (!current || current.assessmentId !== pending.assessmentId) {
          return current;
        }
        return {
          ...current,
          ...result,
          actor: result.actor || current.actor,
          eligible: false,
          alreadyAuthorized: true,
          eligibilityMessage:
            result.eligibilityMessage ||
            "Esta consulta ya fue liberada para un nuevo intento.",
        } as ReleaseLookupResult;
      });
      setSuccessNotice({
        alreadyAuthorized: wasAlreadyAuthorized,
        documentLabel: result.documentLabel || pending.documentLabel,
        requiresNewSolicitud:
          result.requiresNewSolicitud ?? pending.requiresNewSolicitud,
      });
      setFirstSurname("");
      setSurnameError("");
      setPendingAuthorization(null);
    } catch (error) {
      setPendingAuthorization(null);
      setMutationError(
        error instanceof Error
          ? error.message
          : "No se pudo autorizar el nuevo intento."
      );
    } finally {
      submittingRef.current = false;
      setAuthorizing(false);
    }
  }

  function cancelConfirmation() {
    if (authorizing || submittingRef.current) return;
    setPendingAuthorization(null);
    window.setTimeout(() => {
      document.getElementById("tx06-first-surname")?.focus();
    }, 0);
  }

  const canAuthorize = Boolean(
    lookupResult?.eligible && !lookupResult.alreadyAuthorized
  );
  const eligibilityTone = lookupResult?.alreadyAuthorized
    ? ("positive" as const)
    : lookupResult?.eligible
      ? ("warning" as const)
      : ("neutral" as const);
  const actorName = lookupResult
    ? lookupResult.actor.sellerName || lookupResult.actor.userName
    : null;
  const actorContext = lookupResult
    ? [lookupResult.actor.aliadoName, lookupResult.actor.sedeName]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <PageHeader
          eyebrow={analystMode ? "Aprobaciones" : "Administración central"}
          title="Liberar consulta DataCrédito"
          description="Revisa una consulta y autoriza un nuevo intento."
          actions={
            analystMode ? undefined : <Link
              href="/dashboard/datacredito"
              className="fp-ui-button is-secondary"
            >
              <FileSearch className="h-4 w-4" aria-hidden="true" />
              Ver historial
            </Link>
          }
        />

        <div className={styles.scopeBar}>
          <span><ShieldCheck size={17} aria-hidden="true" />Operación auditada</span>
          <Badge tone="neutral">Solo TX06 sin puntaje</Badge>
        </div>

        <Card className={styles.searchCard}>
          <section className={styles.searchIntro} aria-labelledby="tx06-search-title">
            <span className={styles.searchIcon}><FileSearch size={27} aria-hidden="true" /></span>
            <div>
              <h2 id="tx06-search-title">Buscar consulta</h2>
              <p>Ingresa la cédula exacta del titular.</p>
            </div>
          </section>

            <form
              className={styles.searchForm}
              onSubmit={searchDocument}
              noValidate
            >
              <label htmlFor="tx06-document">Cédula exacta</label>
              <div className={styles.searchControls}>
                <Input
                  id="tx06-document"
                  type="search"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={13}
                  value={documentNumber}
                  onChange={(event) =>
                    resetResultForDocument(onlyDigits(event.target.value))
                  }
                  placeholder="Número de cédula"
                  disabled={searching || authorizing}
                  aria-invalid={Boolean(lookupError)}
                  aria-describedby={
                    lookupError ? "tx06-lookup-error" : "tx06-document-help"
                  }
                />
              <Button type="submit" disabled={searching || authorizing}>
                <Search className="h-4 w-4" aria-hidden="true" />
                {searching ? "Buscando..." : "Buscar"}
              </Button>
              </div>
              <span id="tx06-document-help" className={styles.searchHelp}>
                Búsqueda exacta. La cédula no se incluye en la URL.
              </span>
            </form>
        </Card>

        <div className={styles.policyNote} role="note">
          <AlertTriangle size={19} aria-hidden="true" />
          <div>
            <p><strong>La próxima consulta requiere consentimiento nuevo y consume cupo normal.</strong></p>
            <details>
              <summary>Condiciones de liberación<ChevronDown size={16} aria-hidden="true" /></summary>
              <p>Autoriza un nuevo intento únicamente cuando MiDecisor aceptó una consulta TX06 sin puntaje.</p>
              <p>
                La liberación no cambia un rechazo, una aprobación ni un puntaje, y
                no consulta al proveedor en este momento. El vendedor deberá usar el
                primer apellido correcto y obtener un consentimiento nuevo; la
                próxima consulta consumirá el cupo normal.
              </p>
              <p>{analystMode
                ? "Cada liberación queda asociada a tu usuario."
                : "Disponible solo para la administración central."}</p>
            </details>
          </div>
        </div>

        {lookupError ? (
          <div
            ref={lookupErrorRef}
            id="tx06-lookup-error"
            role="alert"
            tabIndex={-1}
            className={styles.errorNotice}
          >
            <strong>Error de búsqueda:</strong> {lookupError}
          </div>
        ) : null}

        {mutationError ? (
          <div
            ref={mutationErrorRef}
            role="alert"
            tabIndex={-1}
            className={styles.errorNotice}
          >
            <strong>Error de liberación:</strong> {mutationError}
          </div>
        ) : null}

        {successNotice ? (
          <div
            ref={successRef}
            role="status"
            aria-live="polite"
            tabIndex={-1}
            className={styles.successNotice}
          >
            <CircleCheckBig
              className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
              aria-hidden="true"
            />
            <p>
              <strong>
                {successNotice.alreadyAuthorized
                  ? "La consulta ya estaba liberada."
                  : `${successNotice.documentLabel} quedó habilitada para un nuevo intento.`}
              </strong>{" "}
              {successNotice.requiresNewSolicitud
                ? "Cree una solicitud nueva y obtenga un consentimiento nuevo. Las solicitudes desistidas permanecen cerradas. "
                : "Retome la solicitud original para realizar la consulta nuevamente. "}
              No se hizo una consulta al proveedor ni se consumió cupo en esta operación.
            </p>
          </div>
        ) : null}

        <section className={styles.results} aria-labelledby="tx06-result-title" aria-busy={searching}>
          {searching ? (
            <Card className={styles.loadingCard}>
              <h2 id="tx06-result-title" className={styles.resultTitle}>Resultado de consulta</h2>
              <LoadingState label="Buscando la consulta más reciente..." />
            </Card>
          ) : !lookupResult ? (
            <Card className={styles.emptyCard}>
              <h2 id="tx06-result-title" className={styles.resultTitle}>Resultado de consulta</h2>
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon}><FileSearch size={38} strokeWidth={1.5} aria-hidden="true" /></span>
                <h3>Busca una cédula para comenzar</h3>
                <p>Verás la consulta vigente y si permite autorizar un nuevo intento.</p>
                <span className={styles.emptyNote}><ShieldCheck size={16} aria-hidden="true" />Buscar no realiza una nueva consulta al proveedor.</span>
              </div>
            </Card>
          ) : (
            <Card className={styles.resultCard}>
              <div className={styles.resultHeader}>
                <div>
                  <p className={styles.eyebrow}>Consulta encontrada</p>
                  <h2 id="tx06-result-title">
                    {lookupResult.documentLabel}
                  </h2>
                  <p className={styles.resultDate}>
                    {dateTime(lookupResult.createdAt)}
                  </p>
                </div>
                <div className={styles.resultStatuses}>
                  <StatusPill tone={statusTone(lookupResult.status)}>
                    {humanStatus(lookupResult.status)}
                  </StatusPill>
                  <StatusPill tone={eligibilityTone}>
                    {lookupResult.alreadyAuthorized
                      ? "Liberación autorizada"
                      : lookupResult.eligible
                        ? "Elegible"
                        : "No elegible"}
                  </StatusPill>
                </div>
              </div>

              <dl className={styles.detailGrid}>
                <DetailValue label="Respuesta">
                  {transactionLabel(lookupResult.transactionCode)}
                </DetailValue>
                <DetailValue label="Estado del proveedor">
                  {displayText(lookupResult.providerStatus)}
                </DetailValue>
                <DetailValue label="Código interno">
                  {displayText(lookupResult.errorCode)}
                </DetailValue>
                <DetailValue label="Plataforma">
                  {platformLabel(lookupResult.platform)}
                </DetailValue>
                <DetailValue label="Consultó">
                  {displayText(actorName)}
                </DetailValue>
                <DetailValue label="Aliado y sede">
                  {displayText(actorContext)}
                </DetailValue>
                <DetailValue label="Solicitud">
                  {lookupResult.draftId ? `#${lookupResult.draftId}` : "No vinculada"}
                </DetailValue>
                <DetailValue label="Vigencia original">
                  {dateTime(lookupResult.expiresAt)}
                </DetailValue>
                <DetailValue label="Liberada">
                  {dateTime(lookupResult.authorizedAt)}
                </DetailValue>
              </dl>

              <div className={styles.authorization}>
                <div
                  id="tx06-action-help"
                  className={styles.eligibility}
                  data-tone={lookupResult.alreadyAuthorized ? "positive" : lookupResult.eligible ? "warning" : "neutral"}
                >
                  {lookupResult.alreadyAuthorized ? <CircleCheckBig size={20} aria-hidden="true" /> : <LockKeyholeOpen size={20} aria-hidden="true" />}
                  <div><strong>
                    {lookupResult.alreadyAuthorized
                      ? "Nuevo intento ya autorizado"
                      : lookupResult.eligible
                        ? "Puede autorizarse un nuevo intento"
                        : "Esta consulta no puede liberarse"}
                  </strong><p>{lookupResult.eligibilityMessage}</p></div>
                </div>

                {canAuthorize ? (
                  <form
                    className={styles.authorizationForm}
                    onSubmit={prepareAuthorization}
                    noValidate
                  >
                    <label
                      className={styles.surnameField}
                      htmlFor="tx06-first-surname"
                    >
                      Primer apellido correcto
                      <Input
                        id="tx06-first-surname"
                        value={firstSurname}
                        onChange={(event) => {
                          setFirstSurname(event.target.value.slice(0, 80));
                          setSurnameError("");
                          setMutationError("");
                        }}
                        autoComplete="off"
                        maxLength={80}
                        placeholder="Primer apellido del titular"
                        disabled={authorizing}
                        aria-invalid={Boolean(surnameError)}
                        aria-describedby={
                          surnameError
                            ? "tx06-surname-help tx06-surname-error"
                            : "tx06-surname-help"
                        }
                      />
                      <span
                        id="tx06-surname-help"
                        className={styles.fieldHelp}
                      >
                        Debe coincidir con el documento. El vendedor lo revisará
                        antes de solicitar el consentimiento nuevo.
                      </span>
                      {surnameError ? (
                        <span
                          id="tx06-surname-error"
                          role="alert"
                          className={styles.fieldError}
                        >
                          {surnameError}
                        </span>
                      ) : null}
                    </label>
                    <Button
                      type="submit"
                      disabled={authorizing}
                      aria-describedby="tx06-action-help"
                    >
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      Revisar liberación
                    </Button>
                  </form>
                ) : null}
              </div>
            </Card>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(pendingAuthorization)}
        title="Autorizar nuevo intento DataCrédito"
        description={
          pendingAuthorization
            ? `Vas a liberar ${pendingAuthorization.documentLabel} usando el primer apellido “${pendingAuthorization.firstSurname}”. Esta autorización aplica solo al TX06 sin puntaje: no cambia un rechazo ni un puntaje y no consulta al proveedor ahora. ${pendingAuthorization.requiresNewSolicitud ? "Las solicitudes desistidas permanecerán cerradas y deberá crearse una solicitud nueva. " : "La solicitud original quedará lista para retomarse. "}La próxima consulta requerirá consentimiento nuevo y consumirá el cupo normal.`
            : "Confirma la liberación de la consulta TX06."
        }
        confirmLabel="Autorizar nuevo intento"
        busy={authorizing}
        onCancel={cancelConfirmation}
        onConfirm={() => void authorizeRetry()}
      />
    </main>
  );
}
