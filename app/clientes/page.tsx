"use client";
import { creditDisplayNumber } from "@/lib/credit-display-number";

import { useCallback, useEffect, useRef, useState } from "react";
import ClientNequiPaymentDialog from "./client-nequi-payment-dialog";
import ClientActiveCreditDashboard from "@/app/clientes/client-active-credit-dashboard";
import { resolveHomeInstallmentPayment } from "./credit-dashboard-presentation";
import ClientCreditPanel, {
  type ClientCreditPanelName,
} from "@/app/clientes/client-credit-panel";
import ClientLoginScreen from "@/app/clientes/client-login-screen";
import PaidCreditDashboard from "@/app/clientes/paid-credit-dashboard";
import {
  CircleUserRound,
  Clock3,
  CreditCard,
  Home,
} from "lucide-react";

type ClientInstallment = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonado: number;
  saldoPendiente: number;
  estado: "PAGO" | "PENDIENTE";
  estaEnMora?: boolean;
  eliminada?: boolean;
};

type ClientCredit = {
  id: number;
  folio: string;
  numeroCreditoVisible?: string;
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
  pazYSalvoEmitidoAt?: string | null;
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

type EfectyPayoffResponse = {
  ok?: boolean;
  convenio?: string;
  referencia?: string;
  amount?: number;
  expiresAt?: string;
  error?: string;
};

type EfectyPayoffInstructions = {
  creditId: number;
  convenio: string;
  referencia: string;
  amount: number;
  expiresAt: string;
};

type PaymentReturnNotice = {
  reference: string;
  creditId: number | null;
  checkedAt?: string | null;
  amount?: number;
  paymentMode?: ClientPaymentMode;
  paymentLabel?: string;
};

type ExplorerPanel = ClientCreditPanelName | null;
type ClientPaymentMode = "INSTALLMENTS" | "PAYOFF";

declare global {
  interface Window {
    FinserPayAndroid?: {
      downloadDocument?: (url: string, filename: string) => void;
      registerClient?: (documento: string) => void;
    };
  }
}

const STORAGE_KEY = "finserpay.cliente.documento";
const NEW_CREDIT_SUPPORT_MESSAGE =
  "Hola, equipo de FINSER PAY 👋 Finalicé mi crédito y quiero solicitar uno nuevo. ¿Podrían orientarme, por favor?";

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
  return credit.cuotas.filter((item) => !item.eliminada && item.saldoPendiente > 0);
}

function getPaidInstallments(credit: ClientCredit) {
  return credit.cuotas.filter(
    (item) => !item.eliminada && (item.estado === "PAGO" || item.saldoPendiente <= 0)
  );
}

