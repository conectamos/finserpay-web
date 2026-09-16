"use client";

import Image from "next/image";
import Link from "next/link";
import {
  FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  IdCard,
  RotateCw,
  ShieldCheck,
  Smartphone,
  UserRound,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
  LoadingState,
  StatusPill,
} from "@/app/_components/finser-ui";
import {
  DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT,
  DATACREDITO_MAX_INSTALLMENT_COUNT,
} from "@/lib/datacredito/policy";
import { resolveMissingAssessmentGateView } from "@/lib/datacredito/resume-gate";
import { CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE, hasCurrentCreditOriginationTerms } from "@/lib/credit-current-origination-terms";
import DataCreditoDailyQuotaModal from "./datacredito-daily-quota-modal";
import styles from "./datacredito-prequalification-gate.module.css";

export type DataCreditoPlatform = "ANDROID" | "IPHONE";

export type DataCreditoOffer = {
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
  installmentCount: number;
  maxInstallmentAmount: number | null;
  policyVersion?: number;
  [key: string]: unknown;
};

export type DataCreditoApprovedResult = {
  platform: DataCreditoPlatform;
  solicitudId: number | null;
  assessmentId: string;
  documentNumber: string;
  firstSurname: string;
  offer: DataCreditoOffer;
  expiresAt: string;
};

export type DatacreditoPrequalificationGateProps = {
  platform: DataCreditoPlatform;
  initialAssessmentId?: string | null;
  initialSolicitudId?: number | null;
  initialDocumentNumber?: string | null;
  initialFirstSurname?: string | null;
  initialErrorCode?: string | null;
  onBypass: () => void;
  onApproved: (result: DataCreditoApprovedResult) => void;
  onAssessmentInvalidated?: () => void;
};

type GateView =
  | "loading"
  | "ready"
  | "submitting"
  | "rejected"
  | "active-request"
  | "seller-session-required"
  | "daily-limit-reached"
  | "unavailable"
  | "technical-error"
  | "approved"
  | "bypassing";

type FormErrors = {
  consent?: string;
  documentNumber?: string;
  firstSurname?: string;
};

type JsonRecord = Record<string, unknown>;

type PolicyResponse = {
  ok?: boolean;
  enabled?: boolean;
  configured?: boolean;
  hasPolicy?: boolean;
  correlationId?: string;
  provider?: {
    configured?: boolean;
  };
  consent?: {
    text?: string;
  };
  policy?: {
    version?: number;
  } | null;
};

type AssessmentFallback = {
  platform?: DataCreditoPlatform;
  solicitudId?: number | null;
  assessmentId?: string;
  documentNumber?: string;
  firstSurname?: string;
};

type DailyQueryLimitReached = {
  limit: number | null;
  used: number;
  remaining: number | null;
  percentUsed: number | null;
  exhausted: boolean;
  resetsAt: string;
};

const CONSENT_ATTESTATION =
  "Confirmo que el titular, antes de esta consulta, autorizó de manera previa, expresa e informada a FINSER PAY S.A.S. para consultar su información crediticia y financiera en DataCrédito Experian con el fin de evaluar esta solicitud de financiación.";

const subscribeToBrowserReady = () => () => undefined;
const getBrowserReadySnapshot = () => true;
const getServerReadySnapshot = () => false;

type ResultDialogShellProps = {
  labelledBy: string;
  describedBy: string;
  dialogRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
};

function ResultDialogShell({
  labelledBy,
  describedBy,
  dialogRef,
  children,
}: ResultDialogShellProps) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fp-ui-dialog-backdrop overflow-y-auto overscroll-contain"
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-3xl outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPlatform(value: unknown): DataCreditoPlatform | null {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "ANDROID" || normalized === "IPHONE"
    ? normalized
    : null;
}

function getCorrelationId(payload: unknown, response?: Response) {
  const body = isRecord(payload) ? payload : null;
  const nestedError = body && isRecord(body.error) ? body.error : null;

  return (
    readString(body?.correlationId) ||
    readString(nestedError?.correlationId) ||
    response?.headers.get("x-correlation-id") ||
    response?.headers.get("x-request-id") ||
    null
  );
}

function getResponseCode(payload: unknown) {
  const body = isRecord(payload) ? payload : null;
  const nestedError = body && isRecord(body.error) ? body.error : null;

  return (
    readString(body?.code) ||
    readString(nestedError?.code) ||
    ""
  ).toUpperCase();
}

async function readJson(response: Response): Promise<JsonRecord> {
  const payload = (await response.json().catch(() => null)) as unknown;
  return isRecord(payload) ? payload : {};
}

function normalizeApprovedAssessment(
  payload: JsonRecord,
  fallback: AssessmentFallback = {}
): DataCreditoApprovedResult | null {
  const source = isRecord(payload.assessment) ? payload.assessment : payload;
  const offerSource = isRecord(source.offer)
    ? source.offer
    : isRecord(payload.offer)
      ? payload.offer
      : null;

  if (!offerSource) return null;

  const assessmentId =
    readString(source.assessmentId) ||
    readString(source.id) ||
    readString(payload.assessmentId) ||
    fallback.assessmentId ||
    null;
  const solicitudIdValue =
    readNumber(source.solicitudId) ??
    readNumber(payload.solicitudId) ??
    fallback.solicitudId ??
    null;
  const solicitudId =
    solicitudIdValue !== null &&
    Number.isInteger(solicitudIdValue) &&
    solicitudIdValue > 0
      ? solicitudIdValue
      : null;
  const documentNumber =
    readString(source.documentNumber) ||
    readString(payload.documentNumber) ||
    fallback.documentNumber ||
    null;
  const firstSurname =
    readString(source.firstSurname) ||
    readString(payload.firstSurname) ||
    fallback.firstSurname ||
    null;
  const platform =
    readPlatform(source.platform) ||
    readPlatform(payload.platform) ||
    fallback.platform ||
    null;
  const expiresAt =
    readString(source.expiresAt) || readString(payload.expiresAt) || null;
  const initialPaymentPercentage = readNumber(
    offerSource.initialPaymentPercentage
  );
  const suretyPercentage = readNumber(offerSource.suretyPercentage);
  const maxFinancedAmount = readNumber(offerSource.maxFinancedAmount);
  const installmentCount = readNumber(offerSource.installmentCount);
  const maxInstallmentAmount = readNumber(offerSource.maxInstallmentAmount);
  const validMaxFinancedAmount =
    Number.isSafeInteger(maxFinancedAmount) && Number(maxFinancedAmount) > 0;
  const validInstallmentCount =
    Number.isSafeInteger(installmentCount) &&
    Number(installmentCount) >= 1 &&
    Number(installmentCount) <= DATACREDITO_MAX_INSTALLMENT_COUNT;
  const validMaxInstallmentAmount =
    maxInstallmentAmount === null ||
    (Number.isSafeInteger(maxInstallmentAmount) &&
      Number(maxInstallmentAmount) > 0 &&
      Number(maxInstallmentAmount) <= DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT);

  if (
    !assessmentId ||
    !documentNumber ||
    !firstSurname ||
    !platform ||
    !expiresAt ||
    initialPaymentPercentage === null ||
    suretyPercentage === null ||
    !validMaxFinancedAmount ||
    !validInstallmentCount ||
    !validMaxInstallmentAmount
  ) {
    return null;
  }

  const policyVersion = readNumber(offerSource.policyVersion);

  return {
    platform,
    solicitudId,
    assessmentId,
    documentNumber,
    firstSurname,
    expiresAt,
    offer: {
      ...offerSource,
      initialPaymentPercentage,
      suretyPercentage,
      ...(policyVersion === null ? {} : { policyVersion }),
      maxFinancedAmount: Number(maxFinancedAmount),
      installmentCount: Number(installmentCount),
      maxInstallmentAmount:
        maxInstallmentAmount === null ? null : Number(maxInstallmentAmount),
    },
  };
}

