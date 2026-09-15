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
  CircleCheckBig,
  FileSearch,
  RefreshCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  PageHeader,
  StatusPill,
} from "@/app/_components/finser-ui";

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
};

type SuccessNotice = {
  alreadyAuthorized: boolean;
  documentLabel: string;
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
    <div className="min-w-0 border-t border-[var(--fp-border)] px-4 py-3 first:border-t-0 sm:border-l sm:[&:nth-child(-n+3)]:border-t-0 sm:[&:nth-child(3n+1)]:border-l-0">
      <dt className="text-xs font-bold text-[var(--fp-muted)]">{label}</dt>
      <dd className="mt-1 break-words font-black text-[var(--fp-graphite)]">
        {children}
      </dd>
    </div>
  );
}

export default function Tx06ReleaseConsole() {
  const [documentNumber, setDocumentNumber] = useState("");
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
    <main className="px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <div className="mx-auto max-w-[1180px] space-y-5">
        <PageHeader
          eyebrow="Administración central"
          title="Liberar consulta DataCrédito"
          description="Autoriza un nuevo intento únicamente cuando MiDecisor aceptó una consulta TX06 sin puntaje."
          actions={
            <Link
              href="/dashboard/datacredito"
              className="fp-ui-button is-secondary"
            >
              <FileSearch className="h-4 w-4" aria-hidden="true" />
              Ver historial
            </Link>
          }
        />

        <div
          role="note"
          className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-4 text-sm leading-6 text-[var(--fp-graphite)]"
        >
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-amber)]"
            aria-hidden="true"
          />
          <p>
            La liberación no cambia un rechazo, una aprobación ni un puntaje, y
            no consulta al proveedor en este momento. El vendedor deberá usar el
            primer apellido correcto y obtener un consentimiento nuevo; la
            próxima consulta consumirá el cupo normal.
          </p>
        </div>

        <Card className="p-5 sm:p-6">
          <section aria-labelledby="tx06-search-title">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="tx06-search-title" className="text-xl font-black">
                  Buscar consulta elegible
                </h2>
                <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                  La búsqueda es exacta y está disponible solo para la
                  administración central.
                </p>
              </div>
              <Badge tone="warning">Operación auditada</Badge>
            </div>

            <form
              className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
              onSubmit={searchDocument}
              noValidate
            >
              <label
                className="grid gap-2 text-sm font-bold"
                htmlFor="tx06-document"
              >
                Cédula exacta
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
                <span
                  id="tx06-document-help"
                  className="text-xs font-normal text-[var(--fp-muted)]"
                >
                  Ingresa todos los dígitos; la cédula no se incluye en la URL.
                </span>
              </label>
              <Button type="submit" disabled={searching || authorizing}>
                <Search className="h-4 w-4" aria-hidden="true" />
                {searching ? "Buscando..." : "Buscar"}
              </Button>
            </form>
          </section>
        </Card>

        {lookupError ? (
          <div
            ref={lookupErrorRef}
            id="tx06-lookup-error"
            role="alert"
            tabIndex={-1}
            className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm font-bold text-[var(--fp-danger)] outline-none"
          >
            <strong>Error de búsqueda:</strong> {lookupError}
          </div>
        ) : null}

        {mutationError ? (
          <div
            ref={mutationErrorRef}
            role="alert"
            tabIndex={-1}
            className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm font-bold text-[var(--fp-danger)] outline-none"
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
            className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime)] bg-[var(--fp-lime-soft)] px-4 py-4 text-sm leading-6 text-[var(--fp-graphite)] outline-none"
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
              No se hizo una consulta al proveedor ni se consumió cupo en esta
              operación.
            </p>
          </div>
        ) : null}

        <section aria-labelledby="tx06-result-title" aria-busy={searching}>
          {searching ? (
            <Card className="p-6">
              <LoadingState label="Buscando la consulta más reciente..." />
            </Card>
          ) : !lookupResult ? (
            <Card>
              <EmptyState
                title="Busca una cédula para comenzar"
                description="Mostraremos la consulta TX06 vigente y si puede habilitarse para un nuevo intento."
                action={
                  <RefreshCcw
                    className="mx-auto h-8 w-8 text-[var(--fp-muted)]"
                    aria-hidden="true"
                  />
                }
              />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="flex flex-col gap-4 border-b border-[var(--fp-border)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--fp-lime-strong)]">
                    Consulta encontrada
                  </p>
                  <h2 id="tx06-result-title" className="mt-2 text-2xl font-black">
                    {lookupResult.documentLabel}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--fp-muted)]">
                    {dateTime(lookupResult.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
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

              <dl className="grid bg-[var(--fp-surface)] sm:grid-cols-3">
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

              <div className="border-t border-[var(--fp-border)] px-5 py-5 sm:px-6">
                <div
                  id="tx06-action-help"
                  className={[
                    "rounded-[var(--fp-radius-md)] border px-4 py-3 text-sm leading-6",
                    lookupResult.alreadyAuthorized
                      ? "border-[var(--fp-lime)] bg-[var(--fp-lime-soft)]"
                      : lookupResult.eligible
                        ? "border-[var(--fp-amber)] bg-[var(--fp-amber-soft)]"
                        : "border-[var(--fp-border)] bg-[var(--fp-bg)] text-[var(--fp-muted)]",
                  ].join(" ")}
                >
                  <strong className="block text-[var(--fp-graphite)]">
                    {lookupResult.alreadyAuthorized
                      ? "Nuevo intento ya autorizado"
                      : lookupResult.eligible
                        ? "Puede autorizarse un nuevo intento"
                        : "Esta consulta no puede liberarse"}
                  </strong>
                  <span>{lookupResult.eligibilityMessage}</span>
                </div>

                {canAuthorize ? (
                  <form
                    className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end"
                    onSubmit={prepareAuthorization}
                    noValidate
                  >
                    <label
                      className="grid gap-2 text-sm font-bold"
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
                        className="text-xs font-normal leading-5 text-[var(--fp-muted)]"
                      >
                        Debe coincidir con el documento. El vendedor lo revisará
                        antes de solicitar el consentimiento nuevo.
                      </span>
                      {surnameError ? (
                        <span
                          id="tx06-surname-error"
                          role="alert"
                          className="text-sm font-semibold text-[var(--fp-danger)]"
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
            ? `Vas a liberar ${pendingAuthorization.documentLabel} usando el primer apellido “${pendingAuthorization.firstSurname}”. Esta autorización aplica solo al TX06 sin puntaje: no cambia un rechazo ni un puntaje y no consulta al proveedor ahora. La próxima consulta requerirá consentimiento nuevo y consumirá el cupo normal.`
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
