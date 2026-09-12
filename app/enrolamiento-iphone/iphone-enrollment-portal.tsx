"use client";

import Image from "next/image";
import {
  Check,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  LogOut,
  Search,
  ShieldCheck,
  Smartphone,
  UserRound,
  UserRoundCheck,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import FinserBrand from "@/app/_components/finser-brand";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
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
  operationType?: "SALE" | "WARRANTY_REPLACEMENT";
  operationLabel?: "Venta nueva" | "Cambio por garantía";
  clienteNombre: string;
  documento: string;
  imei: string;
  equipo: string;
  sede: string;
  aliado: string;
  creditDecision: "APROBADA";
  enrollmentStatus:
    | "LISTO_PARA_ENROLAR"
    | "ENROLADO_CORRECTAMENTE";
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
  const [successOpen, setSuccessOpen] = useState(false);
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
    setSuccessOpen(false);
    setMessage("");
  };

  const startNewCase = () => {
    setDocument("");
    setImei("");
    resetCase();
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
        setMessage("El acceso venció. Vuelva a abrir el enlace compartido.");
        setConfirmOpen(false);
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
        setMessage("El acceso venció. Vuelva a abrir el enlace compartido.");
        setConfirmOpen(false);
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
      setMessage("");
      setSuccessOpen(true);
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
            Control de enrolamiento
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--fp-muted)] sm:text-base">
            Consulta la venta con cédula e IMEI, realiza la prueba y confirma el
            enrolamiento. La fábrica del asesor se actualizará automáticamente.
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
                  : "Acceso compartido requerido"}
              </h2>
            </div>
            <EmptyState
              className="p-7 sm:p-10"
              title={
                accessState === "unavailable"
                  ? "No se pudo habilitar el módulo"
                  : "Abra el enlace compartido por FINSER PAY"
              }
              description={
                message ||
                "Este módulo no utiliza el inicio de sesión general. El equipo especializado entra siempre mediante el mismo acceso compartido."
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
                  <ShieldCheck
                    className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 text-sm">
                    <p className="font-black text-[var(--fp-graphite)]">
                      Acceso de especialistas activo
                    </p>
                    <p className="mt-1 break-words text-[var(--fp-muted)]">
                      Puede consultar y enrolar múltiples solicitudes durante esta sesión.
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
                <ApprovedCase item={enrollmentCase} onNewCase={startNewCase} />
              ) : (
                <div>
                  <div className="flex flex-col gap-3 border-b border-[var(--fp-border)] pb-5 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone="positive">Aprobada</StatusPill>
                        <StatusPill tone="warning">Solo falta enrolar</StatusPill>
                        {enrollmentCase.operationType ===
                        "WARRANTY_REPLACEMENT" ? (
                          <StatusPill tone="neutral">Cambio por garantía</StatusPill>
                        ) : null}
                      </div>
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

                  <div className="mt-5 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] p-4 text-sm leading-6 text-[var(--fp-graphite)]">
                    {enrollmentCase.operationType === "WARRANTY_REPLACEMENT"
                      ? "El crédito ya fue finalizado y este IMEI corresponde al equipo de reemplazo autorizado. Realiza la prueba antes de dejar el cambio listo para activación."
                      : "La venta llegó al paso 4. El crédito está aprobado y el iPhone está listo para realizar la prueba de enrolamiento."}
                  </div>

                  <div className="mt-6 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4">
                    <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--fp-lime-strong)]">
                      Resultado de la prueba
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
                      Confirmo que la prueba terminó al 100 % y el iPhone quedó
                      enrolado correctamente.
                    </label>
                  </div>

                  <Button
                    className="mt-5 min-h-12 w-full"
                    disabled={!confirmed || !analyst || approving}
                    onClick={() => setConfirmOpen(true)}
                  >
                    <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                    ENROLADO CORRECTAMENTE
                  </Button>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen && Boolean(enrollmentCase)}
        title="¿Confirmar ENROLADO CORRECTAMENTE?"
        description={
          enrollmentCase
            ? enrollmentCase.operationType === "WARRANTY_REPLACEMENT"
              ? `Se confirmará el enrolamiento del equipo de reemplazo para ${enrollmentCase.solicitudNumero}. El administrador central deberá aplicar el cambio antes de que el nuevo IMEI quede activo.`
              : `Se enviará la confirmación a ${enrollmentCase.solicitudNumero}. La fábrica validará nuevamente la cédula y el IMEI y habilitará las fotografías al asesor.`
            : ""
        }
        confirmLabel="Confirmar ENROLADO CORRECTAMENTE"
        busy={approving}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void approveCase()}
      />

      {enrollmentCase?.review ? (
        <EnrollmentSuccessDialog
          open={successOpen}
          item={enrollmentCase}
          documentValue={document}
          imeiValue={imei}
          onFinish={() => setSuccessOpen(false)}
          onNewCase={startNewCase}
        />
      ) : null}
    </main>
  );
}

