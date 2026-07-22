"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import FinserSupportLink from "@/app/_components/finser-support-link";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleUserRound,
  CreditCard,
  Headphones,
  Home,
  LockKeyhole,
  ReceiptText,
  UserRound,
} from "lucide-react";

type ClientInstallment = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonado: number;
  saldoPendiente: number;
  estado: "PAGO" | "PENDIENTE";
  estaEnMora?: boolean;
};

type ClientCredit = {
  id: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono?: string | null;
  referenciaEquipo: string | null;
  imei?: string | null;
  deviceUid?: string | null;
  fechaCredito: string;
  montoCredito: number;
  valorCuota: number;
  sedeNombre: string;
  estadoPago: "PAGADO" | "AL_DIA" | "MORA";
  saldoPendiente: number;
  liquidacionAnticipada?: {
    capitalPendiente: number;
    condonacion: number;
    disponible: boolean;
    motivo?: string | null;
    saldoObligacion: number;
  };
  saldoDisponible?: number;
  totalPagado: number;
  cuotas: ClientInstallment[];
  abonos: Array<{
    id: number;
    valor: number;
    metodoPago: string;
    fechaAbono: string;
  }>;
};

type ClientCreditsResponse = {
  ok?: boolean;
  items?: ClientCredit[];
  error?: string;
};

type WompiCheckoutResponse = {
  ok?: boolean;
  amount?: number;
  checkoutUrl?: string;
  directError?: string | null;
  error?: string;
  paymentMode?: "CHECKOUT" | "CHECKOUT_FALLBACK" | "NEQUI_DIRECT";
  reference?: string;
  status?: string | null;
  statusMessage?: string | null;
  transactionId?: string | null;
};

type WompiStatusResponse = {
  applied?: boolean;
  alreadyProcessed?: boolean;
  error?: string;
  ok?: boolean;
  status?: string;
};

type PaymentReturnNotice = {
  reference: string;
  creditId: number | null;
  checkedAt?: string | null;
};

type ExplorerPanel = "payments" | "pending" | "history" | null;
type ClientPaymentMode = "INSTALLMENTS" | "PAYOFF";

declare global {
  interface Window {
    FinserPayAndroid?: {
      registerClient?: (documento: string) => void;
    };
  }
}

const STORAGE_KEY = "finserpay.cliente.documento";

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

function normalizeDocument(value: string) {
  return value.replace(/\D/g, "");
}

function normalizePanel(value: string | null): ExplorerPanel {
  const normalized = String(value || "").trim().toLowerCase();

  if (["pay", "payment", "payments", "pagar", "wompi"].includes(normalized)) {
    return "payments";
  }

  if (["pending", "pendientes", "calendario"].includes(normalized)) {
    return "pending";
  }

  if (["history", "historial"].includes(normalized)) {
    return "history";
  }

  return null;
}

function registerAndroidClient(documento: string) {
  try {
    window.FinserPayAndroid?.registerClient?.(documento);
  } catch {
    // Android bridge is optional; web browsers continue normally.
  }
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("57") && digits.length === 12 ? digits.slice(2) : digits;
}

function formatNequiPhone(value: string) {
  return normalizePhone(value).slice(0, 10);
}

function getPayableInstallments(credit: ClientCredit) {
  return credit.cuotas.filter((item) => item.saldoPendiente > 0);
}

function getPaidInstallments(credit: ClientCredit) {
  return credit.cuotas.filter(
    (item) => item.estado === "PAGO" || item.saldoPendiente <= 0
  );
}

function getFirstName(value: string) {
  const first = value.trim().split(/\s+/)[0] || "Cliente";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function stateLabel(estado: ClientCredit["estadoPago"]) {
  if (estado === "AL_DIA") return "Al dia";
  if (estado === "PAGADO") return "Pagado";
  return "En mora";
}

function stateClasses(estado: ClientCredit["estadoPago"]) {
  if (estado === "MORA") return "bg-[#fff1ed] text-[#b63b20]";
  if (estado === "PAGADO") return "bg-[#e8f7ef] text-[#087a4f]";
  return "bg-[#e8f7fb] text-[#087989]";
}

function installmentLabel(item: ClientInstallment) {
  if (item.saldoPendiente <= 0) return "Pagada";
  if (item.estaEnMora) return "Atrasada";
  return "Pendiente";
}

function installmentAmount(item: ClientInstallment) {
  return item.saldoPendiente > 0 ? item.saldoPendiente : item.valorProgramado;
}

function installmentsAmount(items: ClientInstallment[]) {
  return items.reduce((total, item) => total + Math.max(0, item.saldoPendiente), 0);
}

function installmentsRangeLabel(items: ClientInstallment[]) {
  if (!items.length) return "Sin cuotas";
  if (items.length === 1) return `Cuota ${items[0].numero}`;
  return `Cuotas ${items[0].numero} a ${items[items.length - 1].numero}`;
}

function creditTitle(credit: ClientCredit) {
  return credit.referenciaEquipo || `Credito ${credit.folio}`;
}

function creditDeviceImage(credit: ClientCredit) {
  const reference = String(credit.referenciaEquipo || "").toUpperCase();
  return /IPHONE|APPLE|IOS/.test(reference)
    ? "/assets/creditos/iphone-choice-light.png"
    : "/assets/creditos/android-choice-light.png";
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
}

function clientInitials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] || "F";
  const second = parts.length > 1 ? parts[1]?.[0] : parts[0]?.[1];
  return `${first}${second || "P"}`.toUpperCase();
}

function maskedImeiLabel(value?: string | null) {
  const normalized = String(value || "").replace(/\D/g, "");
  if (!normalized) return "IMEI no registrado";
  return `IMEI terminado en ${normalized.slice(-4)}`;
}

function creditStatusText(status: ClientCredit["estadoPago"]) {
  if (status === "MORA") return "Credito en mora";
  if (status === "PAGADO") return "Credito pagado";
  return "Credito al dia";
}

function compactDateLabel(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
  })
    .format(date)
    .replace(".", "")
    .toUpperCase();
}

