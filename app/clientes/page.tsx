"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  CreditCard,
  Headphones,
  Home,
  MoreHorizontal,
  ReceiptText,
  Smartphone,
  WalletCards,
  History as HistoryIconLucide,
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
type ClientNoticeTone = "red" | "green" | "blue" | "gray";

type ClientNotice = {
  title: string;
  detail: string;
  tone: ClientNoticeTone;
};

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

function noticeToneClasses(tone: ClientNoticeTone) {
  if (tone === "red") return "bg-[#fff5f2] text-[#b63b20]";
  if (tone === "green") return "bg-[#f1fbeb] text-[#3f7d2d]";
  if (tone === "blue") return "bg-[#eef9fb] text-[#087989]";
  return "bg-[#f5f6f8] text-[#626976]";
}

function buildClientNotices(
  credit: ClientCredit,
  nextInstallment: ClientInstallment | null
) {
  const notices: ClientNotice[] = [];
  const overdueCount = credit.cuotas.filter(
    (item) => item.saldoPendiente > 0 && item.estaEnMora
  ).length;
  const lastPayment = credit.abonos[0] || null;

  if (overdueCount) {
    notices.push({
      title: "Tienes cuotas vencidas",
      detail: `${overdueCount} ${overdueCount === 1 ? "cuota" : "cuotas"} en mora.`,
      tone: "red",
    });
  } else if (credit.estadoPago === "PAGADO" || !nextInstallment) {
    notices.push({
      title: "Credito al dia",
      detail: "No tienes cuotas pendientes en este momento.",
      tone: "green",
    });
  } else {
    notices.push({
      title: "Proxima cuota",
      detail: `${dateLabel(nextInstallment.fechaVencimiento)} por ${money(
        nextInstallment.saldoPendiente
      )}.`,
      tone: "green",
    });
  }

  if (nextInstallment) {
    notices.push({
      title: "Cuota a pagar",
      detail: `Cuota ${nextInstallment.numero} de ${credit.cuotas.length}.`,
      tone: overdueCount ? "red" : "blue",
    });
  }

  notices.push(
    lastPayment
      ? {
          title: "Ultimo pago",
          detail: `${dateLabel(lastPayment.fechaAbono)} por ${money(lastPayment.valor)}.`,
          tone: "gray",
        }
      : {
          title: "Sin pagos registrados",
          detail: "Cuando pagues, veras el movimiento en historial.",
          tone: "gray",
        }
  );

  return notices.slice(0, 3);
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
        className="flex items-baseline text-[23px] font-black leading-none text-[#111317]"
      >
        <span>FINSER</span>
        <span className="ml-1.5 text-[#747983]">PAY</span>
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

function QuickAction({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-16 items-center gap-3 rounded-lg border border-[#e6e8ee] bg-white px-3 text-left shadow-sm active:bg-[#f6f7f9]"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[#f1f3f7] text-[#111317]">
        {children}
      </span>
      <span className="min-w-0 text-sm font-black leading-4 text-[#323744]">
        {label}
      </span>
    </button>
  );
}

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M3 10h18M7 15h4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 4v6h6M5.2 15a7.5 7.5 0 1 0 1.7-7.9L4 10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path d="M12 8v5l3 2" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function PaymentsIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 6h14M5 12h14M5 18h14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
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
  const clientNotices = activeCredit
    ? buildClientNotices(activeCredit, nextInstallment)
    : [];
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
  const progressSegments = Math.max(1, Math.min(totalCount || 1, 8));
  const completedSegments = Math.min(
    progressSegments,
    Math.round((progress / 100) * progressSegments)
  );
  const deviceImei = activeCredit?.imei || activeCredit?.deviceUid || null;
  const nextDueLabel = nextInstallment
    ? compactDateLabel(nextInstallment.fechaVencimiento)
    : "-";
  const lastPaymentDateLabel = lastHistoryPayment
    ? compactDateLabel(lastHistoryPayment.fechaAbono)
    : "Sin pagos";

  if (!items.length) {
    return (
      <main className="min-h-screen bg-[#f5f6f8] text-[#171b22]">
        <div className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col px-5 py-7">
          <header className="flex items-center justify-between">
            <AppLogo />
            <span className="rounded-md bg-white px-3 py-2 text-xs font-black text-[#626976] shadow-sm">
              Clientes
            </span>
          </header>

          <section className="flex flex-1 flex-col justify-center py-8">
            <AppLogo large />
            <div className="mt-8 text-center">
              <h1 className="text-2xl font-black leading-tight text-[#171b22]">
                Consulta tu credito
              </h1>
              <p className="mx-auto mt-3 max-w-[280px] text-sm font-semibold leading-6 text-[#6d7480]">
                Entra con tu cedula para ver cuotas, pagos y medios disponibles.
              </p>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                const formDocument = String(formData.get("documento") || documento);
                void consultar(formDocument);
              }}
              className="mt-8 rounded-lg border border-[#e6e8ee] bg-white p-4 shadow-[0_16px_36px_rgba(17,19,23,0.08)]"
            >
              <label
                htmlFor="documento"
                className="block text-xs font-black uppercase text-[#737b88]"
              >
                Documento de identidad
              </label>
              <div className="mt-3 flex min-h-14 items-center rounded-lg border border-[#dfe3ea] bg-[#f8f9fb] px-3">
                <span className="mr-3 rounded-md bg-white px-2 py-1 text-sm font-black text-[#303743] shadow-sm">
                  CC
                </span>
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
                  placeholder="Numero de cedula"
                  className="min-w-0 flex-1 bg-transparent text-lg font-black text-[#1f2430] outline-none placeholder:text-[#a0a7b2]"
                />
              </div>
              <div className="mt-4">
                <PrimaryButton disabled={!canSubmit} type="submit">
                  {loading ? "Consultando..." : "Continuar"}
                </PrimaryButton>
              </div>
            </form>

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
          </section>

          <footer className="pb-2 text-center text-xs font-bold text-[#88909c]">
            Portal clientes FINSER PAY
          </footer>
        </div>
      </main>
    );
  }

  return (
    <main
      id="cliente-dashboard"
      className="min-h-screen bg-[#f7f7f6] text-[#111317]"
    >
      <div className="mx-auto min-h-screen w-full max-w-[430px] px-5 pb-[calc(126px+env(safe-area-inset-bottom))] pt-[calc(18px+env(safe-area-inset-top))]">
        <header className="flex items-center justify-between gap-4">
          <AppLogo />
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Notificaciones"
              className="grid h-11 w-11 place-items-center rounded-full text-[#111317] active:bg-black/5"
            >
              <Bell className="h-7 w-7 stroke-[2.1]" />
            </button>
            <button
              type="button"
              aria-label="Cambiar cliente"
              onClick={forgetDocument}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#111418] text-base font-bold text-white shadow-[0_10px_22px_rgba(17,20,24,0.18)]"
            >
              {profileInitials}
            </button>
          </div>
        </header>

        <div className="pt-6">
          {notice ? (
            <div
              className={[
                "rounded-lg border px-4 py-3 text-sm font-bold",
                notice.tone === "emerald"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-red-200 bg-red-50 text-red-700",
              ].join(" ")}
            >
              {notice.text}
            </div>
          ) : null}

          {paymentReturn ? (
            <section className="rounded-lg border border-[#dfece0] bg-white p-4 shadow-sm">
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
              <section className="mb-6">
                <h1 className="text-[23px] font-medium leading-tight text-[#111317]">
                  Hola, {firstName}
                </h1>
                <span
                  className={[
                    "mt-3 inline-flex min-h-10 items-center gap-3 rounded-xl border bg-white px-3.5 text-[15px] font-medium shadow-[0_8px_18px_rgba(17,20,24,0.04)]",
                    activeCredit.estadoPago === "MORA"
                      ? "border-red-100 text-red-700"
                      : "border-[#dfe7d8] text-[#1f242b]",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "h-3 w-3 rounded-full shadow-[0_0_0_5px_rgba(166,231,96,0.14)]",
                      activeCredit.estadoPago === "MORA"
                        ? "bg-red-500"
                        : "bg-[#62b52b]",
                    ].join(" ")}
                  />
                  {creditStatusText(activeCredit.estadoPago)}
                </span>
              </section>

              <section className="rounded-[20px] bg-[#121519] p-5 text-white shadow-[0_20px_44px_rgba(17,20,24,0.22)]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <p className="text-[18px] font-medium text-white/72">
                        Proxima cuota
                      </p>
                      <span className="rounded-lg border border-white/16 bg-white/[0.03] px-2.5 py-1 text-[13px] font-semibold text-white">
                        {nextInstallment ? nextInstallment.numero : paidCount} de{" "}
                        {totalCount || 0}
                      </span>
                    </div>
                    <p className="mt-4 font-serif text-[46px] font-black leading-none text-white">
                      {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                    </p>
                  </div>
                  <MoreHorizontal className="mt-1 h-6 w-6 shrink-0 text-white/82" />
                </div>

                <div className="mt-6 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                  <div>
                    <p className="text-[15px] font-medium text-white/72">Vence</p>
                    <p className="mt-1.5 text-[21px] font-black">
                      {nextDueLabel}
                    </p>
                  </div>
                  <span className="h-12 w-px bg-white/18" />
                  <div>
                    <p className="text-[15px] font-medium text-white/72">
                      Saldo pendiente
                    </p>
                    <p className="mt-1.5 text-[21px] font-black">
                      {money(activeCredit.saldoPendiente)}
                    </p>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-[1fr_58px] items-center gap-4">
                  <button
                    type="button"
                    onClick={() => openWompiConfirm(activeCredit)}
                    disabled={!payable.length || payingCreditId === activeCredit.id}
                    className="inline-flex min-h-[52px] items-center justify-center gap-3 rounded-2xl bg-[#b8f25d] px-5 text-[17px] font-semibold text-[#111317] shadow-[0_14px_28px_rgba(184,242,93,0.24)] disabled:bg-white/20 disabled:text-white/45"
                  >
                    <CreditCard className="h-6 w-6" />
                    {payingCreditId === activeCredit.id ? "Abriendo" : "Pagar ahora"}
                  </button>
                  <button
                    type="button"
                    aria-label="Pagar ahora"
                    onClick={() => openWompiConfirm(activeCredit)}
                    disabled={!payable.length || payingCreditId === activeCredit.id}
                    className="grid h-[58px] w-[58px] place-items-center rounded-full border border-white/16 bg-white/[0.02] text-white active:bg-white/10 disabled:text-white/30"
                  >
                    <ArrowRight className="h-7 w-7" />
                  </button>
                </div>

                {canPayToday && activePayoff ? (
                  <button
                    type="button"
                    onClick={() => openWompiConfirm(activeCredit, "PAYOFF")}
                    disabled={payingCreditId === activeCredit.id}
                    className="mt-3 flex min-h-[58px] w-full items-center justify-between gap-4 rounded-2xl border border-[#b8f25d]/45 bg-[#b8f25d]/[0.08] px-4 text-left text-white transition active:bg-[#b8f25d]/15 disabled:opacity-50"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#b8f25d] text-[#111317]">
                        <WalletCards className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[15px] font-black uppercase">
                          Recoger deuda
                        </span>
                        <span className="mt-0.5 block text-xs font-medium text-white/62">
                          Liquidar el capital pendiente
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[16px] font-black text-[#b8f25d]">
                      {payingCreditId === activeCredit.id
                        ? "Abriendo"
                        : money(activePayoff.capitalPendiente)}
                    </span>
                  </button>
                ) : null}

                <div className="mt-6">
                  <div
                    className="grid gap-1.5"
                    style={{ gridTemplateColumns: `repeat(${progressSegments}, minmax(0, 1fr))` }}
                  >
                    {Array.from({ length: progressSegments }).map((_, index) => (
                      <span
                        key={index}
                        className={[
                          "h-1.5 rounded-full",
                          index < completedSegments ? "bg-[#b8f25d]" : "bg-white/14",
                        ].join(" ")}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex justify-between gap-4 text-[14px] font-medium text-white/72">
                    <span>
                      {paidCount} de {totalCount} cuotas pagadas
                    </span>
                    <span>{progress}% completado</span>
                  </div>
                </div>
              </section>

              {items.length > 1 ? (
                <section className="mt-5 rounded-[18px] border border-[#dfe8dc] bg-white p-4 shadow-[0_10px_24px_rgba(17,20,24,0.05)]">
                  <SectionTitle
                    title="Creditos vigentes"
                    aside={
                      <span className="rounded-full bg-[#effbe6] px-3 py-1 text-xs font-black text-[#3f7d2d]">
                        {items.length} activos
                      </span>
                    }
                  />
                  <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
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
                            "grid min-h-20 min-w-[270px] grid-cols-[1fr_auto] gap-3 rounded-xl border px-4 py-3 text-left transition active:scale-[0.99]",
                            isActive
                              ? "border-[#a7e66f] bg-[#f5ffef] shadow-[0_10px_22px_rgba(111,194,70,0.14)]"
                              : "border-[#edf0f4] bg-[#fbfcfd]",
                          ].join(" ")}
                        >
                          <span className="min-w-0">
                            <span className="block text-[11px] font-black uppercase text-[#7d8490]">
                              Credito {index + 1}
                            </span>
                            <span className="mt-1 block truncate text-sm font-black text-[#171b22]">
                              {creditTitle(credit)}
                            </span>
                            <span className="mt-1 block truncate text-xs font-bold text-[#848c98]">
                              {maskedImeiLabel(credit.imei || credit.deviceUid)}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span
                              className={[
                                "inline-flex rounded-md px-2 py-1 text-[11px] font-black",
                                isActive
                                  ? "bg-[#a7e66f] text-[#102316]"
                                  : "bg-[#eef1f5] text-[#626976]",
                              ].join(" ")}
                            >
                              {isActive ? "Activo" : "Ver"}
                            </span>
                            <span className="mt-2 block text-xs font-black text-[#252a35]">
                              {creditPaid}/{creditTotal}
                            </span>
                            <span className="mt-1 block text-xs font-bold text-[#7d8490]">
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
                className="mt-5 grid min-h-[76px] w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 rounded-[18px] border border-[#e4e6e8] bg-white px-3.5 text-left shadow-[0_12px_30px_rgba(17,20,24,0.07)] active:scale-[0.99]"
              >
                <span className="grid h-11 w-11 place-items-center rounded-full bg-[#f0f0ed] text-[#52575f]">
                  <Smartphone className="h-6 w-6 stroke-[1.8]" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[17px] font-black leading-tight text-[#111317]">
                    {creditTitle(activeCredit)}
                  </span>
                  <span className="mt-1 block truncate text-[14px] font-medium text-[#747985]">
                    {maskedImeiLabel(deviceImei)}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 text-[14px] font-bold text-[#111317]">
                  Ver credito
                  <ChevronRight className="h-5 w-5 text-[#7b8088]" />
                </span>
              </button>

              <section className="mt-8">
                <h2 className="text-[20px] font-semibold text-[#111317]">
                  Tu proximo movimiento
                </h2>
                <div className="mt-4 overflow-hidden rounded-[18px] border border-[#e4e6e8] bg-white shadow-[0_12px_30px_rgba(17,20,24,0.06)]">
                  <button
                    type="button"
                    onClick={() => openPanel("pending")}
                    className="grid min-h-[82px] w-full grid-cols-[50px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 text-left active:bg-[#f7f8f6]"
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-full bg-[#edf8de] text-[#477d26]">
                      <CalendarDays className="h-6 w-6" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[16px] font-black text-[#111317]">
                        {nextDueLabel} - Cuota {nextInstallment?.numero || paidCount}
                      </span>
                      <span className="mt-1 block text-[14px] font-medium text-[#7a808a]">
                        {nextInstallment?.estaEnMora ? "En mora" : "Programada"}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-[16px] font-semibold text-[#111317]">
                      {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                      <ChevronRight className="h-5 w-5 text-[#7b8088]" />
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openPanel("pending")}
                    className="grid min-h-[56px] w-full grid-cols-[50px_1fr_auto] items-center gap-3 border-t border-[#eceef0] px-3.5 text-left active:bg-[#f7f8f6]"
                  >
                    <span />
                    <span className="text-[15px] font-semibold text-[#4d535d]">
                      Ver calendario
                    </span>
                    <ChevronRight className="h-5 w-5 text-[#7b8088]" />
                  </button>
                </div>
              </section>

              <section className="mt-8">
                <h2 className="text-[20px] font-semibold text-[#111317]">
                  Ultimo pago
                </h2>
                <button
                  type="button"
                  onClick={() => openPanel("history")}
                  className="mt-4 grid min-h-[82px] w-full grid-cols-[50px_minmax(0,1fr)_auto] items-center gap-3 rounded-[18px] border border-[#e4e6e8] bg-white px-3.5 text-left shadow-[0_12px_30px_rgba(17,20,24,0.06)] active:bg-[#f7f8f6]"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-[#eef8df] text-[#3e8d27]">
                    <Check className="h-6 w-6 stroke-[2.4]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[16px] font-black text-[#111317]">
                      {lastPaymentDateLabel}
                      {lastHistoryPayment ? ` - ${lastHistoryPayment.metodoPago}` : ""}
                    </span>
                    <span className="mt-1 block text-[14px] font-medium text-[#3e8d27]">
                      {lastHistoryPayment ? "Pago confirmado" : "Sin pagos registrados"}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-[16px] font-semibold text-[#111317]">
                    {lastHistoryPayment ? money(lastHistoryPayment.valor) : money(0)}
                    <ChevronRight className="h-5 w-5 text-[#7b8088]" />
                  </span>
                </button>
              </section>

              <section className="mt-8 grid grid-cols-3 items-center gap-2">
                <button
                  type="button"
                  onClick={() => openPanel("payments")}
                  className="grid min-h-[70px] place-items-center gap-1.5 text-[#111317]"
                >
                  <WalletCards className="h-7 w-7 stroke-[2.1]" />
                  <span className="text-[14px] font-medium">Medios</span>
                </button>
                <button
                  type="button"
                  onClick={() => openPanel("history")}
                  className="grid min-h-[70px] place-items-center gap-1.5 border-x border-[#dde0e4] text-[#111317]"
                >
                  <HistoryIconLucide className="h-7 w-7 stroke-[2.1]" />
                  <span className="text-[14px] font-medium">Historial</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setNotice({
                      tone: "emerald",
                      text: "Comunicate con FINSER PAY por tus canales registrados.",
                    })
                  }
                  className="grid min-h-[70px] place-items-center gap-1.5 text-[#111317]"
                >
                  <Headphones className="h-7 w-7 stroke-[2.1]" />
                  <span className="text-[14px] font-medium">Soporte</span>
                </button>
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