function formatDocument(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : value;
}

function EnrollmentSuccessDialog({
  open,
  item,
  documentValue,
  imeiValue,
  onFinish,
  onNewCase,
}: {
  open: boolean;
  item: EnrollmentCase;
  documentValue: string;
  imeiValue: string;
  onFinish: () => void;
  onNewCase: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const finishRef = useRef(onFinish);
  const review = item.review;

  useEffect(() => {
    finishRef.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-enrollment-success-focus]")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finishRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  if (!open || !review || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden overscroll-contain bg-[#fbfaf6]"
      role="presentation"
    >
      <section
        ref={dialogRef}
        className="mx-auto min-h-dvh w-full max-w-[640px] overflow-hidden bg-[#fbfaf6] text-[var(--fp-graphite)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="iphone-enrollment-success-title"
        aria-describedby="iphone-enrollment-success-description"
      >
        <header
          className="fp-enrollment-success-header grid place-items-start justify-center pt-7 text-center text-white sm:pt-5"
          aria-label="FINSER PAY"
        >
          <span
            className="relative z-10 text-[1.65rem] font-black tracking-[-0.035em] sm:text-[1.6rem]"
            aria-hidden="true"
          >
            <span className="text-[var(--fp-lime)]">FINSER</span>{" "}
            <span>PAY</span>
          </span>
        </header>

        <div className="relative z-10 mx-auto flex w-full max-w-[560px] flex-col items-center px-5 pb-8 text-center sm:px-8 sm:pb-5">
          <Image
            src="/assets/creditos/iphone-enrollment-success-mascot.png"
            alt=""
            width={1145}
            height={1374}
            sizes="(max-width: 639px) 180px, 150px"
            className="fp-enrollment-success-mascot mt-4 h-auto w-[180px] object-contain sm:mt-2 sm:w-[150px]"
            aria-hidden="true"
            priority
          />

          <p className="mt-3 inline-flex min-h-10 items-center rounded-full border border-[var(--fp-lime-strong)] bg-[var(--fp-lime-soft)] px-5 py-2 text-[0.78rem] font-black uppercase tracking-[0.025em] text-[#2f6f1d] sm:mt-1.5 sm:min-h-9 sm:py-1.5 sm:text-xs">
            ENROLADO CORRECTAMENTE
          </p>
          <h2
            id="iphone-enrollment-success-title"
            className="mt-4 text-[clamp(1.9rem,8vw,2.55rem)] font-black leading-[1.03] tracking-[-0.045em] text-black sm:mt-2.5 sm:text-[2rem]"
          >
            Dispositivo protegido
          </h2>
          <p
            id="iphone-enrollment-success-description"
            className="mt-3 max-w-[490px] text-[0.98rem] leading-6 text-[#6f7888] sm:mt-1.5 sm:text-[0.95rem] sm:leading-[1.4rem]"
          >
            El iPhone quedó registrado correctamente y la fábrica del asesor fue
            actualizada.
          </p>

          <div className="mt-7 grid w-full gap-4 text-left sm:mt-4 sm:gap-3">
            <EnrollmentSuccessCard
              id="iphone-enrollment-success-client"
              icon={
                <UserRound
                  className="h-6 w-6"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              }
              title="Cliente"
            >
              <EnrollmentSuccessRow
                label="Nombre"
                value={item.clienteNombre}
                strong
              />
              <EnrollmentSuccessRow
                label="Cédula"
                value={formatDocument(documentValue)}
              />
            </EnrollmentSuccessCard>

            <EnrollmentSuccessCard
              id="iphone-enrollment-success-device"
              icon={
                <Smartphone
                  className="h-6 w-6"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              }
              title="Equipo"
            >
              <EnrollmentSuccessRow
                label="Referencia"
                value={item.equipo}
                strong
              />
              <EnrollmentSuccessRow label="IMEI" value={imeiValue} numeric />
              <EnrollmentSuccessRow
                label="Fecha y hora"
                value={formatDateTime(review.approvedAt)}
                numeric
              />
            </EnrollmentSuccessCard>
          </div>

          <div className="mt-7 grid w-full gap-3 border-t border-[#d9dde2] pt-5 sm:mt-4 sm:gap-2 sm:pt-4">
            <Button
              className="!min-h-14 w-full !rounded-[16px] !text-base !font-black sm:!min-h-12"
              onClick={onFinish}
              data-enrollment-success-focus
            >
              Finalizar
            </Button>
            <Button
              variant="secondary"
              className="!min-h-14 w-full !rounded-[16px] !border-[#98a1af] !text-base !font-black sm:!min-h-12"
              onClick={onNewCase}
            >
              Consultar otra solicitud
            </Button>
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}

function EnrollmentSuccessCard({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="overflow-hidden rounded-[18px] border border-[#d8dde3] bg-white shadow-[0_8px_24px_rgba(17,21,25,0.035)]"
      aria-labelledby={id}
    >
      <div className="flex min-h-16 items-center gap-4 px-4 py-3 sm:min-h-[52px] sm:gap-3 sm:px-5 sm:py-2">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#f1f2f3] text-[#5f6877] sm:h-10 sm:w-10">
          {icon}
        </span>
        <h3 id={id} className="text-xl font-black tracking-[-0.025em] text-black sm:text-lg">
          {title}
        </h3>
      </div>
      <dl className="border-t border-[#e0e3e7] px-4 sm:px-5">{children}</dl>
    </section>
  );
}

function EnrollmentSuccessRow({
  label,
  value,
  strong = false,
  numeric = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  numeric?: boolean;
}) {
  return (
    <div className="grid min-h-[52px] grid-cols-[106px_minmax(0,1fr)] items-center gap-3 border-b border-[#e0e3e7] py-3 last:border-b-0 sm:min-h-11 sm:grid-cols-[132px_minmax(0,1fr)] sm:py-2">
      <dt className="text-[0.7rem] font-bold uppercase tracking-[0.11em] text-[#778195] sm:text-xs">
        {label}
      </dt>
      <dd
        className={`min-w-0 break-words text-sm text-[#111519] sm:text-base ${
          strong ? "font-black" : "font-semibold"
        } ${
          numeric ? "break-all font-mono tabular-nums tracking-[-0.02em]" : ""
        }`}
      >
        {value}
      </dd>
    </div>
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
        ENROLADO CORRECTAMENTE
      </StatusPill>
      <h2 className="mt-4 text-2xl font-black">
        {item.operationType === "WARRANTY_REPLACEMENT"
          ? "Cambio listo para activar"
          : "Asesor habilitado"}
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--fp-muted)]">
        {item.solicitudNumero} · {item.equipo}.{" "}
        {item.operationType === "WARRANTY_REPLACEMENT"
          ? "El administrador central debe aplicar el reemplazo para activar el nuevo IMEI."
          : "En máximo 8 segundos se habilitarán las fotografías en la fábrica de créditos."}
      </p>
      <div className="mt-6 grid gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4 text-left text-sm">
        <div className="flex items-start gap-3">
          <UserRoundCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
          <p>
            Confirmado por: <strong>Equipo especializado de enrolamiento</strong>
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
          <p>
            Enrolado: <strong>{formatDateTime(review.approvedAt)}</strong>
          </p>
        </div>
      </div>
      <Button variant="secondary" className="mt-6 min-h-12 w-full" onClick={onNewCase}>
        Consultar otra solicitud
      </Button>
    </div>
  );
}