function AppLogo({ large = false }: { large?: boolean }) {
  if (!large) {
    return (
      <div
        aria-label="FINSER PAY"
        className="flex items-baseline text-[24px] font-black leading-none tracking-[0.05em] text-white"
      >
        <span>FINSER</span>
        <span className="ml-2 text-[#A8F34A]">PAY</span>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      <Image
        src="/branding/finserpay-logo.jpg"
        alt="FINSER PAY"
        width={180}
        height={64}
        className="h-auto w-44 object-contain"
      />
    </div>
  );
}

function PrimaryButton({
  children,
  disabled,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-[#a7e66f] px-5 py-3 text-sm font-black text-[#102316] shadow-[0_10px_20px_rgba(111,194,70,0.22)] transition active:scale-[0.99] disabled:bg-[#d9dde4] disabled:text-[#7e8490] disabled:shadow-none"
    >
      {children}
    </button>
  );
}

function SectionTitle({
  title,
  aside,
}: {
  title: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-black text-[#171b22]">{title}</h2>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}

function EfectyLogo() {
  return (
    <div className="flex h-11 w-24 items-center justify-center rounded-md bg-[#f6d313] text-[18px] font-black italic text-[#1d2b57]">
      efecty
    </div>
  );
}

function BancolombiaLogo() {
  return (
    <div className="flex h-11 items-center gap-2 text-[#222]">
      <span className="grid h-8 w-8 gap-1">
        <span className="block h-2 w-7 -rotate-12 rounded-sm bg-[#222]" />
        <span className="block h-2 w-7 -rotate-12 rounded-sm bg-[#222]" />
        <span className="block h-2 w-7 -rotate-12 rounded-sm bg-[#222]" />
      </span>
      <span className="text-[22px] font-black tracking-normal">Bancolombia</span>
    </div>
  );
}

function WompiLogo() {
  return (
    <div className="flex h-11 items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-md bg-[#6b35ff] text-sm font-black text-white">
        W
      </span>
      <span className="text-[22px] font-black text-[#171b22]">Wompi</span>
    </div>
  );
}

export default function ClienteConsultaPage() {
  const [documento, setDocumento] = useState("");
  const [activeDocumento, setActiveDocumento] = useState("");
  const [items, setItems] = useState<ClientCredit[]>([]);
  const [openCreditId, setOpenCreditId] = useState<number | null>(null);
  const [selectedLimit, setSelectedLimit] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);
  const [payingCreditId, setPayingCreditId] = useState<number | null>(null);
  const [confirmPaymentCreditId, setConfirmPaymentCreditId] = useState<number | null>(
    null
  );
  const [confirmPaymentMode, setConfirmPaymentMode] =
    useState<ClientPaymentMode>("INSTALLMENTS");
  const [nequiPhone, setNequiPhone] = useState("");
  const [acceptWompiTerms, setAcceptWompiTerms] = useState(false);
  const [paymentReturn, setPaymentReturn] = useState<PaymentReturnNotice | null>(null);
  const [refreshingPayment, setRefreshingPayment] = useState(false);
  const [activePanel, setActivePanel] = useState<ExplorerPanel>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const consultar = useCallback(async (
    rawDocument: string,
    silent = false,
    preferredCreditId: number | null = null,
    preferredPanel: ExplorerPanel = null
  ) => {
    const normalized = normalizeDocument(rawDocument);

    if (normalized.length < 5) {
      setNotice({ text: "Ingresa una cedula valida.", tone: "red" });
      return;
    }

    try {
      setLoading(true);
      if (!silent) setNotice(null);

      const result = await requestJson<ClientCreditsResponse>(
        `/api/clientes/creditos?documento=${encodeURIComponent(normalized)}`
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo consultar la cedula");
      }

      const nextItems = result.data.items || [];
      const preferredOpenId =
        preferredCreditId && nextItems.some((item) => item.id === preferredCreditId)
          ? preferredCreditId
          : null;
      const nextOpenId = preferredOpenId ?? nextItems[0]?.id ?? null;

      localStorage.setItem(STORAGE_KEY, normalized);
      registerAndroidClient(normalized);
      setDocumento(normalized);
      setActiveDocumento(normalized);
      setItems(nextItems);
      setOpenCreditId(nextOpenId);
      setActivePanel(preferredPanel);
      setConfirmPaymentCreditId(null);
      setSelectedLimit(
        Object.fromEntries(
          nextItems
            .map((credit) => {
              const nextInstallment = getPayableInstallments(credit)[0];
              return nextInstallment ? [credit.id, nextInstallment.numero] : null;
            })
            .filter((item): item is [number, number] => Boolean(item))
        )
      );
      setNotice(
        silent || nextItems.length
          ? null
          : {
              text: "No encontramos creditos con esa cedula.",
              tone: "red",
            }
      );

      if (preferredPanel) {
        window.setTimeout(() => scrollToSection("explora-panel"), 120);
      }
    } catch (error) {
      setItems([]);
      setOpenCreditId(null);
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo consultar la cedula",
        tone: "red",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlDocument = normalizeDocument(params.get("documento") || "");
    const storedDocument = normalizeDocument(localStorage.getItem(STORAGE_KEY) || "");
    const nextDocument = urlDocument || storedDocument;
    const wompiReference =
      params.get("wompiReference") || params.get("reference") || "";
    const creditFromUrl = Math.trunc(Number(params.get("credito") || 0)) || null;
    const panelFromUrl = normalizePanel(
      params.get("panel") || params.get("focus") || params.get("accion")
    );

    if (wompiReference) {
      setPaymentReturn({
        reference: wompiReference,
        creditId: creditFromUrl,
        checkedAt: null,
      });
    }

    if (nextDocument) {
      setDocumento(nextDocument);
      void consultar(nextDocument, true, creditFromUrl, panelFromUrl);
    }
  }, [consultar]);

  const cuotasSeleccionadas = (credit: ClientCredit) => {
    const limit = selectedLimit[credit.id] || 0;
    return getPayableInstallments(credit).filter((item) => item.numero <= limit);
  };

  const selectPaymentLimit = (creditId: number, installmentNumber: number) => {
    setSelectedLimit((current) => ({
      ...current,
      [creditId]: installmentNumber,
    }));
  };

  const openWompiConfirm = (
    credit: ClientCredit,
    mode: ClientPaymentMode = "INSTALLMENTS"
  ) => {
    if (mode === "PAYOFF" && !credit.liquidacionAnticipada?.disponible) {
      setNotice({
        text:
          credit.liquidacionAnticipada?.motivo ||
          "Pagar hoy solo esta disponible cuando el credito esta al dia.",
        tone: "red",
      });
      return;
    }

    if (mode === "INSTALLMENTS" && !cuotasSeleccionadas(credit).length) {
      setNotice({ text: "Selecciona una cuota para pagar.", tone: "red" });
      return;
    }

    const suggestedPhone = formatNequiPhone(credit.clienteTelefono || nequiPhone);

    if (suggestedPhone) {
      setNequiPhone(suggestedPhone);
    }

    setAcceptWompiTerms(false);
    setNotice(null);
    setConfirmPaymentMode(mode);
    setConfirmPaymentCreditId(credit.id);
  };

  const payWithWompi = async (credit: ClientCredit) => {
    const cuotaNumeros = cuotasSeleccionadas(credit).map((item) => item.numero);
    const paymentMode = confirmPaymentMode;
    const cleanNequiPhone = formatNequiPhone(nequiPhone);

    if (paymentMode === "INSTALLMENTS" && !cuotaNumeros.length) {
      setNotice({ text: "Selecciona una cuota para pagar.", tone: "red" });
      return;
    }

    if (cleanNequiPhone.length !== 10) {
      setNotice({ text: "Ingresa un numero Nequi valido de 10 digitos.", tone: "red" });
      return;
    }

    if (!acceptWompiTerms) {
      setNotice({ text: "Acepta los terminos de Wompi para enviar el pago.", tone: "red" });
      return;
    }

    try {
      setPayingCreditId(credit.id);
      setConfirmPaymentCreditId(null);
      setNotice(null);

      const result = await requestJson<WompiCheckoutResponse>(
        "/api/clientes/wompi-checkout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            acceptWompiTerms,
            creditoId: credit.id,
            cuotaNumeros: paymentMode === "PAYOFF" ? [] : cuotaNumeros,
            documento: credit.clienteDocumento || activeDocumento || documento,
            nequiPhone: cleanNequiPhone,
            paymentMethod: "NEQUI",
            paymentMode:
              paymentMode === "PAYOFF" ? "LIQUIDACION_ANTICIPADA" : "CUOTAS",
          }),
        }
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo iniciar el pago");
      }

      if (result.data.paymentMode === "NEQUI_DIRECT") {
        setPaymentReturn({
          reference: result.data.reference || "",
          creditId: credit.id,
          checkedAt: null,
        });
        setConfirmPaymentMode("INSTALLMENTS");
        setNotice({
          text:
            "Solicitud enviada a Nequi. Abre la app Nequi y aprueba el pago; FINSER PAY lo aplicara automaticamente.",
          tone: "emerald",
        });
        setActivePanel("payments");
        window.setTimeout(() => {
          void refreshPaymentStatus();
        }, 9000);
        return;
      }

      if (result.data.paymentMode === "CHECKOUT_FALLBACK") {
        throw new Error(
          result.data.directError ||
            "No se pudo enviar la solicitud directa a Nequi."
        );
      }

      if (!result.data.checkoutUrl) {
        throw new Error(result.data.directError || "Wompi no entrego un enlace de pago");
      }

      window.location.assign(result.data.checkoutUrl);
    } catch (error) {
      setConfirmPaymentCreditId(credit.id);
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo iniciar el pago con Wompi",
        tone: "red",
      });
    } finally {
      setPayingCreditId(null);
    }
  };

  const forgetDocument = () => {
    localStorage.removeItem(STORAGE_KEY);
    setDocumento("");
    setActiveDocumento("");
    setItems([]);
    setOpenCreditId(null);
    setActivePanel(null);
    setConfirmPaymentCreditId(null);
    setConfirmPaymentMode("INSTALLMENTS");
    setAcceptWompiTerms(false);
    setNequiPhone("");
    setPaymentReturn(null);
    setNotice(null);
  };

  const returnHome = () => {
    setActivePanel(null);
    setConfirmPaymentCreditId(null);
    setConfirmPaymentMode("INSTALLMENTS");
    scrollToSection("cliente-dashboard");
  };

  const openPanel = (panel: Exclude<ExplorerPanel, null>) => {
    setConfirmPaymentCreditId(null);
    setConfirmPaymentMode("INSTALLMENTS");
    setActivePanel(panel);
    window.setTimeout(() => scrollToSection("explora-panel"), 80);
  };

  const selectCredit = (creditId: number) => {
    setOpenCreditId(creditId);
    setActivePanel(null);
    setConfirmPaymentCreditId(null);
    setConfirmPaymentMode("INSTALLMENTS");
    window.setTimeout(() => scrollToSection("cliente-dashboard"), 40);
  };

  const refreshPaymentStatus = useCallback(async () => {
    const targetDocument = activeDocumento || documento;

    if (!targetDocument) return;

    try {
      setRefreshingPayment(true);
      let paymentApplied = false;

      if (paymentReturn?.reference) {
        const params = new URLSearchParams({
          documento: targetDocument,
          reference: paymentReturn.reference,
        });
        const statusResult = await requestJson<WompiStatusResponse>(
          `/api/clientes/wompi-status?${params.toString()}`
        );

        if (!statusResult.ok) {
          throw new Error(
            statusResult.data.error || "No se pudo verificar el pago en Wompi"
          );
        }

        paymentApplied = Boolean(
          statusResult.data.applied || statusResult.data.alreadyProcessed
        );
      }

      await consultar(
        targetDocument,
        true,
        paymentReturn?.creditId ?? openCreditId,
        activePanel
      );

      if (paymentApplied) {
        setNotice({
          text: "Pago aprobado y aplicado. Tus cuotas e historial ya quedaron actualizados.",
          tone: "emerald",
        });
        setPaymentReturn(null);
        return;
      }

      setPaymentReturn((current) =>
        current
          ? {
              ...current,
              checkedAt: new Date().toISOString(),
            }
          : current
      );
    } finally {
      setRefreshingPayment(false);
    }
  }, [
    activeDocumento,
    activePanel,
    consultar,
    documento,
    openCreditId,
    paymentReturn?.creditId,
    paymentReturn?.reference,
  ]);

  useEffect(() => {
    if (!paymentReturn?.reference || !activeDocumento) return;

    let stopped = false;
    let inFlight = false;
    let attempts = 0;
    let timer: number | undefined;

    const pollPayment = async () => {
      if (stopped || inFlight) return;

      attempts += 1;
      inFlight = true;

      try {
        await refreshPaymentStatus();
      } finally {
        inFlight = false;

        if (!stopped && attempts < 30) {
          timer = window.setTimeout(pollPayment, attempts < 3 ? 6000 : 12000);
        }
      }
    };

    timer = window.setTimeout(pollPayment, 5000);

    return () => {
      stopped = true;

      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [activeDocumento, paymentReturn?.reference, refreshPaymentStatus]);

  const activeCredit = items.find((item) => item.id === openCreditId) || items[0] || null;
  const paidCount = activeCredit ? getPaidInstallments(activeCredit).length : 0;
  const payable = activeCredit ? getPayableInstallments(activeCredit) : [];
  const totalCount = activeCredit?.cuotas.length || 0;
  const progress = totalCount ? Math.round((paidCount / totalCount) * 100) : 0;
  const nextInstallment = payable[0] || null;
  const overdueInstallments = payable.filter((item) => item.estaEnMora);
  const upcomingInstallments = payable.filter((item) => !item.estaEnMora);
  const nextUpcomingInstallment = upcomingInstallments[0] || null;
  const futureInstallments = upcomingInstallments.slice(1);
  const pendingAmount = installmentsAmount(payable);
  const overdueAmount = installmentsAmount(overdueInstallments);
  const selectedInstallments = activeCredit ? cuotasSeleccionadas(activeCredit) : [];
  const selectedAmount = installmentsAmount(selectedInstallments);
  const selectedPaymentLabel = installmentsRangeLabel(selectedInstallments);
  const selectedPaymentLimit =
    activeCredit && nextInstallment
      ? selectedLimit[activeCredit.id] || nextInstallment.numero
      : 0;
  const selectedPaymentIndex = payable.findIndex(
    (item) => item.numero === selectedPaymentLimit
  );
  const selectedPaymentStep = selectedPaymentIndex >= 0 ? selectedPaymentIndex : 0;
  const canSubmit = !loading;
  const firstName = activeCredit ? getFirstName(activeCredit.clienteNombre) : "";
  const paymentReference = activeCredit?.clienteDocumento || activeDocumento || documento;
  const lastHistoryPayment = activeCredit?.abonos[0] || null;
  const historyPaymentCount = activeCredit?.abonos.length || 0;
  const historyPaymentCountLabel = `${historyPaymentCount} ${
    historyPaymentCount === 1 ? "pago" : "pagos"
  }`;
  const historyTotalPaid = activeCredit?.totalPagado || 0;
  const historyBalance = activeCredit?.saldoPendiente ?? pendingAmount;
  const confirmCredit =
    items.find((item) => item.id === confirmPaymentCreditId) || null;
  const confirmInstallments = confirmCredit ? cuotasSeleccionadas(confirmCredit) : [];
  const confirmPayoff =
    confirmPaymentMode === "PAYOFF" ? confirmCredit?.liquidacionAnticipada : null;
  const confirmAmount =
    confirmPaymentMode === "PAYOFF"
      ? Number(confirmPayoff?.capitalPendiente || 0)
      : installmentsAmount(confirmInstallments);
  const confirmPaymentLabel =
    confirmPaymentMode === "PAYOFF"
      ? "Liquidacion anticipada"
      : installmentsRangeLabel(confirmInstallments);
  const confirmPaymentReference =
    confirmCredit?.clienteDocumento || activeDocumento || documento;
  const activePayoff = activeCredit?.liquidacionAnticipada || null;
  const canPayToday =
    activeCredit?.estadoPago === "AL_DIA" && Boolean(activePayoff?.disponible);
  const profileInitials = activeCredit
    ? clientInitials(activeCredit.clienteNombre)
    : "FP";
  const nextDueLabel = nextInstallment
    ? compactDateLabel(nextInstallment.fechaVencimiento)
    : "-";
  const lastPaymentDateLabel = lastHistoryPayment
    ? compactDateLabel(lastHistoryPayment.fechaAbono)
    : "Sin pagos";
  const progressCircle = 2 * Math.PI * 72;
  const progressOffset = progressCircle - (progressCircle * Math.min(progress, 100)) / 100;

  if (!items.length) {
    return (
      <main className="client-login-page min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#f8f8f7] text-[#f7f8f8]">
        <div className="mx-auto w-full max-w-[430px] min-w-0 overflow-x-hidden bg-[#090b0d] shadow-[0_0_60px_rgba(0,0,0,0.28)]">
          <section className="client-login-hero relative h-[54dvh] w-full overflow-hidden px-6 pb-5 pt-[max(1rem,env(safe-area-inset-top))] [@media(max-height:779px)]:h-[49dvh] [@media(min-height:900px)]:h-[55dvh]">
            <div className="pointer-events-none absolute -right-16 top-14 h-48 w-48 rounded-full border border-[#a9df35]/20" />
            <div className="pointer-events-none absolute -right-10 top-20 h-32 w-32 rounded-full border border-[#a9df35]/10" />
            <header className="flex items-center justify-between">
              <div
                aria-label="FINSER PAY"
                className="flex items-baseline text-[25px] font-black leading-none tracking-[0.08em] text-white max-[740px]:text-[22px]"
              >
                <span>FINSER</span>
                <span className="ml-2 text-[#A8F34A]">PAY</span>
              </div>
              <FinserSupportLink
                className="grid h-12 w-12 place-items-center rounded-full border border-[#d9dde2]/80 text-[#f6f7f8] transition hover:border-[#A8F34A] hover:text-[#A8F34A]"
              >
                <CircleHelp className="h-7 w-7" strokeWidth={1.7} />
              </FinserSupportLink>
            </header>

            <div className="client-login-hero-copy mt-8 [@media(max-height:779px)]:mt-5">
              <div className="flex items-center gap-3 text-[12px] font-black uppercase tracking-[0.26em] text-[#A8F34A] max-[740px]:text-[11px]">
                <span className="h-3 w-3 rounded-full bg-[#A8F34A] shadow-[0_0_18px_rgba(168,243,74,0.65)]" />
                Portal de clientes
              </div>
              <h1 className="client-login-title mt-4 max-w-[350px] font-serif text-[33px] font-black leading-[0.98] tracking-[-0.03em] text-white [@media(max-height:779px)]:mt-3 [@media(max-height:779px)]:text-[30px]">
                Tu crédito,
                <br />
                siempre contigo.
              </h1>
              <p className="client-login-description mt-3 max-w-[230px] text-[15px] font-medium leading-6 text-[#b8bbc1] [@media(max-height:779px)]:mt-2 [@media(max-height:779px)]:text-[14px] [@media(max-height:779px)]:leading-5">
                Consulta tus cuotas, pagos y saldo cuando quieras.
              </p>
            </div>

            <div className="client-login-shield-wrap absolute bottom-3 right-7 grid place-items-center [@media(max-height:779px)]:bottom-2 [@media(max-height:779px)]:right-6">
              <div className="client-login-shield relative grid h-[94px] w-[94px] place-items-center rounded-full border border-[#A8F34A]/45 [@media(max-height:779px)]:h-[76px] [@media(max-height:779px)]:w-[76px]">
                <div className="absolute -right-1 top-6 h-2.5 w-2.5 rounded-full bg-[#A8F34A] shadow-[0_0_14px_rgba(168,243,74,0.8)]" />
                <div className="client-login-shield-core grid h-[58px] w-[58px] place-items-center rounded-full bg-white/5 [@media(max-height:779px)]:h-[48px] [@media(max-height:779px)]:w-[48px]">
                  <Image
                    src="/icons/finserpay-client-512.png"
                    alt="Emblema FINSER PAY"
                    width={72}
                    height={72}
                    priority
                    className="client-login-shield-image h-[46px] w-[46px] rounded-full object-cover [@media(max-height:779px)]:h-[38px] [@media(max-height:779px)]:w-[38px]"
                  />
                </div>
              </div>
              <div className="client-login-secure mt-2 flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-white/72 [@media(max-height:779px)]:mt-1.5 [@media(max-height:779px)]:text-[10px]">
                <LockKeyhole className="h-3.5 w-3.5" />
                Acceso seguro
              </div>
            </div>
          </section>

          <section className="client-login-sheet relative z-10 -mt-5 w-full max-w-full rounded-t-[38px] bg-[#f8f8f7] px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 text-[#121417] [@media(max-height:779px)]:pt-5 [@media(min-height:900px)]:pt-7">
            <div>
              <h2 className="text-[26px] font-black leading-tight tracking-[0.01em] [@media(min-height:900px)]:text-[28px]">
                Consulta tu crédito
              </h2>
              <p className="mt-2 text-[14px] font-medium leading-6 text-[#666a71]">
                Ingresa tu número de documento para continuar.
              </p>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                const formDocument = String(formData.get("documento") || documento);
                void consultar(formDocument);
              }}
              className="client-login-form mt-5 [@media(min-height:900px)]:mt-6"
            >
              <label
                htmlFor="documento"
                className="sr-only"
              >
                Documento de identidad
              </label>
              <div className="client-login-field flex h-[58px] w-full max-w-full items-center rounded-lg border border-[#cfd2d6] bg-white px-2 shadow-[0_8px_22px_rgba(18,20,23,0.04)] focus-within:border-[#171a1e] focus-within:ring-1 focus-within:ring-[#171a1e] [@media(min-height:900px)]:h-[62px]">
                <div className="flex h-11 shrink-0 items-center gap-2 border-r border-[#d7d9dd] px-2.5 text-[17px] font-black text-[#24272c]">
                  CC
                  <ChevronDown className="h-4 w-4" strokeWidth={2.2} />
                </div>
                <input
                  id="documento"
                  name="documento"
                  defaultValue={documento}
                  onInput={(event) => {
                    const normalized = normalizeDocument(event.currentTarget.value);
                    if (event.currentTarget.value !== normalized) {
                      event.currentTarget.value = normalized;
                    }
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="Número de cédula"
                  className="min-w-0 flex-1 bg-transparent px-3 text-[16px] font-bold text-[#1f2328] outline-none placeholder:font-semibold placeholder:text-[#a3a6ac]"
                />
                <UserRound className="h-7 w-7 shrink-0 text-[#24282e]" strokeWidth={1.7} />
              </div>

              <button
                disabled={!canSubmit}
                type="submit"
                className="client-login-submit mt-4 flex h-[58px] w-full max-w-full min-w-0 items-center justify-between rounded-lg bg-[#A8F34A] px-5 text-[21px] font-black text-[#0D1112] shadow-[0_14px_28px_rgba(168,243,74,0.22)] transition hover:bg-[#b7ff5c] disabled:cursor-wait disabled:opacity-60 [@media(min-height:900px)]:h-[62px]"
              >
                <span>{loading ? "Consultando..." : "Continuar"}</span>
                <ArrowRight className="h-9 w-9 text-[#0D1112]" strokeWidth={1.8} />
              </button>
            </form>

            {notice ? (
              <div
                role={notice.tone === "red" ? "alert" : "status"}
                className={[
                  "mt-4 rounded-lg border px-4 py-3 text-sm font-bold leading-5",
                  notice.tone === "emerald"
                    ? "border-[#d5e8b0] bg-[#f2f8e8] text-[#43631f]"
                    : "border-red-200 bg-red-50 text-red-700",
                ].join(" ")}
              >
                {notice.text}
              </div>
            ) : null}

            <div className="client-login-protection mt-4 flex items-center justify-center gap-3 text-[13px] font-medium text-[#656970] [@media(min-height:900px)]:mt-5">
              <LockKeyhole className="h-5 w-5" strokeWidth={1.7} />
              Tus datos están protegidos
            </div>

            <footer className="client-login-footer mt-5 border-t border-[#d9d8d2] pt-4 text-center [@media(min-height:900px)]:mt-6 [@media(min-height:900px)]:pt-5">
              <FinserSupportLink
                className="text-[15px] font-medium text-[#24272c] underline decoration-[#A8F34A] decoration-2 underline-offset-4 [@media(min-height:900px)]:text-[16px]"
              >
                ¿Necesitas ayuda?
              </FinserSupportLink>
              <p className="client-login-brand mt-4 text-[12px] font-semibold text-[#8a8e94]">
                <span className="font-black tracking-[0.04em]">FINSER PAY</span>
                <span className="px-2">·</span>
                Portal seguro
              </p>
            </footer>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main
      id="cliente-dashboard"
      className="min-h-[100svh] overflow-x-hidden bg-[#F4F3EE] text-[#111317]"
    >
      <div className="mx-auto min-h-[100svh] w-full max-w-[430px] bg-[#F4F3EE] px-5 pb-[calc(126px+env(safe-area-inset-bottom))] pt-[calc(18px+env(safe-area-inset-top))] shadow-[0_0_60px_rgba(13,17,18,0.16)]">
        <header className="-mx-5 -mt-[calc(18px+env(safe-area-inset-top))] flex items-center justify-between gap-4 bg-[#0D1112] px-6 pb-5 pt-[calc(28px+env(safe-area-inset-top))]">
          <AppLogo />
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Notificaciones"
              onClick={() => openPanel("history")}
              className="relative grid h-11 w-11 place-items-center rounded-full text-white active:bg-white/10"
            >
              <Bell className="h-7 w-7 stroke-[2.1]" />
              <span className="absolute right-2 top-2 h-3 w-3 rounded-full bg-[#A8F34A] shadow-[0_0_14px_rgba(168,243,74,0.8)]" />
            </button>
            <button
              type="button"
              aria-label="Cambiar cliente"
              onClick={forgetDocument}
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-white/10 text-[18px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] active:bg-white/15"
            >
              {profileInitials}
            </button>
          </div>
        </header>

        <div>
          {notice ? (
            <div
              className={[
                "mt-4 rounded-lg border px-4 py-3 text-sm font-bold",
                notice.tone === "emerald"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-red-200 bg-red-50 text-red-700",
              ].join(" ")}
            >
              {notice.text}
            </div>
          ) : null}

          {paymentReturn ? (
            <section className="mt-4 rounded-lg border border-[#dfece0] bg-white p-4 shadow-sm">
              <div className="grid grid-cols-[38px_1fr] gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-md bg-[#f1fbeb] text-sm font-black text-[#3f7d2d]">
                  W
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-black text-[#171b22]">
                    Pago enviado a validacion
                  </p>
                  <p className="mt-1 text-xs font-bold leading-5 text-[#6d7480]">
                    La app esta validando Wompi automaticamente. Cuando el pago
                    quede aprobado, tus cuotas e historial se actualizaran aqui.
                  </p>
                  <p className="mt-2 truncate text-[11px] font-black uppercase text-[#8a919d]">
                    Ref. {paymentReturn.reference}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-3">
                <p className="min-w-0 truncate text-xs font-bold text-[#7d8490]">
                  {paymentReturn.checkedAt
                    ? `Ultima revision ${new Date(
                        paymentReturn.checkedAt
                      ).toLocaleTimeString("es-CO", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : "La app revisara automaticamente."}
                </p>
                <button
                  type="button"
                  onClick={() => void refreshPaymentStatus()}
                  disabled={refreshingPayment || loading}
                  className="min-h-10 rounded-lg bg-[#a7e66f] px-3 text-xs font-black text-[#102316] disabled:bg-[#d9dde4] disabled:text-[#7e8490]"
                >
                  {refreshingPayment ? "Revisando" : "Revisar ahora"}
                </button>
              </div>
            </section>
          ) : null}

          {activeCredit ? (
            <>
              <section className="-mx-5 bg-[#0D1112] px-6 pb-2 pt-4">
                <h1 className="text-[27px] font-medium leading-tight text-white/68">
                  Hola, {firstName}
                </h1>
                <span
                  className={[
                    "mt-5 inline-flex min-h-11 items-center gap-3 text-[18px] font-medium",
                    activeCredit.estadoPago === "MORA"
                      ? "text-red-200"
                      : "text-[#A8F34A]",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "h-4 w-4 rounded-full",
                      activeCredit.estadoPago === "MORA"
                        ? "bg-red-400 shadow-[0_0_18px_rgba(248,113,113,0.55)]"
                        : "bg-[#A8F34A] shadow-[0_0_18px_rgba(168,243,74,0.75)]",
                    ].join(" ")}
                  />
                  {creditStatusText(activeCredit.estadoPago)}
                </span>
              </section>

              <section className="-mx-5 overflow-hidden rounded-b-[42px] bg-[#0D1112] px-6 pb-20 pt-7 text-white shadow-[0_20px_44px_rgba(13,17,18,0.22)]">
                <div className="grid grid-cols-[minmax(138px,0.92fr)_minmax(0,1fr)] items-center gap-5">
                  <div className="relative mx-auto h-[166px] w-[166px]">
                    <svg
                      viewBox="0 0 168 168"
                      className="h-full w-full -rotate-90"
                      aria-hidden="true"
                    >
                      <circle
                        cx="84"
                        cy="84"
                        r="72"
                        fill="none"
                        stroke="rgba(255,255,255,0.13)"
                        strokeWidth="12"
                      />
                      <circle
                        cx="84"
                        cy="84"
                        r="72"
                        fill="none"
                        stroke="#A8F34A"
                        strokeLinecap="round"
                        strokeWidth="12"
                        strokeDasharray={progressCircle}
                        strokeDashoffset={progressOffset}
                        className="drop-shadow-[0_0_14px_rgba(168,243,74,0.55)]"
                      />
                    </svg>
                    <div className="absolute inset-0 grid place-items-center text-center">
                      <div>
                        <p className="font-serif text-[56px] leading-none tracking-[-0.04em] text-[#fbfaf5]">
                          {progress}
                          <span className="ml-1 font-sans text-[23px]">%</span>
                        </p>
                        <p className="mt-2 text-[18px] font-semibold text-white/58">
                          {paidCount} de {totalCount} cuotas
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold uppercase tracking-[0.05em] text-white/42">
                      Proxima cuota
                    </p>
                    <p className="mt-4 break-words font-serif text-[50px] leading-none tracking-[-0.04em] text-[#fbfaf5]">
                      {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                    </p>
                    <p className="mt-4 text-[21px] font-medium text-white/58">
                      Vence{" "}
                      <span className="font-black text-[#A8F34A]">
                        {nextDueLabel.toLowerCase()}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="relative z-10 mt-10 text-center">
                  <button
                    type="button"
                    onClick={() => openWompiConfirm(activeCredit)}
                    disabled={!payable.length || payingCreditId === activeCredit.id}
                    className="mx-auto inline-flex min-h-[64px] w-full max-w-[308px] items-center justify-center gap-5 rounded-full bg-[#A8F34A] px-6 text-[22px] font-black text-[#0D1112] shadow-[0_18px_44px_rgba(168,243,74,0.34)] transition active:scale-[0.98] disabled:bg-white/18 disabled:text-white/45"
                  >
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#0D1112] text-[#A8F34A]">
                      <CreditCard className="h-7 w-7" />
                    </span>
                    {payingCreditId === activeCredit.id ? "Abriendo" : "Pagar ahora"}
                  </button>

                  {canPayToday && activePayoff ? (
                    <button
                      type="button"
                      onClick={() => openWompiConfirm(activeCredit, "PAYOFF")}
                      disabled={payingCreditId === activeCredit.id}
                      className="mt-5 min-h-11 text-[16px] font-medium text-white/54 underline decoration-[#A8F34A] decoration-dotted underline-offset-4 disabled:opacity-50"
                    >
                      Liquidar por{" "}
                      <span className="font-black text-[#A8F34A]">
                        {money(activePayoff.capitalPendiente)}
                      </span>
                    </button>
                  ) : null}
                </div>
              </section>

              {items.length > 1 ? (
                <section className="-mt-10 mb-7">
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {items.map((credit, index) => {
                      const isActive = credit.id === activeCredit.id;
                      const creditPaid = getPaidInstallments(credit).length;
                      const creditTotal = credit.cuotas.length;
                      const creditNext = getPayableInstallments(credit)[0] || null;

                      return (
                        <button
                          key={credit.id}
                          type="button"
                          onClick={() => selectCredit(credit.id)}
                          className={[
                            "grid min-h-[74px] min-w-[210px] grid-cols-[1fr_auto] gap-3 rounded-[22px] px-4 py-3 text-left transition active:scale-[0.99]",
                            isActive
                              ? "bg-[#0D1112] text-white"
                              : "bg-white/70 text-[#171b22]",
                          ].join(" ")}
                        >
                          <span className="min-w-0">
                            <span className="block text-[11px] font-black uppercase tracking-[0.12em] text-[#A8F34A]">
                              Credito {index + 1}
                            </span>
                            <span className="mt-1 block truncate text-sm font-black">
                              {creditTitle(credit)}
                            </span>
                            <span className="mt-1 block truncate text-xs font-semibold opacity-65">
                              {maskedImeiLabel(credit.imei || credit.deviceUid)}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span
                              className={[
                                "inline-flex rounded-full px-2.5 py-1 text-[11px] font-black",
                                isActive
                                  ? "bg-[#A8F34A] text-[#0D1112]"
                                  : "bg-[#eef1f5] text-[#626976]",
                              ].join(" ")}
                            >
                              {isActive ? "Activo" : "Ver"}
                            </span>
                            <span className="mt-2 block text-xs font-black">
                              {creditPaid}/{creditTotal}
                            </span>
                            <span className="mt-1 block text-xs font-bold opacity-70">
                              {creditNext ? money(creditNext.saldoPendiente) : "Al dia"}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <button
                type="button"
                onClick={() => openPanel("pending")}
                className="mt-7 grid min-h-[112px] w-full grid-cols-[82px_minmax(0,1fr)_44px] items-center gap-5 text-left active:scale-[0.99]"
              >
                <span className="grid h-[82px] w-[82px] place-items-center overflow-hidden rounded-[22px] bg-white shadow-[0_14px_30px_rgba(13,17,18,0.06)]">
                  <Image
                    src={creditDeviceImage(activeCredit)}
                    alt=""
                    width={76}
                    height={76}
                    aria-hidden="true"
                    className="h-[76px] w-[76px] object-contain"
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-[23px] font-medium text-[#5c5b57]">
                    Tu credito
                  </span>
                  <span className="mt-2 block truncate text-[22px] font-black uppercase leading-tight text-[#0D1112]">
                    {creditTitle(activeCredit)}
                  </span>
                  <span className="mt-2 block truncate text-[18px] font-medium text-[#6b6964]">
                    Saldo{" "}
                    <strong className="font-serif text-[23px] text-[#0D1112]">
                      {money(activeCredit.saldoPendiente)}
                    </strong>
                  </span>
                </span>
                <span className="grid h-11 w-11 place-items-center rounded-full bg-white/70 text-[#0D1112]">
                  <ChevronRight className="h-7 w-7" />
                </span>
              </button>

              <section className="mt-9">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-[30px] font-black tracking-[-0.02em] text-[#0D1112]">
                    Actividad
                  </h2>
                  <div className="flex items-center gap-3 text-[16px] font-medium text-[#222524]">
                    <button
                      type="button"
                      onClick={() => openPanel("pending")}
                      className="inline-flex min-h-11 items-center gap-2"
                    >
                      <CalendarDays className="h-6 w-6" />
                      Calendario
                    </button>
                    <span className="h-6 w-px bg-[#cfccc4]" />
                    <FinserSupportLink
                      className="inline-flex min-h-11 items-center gap-2"
                    >
                      <Headphones className="h-6 w-6" />
                      Soporte
                    </FinserSupportLink>
                  </div>
                </div>

                <div className="mt-7 grid gap-0">
                  <button
                    type="button"
                    onClick={() => openPanel("pending")}
                    className="grid min-h-[86px] grid-cols-[54px_minmax(0,1fr)_auto] gap-4 text-left"
                  >
                    <span className="relative flex justify-center">
                      <span className="absolute top-9 h-[86px] w-px bg-[#d8d5cc]" />
                      <span className="relative z-10 mt-1 grid h-9 w-9 place-items-center rounded-full border-4 border-[#F4F3EE] bg-[#A8F34A] ring-2 ring-[#76b82f]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[21px] font-black text-[#0D1112]">
                        {nextDueLabel.toLowerCase()} · Cuota{" "}
                        {nextInstallment?.numero || paidCount}
                      </span>
                      <span className="mt-2 block text-[17px] font-medium text-[#6d6a64]">
                        {nextInstallment?.estaEnMora ? "En mora" : "Programada"}
                      </span>
                    </span>
                    <span className="pt-2 text-right font-serif text-[24px] font-black text-[#0D1112]">
                      {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openPanel("history")}
                    className="grid min-h-[86px] grid-cols-[54px_minmax(0,1fr)_auto] gap-4 text-left"
                  >
                    <span className="flex justify-center">
                      <span className="mt-1 grid h-9 w-9 place-items-center rounded-full border-4 border-[#F4F3EE] bg-[#d7d5cf] ring-2 ring-[#858580]">
                        <span className="h-4 w-4 rounded-full bg-[#F4F3EE]" />
                      </span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[21px] font-black text-[#0D1112]">
                        {lastPaymentDateLabel.toLowerCase()}
                        {lastHistoryPayment ? ` · ${lastHistoryPayment.metodoPago}` : ""}
                      </span>
                      <span className="mt-2 block text-[17px] font-medium text-[#4f8f22]">
                        {lastHistoryPayment ? "Pago confirmado" : "Sin pagos registrados"}
                      </span>
                    </span>
                    <span className="pt-2 text-right font-serif text-[24px] font-black text-[#0D1112]">
                      {lastHistoryPayment ? money(lastHistoryPayment.valor) : money(0)}
                    </span>
                  </button>
                </div>
              </section>

              {activePanel ? (
                <section
                  id="explora-panel"
                  className="mt-5 rounded-lg border border-[#e6e8ee] bg-white p-4 shadow-sm"
                >
                  {activePanel === "pending" ? (
                    <>
                      <SectionTitle
                        title="Pagos pendientes"
                        aside={
                          <span className="text-xs font-black text-[#7d8490]">
                            {paidCount}/{totalCount}
                          </span>
                        }
                      />
                      <div className="mt-3 rounded-lg bg-[#111317] p-4 text-white">
                        <p className="text-xs font-black uppercase text-white/55">
                          Saldo pendiente
                        </p>
                        <p className="mt-1 text-3xl font-black leading-none">
                          {money(pendingAmount)}
                        </p>
                        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                          <div className="rounded-md bg-white/8 px-2 py-2">
                            <p className="text-[11px] font-bold text-white/55">
                              Vencidas
                            </p>
                            <p className="mt-1 text-sm font-black">
                              {overdueInstallments.length}
                            </p>
                          </div>
                          <div className="rounded-md bg-white/8 px-2 py-2">
                            <p className="text-[11px] font-bold text-white/55">
                              Proxima
                            </p>
                            <p className="mt-1 truncate text-sm font-black">
                              {nextUpcomingInstallment
                                ? dateLabel(nextUpcomingInstallment.fechaVencimiento)
                                : "-"}
                            </p>
                          </div>
                          <div className="rounded-md bg-white/8 px-2 py-2">
                            <p className="text-[11px] font-bold text-white/55">
                              Seleccion
                            </p>
                            <p className="mt-1 truncate text-sm font-black">
                              {selectedPaymentLabel}
                            </p>
                          </div>
                        </div>
                      </div>

                      {!payable.length ? (
                        <p className="mt-3 rounded-lg bg-[#f6f7f9] px-4 py-3 text-sm font-bold text-[#626976]">
                          No tienes pagos pendientes.
                        </p>
                      ) : null}

                      {overdueInstallments.length ? (
                        <div className="mt-4">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-black text-[#b63b20]">
                              Vencidas
                            </h3>
                            <span className="rounded-md bg-[#fff1ed] px-2 py-1 text-xs font-black text-[#b63b20]">
                              {money(overdueAmount)}
                            </span>
                          </div>
                          <div className="mt-2 grid gap-2">
                            {overdueInstallments.map((item) => (
                              <button
                                key={item.numero}
                                type="button"
                                onClick={() =>
                                  selectPaymentLimit(activeCredit.id, item.numero)
                                }
                                className={[
                                  "grid min-h-16 grid-cols-[1fr_auto] items-center gap-3 rounded-lg border px-3 py-2 text-left",
                                  item.numero === selectedPaymentLimit
                                    ? "border-[#a7e66f] bg-[#f5ffef]"
                                    : "border-[#fde1d8] bg-[#fff8f6]",
                                ].join(" ")}
                              >
                                <span className="min-w-0">
                                  <span className="block text-sm font-black text-[#252a35]">
                                    Cuota {item.numero}
                                  </span>
                                  <span className="mt-1 block text-xs font-bold text-[#8a919d]">
                                    {dateLabel(item.fechaVencimiento)} -{" "}
                                    {installmentLabel(item)}
                                  </span>
                                </span>
                                <span className="shrink-0 text-right text-sm font-black text-[#252a35]">
                                  {money(installmentAmount(item))}
                                  {item.numero === selectedPaymentLimit ? (
                                    <span className="mt-1 block text-[11px] font-black text-[#4f9b35]">
                                      Seleccionada
                                    </span>
                                  ) : null}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {nextUpcomingInstallment ? (
                        <div className="mt-4">
                          <h3 className="text-sm font-black text-[#3f7d2d]">
                            Proxima cuota
                          </h3>
                          <button
                            type="button"
                            onClick={() =>
                              selectPaymentLimit(
                                activeCredit.id,
                                nextUpcomingInstallment.numero
                              )
                            }
                            className={[
                              "mt-2 grid min-h-16 w-full grid-cols-[1fr_auto] items-center gap-3 rounded-lg border px-3 py-2 text-left",
                              nextUpcomingInstallment.numero === selectedPaymentLimit
                                ? "border-[#a7e66f] bg-[#f5ffef]"
                                : "border-[#dfece0] bg-[#fbfff8]",
                            ].join(" ")}
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-black text-[#252a35]">
                                Cuota {nextUpcomingInstallment.numero}
                              </span>
                              <span className="mt-1 block text-xs font-bold text-[#8a919d]">
                                {dateLabel(nextUpcomingInstallment.fechaVencimiento)} -{" "}
                                {installmentLabel(nextUpcomingInstallment)}
                              </span>
                            </span>
                            <span className="shrink-0 text-right text-sm font-black text-[#252a35]">
                              {money(installmentAmount(nextUpcomingInstallment))}
                              {nextUpcomingInstallment.numero ===
                              selectedPaymentLimit ? (
                                <span className="mt-1 block text-[11px] font-black text-[#4f9b35]">
                                  Seleccionada
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </div>
                      ) : null}

                      {futureInstallments.length ? (
                        <div className="mt-4">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-black text-[#252a35]">
                              Futuras
                            </h3>
                            <span className="text-xs font-black text-[#7d8490]">
                              {futureInstallments.length} cuotas
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            {futureInstallments.map((item) => (
                              <button
                                key={item.numero}
                                type="button"
                                onClick={() =>
                                  selectPaymentLimit(activeCredit.id, item.numero)
                                }
                                className={[
                                  "min-h-16 rounded-lg border px-2 py-2 text-left",
                                  item.numero === selectedPaymentLimit
                                    ? "border-[#a7e66f] bg-[#f5ffef]"
                                    : "border-[#edf0f4] bg-[#fbfcfd]",
                                ].join(" ")}
                              >
                                <span className="block text-xs font-black text-[#252a35]">
                                  C{item.numero}
                                </span>
                                <span className="mt-1 block text-[11px] font-bold text-[#8a919d]">
                                  {dateLabel(item.fechaVencimiento)}
                                </span>
                                <span className="mt-1 block truncate text-[11px] font-black text-[#252a35]">
                                  {money(installmentAmount(item))}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {activePanel === "payments" ? (
                    <>
                      <SectionTitle title="Medios de pago" />
                      <div className="mt-3 grid gap-3">
                        <div className="rounded-lg border border-[#dfece0] bg-[#f8fff4] p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-xs font-black uppercase text-[#5f8f44]">
                                Valor a pagar
                              </p>
                              <p className="mt-1 text-3xl font-black leading-none text-[#171b22]">
                                {money(selectedAmount)}
                              </p>
                              <p className="mt-2 text-sm font-bold text-[#67706b]">
                                {selectedPaymentLabel}
                              </p>
                            </div>
                            <span
                              className={[
                                "shrink-0 rounded-md px-2 py-1 text-xs font-black",
                                stateClasses(activeCredit.estadoPago),
                              ].join(" ")}
                            >
                              {stateLabel(activeCredit.estadoPago)}
                            </span>
                          </div>

                          {payable.length > 1 ? (
                            <div className="mt-4">
                              <p className="text-xs font-black uppercase text-[#7d8490]">
                                Ajustar cuotas
                              </p>
                              <div className="mt-2 grid grid-cols-[40px_1fr_40px] items-center gap-2">
                                <button
                                  type="button"
                                  aria-label="Pagar menos cuotas"
                                  disabled={selectedPaymentStep <= 0}
                                  onClick={() => {
                                    const previous = payable[selectedPaymentStep - 1];
                                    if (previous) {
                                      selectPaymentLimit(activeCredit.id, previous.numero);
                                    }
                                  }}
                                  className="grid h-10 w-10 place-items-center rounded-lg border border-[#dfe5dd] bg-white text-xl font-black text-[#303743] disabled:text-[#c2c8d0]"
                                >
                                  -
                                </button>
                                <div className="min-w-0 rounded-lg bg-white px-3 py-2 text-center">
                                  <p className="truncate text-sm font-black text-[#171b22]">
                                    {selectedPaymentLabel}
                                  </p>
                                  <p className="mt-1 text-[11px] font-bold text-[#7d8490]">
                                    {selectedInstallments.length}{" "}
                                    {selectedInstallments.length === 1
                                      ? "cuota seleccionada"
                                      : "cuotas seleccionadas"}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  aria-label="Pagar mas cuotas"
                                  disabled={selectedPaymentStep >= payable.length - 1}
                                  onClick={() => {
                                    const next = payable[selectedPaymentStep + 1];
                                    if (next) {
                                      selectPaymentLimit(activeCredit.id, next.numero);
                                    }
                                  }}
                                  className="grid h-10 w-10 place-items-center rounded-lg border border-[#a7e66f] bg-[#a7e66f] text-xl font-black text-[#102316] disabled:border-[#dfe5dd] disabled:bg-white disabled:text-[#c2c8d0]"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        {canPayToday && activePayoff ? (
                          <div className="rounded-lg border border-[#cceec0] bg-[#f7fff2] p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-black uppercase text-[#4f8735]">
                                  Recoger deuda
                                </p>
                                <p className="mt-1 text-3xl font-black leading-none text-[#171b22]">
                                  {money(activePayoff.capitalPendiente)}
                                </p>
                                <p className="mt-2 text-sm font-bold text-[#67706b]">
                                  Liquida el capital pendiente y cierra el credito.
                                </p>
                              </div>
                            </div>
                            <div className="mt-4">
                              <PrimaryButton
                                disabled={payingCreditId === activeCredit.id}
                                onClick={() => openWompiConfirm(activeCredit, "PAYOFF")}
                              >
                                {payingCreditId === activeCredit.id
                                  ? "Abriendo Wompi..."
                                  : `Recoger deuda ${money(activePayoff.capitalPendiente)}`}
                              </PrimaryButton>
                            </div>
                          </div>
                        ) : null}

                        <div className="rounded-lg border border-[#edf0f4] bg-[#fffdf1] p-4">
                          <EfectyLogo />
                          <div className="mt-4 grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-xs font-black uppercase text-[#7d8490]">
                                Convenio
                              </p>
                              <p className="mt-1 text-lg font-black text-[#171b22]">
                                113950
                              </p>
                            </div>
                            <div>
                              <p className="text-xs font-black uppercase text-[#7d8490]">
                                Referencia
                              </p>
                              <p className="mt-1 break-all text-lg font-black text-[#171b22]">
                                {paymentReference}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-lg border border-[#edf0f4] bg-white p-4">
                          <BancolombiaLogo />
                          <div className="mt-4">
                            <p className="text-xs font-black uppercase text-[#7d8490]">
                              Cuenta de ahorros
                            </p>
                            <p className="mt-1 text-2xl font-black text-[#171b22]">
                              71800000458
                            </p>
                          </div>
                        </div>

                        <div className="rounded-lg border border-[#edf0f4] bg-white p-4">
                          <WompiLogo />
                          <p className="mt-3 text-sm font-bold text-[#737b88]">
                            Pago Nequi por el valor seleccionado.
                          </p>
                          <div className="mt-4">
                            <PrimaryButton
                              disabled={payingCreditId === activeCredit.id || !payable.length}
                              onClick={() => openWompiConfirm(activeCredit)}
                            >
                              {payingCreditId === activeCredit.id
                                ? "Abriendo Wompi..."
                                : `Pagar ${money(selectedAmount)}`}
                            </PrimaryButton>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {activePanel === "history" ? (
                    <>
                      <SectionTitle
                        title="Historial"
                        aside={
                          <span className="rounded-md bg-[#effbe6] px-2 py-1 text-xs font-black text-[#3f7d2d]">
                            {historyPaymentCountLabel}
                          </span>
                        }
                      />

                      <div className="mt-3 rounded-lg bg-[#111317] p-4 text-white">
                        <p className="text-xs font-black uppercase text-white/55">
                          Total pagado
                        </p>
                        <p className="mt-1 text-3xl font-black leading-none">
                          {money(historyTotalPaid)}
                        </p>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          <div className="rounded-md bg-white/8 px-3 py-2">
                            <p className="text-[11px] font-bold text-white/55">
                              Ultimo pago
                            </p>
                            <p className="mt-1 truncate text-sm font-black">
                              {lastHistoryPayment
                                ? dateLabel(lastHistoryPayment.fechaAbono)
                                : "Sin pagos"}
                            </p>
                          </div>
                          <div className="rounded-md bg-white/8 px-3 py-2">
                            <p className="text-[11px] font-bold text-white/55">
                              Saldo
                            </p>
                            <p className="mt-1 truncate text-sm font-black">
                              {money(historyBalance)}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-2">
                        {activeCredit.abonos.length ? (
                          activeCredit.abonos.map((abono) => (
                            <div
                              key={abono.id}
                              className="grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg bg-[#f9fafb] px-3 py-3"
                            >
                              <div className="grid h-11 w-11 place-items-center rounded-md bg-[#eef9fb] text-xs font-black text-[#087989]">
                                {dateLabel(abono.fechaAbono)}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-black text-[#252a35]">
                                  {abono.metodoPago}
                                </p>
                                <p className="mt-1 text-xs font-bold text-[#8a919d]">
                                  Pago registrado
                                </p>
                              </div>
                              <p className="shrink-0 text-sm font-black text-[#252a35]">
                                {money(abono.valor)}
                              </p>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-lg bg-[#f6f7f9] p-4">
                            <p className="text-sm font-black text-[#252a35]">
                              Aun no hay pagos registrados.
                            </p>
                            <p className="mt-1 text-xs font-bold text-[#7d8490]">
                              Cuando hagas un pago, aparecera aqui.
                            </p>
                            <button
                              type="button"
                              onClick={() => openPanel("payments")}
                              className="mt-3 min-h-11 w-full rounded-lg bg-[#a7e66f] px-4 text-sm font-black text-[#102316]"
                            >
                              Ver medios de pago
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>

        <nav className="fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 px-5 pb-[calc(8px+env(safe-area-inset-bottom))]">
          <div className="grid min-h-[86px] grid-cols-4 items-end rounded-[20px] border border-[#e7e9eb] bg-white px-2 pb-3 pt-3 shadow-[0_-14px_30px_rgba(17,20,24,0.11)]">
            <button
              type="button"
              onClick={returnHome}
              className="grid min-h-[58px] place-items-center gap-1 text-[#111317]"
            >
              <Home className="h-7 w-7 fill-[#111317] stroke-[2.1]" />
              <span className="text-[13px] font-medium">Inicio</span>
              <span className="h-1 w-8 rounded-full bg-[#b8f25d]" />
            </button>

            <button
              type="button"
              onClick={() => openPanel("pending")}
              className="grid min-h-[58px] place-items-center gap-1 text-[#757b84] active:text-[#111317]"
            >
              <ReceiptText className="h-7 w-7 stroke-[2.1]" />
              <span className="text-[13px] font-medium">Pagos</span>
            </button>

            <button
              type="button"
              onClick={() => activeCredit && openWompiConfirm(activeCredit)}
              disabled={!activeCredit || !payable.length || payingCreditId === activeCredit.id}
              className="-mt-9 grid min-h-[78px] place-items-center gap-1 text-[#111317] disabled:text-[#8e949c]"
            >
              <span className="grid h-[66px] w-[66px] place-items-center rounded-full bg-[#111418] text-white shadow-[0_12px_26px_rgba(17,20,24,0.26)]">
                <CreditCard className="h-8 w-8 stroke-[2.1]" />
              </span>
              <span className="text-[13px] font-medium">Pagar</span>
            </button>

            <button
              type="button"
              onClick={forgetDocument}
              className="grid min-h-[58px] place-items-center gap-1 text-[#757b84] active:text-[#111317]"
            >
              <CircleUserRound className="h-7 w-7 stroke-[2.1]" />
              <span className="text-[13px] font-medium">Perfil</span>
            </button>
          </div>
        </nav>

        {confirmCredit ? (
          <div
            aria-modal="true"
            role="dialog"
            aria-labelledby="confirm-payment-title"
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 px-4 pb-4"
          >
            <div className="w-full max-w-[440px] rounded-lg bg-white p-4 shadow-[0_20px_44px_rgba(0,0,0,0.28)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-black uppercase text-[#6c747f]">
                    Nequi por Wompi
                  </p>
                  <h2
                    id="confirm-payment-title"
                    className="mt-1 text-xl font-black text-[#171b22]"
                  >
                    Confirmar pago
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Cancelar pago"
                  onClick={() => {
                    setConfirmPaymentCreditId(null);
                    setConfirmPaymentMode("INSTALLMENTS");
                  }}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#dde1e8] bg-white text-lg font-black text-[#535b66]"
                >
                  x
                </button>
              </div>

              <div className="mt-4 rounded-lg bg-[#f8fff4] p-4">
                <p className="text-xs font-black uppercase text-[#5f8f44]">
                  Valor a pagar
                </p>
                <p className="mt-1 text-3xl font-black leading-none text-[#171b22]">
                  {money(confirmAmount)}
                </p>
                <p className="mt-2 text-sm font-bold text-[#67706b]">
                  {confirmPaymentLabel}
                </p>
              </div>

              <div className="mt-4 grid gap-3 text-sm">
                <div className="grid grid-cols-[82px_1fr] gap-3">
                  <span className="font-black uppercase text-[#7d8490]">Equipo</span>
                  <span className="truncate font-black text-[#252a35]">
                    {creditTitle(confirmCredit)}
                  </span>
                </div>
                <div className="grid grid-cols-[82px_1fr] gap-3">
                  <span className="font-black uppercase text-[#7d8490]">IMEI</span>
                  <span className="break-all font-black text-[#252a35]">
                    {confirmCredit.imei || confirmCredit.deviceUid || "No registrado"}
                  </span>
                </div>
                <div className="grid grid-cols-[82px_1fr] gap-3">
                  <span className="font-black uppercase text-[#7d8490]">Cedula</span>
                  <span className="font-black text-[#252a35]">
                    {confirmPaymentReference}
                  </span>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-[#e6e8ee] bg-[#f8f9fb] p-4">
                <label
                  htmlFor="nequi-phone"
                  className="block text-xs font-black uppercase text-[#6c747f]"
                >
                  Numero Nequi
                </label>
                <input
                  id="nequi-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  value={nequiPhone}
                  onChange={(event) => {
                    setNequiPhone(formatNequiPhone(event.target.value));
                    if (notice?.tone === "red") setNotice(null);
                  }}
                  placeholder="3001234567"
                  className="mt-2 min-h-12 w-full rounded-lg border border-[#dde1e8] bg-white px-4 text-base font-black text-[#171b22] outline-none focus:border-[#a7e66f]"
                />
                <p className="mt-2 text-xs font-bold leading-5 text-[#737b88]">
                  Wompi enviara una notificacion a la app Nequi. El pago queda
                  registrado cuando el cliente lo apruebe.
                </p>
                <label className="mt-3 grid cursor-pointer grid-cols-[22px_1fr] gap-3 text-xs font-bold leading-5 text-[#535b66]">
                  <input
                    type="checkbox"
                    checked={acceptWompiTerms}
                    onChange={(event) => {
                      setAcceptWompiTerms(event.target.checked);
                      if (notice?.tone === "red") setNotice(null);
                    }}
                    className="mt-1 h-4 w-4 accent-[#a7e66f]"
                  />
                  <span>Acepto reglamentos y politica de privacidad para hacer este pago.</span>
                </label>
              </div>

              {notice ? (
                <div
                  className={[
                    "mt-3 rounded-lg border px-4 py-3 text-xs font-bold leading-5",
                    notice.tone === "emerald"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-red-200 bg-red-50 text-red-700",
                  ].join(" ")}
                >
                  {notice.text}
                </div>
              ) : null}

              <div className="mt-5 grid grid-cols-[1fr_1.4fr] gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmPaymentCreditId(null);
                    setConfirmPaymentMode("INSTALLMENTS");
                    setNotice(null);
                  }}
                  className="min-h-12 rounded-lg border border-[#dde1e8] bg-white px-3 text-sm font-black text-[#414854]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void payWithWompi(confirmCredit)}
                  disabled={
                    payingCreditId === confirmCredit.id ||
                    nequiPhone.length !== 10 ||
                    !acceptWompiTerms
                  }
                  className="min-h-12 rounded-lg bg-[#a7e66f] px-3 text-sm font-black text-[#102316] shadow-[0_10px_20px_rgba(111,194,70,0.22)] disabled:bg-[#d9dde4] disabled:text-[#7e8490]"
                >
                  {payingCreditId === confirmCredit.id
                    ? "Enviando..."
                    : "Enviar a Nequi"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