function normalizeDecision(payload: JsonRecord) {
  const source = isRecord(payload.assessment) ? payload.assessment : payload;
  const value = String(source.status ?? source.decision ?? payload.status ?? "")
    .trim()
    .toUpperCase();

  if (value === "APROBADO" || value === "APPROVED") return "APROBADO";
  if (value === "RECHAZADO" || value === "REJECTED") return "RECHAZADO";
  return null;
}

function normalizeDailyQueryLimitReached(
  payload: JsonRecord
): DailyQueryLimitReached | null {
  if (!isRecord(payload.dailyQuota)) return null;
  const source = payload.dailyQuota;
  const readNonNegativeInteger = (value: unknown) => {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;
  };
  const limit = readNonNegativeInteger(source.limit);
  const used = readNonNegativeInteger(source.used);
  const remaining = readNonNegativeInteger(source.remaining);
  const percentUsed = readNonNegativeInteger(source.percentUsed);
  const resetsAt = readString(source.resetsAt);
  if (
    used === null || !resetsAt || !Number.isFinite(Date.parse(resetsAt)) ||
    typeof source.exhausted !== "boolean"
  ) return null;
  if (source.limit === null) {
    if (source.remaining !== null || source.percentUsed !== null || source.exhausted) return null;
  } else if (
    limit === null || remaining === null || percentUsed === null || percentUsed > 100 ||
    (source.exhausted && (percentUsed !== 100 || remaining !== 0 || used < limit)) ||
    (!source.exhausted && (percentUsed >= 100 || remaining <= 0 || used >= limit))
  ) return null;
  // El porcentaje y el agotamiento vienen del servidor, nunca del reloj ni de
  // un contador local. Una respuesta incompleta no se presenta como cupo agotado.
  return {
    limit, used, remaining, percentUsed,
    exhausted: source.exhausted,
    resetsAt,
  };
}

function formatDailyQueryLimitReset(value: string | null) {
  if (!value) return "al iniciar el siguiente día";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "al iniciar el siguiente día";
  }

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

function isRecoverableInitialAssessmentFailure(
  response: Response,
  payload: JsonRecord
) {
  const code = String(payload.code || "").trim().toUpperCase();

  // Reabrir una solicitud nunca debe convertir inconsistencias de identidad,
  // plataforma o consumo en una consulta nueva. Solo una expiración explícita
  // habilita al asesor para volver a consultar.
  return (
    code === "ASSESSMENT_EXPIRED" &&
    [409, 410, 422].includes(response.status)
  );
}

function formatPercentage(value: number) {
  return `${new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 2,
  }).format(value)} %`;
}

function formatMoney(value: number) {
  return `$ ${new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 0,
  }).format(value)}`;
}

