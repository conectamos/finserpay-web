"use client";

import {
  Check,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  LogOut,
  Search,
  ShieldCheck,
  Smartphone,
  UserRoundCheck,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import FinserBrand from "@/app/_components/finser-brand";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingState,
  StatusPill,
} from "@/app/_components/finser-ui";

type AccessState = "checking" | "authorized" | "locked" | "unavailable";

type EnrollmentReview = {
  id: string;
  decision: "APROBADO";
  analystName: string;
  analystExternalId: string;
  approvedAt: string;
  checklistVersion: string;
};

type AuthorizedAnalyst = {
  name: string;
  externalId: string;
};

type EnrollmentCase = {
  solicitudId: number;
  solicitudNumero: string;
  clienteNombre: string;
  documento: string;
  imei: string;
  equipo: string;
  sede: string;
  aliado: string;
  review: EnrollmentReview | null;
};

type ApiResponse = {
  ok?: boolean;
  authorized?: boolean;
  configured?: boolean;
  error?: string;
  caseToken?: string;
  item?: EnrollmentCase;
  review?: EnrollmentReview;
  alreadyApproved?: boolean;
  analyst?: AuthorizedAnalyst;
  expiresAt?: string;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as ApiResponse;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

export default function IphoneEnrollmentPortal() {
  const [accessState, setAccessState] = useState<AccessState>("checking");
  const [document, setDocument] = useState("");
  const [imei, setImei] = useState("");
  const [analyst, setAnalyst] = useState<AuthorizedAnalyst | null>(null);
  const [caseToken, setCaseToken] = useState("");
  const [enrollmentCase, setEnrollmentCase] = useState<EnrollmentCase | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [approving, setApproving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    const authorize = async () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = fragment.get("acceso") || "";
      if (window.location.hash) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`
        );
      }

      try {
        const response = accessToken
          ? await fetch("/api/public/iphone-enrollment/access", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: accessToken }),
            })
          : await fetch("/api/public/iphone-enrollment/session", {
              credentials: "same-origin",
              cache: "no-store",
            });
        const data = await readJson(response);
        if (cancelled) return;
        if (response.ok && data.authorized && data.analyst) {
          setAnalyst(data.analyst);
          setAccessState("authorized");
          return;
        }
        setAccessState(response.status === 503 ? "unavailable" : "locked");
        setMessage(data.error || "El enlace de acceso no es valido o vencio.");
      } catch {
        if (!cancelled) {
          setAccessState("unavailable");
          setMessage("No se pudo verificar el acceso al modulo.");
        }
      }
    };

    void authorize();
    return () => {
      cancelled = true;
    };
  }, []);

  const resetCase = () => {
    setEnrollmentCase(null);
    setCaseToken("");
    setConfirmed(false);
    setConfirmOpen(false);
    setMessage("");
  };

  const searchCase = async (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    setMessage("");
    setEnrollmentCase(null);
    setCaseToken("");
    setConfirmed(false);
    try {
      const response = await fetch("/api/public/iphone-enrollment/cases", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document, imei }),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        setAccessState("locked");
        setMessage("El acceso vencio. Solicita un nuevo enlace autorizado.");
        return;
      }
      if (!response.ok || !data.item || !data.caseToken) {
        setMessage(data.error || "No se pudo consultar la solicitud.");
        return;
      }
      setEnrollmentCase(data.item);
      setCaseToken(data.caseToken);
    } catch {
      setMessage("No se pudo conectar con FINSER PAY. Intenta nuevamente.");
    } finally {
      setSearching(false);
    }
  };

  const approveCase = async () => {
    if (!caseToken || !confirmed || !analyst) return;
    setApproving(true);
    setMessage("");
    try {
      const response = await fetch(
        "/api/public/iphone-enrollment/cases/approve",
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caseToken,
            enrollmentApproved: true,
          }),
        }
      );
      const data = await readJson(response);
      if (response.status === 401) {
        setAccessState("locked");
        setMessage("El acceso vencio. Solicita un nuevo enlace autorizado.");
        return;
      }
      if (!response.ok || !data.review) {
        setMessage(data.error || "No se pudo aprobar el enrolamiento.");
        setConfirmOpen(false);
        return;
      }
      setEnrollmentCase((current) =>
        current ? { ...current, review: data.review || null } : current
      );
      setConfirmOpen(false);
      setConfirmed(true);
      setMessage(
        data.alreadyApproved
          ? "Esta solicitud ya tenia el enrolamiento aprobado."
          : "Aprobacion enviada a la solicitud."
      );
    } catch {
      setMessage("No se pudo conectar con FINSER PAY. Intenta nuevamente.");
      setConfirmOpen(false);
    } finally {
      setApproving(false);
    }
  };

  const closeAccess = async () => {
    await fetch("/api/public/iphone-enrollment/access", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }).catch(() => undefined);
    setAccessState("locked");
    setAnalyst(null);
    resetCase();
  };

  return (
    <main className="min-h-svh bg-[var(--fp-bg)] text-[var(--fp-graphite)]">
      <div className="border-b border-white/10 bg-[var(--fp-navy)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <FinserBrand compact dark accentPay showTagline={false} />
          {accessState === "authorized" ? (
            <Button
              variant="ghost"
              className="min-h-11 border border-white/15 text-white hover:bg-white/10"
              onClick={() => void closeAccess()}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Cerrar acceso</span>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl px-4 py-7 sm:px-6 sm:py-10">
        <header className="mb-6 max-w-3xl">
          <Badge tone="positive">Operación iPhone</Badge>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
            Aprobación de enrolamiento
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--fp-muted)] sm:text-base">
            Consulta la solicitud con cédula e IMEI. Al aprobar, la fábrica de
            créditos recibirá automáticamente el checklist del analista.
          </p>
        </header>

        {accessState === "checking" ? (
          <Card className="p-7 sm:p-10">
            <LoadingState label="Verificando acceso seguro..." />
          </Card>
        ) : accessState !== "authorized" ? (
          <Card className="overflow-hidden p-0">
            <div className="border-b border-[var(--fp-border)] bg-[var(--fp-navy)] px-6 py-7 text-white sm:px-8">
              <LockKeyhole className="h-9 w-9 text-[var(--fp-lime)]" aria-hidden="true" />
              <h2 className="mt-4 text-2xl font-black">
                {accessState === "unavailable"
                  ? "Módulo no disponible"
                  : "Enlace autorizado requerido"}
              </h2>
            </div>
            <EmptyState
              className="p-7 sm:p-10"
              title={
                accessState === "unavailable"
                  ? "No se pudo habilitar el módulo"
                  : "Solicita un nuevo enlace a FINSER PAY"
              }
              description={
                message ||
                "Este módulo no utiliza el inicio de sesión general, pero sí exige un enlace operativo autorizado."
              }
            />
          </Card>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <Card className="p-5 sm:p-7">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-sm)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
                  <Search className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-xl font-black">Consultar solicitud</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--fp-muted)]">
                    Ambos datos deben coincidir con una única solicitud iPhone activa.
                  </p>
                </div>
              </div>

              {analyst ? (
                <div className="mt-5 flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
                  <UserRoundCheck
                    className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 text-sm">
                    <p className="font-black text-[var(--fp-graphite)]">
                      {analyst.name}
                    </p>
                    <p className="mt-1 break-words text-[var(--fp-muted)]">
                      Analista autorizado · {analyst.externalId}
                    </p>
                  </div>
                </div>
              ) : null}

              <form className="mt-6 grid gap-5" onSubmit={searchCase}>
                <label className="grid gap-2 text-sm font-bold">
                  Cédula del cliente
                  <Input
                    value={document}
                    onChange={(event) => {
                      setDocument(event.target.value.replace(/\D/g, "").slice(0, 20));
                      if (enrollmentCase) resetCase();
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Número de cédula"
                    minLength={5}
                    maxLength={20}
                    required
                  />
                </label>
                <label className="grid gap-2 text-sm font-bold">
                  IMEI del iPhone
                  <Input
                    value={imei}
                    onChange={(event) => {
                      setImei(event.target.value.replace(/\D/g, "").slice(0, 15));
                      if (enrollmentCase) resetCase();
                    }}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="15 dígitos"
                    minLength={15}
                    maxLength={15}
                    required
                  />
                </label>
                <Button
                  type="submit"
                  className="min-h-12 w-full"
                  disabled={searching || document.length < 5 || imei.length !== 15}
                >
                  {searching ? "Consultando..." : "Consultar solicitud"}
                </Button>
              </form>

              {message ? (
                <div
                  className="mt-5 rounded-[var(--fp-radius-sm)] border border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-sm leading-6 text-[var(--fp-muted)]"
                  role="status"
                  aria-live="polite"
                >
                  {message}
                </div>
              ) : null}
            </Card>

            <Card className="min-h-[360px] p-5 sm:p-7">
              {searching ? (
                <LoadingState label="Buscando la solicitud exacta..." />
              ) : !enrollmentCase ? (
                <EmptyState
                  title="Consulta pendiente"
                  description="Ingresa la cédula y el IMEI para cargar únicamente el caso que vas a validar."
                />
              ) : enrollmentCase.review ? (
                <ApprovedCase item={enrollmentCase} onNewCase={() => {
                  setDocument("");
                  setImei("");
                  resetCase();
                }} />
              ) : (
                <div>
                  <div className="flex flex-col gap-3 border-b border-[var(--fp-border)] pb-5 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <StatusPill tone="warning">Pendiente de aprobación</StatusPill>
                      <h2 className="mt-3 text-2xl font-black">
                        {enrollmentCase.solicitudNumero}
                      </h2>
                      <p className="mt-1 text-sm text-[var(--fp-muted)]">
                        {enrollmentCase.clienteNombre} · {enrollmentCase.documento}
                      </p>
                    </div>
                    <Smartphone className="h-8 w-8 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                  </div>

                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                    <CaseDetail label="Equipo" value={enrollmentCase.equipo} />
                    <CaseDetail label="IMEI" value={enrollmentCase.imei} />
                    <CaseDetail label="Aliado" value={enrollmentCase.aliado} />
                    <CaseDetail label="Sede" value={enrollmentCase.sede} />
                  </dl>

                  <div className="mt-6 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
                    <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--fp-lime-strong)]">
                      Checklist de aprobación
                    </p>
                    <ChecklistItem label="La cédula coincide con la solicitud" />
                    <ChecklistItem label="El IMEI coincide con el iPhone consultado" />
                    <label className="mt-3 flex min-h-14 cursor-pointer items-start gap-3 rounded-[var(--fp-radius-sm)] border border-[var(--fp-border)] bg-white p-3 text-sm font-bold leading-6">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--fp-lime-strong)]"
                      />
                      Confirmo como analista que el iPhone quedó correctamente enrolado.
                    </label>
                  </div>

                  <Button
                    className="mt-5 min-h-12 w-full"
                    disabled={!confirmed || !analyst || approving}
                    onClick={() => setConfirmOpen(true)}
                  >
                    <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                    Aprobar enrolamiento
                  </Button>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {confirmOpen && enrollmentCase ? (
        <div
          className="fixed inset-0 z-50 grid place-items-end bg-slate-950/55 p-0 sm:place-items-center sm:p-5"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !approving) setConfirmOpen(false);
          }}
        >
          <Card
            className="w-full max-w-lg rounded-b-none p-6 shadow-2xl sm:rounded-[var(--fp-radius-lg)] sm:p-7"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-enrollment-title"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Badge tone="warning">Confirmación final</Badge>
                <h2 id="confirm-enrollment-title" className="mt-3 text-2xl font-black">
                  ¿Aprobar este enrolamiento?
                </h2>
              </div>
              <Button
                variant="ghost"
                className="h-11 w-11 p-0"
                aria-label="Cerrar confirmación"
                disabled={approving}
                onClick={() => setConfirmOpen(false)}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>
            <p className="mt-4 text-sm leading-6 text-[var(--fp-muted)]">
              Se enviará el checklist aprobado a {enrollmentCase.solicitudNumero}.
              La fábrica validará nuevamente la cédula y el IMEI antes de finalizar.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <Button
                variant="secondary"
                className="min-h-12 w-full"
                disabled={approving}
                onClick={() => setConfirmOpen(false)}
              >
                Volver
              </Button>
              <Button
                className="min-h-12 w-full"
                disabled={approving}
                onClick={() => void approveCase()}
              >
                {approving ? "Enviando..." : "Sí, aprobar"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </main>
  );
}

function CaseDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--fp-radius-sm)] border border-[var(--fp-border)] bg-white px-3 py-3">
      <dt className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--fp-muted)]">
        {label}
      </dt>
      <dd className="mt-1 break-words font-black text-[var(--fp-graphite)]">{value}</dd>
    </div>
  );
}

function ChecklistItem({ label }: { label: string }) {
  return (
    <div className="mt-3 flex items-center gap-3 text-sm font-bold">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
        <Check className="h-4 w-4" aria-hidden="true" />
      </span>
      {label}
    </div>
  );
}

function ApprovedCase({
  item,
  onNewCase,
}: {
  item: EnrollmentCase;
  onNewCase: () => void;
}) {
  const review = item.review;
  if (!review) return null;
  return (
    <div className="text-center" role="status" aria-live="polite">
      <div className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]">
        <CheckCircle2 className="h-10 w-10" aria-hidden="true" />
      </div>
      <StatusPill tone="positive" className="mt-5">
        Enrolamiento aprobado
      </StatusPill>
      <h2 className="mt-4 text-2xl font-black">Checklist enviado</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
        {item.solicitudNumero} · {item.equipo}
      </p>
      <div className="mt-6 grid gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4 text-left text-sm">
        <div className="flex items-start gap-3">
          <UserRoundCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
          <p>
            Analista: <strong>{review.analystName}</strong>
            {review.analystExternalId ? ` · ${review.analystExternalId}` : ""}
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
          <p>
            Aprobado: <strong>{formatDateTime(review.approvedAt)}</strong>
          </p>
        </div>
      </div>
      <Button variant="secondary" className="mt-6 min-h-12 w-full" onClick={onNewCase}>
        Consultar otra solicitud
      </Button>
    </div>
  );
}
