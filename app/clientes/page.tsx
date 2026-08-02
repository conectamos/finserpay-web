"use client";

import { useCallback, useEffect, useState } from "react";
import ClientActiveCreditDashboard from "@/app/clientes/client-active-credit-dashboard";
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

type PaymentReturnNotice = {
  reference: string;
  creditId: number | null;
  checkedAt?: string | null;
};

type ExplorerPanel = ClientCreditPanelName | null;
type ClientPaymentMode = "INSTALLMENTS" | "PAYOFF";

declare global {
  interface Window {
    FinserPayAndroid?: {
      registerClient?: (documento: string) => void;
    };
  }
}

const STORAGE_KEY = "finserpay.cliente.documento";
const NEW_CREDIT_SUPPORT_MESSAGE =
  "Hola, equipo de FINSER PAY 👋 Finalicé mi crédito y quiero solicitar uno nuevo. ¿Podrían orientarme, por favor?";

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
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

function maskedDocumentLabel(value?: string | null) {
  const normalized = String(value || "").replace(/\D/g, "");
  if (!normalized) return "Documento no registrado";
  return `Documento terminado en ${normalized.slice(-4)}`;
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
    const targetPanel = wompiReference ? panelFromUrl || "payments" : panelFromUrl;

    if (wompiReference) {
      setPaymentReturn({
        reference: wompiReference,
        creditId: creditFromUrl,
        checkedAt: null,
      });
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
  const totalCount = activeCredit?.cuotas.length || 0;
  const nextInstallment = payable[0] || null;
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
      className="min-h-[100svh] overflow-x-hidden bg-[#F4F3EE] text-[#111317]"
    >
      <div className="mx-auto min-h-[100svh] w-full max-w-[430px] bg-[#F4F3EE] pb-[calc(88px+env(safe-area-inset-bottom))] shadow-[0_0_60px_rgba(13,17,18,0.16)]">
        <div
          aria-hidden={activePanel ? true : undefined}
          inert={activePanel ? true : undefined}
        >
          <ClientActiveCreditDashboard
          activeCreditId={activeCredit.id}
          clientFirstName={firstName}
          creditOptions={items.map((credit, index) => ({
            id: credit.id,
            label: `Crédito ${index + 1} · ${creditTitle(credit)}`,
          }))}
          device={{
            imageAlt: "",
            imageSrc: creditDeviceImage(activeCredit),
            meta: `${totalCount} cuotas · Equipo financiado`,
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
          notice={notice}
          onOpenDevice={() => openPanel("pending")}
          onOpenHistory={() => openPanel("history")}
          onOpenNotifications={() => openPanel("history")}
          onOpenPaymentMethods={() => openPanel("payments")}
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
                }
              : null
          }
          profileActionLabel="Cambiar cliente"
          profileInitials={profileInitials}
          statusLabel={
            activeCredit.estadoPago === "MORA" ? "Crédito en mora" : "Crédito al día"
          }
          statusTone={activeCredit.estadoPago === "MORA" ? "overdue" : "current"}
            totalInstallments={totalCount}
          />
        </div>

        {activePanel && activeCredit ? (
          <ClientCreditPanel
            credit={activeCredit}
            notice={notice}
            onBack={returnHome}
            onOpenPanel={openPanel}
            onPayoff={() => openWompiConfirm(activeCredit, "PAYOFF")}
            onPaySelected={() => openWompiConfirm(activeCredit)}
            onRefreshPayment={() => void refreshPaymentStatus()}
            onSelectPaymentLimit={(installmentNumber) =>
              selectPaymentLimit(activeCredit.id, installmentNumber)
            }
            panel={activePanel}
            pendingPayment={paymentReturn}
            paying={payingCreditId === activeCredit.id}
            refreshingPayment={refreshingPayment || loading}
            selectedPaymentLimit={selectedPaymentLimit}
          />
        ) : null}

        <nav
          aria-label="Navegación del portal"
          className="fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 border-t border-[#e5e3de] bg-white/95 px-4 pb-[calc(8px+env(safe-area-inset-bottom))] pt-2 shadow-[0_-14px_34px_rgba(17,20,24,0.09)] backdrop-blur-xl"
        >
          <div className="grid min-h-[72px] grid-cols-4 items-center">
            <button
              type="button"
              onClick={returnHome}
              aria-current={activePanel === null ? "page" : undefined}
              className={`grid min-h-[60px] place-items-center gap-1 ${
                activePanel === null ? "text-[#5f8f16]" : "text-[#676d72]"
              }`}
            >
              <Home
                className={`h-7 w-7 stroke-[2] ${
                  activePanel === null ? "fill-[#77a923]" : "fill-none"
                }`}
              />
              <span className="text-[12px] font-semibold">Inicio</span>
              <span
                className={`h-1 w-8 rounded-full ${
                  activePanel === null ? "bg-[#b7e63d]" : "bg-transparent"
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
                    ? "bg-[#b7e63d]"
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
                  activePanel === "history" ? "bg-[#b7e63d]" : "bg-transparent"
                }`}
              />
            </button>

            <button
              type="button"
              onClick={forgetDocument}
              className="grid min-h-[60px] place-items-center gap-1 text-[#676d72] active:text-[#111317]"
            >
              <CircleUserRound className="h-7 w-7 stroke-[2]" />
              <span className="text-[12px] font-semibold">Perfil</span>
              <span className="h-1 w-8 rounded-full bg-transparent" />
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
                  <span className="font-black text-[#252a35]">
                    {maskedImeiLabel(confirmCredit.imei || confirmCredit.deviceUid)}
                  </span>
                </div>
                <div className="grid grid-cols-[82px_1fr] gap-3">
                  <span className="font-black uppercase text-[#7d8490]">Documento</span>
                  <span className="font-black text-[#252a35]">
                    {maskedDocumentLabel(confirmPaymentReference)}
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
    </div>
  );
}