function TechnicalErrorPanel({
  correlationId,
  consumedCreditId,
  onRetry,
}: {
  correlationId: string | null;
  consumedCreditId: number | null;
  onRetry: () => void;
}) {
  if (consumedCreditId) {
    return (
      <Card
        className='border-[var(--fp-lime)] p-6 sm:p-8'
        role='status'
        aria-labelledby='datacredito-consumed-title'
      >
        <div className='flex items-start gap-4'>
          <span
            className='grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]'
            aria-hidden='true'
          >
            <CheckCircle2 className='h-5 w-5' />
          </span>
          <div className='min-w-0'>
            <h2
              id='datacredito-consumed-title'
              className='text-xl font-black text-[var(--fp-graphite)]'
            >
              El crédito ya fue creado
            </h2>
            <p className='mt-2 text-sm leading-6 text-[var(--fp-muted)]'>
              Esta precalificación ya se usó en el crédito #{consumedCreditId}.
              No realices una nueva consulta.
            </p>
          </div>
        </div>
        <Link
          href='/dashboard/creditos'
          className='fp-ui-button is-secondary mt-6 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]'
        >
          Ir a créditos
        </Link>
      </Card>
    );
  }

  return (
    <Card
      className="border-[var(--fp-danger)] p-6 sm:p-8"
      role="alert"
      aria-labelledby="datacredito-technical-error-title"
    >
      <div className="flex items-start gap-4">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]"
          aria-hidden="true"
        >
          <CircleAlert className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2
            id="datacredito-technical-error-title"
            className="text-xl font-black text-[var(--fp-graphite)]"
          >
            No se pudo evaluar
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
            Ocurrió un inconveniente técnico. Esta situación no significa que la
            solicitud haya sido rechazada.
          </p>
          {correlationId ? (
            <p className="mt-3 break-all text-xs text-[var(--fp-muted)]">
              Código de seguimiento: <code>{correlationId}</code>
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button variant="secondary" onClick={onRetry}>
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Intentar de nuevo
        </Button>
        <Link
          href="/dashboard/creditos?mode=create-client"
          className="fp-ui-button is-ghost focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Volver a créditos
        </Link>
      </div>
    </Card>
  );
}

export default function DatacreditoPrequalificationGate({
  platform,
  initialAssessmentId = null,
  initialSolicitudId = null,
  initialDocumentNumber = null,
  initialFirstSurname = null,
  initialErrorCode = null,
  onBypass,
  onApproved,
  onAssessmentInvalidated,
}: DatacreditoPrequalificationGateProps) {
  const normalizedInitialDocument = String(initialDocumentNumber || "")
    .replace(/\D/g, "")
    .slice(0, 13);
  const normalizedInitialSurname = String(initialFirstSurname || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const normalizedInitialErrorCode = String(initialErrorCode || "")
    .trim()
    .toUpperCase();
  const identityMismatchRecovery = Boolean(
    initialSolicitudId &&
      !initialAssessmentId &&
      normalizedInitialDocument &&
      normalizedInitialErrorCode === "ASSESSMENT_IDENTITY_MISMATCH"
  );
  const financialTermsRecovery = normalizedInitialErrorCode === CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE;
  const newQueryRetryRecovery = Boolean(
    initialSolicitudId &&
      !initialAssessmentId &&
      normalizedInitialDocument &&
      normalizedInitialSurname &&
      (normalizedInitialErrorCode === "RATE_LIMITED" ||
        normalizedInitialErrorCode === "ALLY_DAILY_QUERY_LIMIT_REACHED" ||
        normalizedInitialErrorCode === "ASSESSMENT_RETRY_AUTHORIZED")
  );
  const [view, setView] = useState<GateView>("loading");
  const [documentNumber, setDocumentNumber] = useState(
    normalizedInitialDocument
  );
  const [firstSurname, setFirstSurname] = useState(normalizedInitialSurname);
  const [lastInitialIdentity, setLastInitialIdentity] = useState(() => ({
    platform,
    assessmentId: initialAssessmentId,
    solicitudId: initialSolicitudId,
    documentNumber: normalizedInitialDocument,
    firstSurname: normalizedInitialSurname,
    errorCode: normalizedInitialErrorCode,
  }));
  const [consentText, setConsentText] = useState(CONSENT_ATTESTATION);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [financialReuseUnavailable, setFinancialReuseUnavailable] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [consumedCreditId, setConsumedCreditId] = useState<number | null>(null);
  const [dailyQueryLimitReached, setDailyQueryLimitReached] =
    useState<DailyQueryLimitReached | null>(null);
  const [dailyQuotaModalOpen, setDailyQuotaModalOpen] = useState(false);
  const [checkingDailyQuota, setCheckingDailyQuota] = useState(false);
  const [dailyQuotaCheckError, setDailyQuotaCheckError] = useState<string | null>(null);
  const quotaRefreshAbortRef = useRef<AbortController | null>(null);
  const submissionInFlightRef = useRef(false);
  const [retryMode, setRetryMode] = useState<"bootstrap" | "form">("bootstrap");
  const [approvedResult, setApprovedResult] =
    useState<DataCreditoApprovedResult | null>(null);
  const bypassCalledRef = useRef(false);
  const approvedAssessmentIdsRef = useRef(new Set<string>());
  const expiredRequerySolicitudIdRef = useRef<number | null>(null);
  const onBypassRef = useRef(onBypass);
  const onApprovedRef = useRef(onApproved);
  const onAssessmentInvalidatedRef = useRef(onAssessmentInvalidated);
  const approvedHeadingRef = useRef<HTMLHeadingElement>(null);
  const rejectedHeadingRef = useRef<HTMLHeadingElement>(null);
  const activeRequestHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultDialogRef = useRef<HTMLDivElement>(null);
  const resultPortalReady = useSyncExternalStore(
    subscribeToBrowserReady,
    getBrowserReadySnapshot,
    getServerReadySnapshot
  );

  if (
    lastInitialIdentity.platform !== platform ||
    lastInitialIdentity.assessmentId !== initialAssessmentId ||
    lastInitialIdentity.solicitudId !== initialSolicitudId ||
    lastInitialIdentity.documentNumber !== normalizedInitialDocument ||
    lastInitialIdentity.firstSurname !== normalizedInitialSurname ||
    lastInitialIdentity.errorCode !== normalizedInitialErrorCode
  ) {
    setLastInitialIdentity({
      platform,
      assessmentId: initialAssessmentId,
      solicitudId: initialSolicitudId,
      documentNumber: normalizedInitialDocument,
      firstSurname: normalizedInitialSurname,
      errorCode: normalizedInitialErrorCode,
    });
    setDocumentNumber(normalizedInitialDocument);
    setFirstSurname(normalizedInitialSurname);
  }

  useEffect(() => {
    onBypassRef.current = onBypass;
  }, [onBypass]);

  useEffect(() => {
    onApprovedRef.current = onApproved;
  }, [onApproved]);

  useEffect(() => {
    onAssessmentInvalidatedRef.current = onAssessmentInvalidated;
  }, [onAssessmentInvalidated]);


  useEffect(() => {
    if (
      view !== "approved" &&
      view !== "rejected" &&
      view !== "active-request"
    ) {
      return;
    }

    const dialog = resultDialogRef.current;
    const heading =
      view === "approved"
        ? approvedHeadingRef.current
        : view === "rejected"
          ? rejectedHeadingRef.current
          : activeRequestHeadingRef.current;
    if (!dialog || !heading) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    heading.focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("aria-hidden"));

      if (focusableElements.length === 0) {
        event.preventDefault();
        heading.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const activeElementIsFocusable =
        activeElement instanceof HTMLElement &&
        focusableElements.includes(activeElement);

      if (
        event.shiftKey &&
        (activeElement === firstElement || !activeElementIsFocusable)
      ) {
        event.preventDefault();
        lastElement.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === lastElement || !activeElementIsFocusable)
      ) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [resultPortalReady, view]);

  const finishBypass = useCallback(() => {
    if (bypassCalledRef.current) return;

    bypassCalledRef.current = true;
    setView("bypassing");
    onBypassRef.current();
  }, []);

  const showApproved = useCallback((result: DataCreditoApprovedResult) => {
    setApprovedResult(result);
    setView("approved");
  }, []);

  const continueApproved = useCallback(() => {
    if (
      !approvedResult ||
      approvedAssessmentIdsRef.current.has(approvedResult.assessmentId)
    ) {
      return;
    }

    approvedAssessmentIdsRef.current.add(approvedResult.assessmentId);
    expiredRequerySolicitudIdRef.current = null;
    setView("bypassing");
    onApprovedRef.current(approvedResult);
  }, [approvedResult]);

  const loadInitialState = useCallback(
    async (signal?: AbortSignal) => {
      setView("loading");
      setCorrelationId(null);
      setConsumedCreditId(null);
      setDailyQueryLimitReached(null);
      setDailyQuotaModalOpen(false);
      setDailyQuotaCheckError(null);
      quotaRefreshAbortRef.current?.abort();
      quotaRefreshAbortRef.current = null;
      setCheckingDailyQuota(false);
      setApprovedResult(null);
      setRetryMode("bootstrap");

      try {
        const policyResponse = await fetch(
          initialSolicitudId && !initialAssessmentId && normalizedInitialErrorCode === "ALLY_DAILY_QUERY_LIMIT_REACHED"
            ? `/api/creditos/datacredito/politica?solicitudId=${encodeURIComponent(initialSolicitudId)}`
            : "/api/creditos/datacredito/politica",
          {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal,
          }
        );
        const policyPayload = (await readJson(
          policyResponse
        )) as PolicyResponse & JsonRecord;

        setConsentText(
          readString(policyPayload.consent?.text) || CONSENT_ATTESTATION
        );

        if (!policyResponse.ok || policyPayload.ok === false) {
          setCorrelationId(getCorrelationId(policyPayload, policyResponse));
          setView("technical-error");
          return;
        }

        if (policyPayload.enabled === false) {
          if (financialTermsRecovery) {
            setView("unavailable");
            return;
          }
          finishBypass();
          return;
        }

        const configured =
          policyPayload.configured ?? policyPayload.provider?.configured;
        const hasPolicy =
          policyPayload.hasPolicy ?? Boolean(policyPayload.policy);

        if (
          policyPayload.enabled !== true ||
          configured !== true ||
          hasPolicy !== true ||
          !policyPayload.policy
        ) {
          setCorrelationId(getCorrelationId(policyPayload, policyResponse));
          setView("unavailable");
          return;
        }

        // Renovar nunca reacepta el GET de la evaluación anterior ni consulta al proveedor.
        if (financialTermsRecovery) {
          if (!initialSolicitudId || !normalizedInitialDocument || !normalizedInitialSurname) {
            setView("unavailable");
            return;
          }
          setApprovedResult(null);
          setConsentAccepted(false);
          setFormErrors({});
          setRetryMode("form");
          setView("ready");
          return;
        }
        if (!initialAssessmentId) {
          if (newQueryRetryRecovery && normalizedInitialErrorCode === "ALLY_DAILY_QUERY_LIMIT_REACHED") {
            const quota = normalizeDailyQueryLimitReached(policyPayload);
            if (quota?.exhausted && quota.percentUsed === 100) {
              setDailyQueryLimitReached(quota);
              setDailyQuotaModalOpen(true);
              setRetryMode("form");
              setView("daily-limit-reached");
              return;
            }
          }
          if (identityMismatchRecovery || newQueryRetryRecovery) {
            setConsentAccepted(false);
            setFormErrors({});
            setRetryMode("form");
            setView("ready");
            return;
          }
          // Una solicitud ya materializada siempre debe conservar su evaluación
          // canónica. Si falta, fallamos cerrado: mostrar el formulario permitiría
          // consumir una consulta nueva al proveedor sobre el mismo borrador.
          setView(
            resolveMissingAssessmentGateView({
              solicitudId: initialSolicitudId,
              expiredRequerySolicitudId:
                expiredRequerySolicitudIdRef.current,
            })
          );
          return;
        }

        const assessmentParams = new URLSearchParams({ platform });
        if (normalizedInitialDocument) {
          assessmentParams.set("documentNumber", normalizedInitialDocument);
        }
        if (normalizedInitialSurname.trim()) {
          assessmentParams.set("firstSurname", normalizedInitialSurname.trim());
        }
        if (initialSolicitudId) {
          assessmentParams.set("draftId", String(initialSolicitudId));
        }
        const assessmentResponse = await fetch(
          `/api/creditos/datacredito/evaluaciones/${encodeURIComponent(
            initialAssessmentId
          )}?${assessmentParams.toString()}`,
          {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal,
          }
        );
        const assessmentPayload = await readJson(assessmentResponse);

        if (!assessmentResponse.ok || assessmentPayload.ok === false) {
          const assessmentCode = String(assessmentPayload.code || '')
            .trim()
            .toUpperCase();
          if (assessmentCode === 'ASSESSMENT_CONSUMED') {
            const creditId = readNumber(assessmentPayload.creditId);
            setConsumedCreditId(
              creditId !== null && Number.isInteger(creditId) && creditId > 0
                ? creditId
                : null
            );
            setView('technical-error');
            return;
          }

          if (
            isRecoverableInitialAssessmentFailure(
              assessmentResponse,
              assessmentPayload
            )
          ) {
            expiredRequerySolicitudIdRef.current = initialSolicitudId;
            onAssessmentInvalidatedRef.current?.();
            setConsentAccepted(false);
            setFormErrors({});
            setCorrelationId(null);
            setView("ready");
            return;
          }

          setCorrelationId(
            getCorrelationId(assessmentPayload, assessmentResponse)
          );
          setView("technical-error");
          return;
        }

        const decision = normalizeDecision(assessmentPayload);

        if (decision === "RECHAZADO") {
          setView("rejected");
          return;
        }

        if (decision === "APROBADO") {
          const approved = normalizeApprovedAssessment(assessmentPayload, {
            solicitudId: initialSolicitudId,
            assessmentId: initialAssessmentId,
            documentNumber: normalizedInitialDocument || undefined,
            firstSurname: normalizedInitialSurname || undefined,
          });

          if (approved && approved.platform !== platform) {
            setCorrelationId(
              getCorrelationId(assessmentPayload, assessmentResponse)
            );
            setView("technical-error");
            return;
          }

          if (approved) {
            setDocumentNumber(approved.documentNumber);
            setFirstSurname(approved.firstSurname);
            setConsentAccepted(true);
            if (initialSolicitudId) {
              if (
                !approvedAssessmentIdsRef.current.has(approved.assessmentId)
              ) {
                approvedAssessmentIdsRef.current.add(approved.assessmentId);
                expiredRequerySolicitudIdRef.current = null;
                setView("bypassing");
                onApprovedRef.current({
                  ...approved,
                  solicitudId: initialSolicitudId,
                });
              }
              return;
            }
            showApproved(approved);
            return;
          }
        }

        setCorrelationId(
          getCorrelationId(assessmentPayload, assessmentResponse)
        );
        setView("technical-error");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setView("technical-error");
      }
    },
    [
      finishBypass,
      initialAssessmentId,
      initialSolicitudId,
      identityMismatchRecovery,
      financialTermsRecovery,
      newQueryRetryRecovery,
      normalizedInitialDocument,
      normalizedInitialSurname,
      normalizedInitialErrorCode,
      platform,
      showApproved,
    ]
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void loadInitialState(controller.signal);
    });
    return () => controller.abort();
  }, [loadInitialState]);

  const checkDailyQueryQuota = useCallback(async (reopen = false) => {
    if (quotaRefreshAbortRef.current) return;
    const controller = new AbortController();
    quotaRefreshAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setCheckingDailyQuota(true);
    setDailyQuotaCheckError(null);
    try {
      const response = await fetch(initialSolicitudId
        ? `/api/creditos/datacredito/politica?solicitudId=${encodeURIComponent(initialSolicitudId)}`
        : "/api/creditos/datacredito/politica", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const payload = await readJson(response);
      const quota = normalizeDailyQueryLimitReached(payload);
      if (!response.ok || payload.ok === false || !quota) throw new Error("QUOTA_CHECK_UNAVAILABLE");
      if (controller.signal.aborted) return;
      if (quota.exhausted && quota.percentUsed === 100) {
        setDailyQueryLimitReached(quota);
        if (reopen) setDailyQuotaModalOpen(true);
      } else {
        // Una comprobación del cupo no inicia una consulta pagada: el asesor
        // debe volver a pulsar Evaluar cuando el servidor confirme disponibilidad.
        setDailyQueryLimitReached(null);
        setDailyQuotaModalOpen(false);
        setCorrelationId(null);
        setView("ready");
      }
    } catch {
      if (quotaRefreshAbortRef.current === controller) {
        setDailyQuotaCheckError("No pudimos verificar el cupo disponible. Intenta verificarlo nuevamente; no se realizó una consulta crediticia.");
      }
    } finally {
      window.clearTimeout(timeout);
      if (quotaRefreshAbortRef.current === controller) {
        quotaRefreshAbortRef.current = null;
        setCheckingDailyQuota(false);
      }
    }
  }, [initialSolicitudId]);

  useEffect(() => {
    if (view !== "daily-limit-reached" || !dailyQueryLimitReached) return;
    const recheck = () => {
      if (document.visibilityState !== "hidden") void checkDailyQueryQuota();
    };
    // No dependemos de la hora del dispositivo. Solo la lectura del servidor
    // libera el cupo; una sesión visible se actualiza en un máximo de 30 s.
    // Al volver a la pestaña se comprueba inmediatamente, sin consulta pagada.
    const timer = window.setInterval(recheck, 30_000);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      const controller = quotaRefreshAbortRef.current;
      quotaRefreshAbortRef.current = null;
      controller?.abort();
    };
  }, [checkDailyQueryQuota, dailyQueryLimitReached, view]);

  const validateForm = () => {
    const errors: FormErrors = {};
    const normalizedDocument = documentNumber.trim();
    const normalizedSurname = firstSurname.trim().replace(/\s+/g, " ");

    if (!/^\d{3,13}$/.test(normalizedDocument)) {
      errors.documentNumber = "Ingresa una cédula de 3 a 13 dígitos.";
    }

    if (
      !normalizedSurname ||
      normalizedSurname.length > 80 ||
      !/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u.test(normalizedSurname)
    ) {
      errors.firstSurname =
        "Ingresa el primer apellido usando solo letras y espacios simples.";
    }

    if (!consentAccepted) {
      errors.consent = "Debes confirmar la autorización previa del titular.";
    }

    setFormErrors(errors);
    return {
      valid: Object.keys(errors).length === 0,
      documentNumber: normalizedDocument,
      firstSurname: normalizedSurname,
    };
  };

  const submitAssessment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (financialTermsRecovery && financialReuseUnavailable) return;
    if (view === "daily-limit-reached") {
      // Reabre la explicación mediante una lectura, nunca una consulta pagada.
      void checkDailyQueryQuota(true);
      return;
    }
    if (submissionInFlightRef.current) return;
    const validation = validateForm();

    if (!validation.valid) return;
    submissionInFlightRef.current = true;

    setView("submitting");
    setCorrelationId(null);
    setDailyQueryLimitReached(null);
    setConflictMessage(null);
    setRetryMode("form");

    try {
      const response = await fetch(
        "/api/creditos/datacredito/evaluaciones",
        {
          method: "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            solicitudId: initialSolicitudId,
            documentNumber: validation.documentNumber,
            firstSurname: validation.firstSurname,
            platform,
            consentAccepted: true,
            reuseOnly: identityMismatchRecovery || financialTermsRecovery,
            refreshFinancialTerms: financialTermsRecovery,
          }),
        }
      );
      const payload = await readJson(response);

      if (!response.ok || payload.ok === false) {
        if (financialTermsRecovery && getResponseCode(payload) === "ASSESSMENT_REUSE_NOT_FOUND") {
          setFinancialReuseUnavailable(true);
          setConsentAccepted(false);
          setView("ready");
          return;
        }
        const dailyQuota = normalizeDailyQueryLimitReached(payload);
        if (
          response.status === 429 &&
          getResponseCode(payload) === "ALLY_DAILY_QUERY_LIMIT_REACHED" &&
          dailyQuota?.exhausted === true && dailyQuota.percentUsed === 100
        ) {
          setDailyQueryLimitReached(dailyQuota);
          setDailyQuotaModalOpen(true);
          setCorrelationId(getCorrelationId(payload, response));
          setView("daily-limit-reached");
          return;
        }
        if (
          identityMismatchRecovery &&
          getResponseCode(payload) === "ASSESSMENT_IDENTITY_MISMATCH"
        ) {
          setCorrelationId(null);
          setFormErrors((current) => ({
            ...current,
            firstSurname:
              "El apellido aún no coincide con la consulta vigente. Corrígelo y vuelve a intentar.",
          }));
          setView("ready");
          return;
        }
        if (getResponseCode(payload) === "SOLICITUD_ACTIVA_EXISTENTE") {
          setConflictMessage(
            readString(payload.error) ||
              "Ya existe una solicitud para esta cédula. Debe retomarse o desistirse antes de iniciar otra."
          );
          setCorrelationId(null);
          setView("active-request");
          return;
        }
        if (getResponseCode(payload) === "SELLER_SESSION_REQUIRED") {
          setCorrelationId(null);
          setView("seller-session-required");
          return;
        }
        setCorrelationId(getCorrelationId(payload, response));
        setView("technical-error");
        return;
      }

      const decision = normalizeDecision(payload);

      if (decision === "RECHAZADO") {
        setView("rejected");
        return;
      }

      if (decision === "APROBADO") {
        const result = normalizeApprovedAssessment(payload, {
          platform,
          documentNumber: validation.documentNumber,
          firstSurname: validation.firstSurname,
        });

        if (result?.platform === platform) {
          if (financialTermsRecovery && !hasCurrentCreditOriginationTerms(result.offer.financialSettings)) {
            setView("unavailable");
            return;
          }
          showApproved(result);
          return;
        }
      }

      setCorrelationId(getCorrelationId(payload, response));
      setView("technical-error");
    } catch {
      setView("technical-error");
    } finally {
      submissionInFlightRef.current = false;
    }
  };

  const retryTechnicalFailure = () => {
    if (retryMode === "bootstrap") {
      void loadInitialState();
      return;
    }

    setCorrelationId(null);
    setView("ready");
  };

  const solicitudWallHref = documentNumber
    ? `/dashboard/solicitudes?q=${encodeURIComponent(documentNumber)}`
    : "/dashboard/solicitudes";

  if (view === "loading" || view === "bypassing") {
    const label =
      view === "bypassing"
        ? approvedResult
          ? "Abriendo información del cliente..."
          : "Continuando con el flujo disponible..."
        : "Verificando disponibilidad de la evaluación...";

    return (
      <Card className="p-4 sm:p-6" aria-busy="true">
        <LoadingState label={label} />
      </Card>
    );
  }

  if (view === "approved" && approvedResult) {
    if (!resultPortalReady) return null;

    return (
      <ResultDialogShell
        dialogRef={resultDialogRef}
        labelledBy="datacredito-approved-title"
        describedBy="datacredito-approved-description"
      >
        <Card className="max-h-[calc(100dvh-2.5rem)] overflow-y-auto overscroll-contain">
          <div className="relative h-[260px] overflow-hidden bg-[var(--fp-bg)] sm:h-[340px]">
          <Image
            src="/assets/creditos/datacredito-approved-hero.png"
            alt=""
            aria-hidden="true"
            width={941}
            height={1672}
            preload
            sizes="(max-width: 640px) 100vw, 520px"
            className="absolute left-1/2 top-0 h-auto w-full max-w-[520px] -translate-x-1/2"
          />
          <div
            className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[var(--fp-surface)] to-transparent"
            aria-hidden="true"
          />
        </div>

        <div className="px-5 pb-6 pt-2 text-center sm:px-10 sm:pb-10">
          <Badge tone="positive">Oferta aprobada</Badge>
          <h2
            id="datacredito-approved-title"
            ref={approvedHeadingRef}
            tabIndex={-1}
            className="mt-4 text-3xl font-black tracking-tight text-[var(--fp-graphite)] outline-none sm:text-4xl"
          >
            Consulta aprobada
          </h2>
          <p
            id="datacredito-approved-description"
            className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--fp-muted)] sm:text-base"
          >
            La solicitud quedó creada. Continúa para completar la información del cliente.
          </p>

          <div className="mt-7 grid gap-3 text-left sm:grid-cols-2">
            <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] p-4">
              <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                Inicial
              </p>
              <p className="mt-2 text-3xl font-black text-[var(--fp-graphite)]">
                {formatPercentage(
                  approvedResult.offer.initialPaymentPercentage
                )}
              </p>
            </div>
            <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
              <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                Crédito máximo
              </p>
              <p className="mt-2 text-2xl font-black text-[var(--fp-graphite)]">
                {formatMoney(approvedResult.offer.maxFinancedAmount)}
              </p>
            </div>
            <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
              <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                Plazo máximo autorizado
              </p>
              <p className="mt-2 text-2xl font-black text-[var(--fp-graphite)]">
                {approvedResult.offer.installmentCount} cuotas
              </p>
            </div>
            {approvedResult.offer.maxInstallmentAmount ? (
              <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
                <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                  Tope de cuota iPhone
                </p>
                <p className="mt-2 text-2xl font-black text-[var(--fp-graphite)]">
                  {formatMoney(approvedResult.offer.maxInstallmentAmount)}
                </p>
              </div>
            ) : null}
          </div>

          <p className="mt-5 text-xs leading-5 text-[var(--fp-muted)]">
            El cupo solo aumenta la cuota inicial cuando, después de aplicar la
            inicial y el tope del equipo, el saldo a financiar supera el monto
            aprobado.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse sm:justify-center">
            <Button onClick={continueApproved}>
              Continuar con los datos
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Link
              href="/dashboard"
              className="fp-ui-button is-secondary focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
            >
              Cancelar
            </Link>
          </div>
        </div>
        </Card>
      </ResultDialogShell>
    );
  }

  if (view === "active-request") {
    if (!resultPortalReady) return null;

    return (
      <ResultDialogShell
        dialogRef={resultDialogRef}
        labelledBy="datacredito-active-request-title"
        describedBy="datacredito-active-request-description"
      >
        <Card className="mx-auto max-h-[calc(100dvh-2.5rem)] max-w-xl overflow-y-auto overscroll-contain">
          <div className="px-6 py-8 text-center sm:px-10 sm:py-10">
            <div
              className="relative mx-auto grid h-32 w-32 place-items-center rounded-full border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)] shadow-[var(--fp-shadow-sm)]"
              aria-hidden="true"
            >
              <Smartphone className="h-20 w-20" strokeWidth={1.7} />
              <span className="absolute -bottom-1 -right-1 grid h-12 w-12 place-items-center rounded-[var(--fp-radius-md)] border-4 border-[var(--fp-surface)] bg-[var(--fp-lime)] text-[var(--fp-graphite)] shadow-[var(--fp-shadow-sm)]">
                <FileCheck2 className="h-6 w-6" strokeWidth={2.4} />
              </span>
            </div>

            <Badge tone="positive" className="mt-6">
              Solicitud en proceso
            </Badge>
            <h2
              id="datacredito-active-request-title"
              ref={activeRequestHeadingRef}
              tabIndex={-1}
              className="mt-4 text-3xl font-black uppercase tracking-tight text-[var(--fp-graphite)] outline-none sm:text-4xl"
            >
              Cliente ya existe
            </h2>
            <p
              id="datacredito-active-request-description"
              className="mx-auto mt-4 max-w-md text-base leading-7 text-[var(--fp-muted)]"
            >
              {conflictMessage ||
                "Este cliente ya cuenta con una solicitud que debe retomarse desde el muro."}
            </p>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--fp-muted)]">
              Si eres el asesor titular, búscala en el muro para retomarla. Si no
              aparece, debe gestionarla el asesor titular o el administrador central
              de FINSER PAY.
            </p>

            <Link
              href={solicitudWallHref}
              className="fp-ui-button is-primary mt-8 w-full justify-center focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
            >
              Buscar en mi muro
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </Link>
          </div>
        </Card>
      </ResultDialogShell>
    );
  }

  if (view === "seller-session-required") {
    return (
      <Card
        className="border-[var(--fp-amber)] p-6 sm:p-8"
        role="alert"
        aria-labelledby="datacredito-seller-session-title"
      >
        <div className="flex items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]"
            aria-hidden="true"
          >
            <UserRound className="h-5 w-5" />
          </span>
          <div>
            <h2
              id="datacredito-seller-session-title"
              className="text-xl font-black text-[var(--fp-graphite)]"
            >
              Selecciona el perfil del asesor
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
              La sesión del asesor no está activa. Ingresa nuevamente al perfil
              correspondiente antes de validar al cliente.
            </p>
          </div>
        </div>
        <Link
          href="/dashboard"
          className="fp-ui-button is-primary mt-6 w-full justify-center focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)] sm:w-auto"
        >
          Ir a perfiles
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </Card>
    );
  }

  if (view === "technical-error") {
    return (
      <TechnicalErrorPanel
        correlationId={correlationId}
        consumedCreditId={consumedCreditId}
        onRetry={retryTechnicalFailure}
      />
    );
  }

  if (view === "unavailable") {
    return (
      <Card
        className="border-[var(--fp-amber)] p-6 sm:p-8"
        role="status"
        aria-labelledby="datacredito-unavailable-title"
      >
        <div className="flex items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]"
            aria-hidden="true"
          >
            <CircleAlert className="h-5 w-5" />
          </span>
          <div>
            <h2
              id="datacredito-unavailable-title"
              className="text-xl font-black text-[var(--fp-graphite)]"
            >
              Evaluación temporalmente no disponible
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
              La configuración técnica o la política de evaluación aún no está
              disponible. No se realizó ninguna consulta y esto no corresponde a
              un rechazo.
            </p>
            {correlationId ? (
              <p className="mt-3 break-all text-xs text-[var(--fp-muted)]">
                Código de seguimiento: <code>{correlationId}</code>
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button variant="secondary" onClick={() => void loadInitialState()}>
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Verificar nuevamente
          </Button>
          <Link
            href="/dashboard/creditos?mode=create-client"
            className="fp-ui-button is-ghost focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Volver a créditos
          </Link>
        </div>
      </Card>
    );
  }

  if (view === "rejected") {
    if (!resultPortalReady) return null;

    return (
      <ResultDialogShell
        dialogRef={resultDialogRef}
        labelledBy="datacredito-rejected-title"
        describedBy="datacredito-rejected-description"
      >
        <Card className="max-h-[calc(100dvh-2.5rem)] overflow-y-auto overscroll-contain border-[var(--fp-danger)]">
          <div className="relative h-[260px] overflow-hidden bg-[var(--fp-bg)] sm:h-[340px]">
          <Image
            src="/assets/creditos/datacredito-rejected-hero.png"
            alt=""
            aria-hidden="true"
            width={941}
            height={1672}
            preload
            sizes="(max-width: 640px) 100vw, 520px"
            className="absolute left-1/2 top-0 h-auto w-full max-w-[520px] -translate-x-1/2"
          />
          <div
            className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[var(--fp-surface)] to-transparent"
            aria-hidden="true"
          />
        </div>

        <div className="px-5 pb-6 pt-2 text-center sm:px-10 sm:pb-10">
          <StatusPill tone="danger">Resultado de la evaluación</StatusPill>
          <h2
            id="datacredito-rejected-title"
            ref={rejectedHeadingRef}
            tabIndex={-1}
            className="mt-4 text-3xl font-black tracking-tight text-[var(--fp-danger)] outline-none sm:text-4xl"
          >
            Solicitud no aprobada
          </h2>
          <p
            id="datacredito-rejected-description"
            className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--fp-muted)] sm:text-base"
          >
            En este momento la solicitud no puede continuar con la venta.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse sm:justify-center">
            <Link
              href={solicitudWallHref}
              className="fp-ui-button focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
            >
              Ver solicitud en el muro
            </Link>
            <Link
              href="/dashboard"
              className="fp-ui-button is-secondary focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Volver al inicio
            </Link>
          </div>
        </div>
        </Card>
      </ResultDialogShell>
    );
  }

  const isSubmitting = view === "submitting";
  const dailyQuotaBlocked = view === "daily-limit-reached" && dailyQueryLimitReached?.exhausted === true;

  return (
    <Card
      className={styles.gateCard}
      aria-busy={isSubmitting}
    >
      <div className={styles.gateLayout}>
        <aside className={styles.mascotPanel} aria-hidden="true">
          <div className={styles.mascotEntry}>
            <Image
              src="/assets/creditos/datacredito-client-check-mascot.png"
              alt=""
              width={1199}
              height={1312}
              preload
              sizes="(max-width: 959px) 260px, 390px"
              className={styles.mascot}
            />
          </div>
          <span className={styles.mascotFloor} />
        </aside>

        <form className={styles.formPanel} noValidate onSubmit={submitAssessment}>
          <header className={styles.formHeader}>
            <div>
              <p className={styles.kicker}>Paso 1 · Datos básicos</p>
              <h2>Validemos al cliente</h2>
              <p className={styles.description}>
                Ingresa la cédula y el primer apellido para continuar.
              </p>
            </div>
            <span className={styles.requiredBadge}>
              <span aria-hidden="true" />
              2 datos requeridos
            </span>
          </header>

          {financialTermsRecovery ? (
            <div className={styles.statusNotice} role="status">
              {financialReuseUnavailable
                ? "No hay una consulta reutilizable dentro de los 15 días. No se hizo una nueva consulta ni cobro. Solicita al administrador la autorización correspondiente antes de iniciar una consulta nueva; esta pantalla no la realizará automáticamente."
                : "La oferta conserva condiciones financieras anteriores. Renueva únicamente la oferta usando la consulta vigente de 15 días, sin una nueva consulta a DataCrédito ni cobro. Se conservan los datos de la solicitud y la validación facial."}
            </div>
          ) : null}
          {dailyQuotaBlocked ? (
            <div className={styles.statusNotice} role="status" id="datacredito-quota-status">
              <p className="font-bold">Límite diario de consultas alcanzado.</p>
              <p>El cupo se restablece {formatDailyQueryLimitReset(dailyQueryLimitReached.resetsAt)} (hora de Bogotá). Las solicitudes existentes y el simulador siguen disponibles.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Button variant="secondary" onClick={() => void checkDailyQueryQuota()} disabled={checkingDailyQuota} aria-disabled={checkingDailyQuota}>
                  {checkingDailyQuota ? "Verificando cupo..." : "Verificar cupo disponible"}
                </Button>
                <Link className="fp-ui-button is-secondary" href="/dashboard/solicitudes?estado=PROCESO">Retomar solicitudes aprobadas</Link>
                <Link className="fp-ui-button is-secondary" href="/dashboard/creditos?mode=simulator">Ir al simulador</Link>
              </div>
              {dailyQuotaCheckError ? <p className="mt-3" role="alert">{dailyQuotaCheckError}</p> : null}
            </div>
          ) : null}
          {identityMismatchRecovery ? (
            <div className={styles.statusNotice} role="status">
              Esta cédula ya tiene una consulta vigente. Corrige únicamente el
              primer apellido para recuperarla; esta acción no realiza una nueva
              consulta a DataCrédito.
            </div>
          ) : null}

          <div className={styles.fieldsGrid}>
            <div className={styles.field}>
              <label htmlFor="datacredito-document-number">Número de cédula</label>
              <div className={styles.inputWrap}>
                <IdCard className={styles.inputIcon} aria-hidden="true" />
                <Input
                  id="datacredito-document-number"
                  name="documentNumber"
                  value={documentNumber}
                  onChange={(event) => {
                    setDocumentNumber(
                      event.target.value.replace(/\D/g, "").slice(0, 13)
                    );
                    setFormErrors((current) => ({
                      ...current,
                      documentNumber: undefined,
                    }));
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  minLength={3}
                  maxLength={13}
                  pattern="[0-9]{3,13}"
                  required
                  placeholder="Ingresa el número de cédula"
                  disabled={
                    isSubmitting ||
                    Boolean(initialSolicitudId && normalizedInitialDocument)
                  }
                  className={styles.input}
                  aria-invalid={Boolean(formErrors.documentNumber)}
                  aria-describedby={
                    formErrors.documentNumber
                      ? "datacredito-document-number-error"
                      : "datacredito-document-number-help"
                  }
                />
              </div>
              <p id="datacredito-document-number-help" className={styles.helpText}>
                Entre 3 y 13 dígitos, sin puntos ni espacios.
              </p>
              {formErrors.documentNumber ? (
                <p
                  id="datacredito-document-number-error"
                  className={styles.fieldError}
                  role="alert"
                >
                  {formErrors.documentNumber}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <label htmlFor="datacredito-first-surname">Primer apellido</label>
              <div className={styles.inputWrap}>
                <UserRound className={styles.inputIcon} aria-hidden="true" />
                <Input
                  id="datacredito-first-surname"
                  name="firstSurname"
                  value={firstSurname}
                  onChange={(event) => {
                    setFirstSurname(event.target.value.slice(0, 80));
                    setFormErrors((current) => ({
                      ...current,
                      firstSurname: undefined,
                    }));
                  }}
                  autoComplete="family-name"
                  maxLength={80}
                  required
                  placeholder="Ingresa el primer apellido"
                  disabled={
                    isSubmitting ||
                    (Boolean(initialSolicitudId && normalizedInitialSurname) &&
                      !identityMismatchRecovery)
                  }
                  className={styles.input}
                  aria-invalid={Boolean(formErrors.firstSurname)}
                  aria-describedby={
                    formErrors.firstSurname
                      ? "datacredito-first-surname-error"
                      : undefined
                  }
                />
              </div>
              {formErrors.firstSurname ? (
                <p
                  id="datacredito-first-surname-error"
                  className={styles.fieldError}
                  role="alert"
                >
                  {formErrors.firstSurname}
                </p>
              ) : null}
            </div>
          </div>

          <div className={styles.consentBox}>
            <label className={styles.consentLabel}>
              <input
                type="checkbox"
                checked={consentAccepted}
                onChange={(event) => {
                  setConsentAccepted(event.target.checked);
                  setFormErrors((current) => ({
                    ...current,
                    consent: undefined,
                  }));
                }}
                disabled={isSubmitting}
                className={styles.checkbox}
                aria-invalid={Boolean(formErrors.consent)}
                aria-describedby={
                  formErrors.consent ? "datacredito-consent-error" : undefined
                }
              />
              <span className={styles.consentIcon} aria-hidden="true">
                <FileCheck2 className="h-6 w-6" />
              </span>
              <span className={styles.consentText}>
                {consentText}{" "}
                <Link
                  href="/politica-privacidad"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.privacyLink}
                >
                  Consultar política de privacidad
                  <span className="sr-only"> (abre en una pestaña nueva)</span>
                </Link>
                .
              </span>
            </label>
            {formErrors.consent ? (
              <p
                id="datacredito-consent-error"
                className={styles.consentError}
                role="alert"
              >
                {formErrors.consent}
              </p>
            ) : null}
          </div>

          <div className={styles.actions}>
            <Link
              href="/dashboard/creditos?mode=create-client"
              className={styles.backLink}
            >
              <ArrowLeft aria-hidden="true" />
              Volver
            </Link>
            <Button
              type="submit"
              id="datacredito-evaluate"
              disabled={isSubmitting || checkingDailyQuota || (financialTermsRecovery && financialReuseUnavailable)}
              aria-disabled={isSubmitting || checkingDailyQuota || dailyQuotaBlocked || (financialTermsRecovery && financialReuseUnavailable)}
              aria-describedby={dailyQuotaBlocked ? "datacredito-quota-status" : undefined}
              className={styles.submitButton}
            >
              {isSubmitting ? (
                <>
                  <RotateCw className="h-5 w-5 animate-spin" aria-hidden="true" />
                  Evaluando...
                </>
              ) : (
                <>
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  {financialTermsRecovery
                    ? "Renovar oferta sin nueva consulta"
                    : identityMismatchRecovery
                    ? "Recuperar consulta vigente"
                    : "Evaluar solicitud"}
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
      {dailyQuotaBlocked && dailyQueryLimitReached.percentUsed !== null ? (
        <DataCreditoDailyQuotaModal
          open={dailyQuotaModalOpen}
          onClose={() => setDailyQuotaModalOpen(false)}
          percentUsed={dailyQueryLimitReached.percentUsed}
          resetsAt={dailyQueryLimitReached.resetsAt}
          approvedHref="/dashboard/solicitudes?estado=PROCESO"
          simulatorHref="/dashboard/creditos?mode=simulator"
          illustrationSrc="/assets/creditos/datacredito-daily-quota-sad-mascot.png"
          returnFocusId="datacredito-evaluate"
        />
      ) : null}
    </Card>
  );
}