function getFirstName(value: string) {
  const first = value.trim().split(/\s+/)[0] || "Cliente";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
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
  return credit.referenciaEquipo || `Crédito ${creditDisplayNumber(credit)}`;
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

function clientPaymentMessage(message: string) {
  return message.includes("plan revisado por abono a capital")
    ? "La liquidación anticipada no está disponible para este crédito."
    : message;
}

function nequiTerminalMessage(status?: string | null) {
  switch (String(status || "").toUpperCase()) {
    case "DECLINED":
      return "Nequi rechazó el pago. Tus cuotas no cambiaron; puedes intentar de nuevo.";
    case "VOIDED":
    case "CANCELED":
    case "CANCELLED":
      return "La solicitud de pago fue cancelada. Tus cuotas no cambiaron.";
    case "EXPIRED":
      return "La solicitud de pago venció. Tus cuotas no cambiaron; puedes enviar otra.";
    case "ERROR":
      return "El pago no pudo completarse. Tus cuotas no cambiaron; puedes intentar de nuevo.";
    default:
      return null;
  }
}
export default function ClienteConsultaPage() {
  const [documento, setDocumento] = useState("");
  const [activeDocumento, setActiveDocumento] = useState("");
  const [items, setItems] = useState<ClientCredit[]>([]);
  const [openCreditId, setOpenCreditId] = useState<number | null>(null);
  const [selectedLimit, setSelectedLimit] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);
  const [payingCreditId, setPayingCreditId] = useState<number | null>(null);
  const sendingPaymentRef = useRef(false);
  const preparingEfectyPayoffRef = useRef(false);
  const [preparingEfectyPayoffCreditId, setPreparingEfectyPayoffCreditId] = useState<number | null>(null);
  const [efectyPayoff, setEfectyPayoff] = useState<EfectyPayoffInstructions | null>(null);
  const pendingPaymentRef = useRef<PaymentReturnNotice | null>(null);
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
      return false;
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
      setEfectyPayoff(null);
      setOpenCreditId(nextOpenId);
      setActivePanel(preferredPanel);
      setConfirmPaymentCreditId(null);
      setSelectedLimit(
        Object.fromEntries(
          nextItems
            .map((credit) => {
              const payment = resolveHomeInstallmentPayment(credit);
              const limit = payment.requiresPlanReview
                ? getPayableInstallments(credit)[0]?.numero
                : payment.installmentLimit;
              return limit !== undefined ? [credit.id, limit] : null;
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
      return true;
    } catch (error) {
      if (!silent) {
        setItems([]);
        setOpenCreditId(null);
      }
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo consultar la cedula",
        tone: "red",
      });
      return false;
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
    const targetPanel = wompiReference ? panelFromUrl || "payments" : panelFromUrl;

    if (wompiReference) {
      const pending = { reference: wompiReference, creditId: creditFromUrl, checkedAt: null };
      pendingPaymentRef.current = pending;
      setPaymentReturn(pending);
    }

    if (nextDocument) {
      setDocumento(nextDocument);
      void consultar(nextDocument, true, creditFromUrl, targetPanel);
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
    mode: ClientPaymentMode = "INSTALLMENTS",
    installmentLimit?: number
  ) => {
    if (sendingPaymentRef.current) return;
    if (pendingPaymentRef.current?.reference || paymentReturn?.reference) {
      setActivePanel("payments");
      setNotice({ text: "Ya tienes una solicitud de pago pendiente. Revisa su estado antes de enviar otra.", tone: "red" });
      return;
    }
    if (mode === "PAYOFF" && !credit.liquidacionAnticipada?.disponible) {
      setNotice({
        text: clientPaymentMessage(
          credit.liquidacionAnticipada?.motivo ||
          "Pagar hoy solo esta disponible cuando el credito esta al dia."
        ),
        tone: "red",
      });
      return;
    }

    const selectedInstallments =
      mode === "INSTALLMENTS" && installmentLimit !== undefined
        ? getPayableInstallments(credit).filter(
            (installment) => installment.numero <= installmentLimit
          )
        : cuotasSeleccionadas(credit);

    if (mode === "INSTALLMENTS" && !selectedInstallments.length) {
      setNotice({ text: "Selecciona una cuota para pagar.", tone: "red" });
      return;
    }

    if (mode === "INSTALLMENTS" && installmentLimit !== undefined) {
      setSelectedLimit((current) => ({
        ...current,
        [credit.id]: installmentLimit,
      }));
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

  const openNextInstallmentWompiConfirm = (credit: ClientCredit) => {
    const payment = resolveHomeInstallmentPayment(credit);
    if (payment.requiresPlanReview) {
      openPanel("pending");
      setNotice({ text: "Revisa el calendario de tu plan de pagos antes de confirmar las cuotas vencidas.", tone: "red" });
      return;
    }
    openWompiConfirm(credit, "INSTALLMENTS", payment.installmentLimit);
  };

  const prepareEfectyPayoff = async (credit: ClientCredit) => {
    if (preparingEfectyPayoffRef.current) return;
    if (pendingPaymentRef.current?.reference || paymentReturn?.reference) {
      setNotice({ text: "Ya tienes una solicitud de pago pendiente. Revisa su estado antes de preparar otra liquidación.", tone: "red" });
      return;
    }
    if (!credit.liquidacionAnticipada?.disponible) {
      setNotice({ text: credit.liquidacionAnticipada?.motivo || "La liquidación anticipada no está disponible para este crédito.", tone: "red" });
      return;
    }

    preparingEfectyPayoffRef.current = true;
    setPreparingEfectyPayoffCreditId(credit.id);
    setNotice(null);
    try {
      const result = await requestJson<EfectyPayoffResponse>(
        "/api/clientes/efecty-liquidacion",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creditoId: credit.id,
            documento: credit.clienteDocumento || activeDocumento || documento,
          }),
        }
      );
      if (!result.ok || !result.data.ok) {
        throw new Error(result.data.error || "No se pudo preparar la liquidación en Efecty.");
      }
      if (
        !result.data.convenio ||
        !result.data.referencia ||
        !Number.isFinite(result.data.amount) ||
        Number(result.data.amount) <= 0 ||
        !result.data.expiresAt
      ) {
        throw new Error("No recibimos las instrucciones completas de Efecty. Intenta de nuevo.");
      }

      setEfectyPayoff({
        creditId: credit.id,
        convenio: result.data.convenio,
        referencia: result.data.referencia,
        amount: Number(result.data.amount),
        expiresAt: result.data.expiresAt,
      });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo preparar la liquidación en Efecty.",
        tone: "red",
      });
    } finally {
      preparingEfectyPayoffRef.current = false;
      setPreparingEfectyPayoffCreditId(null);
    }
  };

  const payWithWompi = async (credit: ClientCredit) => {
    if (sendingPaymentRef.current) return;
    if (pendingPaymentRef.current?.reference || paymentReturn?.reference) {
      setNotice({ text: "Ya tienes una solicitud de pago pendiente. Revisa su estado antes de enviar otra.", tone: "red" });
      return;
    }
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

    sendingPaymentRef.current = true;
    try {
      setPayingCreditId(credit.id);
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
        const terminalMessage = nequiTerminalMessage(result.data.status);
        if (terminalMessage) {
          setNotice({ text: terminalMessage, tone: "red" });
          return;
        }
        if (!result.data.reference) {
          throw new Error("No recibimos la referencia de la solicitud. Consulta el estado del pago antes de volver a intentarlo.");
        }
        const pending: PaymentReturnNotice = {
          reference: result.data.reference,
          creditId: credit.id,
          checkedAt: null,
          amount: result.data.amount ?? confirmAmount,
          paymentMode,
          paymentLabel: confirmPaymentLabel,
        };
        pendingPaymentRef.current = pending;
        setPaymentReturn(pending);
        setConfirmPaymentCreditId(null);
        setConfirmPaymentMode("INSTALLMENTS");
        setNotice({
          text: String(result.data.status || "").toUpperCase() === "APPROVED"
            ? "Nequi aprobó la solicitud. Estamos verificando su aplicación a tus cuotas."
            : "Solicitud enviada. Abre Nequi para aprobarla. Tus cuotas se actualizarán cuando Wompi confirme el pago.",
          tone: "emerald",
        });
        setActivePanel("payments");
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
            ? clientPaymentMessage(error.message)
            : "No se pudo iniciar el pago con Wompi",
        tone: "red",
      });
    } finally {
      sendingPaymentRef.current = false;
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
    pendingPaymentRef.current = null;
    setPaymentReturn(null);
    setEfectyPayoff(null);
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
    setEfectyPayoff(null);
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
      let terminalMessage: string | null = null;

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

        terminalMessage = nequiTerminalMessage(statusResult.data.status);
        paymentApplied = Boolean(
          statusResult.data.applied || statusResult.data.alreadyProcessed
        );
      }

      const refreshed = await consultar(
        targetDocument,
        true,
        paymentReturn?.creditId ?? openCreditId,
        activePanel
      );
      if (!refreshed) return;

      if (paymentApplied) {
        pendingPaymentRef.current = null;
        setNotice({
          text: "Pago aprobado y aplicado. Tus cuotas e historial ya quedaron actualizados.",
          tone: "emerald",
        });
        setPaymentReturn(null);
        return;
      }

      if (terminalMessage) {
        pendingPaymentRef.current = null;
        setPaymentReturn(null);
        setNotice({ text: terminalMessage, tone: "red" });
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
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo verificar el pago en Wompi",
        tone: "red",
      });
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
  const totalCount = activeCredit?.cuotas.filter((item) => !item.eliminada).length || 0;
  const nextInstallment = payable[0] || null;
  const homePayment = activeCredit ? resolveHomeInstallmentPayment(activeCredit) : null;
  const selectedPaymentLimit =
    activeCredit && nextInstallment
      ? selectedLimit[activeCredit.id] || nextInstallment.numero
      : 0;
  const firstName = activeCredit ? getFirstName(activeCredit.clienteNombre) : "";
  const paymentReference = activeCredit?.clienteDocumento || activeDocumento || documento;
  const pazYSalvoHref = activeCredit
    ? `/api/clientes/creditos/${activeCredit.id}/paz-y-salvo?documento=${encodeURIComponent(
        paymentReference
      )}`
    : "#";
  const lastHistoryPayment = activeCredit?.abonos[0] || null;
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
  const isPaidCredit = activeCredit?.estadoPago === "PAGADO";
  const canPayToday =
    activeCredit?.estadoPago === "AL_DIA" && Boolean(activePayoff?.disponible);
  const profileInitials = activeCredit
    ? clientInitials(activeCredit.clienteNombre)
    : "FP";

  if (!items.length) {
    return (
      <ClientLoginScreen
        documento={documento}
        loading={loading}
        notice={notice}
        onSubmit={(formDocument) => void consultar(formDocument)}
      />
    );
  }

  if (activeCredit && isPaidCredit) {
    return (
      <PaidCreditDashboard
        activePanel={activePanel}
        credit={activeCredit}
        credits={items}
        firstName={firstName}
        newCreditSupportMessage={NEW_CREDIT_SUPPORT_MESSAGE}
        notice={notice}
        onForgetDocument={forgetDocument}
        onHome={returnHome}
        onOpenPanel={openPanel}
        onSelectCredit={selectCredit}
        pazYSalvoHref={pazYSalvoHref}
        profileInitials={profileInitials}
      />
    );
  }

  return (
    <div
      id="cliente-dashboard"
      className="min-h-[100svh] overflow-x-hidden bg-[var(--fp-client-bg)] text-[#111317]"
    >
      <div className="mx-auto min-h-[100svh] w-full max-w-[600px] bg-[var(--fp-client-bg)] pb-[calc(88px+env(safe-area-inset-bottom))]">
        <div
          aria-hidden={activePanel ? true : undefined}
          inert={activePanel ? true : undefined}
        >
          <ClientActiveCreditDashboard
          activeCreditId={activeCredit.id}
          creditNumber={creditDisplayNumber(activeCredit)}
          clientFirstName={firstName}
          creditOptions={items.map((credit) => ({
            id: credit.id,
            label: `Crédito ${creditDisplayNumber(credit)}${credit.referenciaEquipo ? ` · ${credit.referenciaEquipo}` : ""}`,
          }))}
          device={{
            name: creditTitle(activeCredit),
          }}
          lastPayment={
            lastHistoryPayment
              ? {
                  amount: lastHistoryPayment.valor,
                  date: lastHistoryPayment.fechaAbono,
                  label: "Pago recibido",
                  stateLabel: "Confirmado",
                }
              : null
          }
          nextInstallment={
            nextInstallment
              ? {
                  amount: nextInstallment.saldoPendiente,
                  dueDate: nextInstallment.fechaVencimiento,
                  number: nextInstallment.numero,
                  stateLabel: nextInstallment.estaEnMora ? "En mora" : "Programada",
                }
              : null
          }
          overduePayment={homePayment && homePayment.overdueCount > 0 && homePayment.dueDate
            ? { amount: homePayment.amount, count: homePayment.overdueCount, dueDate: homePayment.dueDate }
            : null}
          notice={notice}
          onOpenDevice={() => openPanel("pending")}
          onOpenHistory={() => openPanel("history")}
          onOpenNotifications={() => openPanel("history")}
          onPayInstallment={() => openNextInstallmentWompiConfirm(activeCredit)}
          onOpenPlan={() => openPanel("pending")}
          onOpenProfile={forgetDocument}
          onPayoff={() => openWompiConfirm(activeCredit, "PAYOFF")}
          onSelectCredit={selectCredit}
          paidInstallments={paidCount}
          paying={payingCreditId === activeCredit.id}
          payoff={
            activePayoff
              ? {
                  amount: activePayoff.capitalPendiente,
                  available: canPayToday,
                  reason: activePayoff.motivo,
                }
              : null
          }
          profileActionLabel="Cambiar cliente"
          profileInitials={profileInitials}
          statusLabel={
            activeCredit.estadoPago === "MORA" ? "Pago pendiente" : "Crédito al día"
          }
          statusTone={activeCredit.estadoPago === "MORA" ? "overdue" : "current"}
          totalInstallments={totalCount}
          />
        </div>

        {activePanel && activeCredit ? (
          <ClientCreditPanel
            credit={activeCredit}
            efectyPayoff={efectyPayoff?.creditId === activeCredit.id && new Date(efectyPayoff.expiresAt).getTime() > Date.now() ? efectyPayoff : null}
            notice={notice}
            onBack={returnHome}
            onOpenPanel={openPanel}
            onPayoff={() => openWompiConfirm(activeCredit, "PAYOFF")}
            onPaySelected={() => openWompiConfirm(activeCredit)}
            onPrepareEfectyPayoff={() => void prepareEfectyPayoff(activeCredit)}
            onRefreshPayment={() => void refreshPaymentStatus()}
            onSelectPaymentLimit={(installmentNumber) =>
              selectPaymentLimit(activeCredit.id, installmentNumber)
            }
            panel={activePanel}
            pendingPayment={paymentReturn}
            paying={payingCreditId === activeCredit.id}
            preparingEfectyPayoff={preparingEfectyPayoffCreditId === activeCredit.id}
            refreshingPayment={refreshingPayment || loading}
            selectedPaymentLimit={selectedPaymentLimit}
          />
        ) : null}

        <nav
          aria-label="Navegación del portal"
          className="fixed bottom-0 left-1/2 z-30 w-full max-w-[600px] -translate-x-1/2 border-t border-[#e5e3de] bg-white/95 px-4 pb-[calc(8px+env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl"
        >
          <div className="grid min-h-[72px] grid-cols-4 items-center">
            <button
              type="button"
              onClick={returnHome}
              aria-current={activePanel === null ? "page" : undefined}
              className={`grid min-h-[60px] place-items-center gap-1 ${
                activePanel === null ? "text-[var(--fp-client-green)]" : "text-[#676d72]"
              }`}
            >
              <Home
                className={`h-7 w-7 stroke-[2] ${
                  activePanel === null ? "fill-[var(--fp-client-green)]" : "fill-none"
                }`}
              />
              <span className="text-[12px] font-semibold">Inicio</span>
              <span
                className={`h-1 w-8 rounded-full ${
                  activePanel === null ? "bg-[var(--fp-client-action)]" : "bg-transparent"
                }`}
              />
            </button>

            <button
              type="button"
              onClick={() => openPanel("pending")}
              aria-current={
                activePanel === "pending" || activePanel === "payments"
                  ? "page"
                  : undefined
              }
              className={`grid min-h-[60px] place-items-center gap-1 ${
                activePanel === "pending" || activePanel === "payments"
                  ? "text-[#111317]"
                  : "text-[#676d72]"
              }`}
            >
              <CreditCard
                className={`h-7 w-7 stroke-[2] ${
                  activePanel === "pending" || activePanel === "payments"
                    ? "fill-[#1b1e20]"
                    : "fill-none"
                }`}
              />
              <span className="text-[12px] font-semibold">Crédito</span>
              <span
                className={`h-1 w-8 rounded-full ${
                  activePanel === "pending" || activePanel === "payments"
                    ? "bg-[var(--fp-client-action)]"
                    : "bg-transparent"
                }`}
              />
            </button>

            <button
              type="button"
              onClick={() => openPanel("history")}
              aria-current={activePanel === "history" ? "page" : undefined}
              className={`grid min-h-[60px] place-items-center gap-1 ${
                activePanel === "history" ? "text-[#111317]" : "text-[#676d72]"
              }`}
            >
              <Clock3 className="h-7 w-7 stroke-[2]" />
              <span className="text-[12px] font-semibold">Historial</span>
              <span
                className={`h-1 w-8 rounded-full ${
                  activePanel === "history" ? "bg-[var(--fp-client-action)]" : "bg-transparent"
                }`}
              />
            </button>

            <button
              type="button"
              onClick={forgetDocument}
              className="grid min-h-[60px] place-items-center gap-1 text-[#676d72] active:text-[#111317]"
            >
              <CircleUserRound className="h-7 w-7 stroke-[2]" />
              <span className="text-[12px] font-semibold">SALIR</span>
              <span className="h-1 w-8 rounded-full bg-transparent" />
            </button>
          </div>
        </nav>

        {confirmCredit ? (
          <ClientNequiPaymentDialog
            amount={confirmAmount}
            installmentLabel={confirmPaymentLabel}
            product={creditTitle(confirmCredit)}
            imei={confirmCredit.imei || confirmCredit.deviceUid || null}
            document={confirmPaymentReference}
            phone={nequiPhone}
            acceptedTerms={acceptWompiTerms}
            submitting={payingCreditId === confirmCredit.id}
            notice={notice}
            onPhoneChange={(value) => {
              setNequiPhone(formatNequiPhone(value));
              if (notice?.tone === "red") setNotice(null);
            }}
            onTermsChange={(value) => {
              setAcceptWompiTerms(value);
              if (notice?.tone === "red") setNotice(null);
            }}
            onCancel={() => {
              if (sendingPaymentRef.current) return;
              setConfirmPaymentCreditId(null);
              setConfirmPaymentMode("INSTALLMENTS");
              setAcceptWompiTerms(false);
              setNotice(null);
            }}
            onSubmit={() => void payWithWompi(confirmCredit)}
          />
        ) : null}


      </div>
    </div>
  );
}
