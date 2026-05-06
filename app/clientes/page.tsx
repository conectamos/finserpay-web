"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

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
  referenciaEquipo: string | null;
  imei?: string | null;
  deviceUid?: string | null;
  fechaCredito: string;
  montoCredito: number;
  valorCuota: number;
  sedeNombre: string;
  estadoPago: "PAGADO" | "AL_DIA" | "MORA";
  saldoPendiente: number;
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
  error?: string;
  reference?: string;
};

type ExplorerPanel = "payments" | "pending" | "history" | null;

const STORAGE_KEY = "finserpay.cliente.documento";
const WOMPI_PUBLIC_LINK = "https://checkout.wompi.co/l/4banHJ";

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

function installmentDotClass(item: ClientInstallment) {
  if (item.saldoPendiente <= 0) return "bg-[#15a66a]";
  if (item.estaEnMora) return "bg-[#e34c2f]";
  return "bg-[#a7e66f]";
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

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
}

function AppLogo({ large = false }: { large?: boolean }) {
  return (
    <div className={large ? "text-center" : "flex items-center gap-3"}>
      <Image
        src="/icons/finserpay-client-192.png"
        alt="FINSER PAY"
        width={large ? 80 : 40}
        height={large ? 80 : 40}
        className={[
          "object-cover",
          large ? "mx-auto h-20 w-20 rounded-lg" : "h-10 w-10 rounded-lg",
        ].join(" ")}
      />
      <div className={large ? "mt-4" : "min-w-0"}>
        <p
          className={[
            "font-black text-[#111317]",
            large ? "text-3xl" : "truncate text-base",
          ].join(" ")}
        >
          FINSER PAY
        </p>
        {!large ? (
          <p className="truncate text-xs font-bold text-[#7a7f87]">Clientes</p>
        ) : null}
      </div>
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
  const [activePanel, setActivePanel] = useState<ExplorerPanel>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const consultar = useCallback(async (rawDocument: string, silent = false) => {
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
      const nextOpenId = nextItems[0]?.id ?? null;

      localStorage.setItem(STORAGE_KEY, normalized);
      setDocumento(normalized);
      setActiveDocumento(normalized);
      setItems(nextItems);
      setOpenCreditId(nextOpenId);
      setActivePanel(null);
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
    const urlDocument = normalizeDocument(
      new URLSearchParams(window.location.search).get("documento") || ""
    );
    const storedDocument = normalizeDocument(localStorage.getItem(STORAGE_KEY) || "");
    const nextDocument = urlDocument || storedDocument;

    if (nextDocument) {
      setDocumento(nextDocument);
      void consultar(nextDocument, true);
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

  const payWithWompi = async (credit: ClientCredit) => {
    const cuotaNumeros = cuotasSeleccionadas(credit).map((item) => item.numero);

    if (!cuotaNumeros.length) {
      setNotice({ text: "Selecciona una cuota para pagar.", tone: "red" });
      return;
    }

    try {
      setPayingCreditId(credit.id);
      setNotice(null);

      const result = await requestJson<WompiCheckoutResponse>(
        "/api/clientes/wompi-checkout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creditoId: credit.id,
            cuotaNumeros,
            documento: credit.clienteDocumento || activeDocumento || documento,
          }),
        }
      );

      if (!result.ok || !result.data.checkoutUrl) {
        window.location.assign(WOMPI_PUBLIC_LINK);
        return;
      }

      window.location.assign(result.data.checkoutUrl);
    } catch {
      window.location.assign(WOMPI_PUBLIC_LINK);
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
    setNotice(null);
  };

  const returnHome = () => {
    setActivePanel(null);
    scrollToSection("cliente-dashboard");
  };

  const openPanel = (panel: Exclude<ExplorerPanel, null>) => {
    setActivePanel(panel);
    window.setTimeout(() => scrollToSection("explora-panel"), 80);
  };

  const selectCredit = (creditId: number) => {
    setOpenCreditId(creditId);
    setActivePanel(null);
    window.setTimeout(() => scrollToSection("cliente-dashboard"), 40);
  };

  const activeCredit = items.find((item) => item.id === openCreditId) || items[0] || null;
  const paidCount = activeCredit ? getPaidInstallments(activeCredit).length : 0;
  const payable = activeCredit ? getPayableInstallments(activeCredit) : [];
  const totalCount = activeCredit?.cuotas.length || 0;
  const progress = totalCount ? Math.round((paidCount / totalCount) * 100) : 0;
  const nextInstallment = payable[0] || null;
  const selectedInstallments = activeCredit ? cuotasSeleccionadas(activeCredit) : [];
  const selectedAmount = installmentsAmount(selectedInstallments);
  const selectedPaymentLabel = installmentsRangeLabel(selectedInstallments);
  const selectedPaymentLimit =
    activeCredit && nextInstallment
      ? selectedLimit[activeCredit.id] || nextInstallment.numero
      : 0;
  const canSubmit = !loading;
  const firstName = activeCredit ? getFirstName(activeCredit.clienteNombre) : "";
  const paymentReference = activeCredit?.clienteDocumento || activeDocumento || documento;

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
    <main id="cliente-dashboard" className="min-h-screen bg-[#f5f6f8] text-[#252a35]">
      <div className="mx-auto min-h-screen w-full max-w-[440px] pb-24">
        <header className="sticky top-0 z-20 border-b border-[#e8eaf0] bg-[#f5f6f8]/95 px-5 py-4 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              aria-label="Volver al dashboard"
              onClick={returnHome}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[#dde1e8] bg-white text-[#171b22] shadow-sm active:bg-[#f3f4f6]"
            >
              <HomeIcon />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-black text-[#7d8490]">Hola, {firstName}</p>
              <p className="truncate text-lg font-black text-[#171b22]">
                Tu credito FINSER PAY
              </p>
            </div>
            <button
              type="button"
              onClick={forgetDocument}
              className="rounded-md border border-[#dde1e8] bg-white px-3 py-2 text-xs font-black text-[#414854] shadow-sm"
            >
              Cambiar
            </button>
          </div>
        </header>

        <div className="space-y-4 px-5 py-4">
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

          {activeCredit ? (
            <>
              <section className="rounded-lg bg-[#111317] p-5 text-white shadow-[0_18px_36px_rgba(17,19,23,0.18)]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-white/60">Proxima cuota</p>
                    <p className="mt-2 text-4xl font-black leading-none">
                      {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                    </p>
                    <p className="mt-3 text-sm font-bold text-white/68">
                      Cuota {nextInstallment ? nextInstallment.numero : paidCount} de{" "}
                      {totalCount}
                    </p>
                  </div>
                  <span
                    className={[
                      "shrink-0 rounded-md px-3 py-2 text-xs font-black",
                      stateClasses(activeCredit.estadoPago),
                    ].join(" ")}
                  >
                    {stateLabel(activeCredit.estadoPago)}
                  </span>
                </div>

                <div className="mt-5 grid grid-cols-[1fr_auto] items-end gap-4">
                  <div>
                    <p className="text-xs font-bold text-white/55">Fecha limite</p>
                    <p className="mt-1 text-lg font-black">
                      {nextInstallment ? dateLabel(nextInstallment.fechaVencimiento) : "-"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void payWithWompi(activeCredit)}
                    disabled={!payable.length || payingCreditId === activeCredit.id}
                    className="rounded-lg bg-[#a7e66f] px-5 py-3 text-sm font-black text-[#102316] shadow-[0_12px_24px_rgba(111,194,70,0.25)] disabled:bg-white/20 disabled:text-white/45"
                  >
                    {payingCreditId === activeCredit.id ? "Abriendo" : "Pagar"}
                  </button>
                </div>

                <div className="mt-5">
                  <div className="h-2 overflow-hidden rounded-full bg-white/15">
                    <div
                      className="h-full rounded-full bg-[#a7e66f]"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-xs font-bold text-white/55">
                    <span>{paidCount} pagadas</span>
                    <span>{progress}% completado</span>
                  </div>
                </div>
              </section>

              {items.length > 1 ? (
                <section className="rounded-lg border border-[#dfece0] bg-white p-4 shadow-sm">
                  <SectionTitle
                    title="Creditos vigentes"
                    aside={
                      <span className="rounded-md bg-[#effbe6] px-2 py-1 text-xs font-black text-[#3f7d2d]">
                        {items.length} activos
                      </span>
                    }
                  />
                  <div className="mt-3 grid gap-2">
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
                            "grid min-h-20 w-full grid-cols-[1fr_auto] gap-3 rounded-lg border px-3 py-3 text-left transition active:scale-[0.99]",
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
                              IMEI {credit.imei || credit.deviceUid || "No registrado"}
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

              <section className="rounded-lg border border-[#e6e8ee] bg-white p-4 shadow-sm">
                <SectionTitle title="Tu equipo financiado" />
                <div className="mt-3 grid gap-3">
                  <div>
                    <p className="text-xs font-black uppercase text-[#7d8490]">
                      Referencia
                    </p>
                    <p className="mt-1 truncate text-base font-black text-[#171b22]">
                      {creditTitle(activeCredit)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-[#f6f7f9] px-3 py-3">
                    <p className="text-xs font-black uppercase text-[#7d8490]">IMEI</p>
                    <p className="mt-1 break-all text-sm font-black text-[#252a35]">
                      {activeCredit.imei || activeCredit.deviceUid || "No registrado"}
                    </p>
                  </div>
                </div>
              </section>

              <section className="rounded-lg border border-[#e6e8ee] bg-white p-4 shadow-sm">
                <SectionTitle title="Explora" />
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <QuickAction
                    label="Pagar cuota"
                    onClick={() => void payWithWompi(activeCredit)}
                  >
                    <CardIcon />
                  </QuickAction>
                  <QuickAction
                    label="Medios de pago"
                    onClick={() => openPanel("payments")}
                  >
                    <PaymentsIcon />
                  </QuickAction>
                  <QuickAction
                    label="Pagos pendientes"
                    onClick={() => openPanel("pending")}
                  >
                    <CalendarIcon />
                  </QuickAction>
                  <QuickAction
                    label="Historial"
                    onClick={() => openPanel("history")}
                  >
                    <HistoryIcon />
                  </QuickAction>
                </div>
              </section>

              {activePanel ? (
                <section
                  id="explora-panel"
                  className="rounded-lg border border-[#e6e8ee] bg-white p-4 shadow-sm"
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
                      <div className="mt-3 divide-y divide-[#edf0f4]">
                        {activeCredit.cuotas.map((item) => {
                          const isPayable = item.saldoPendiente > 0;

                          return (
                            <button
                              key={item.numero}
                              type="button"
                              disabled={!isPayable}
                              onClick={() => {
                                selectPaymentLimit(activeCredit.id, item.numero);
                              }}
                              className={[
                                "flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left disabled:cursor-default",
                                item.numero === selectedPaymentLimit
                                  ? "bg-[#f5ffef]"
                                  : "bg-transparent",
                              ].join(" ")}
                            >
                              <span
                                className={[
                                  "h-2.5 w-2.5 shrink-0 rounded-full",
                                  installmentDotClass(item),
                                ].join(" ")}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-black text-[#252a35]">
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
                          );
                        })}
                      </div>
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
                                Pagar hasta
                              </p>
                              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                                {payable.map((item) => (
                                  <button
                                    key={item.numero}
                                    type="button"
                                    onClick={() =>
                                      selectPaymentLimit(activeCredit.id, item.numero)
                                    }
                                    className={[
                                      "min-w-[104px] rounded-lg border px-3 py-2 text-left",
                                      item.numero === selectedPaymentLimit
                                        ? "border-[#a7e66f] bg-[#a7e66f] text-[#102316]"
                                        : "border-[#dfe5dd] bg-white text-[#303743]",
                                    ].join(" ")}
                                  >
                                    <span className="block text-xs font-black">
                                      Cuota {item.numero}
                                    </span>
                                    <span className="mt-1 block text-[11px] font-bold">
                                      {money(item.saldoPendiente)}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>

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
                            Pago en linea seguro por el valor seleccionado.
                          </p>
                          <div className="mt-4">
                            <PrimaryButton
                              disabled={payingCreditId === activeCredit.id || !payable.length}
                              onClick={() => void payWithWompi(activeCredit)}
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
                      <SectionTitle title="Historial" />
                      <div className="mt-3 divide-y divide-[#edf0f4]">
                        {activeCredit.abonos.length ? (
                          activeCredit.abonos.map((abono) => (
                            <div
                              key={abono.id}
                              className="flex items-center justify-between gap-4 py-3"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-black text-[#252a35]">
                                  {abono.metodoPago}
                                </p>
                                <p className="mt-1 text-xs font-bold text-[#8a919d]">
                                  {dateLabel(abono.fechaAbono)}
                                </p>
                              </div>
                              <p className="shrink-0 text-sm font-black text-[#252a35]">
                                {money(abono.valor)}
                              </p>
                            </div>
                          ))
                        ) : (
                          <p className="rounded-lg bg-[#f6f7f9] px-4 py-3 text-sm font-bold text-[#626976]">
                            Aun no hay pagos registrados.
                          </p>
                        )}
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>

        <nav className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-[440px] -translate-x-1/2 grid-cols-3 border-t border-[#e8eaf0] bg-white px-4 py-3 shadow-[0_-10px_26px_rgba(17,19,23,0.08)]">
          <button type="button" className="rounded-lg px-2 py-2 text-center text-[#111317]">
            <span className="mx-auto block h-1 w-8 rounded-full bg-[#111317]" />
            <span className="mt-2 block text-xs font-black">Inicio</span>
          </button>
          <button
            type="button"
            onClick={() => openPanel("pending")}
            className="rounded-lg px-2 py-2 text-center text-[#7d8490] active:bg-[#f5f6f8]"
          >
            <span className="block text-xs font-black">Pendientes</span>
            <span className="mt-1 block text-xs font-bold">{paidCount}/{totalCount}</span>
          </button>
          <button
            type="button"
            onClick={() => activeCredit && void payWithWompi(activeCredit)}
            disabled={!activeCredit || !payable.length || payingCreditId === activeCredit.id}
            className="rounded-lg bg-[#a7e66f] px-2 py-3 text-center text-xs font-black text-[#102316] shadow-[0_10px_20px_rgba(111,194,70,0.2)] disabled:bg-[#d9dde4] disabled:text-[#7e8490]"
          >
            Pagar
          </button>
        </nav>
      </div>
    </main>
  );
}
