"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  RotateCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
  LoadingState,
  StatusPill,
} from "@/app/_components/finser-ui";

export type DataCreditoPlatform = "ANDROID" | "IPHONE";

export type DataCreditoOffer = {
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
  policyVersion?: number;
  [key: string]: unknown;
};

export type DataCreditoApprovedResult = {
  assessmentId: string;
  documentNumber: string;
  firstSurname: string;
  offer: DataCreditoOffer;
  expiresAt: string;
};

export type DatacreditoPrequalificationGateProps = {
  platform: DataCreditoPlatform;
  initialAssessmentId?: string | null;
  initialDocumentNumber?: string | null;
  initialFirstSurname?: string | null;
  onBypass: () => void;
  onApproved: (result: DataCreditoApprovedResult) => void;
  onAssessmentInvalidated?: () => void;
  showSurety?: boolean;
};

type GateView =
  | "loading"
  | "ready"
  | "submitting"
  | "rejected"
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
  assessmentId?: string;
  documentNumber?: string;
  firstSurname?: string;
};

const CONSENT_ATTESTATION =
  "Confirmo que el titular, antes de esta consulta, autorizó de manera previa, expresa e informada a FINSER PAY S.A.S. para consultar su información crediticia y financiera en DataCrédito Experian con el fin de evaluar esta solicitud de financiación.";

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
  const expiresAt =
    readString(source.expiresAt) || readString(payload.expiresAt) || null;
  const initialPaymentPercentage = readNumber(
    offerSource.initialPaymentPercentage
  );
  const suretyPercentage = readNumber(offerSource.suretyPercentage);
  const maxFinancedAmount = readNumber(offerSource.maxFinancedAmount);
  const validMaxFinancedAmount =
    Number.isSafeInteger(maxFinancedAmount) && Number(maxFinancedAmount) > 0;

  if (
    !assessmentId ||
    !documentNumber ||
    !firstSurname ||
    !expiresAt ||
    initialPaymentPercentage === null ||
    suretyPercentage === null ||
    !validMaxFinancedAmount
  ) {
    return null;
  }

  const policyVersion = readNumber(offerSource.policyVersion);

  return {
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

function isRecoverableInitialAssessmentFailure(
  response: Response,
  payload: JsonRecord
) {
  const code = String(payload.code || "").trim().toUpperCase();
  const status = String(payload.status || "").trim().toUpperCase();

  if (code === 'ASSESSMENT_CONSUMED') return false;

  return (
    response.status === 404 ||
    response.status === 410 ||
    response.status === 422 ||
    code === "ASSESSMENT_EXPIRED" ||
    code === "ASSESSMENT_ENVIRONMENT_MISMATCH" ||
    (status === "NO_EVALUADO" &&
      [409, 410, 422].includes(response.status) &&
      code !== "EVALUATION_IN_PROGRESS")
  );
}

function platformLabel(platform: DataCreditoPlatform) {
  return platform === "ANDROID" ? "Android" : "iPhone";
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
  initialDocumentNumber = null,
  initialFirstSurname = null,
  onBypass,
  onApproved,
  onAssessmentInvalidated,
  showSurety = false,
}: DatacreditoPrequalificationGateProps) {
  const normalizedInitialDocument = String(initialDocumentNumber || "")
    .replace(/\D/g, "")
    .slice(0, 13);
  const normalizedInitialSurname = String(initialFirstSurname || "").slice(
    0,
    80
  );
  const [view, setView] = useState<GateView>("loading");
  const [documentNumber, setDocumentNumber] = useState(
    normalizedInitialDocument
  );
  const [firstSurname, setFirstSurname] = useState(normalizedInitialSurname);
  const [lastInitialIdentity, setLastInitialIdentity] = useState(() => ({
    assessmentId: initialAssessmentId,
    documentNumber: normalizedInitialDocument,
    firstSurname: normalizedInitialSurname,
  }));
  const [consentText, setConsentText] = useState(CONSENT_ATTESTATION);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [consumedCreditId, setConsumedCreditId] = useState<number | null>(null);
  const [retryMode, setRetryMode] = useState<"bootstrap" | "form">("bootstrap");
  const [approvedResult, setApprovedResult] =
    useState<DataCreditoApprovedResult | null>(null);
  const bypassCalledRef = useRef(false);
  const approvedAssessmentIdsRef = useRef(new Set<string>());
  const onBypassRef = useRef(onBypass);
  const onApprovedRef = useRef(onApproved);
  const onAssessmentInvalidatedRef = useRef(onAssessmentInvalidated);
  const approvedHeadingRef = useRef<HTMLHeadingElement>(null);
  const rejectedHeadingRef = useRef<HTMLHeadingElement>(null);

  if (
    lastInitialIdentity.assessmentId !== initialAssessmentId ||
    lastInitialIdentity.documentNumber !== normalizedInitialDocument ||
    lastInitialIdentity.firstSurname !== normalizedInitialSurname
  ) {
    setLastInitialIdentity({
      assessmentId: initialAssessmentId,
      documentNumber: normalizedInitialDocument,
      firstSurname: normalizedInitialSurname,
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
    if (view === "approved") approvedHeadingRef.current?.focus();
    if (view === "rejected") rejectedHeadingRef.current?.focus();
  }, [view]);

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
    setView("bypassing");
    onApprovedRef.current(approvedResult);
  }, [approvedResult]);

  const loadInitialState = useCallback(
    async (signal?: AbortSignal) => {
      setView("loading");
      setCorrelationId(null);
      setConsumedCreditId(null);
      setApprovedResult(null);
      setRetryMode("bootstrap");

      try {
        const policyResponse = await fetch(
          "/api/creditos/datacredito/politica",
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

        if (!initialAssessmentId) {
          setView("ready");
          return;
        }

        const assessmentResponse = await fetch(
          `/api/creditos/datacredito/evaluaciones/${encodeURIComponent(
            initialAssessmentId
          )}`,
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
            assessmentId: initialAssessmentId,
            documentNumber:
              String(initialDocumentNumber || "")
                .replace(/\D/g, "")
                .slice(0, 13) || undefined,
            firstSurname:
              String(initialFirstSurname || "")
                .trim()
                .replace(/\s+/g, " ") || undefined,
          });

          if (approved) {
            setDocumentNumber(approved.documentNumber);
            setFirstSurname(approved.firstSurname);
            setConsentAccepted(true);
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
      initialDocumentNumber,
      initialFirstSurname,
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
    const validation = validateForm();

    if (!validation.valid) return;

    setView("submitting");
    setCorrelationId(null);
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
            documentNumber: validation.documentNumber,
            firstSurname: validation.firstSurname,
            platform,
            consentAccepted: true,
          }),
        }
      );
      const payload = await readJson(response);

      if (!response.ok || payload.ok === false) {
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
          documentNumber: validation.documentNumber,
          firstSurname: validation.firstSurname,
        });

        if (result) {
          showApproved(result);
          return;
        }
      }

      setCorrelationId(getCorrelationId(payload, response));
      setView("technical-error");
    } catch {
      setView("technical-error");
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

  const startNewAssessment = () => {
    setDocumentNumber("");
    setFirstSurname("");
    setConsentAccepted(false);
    setFormErrors({});
    setCorrelationId(null);
    setConsumedCreditId(null);
    setApprovedResult(null);
    setRetryMode("form");
    onAssessmentInvalidatedRef.current?.();
    setView("ready");
  };

  if (view === "loading" || view === "bypassing") {
    const label =
      view === "bypassing"
        ? approvedResult
          ? "Abriendo validación de identidad..."
          : "Continuando con el flujo disponible..."
        : "Verificando disponibilidad de la evaluación...";

    return (
      <Card className="p-4 sm:p-6" aria-busy="true">
        <LoadingState label={label} />
      </Card>
    );
  }

  if (view === "approved" && approvedResult) {
    return (
      <Card
        className="mx-auto max-w-3xl overflow-hidden"
        role="status"
        aria-labelledby="datacredito-approved-title"
      >
        <div className="relative h-[300px] overflow-hidden bg-[var(--fp-bg)] sm:h-[390px]">
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
            ¡Solicitud aprobada!
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--fp-muted)] sm:text-base">
            El cliente puede continuar con la validación de identidad.
          </p>

          <div
            className={[
              "mt-7 grid gap-3 text-left",
              showSurety ? "sm:grid-cols-3" : "sm:grid-cols-2",
            ].join(" ")}
          >
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
            {showSurety ? (
              <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
                <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                  Fianza
                </p>
                <p className="mt-2 text-2xl font-black text-[var(--fp-graphite)]">
                  {formatPercentage(approvedResult.offer.suretyPercentage)}
                </p>
              </div>
            ) : null}
            <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
              <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
                Crédito máximo
              </p>
              <p className="mt-2 text-2xl font-black text-[var(--fp-graphite)]">
                {formatMoney(approvedResult.offer.maxFinancedAmount)}
              </p>
            </div>
          </div>

          <p className="mt-5 text-xs leading-5 text-[var(--fp-muted)]">
            Si el equipo supera el crédito máximo, el excedente se suma a la
            cuota inicial.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse sm:justify-center">
            <Button onClick={continueApproved}>
              Continuar a validación
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
    return (
      <Card
        className="mx-auto max-w-3xl overflow-hidden border-[var(--fp-danger)]"
        role="status"
        aria-labelledby="datacredito-rejected-title"
      >
        <div className="relative h-[300px] overflow-hidden bg-[var(--fp-bg)] sm:h-[390px]">
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
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--fp-muted)] sm:text-base">
            En este momento la solicitud no puede continuar a validación de
            identidad. El puntaje y los motivos internos no se muestran.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse sm:justify-center">
            <Button onClick={startNewAssessment}>
              <RotateCw className="h-4 w-4" aria-hidden="true" />
              Realizar nueva consulta
            </Button>
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
    );
  }

  const isSubmitting = view === "submitting";

  return (
    <Card className="overflow-hidden" aria-busy={isSubmitting}>
      <div className="border-b border-[var(--fp-border)] bg-[var(--fp-bg)] px-5 py-5 sm:px-8 sm:py-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <span
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] bg-[var(--fp-navy)] text-white"
              aria-hidden="true"
            >
              <Smartphone className="h-5 w-5" />
            </span>
            <div>
              <Badge tone="positive">Precalificación</Badge>
              <h2 className="mt-3 text-2xl font-black tracking-tight text-[var(--fp-graphite)]">
                Consulta previa para {platformLabel(platform)}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--fp-muted)]">
                Ingresa únicamente la identificación solicitada. El resultado se
                usa para decidir si el flujo puede continuar.
              </p>
            </div>
          </div>
          <ShieldCheck
            className="hidden h-7 w-7 text-[var(--fp-graphite)] sm:block"
            aria-hidden="true"
          />
        </div>
      </div>

      <form className="p-5 sm:p-8" noValidate onSubmit={submitAssessment}>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label
              htmlFor="datacredito-document-number"
              className="mb-2 block text-sm font-bold text-[var(--fp-graphite)]"
            >
              Número de cédula
            </label>
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
              disabled={isSubmitting}
              aria-invalid={Boolean(formErrors.documentNumber)}
              aria-describedby={
                formErrors.documentNumber
                  ? "datacredito-document-number-error"
                  : "datacredito-document-number-help"
              }
            />
            <p
              id="datacredito-document-number-help"
              className="mt-2 text-xs text-[var(--fp-muted)]"
            >
              Entre 3 y 13 dígitos, sin puntos ni espacios.
            </p>
            {formErrors.documentNumber ? (
              <p
                id="datacredito-document-number-error"
                className="mt-2 text-sm font-semibold text-[var(--fp-danger)]"
                role="alert"
              >
                {formErrors.documentNumber}
              </p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor="datacredito-first-surname"
              className="mb-2 block text-sm font-bold text-[var(--fp-graphite)]"
            >
              Primer apellido
            </label>
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
              disabled={isSubmitting}
              aria-invalid={Boolean(formErrors.firstSurname)}
              aria-describedby={
                formErrors.firstSurname
                  ? "datacredito-first-surname-error"
                  : undefined
              }
            />
            {formErrors.firstSurname ? (
              <p
                id="datacredito-first-surname-error"
                className="mt-2 text-sm font-semibold text-[var(--fp-danger)]"
                role="alert"
              >
                {formErrors.firstSurname}
              </p>
            ) : null}
          </div>
        </div>

        <div
          className="mt-6 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4"
        >
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-[var(--fp-graphite)]">
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
              className="mt-1 h-5 w-5 shrink-0 accent-[var(--fp-graphite)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
              aria-invalid={Boolean(formErrors.consent)}
              aria-describedby={
                formErrors.consent ? "datacredito-consent-error" : undefined
              }
            />
            <span>
              {consentText}{" "}
              <Link
                href="/politica-privacidad"
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold underline decoration-[var(--fp-lime-strong)] decoration-2 underline-offset-2 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
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
              className="mt-2 pl-8 text-sm font-semibold text-[var(--fp-danger)]"
              role="alert"
            >
              {formErrors.consent}
            </p>
          ) : null}
        </div>

        <p className="mt-4 text-xs leading-5 text-[var(--fp-muted)]">
          FINSER PAY no muestra el puntaje al asesor. Los errores técnicos se
          informan por separado y nunca se presentan como un rechazo.
        </p>

        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href="/dashboard/creditos?mode=create-client"
            className="fp-ui-button is-ghost focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-lime)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Volver
          </Link>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              "Evaluando..."
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Evaluar solicitud
              </>
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}
