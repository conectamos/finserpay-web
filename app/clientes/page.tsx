"use client";

import { useEffect, useState } from "react";

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

function getAvailableBalance(credit: ClientCredit) {
  return Math.max(0, Number(credit.saldoDisponible ?? credit.totalPagado ?? 0));
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
  if (estado === "MORA") return "border-[#ff6b4a] text-[#ff6b4a]";
  if (estado === "PAGADO") return "border-[#11a66a] text-[#087a4f]";
  return "border-[#18a7b5] text-[#087989]";
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
}

function FinserLogo({ large = false }: { large?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <img
        src="/icons/finserpay-client-192.png"
        alt="FINSER PAY"
        className={[
          "object-cover shadow-[0_16px_32px_rgba(17,19,23,0.18)]",
          large ? "h-24 w-24 rounded-[28px]" : "h-12 w-12 rounded-2xl",
        ].join(" ")}
      />
      <p
        className={[
          "mt-3 font-black text-[#252a35]",
          large ? "text-3xl" : "text-lg",
        ].join(" ")}
      >
        FINSER PAY
      </p>
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
      className="inline-flex h-14 w-full items-center justify-center rounded-full bg-[#ff8a18] px-5 text-base font-black text-white shadow-[0_16px_30px_rgba(255,138,24,0.26)] transition active:scale-[0.99] disabled:bg-[#dedede] disabled:text-[#9a9a9a] disabled:shadow-none"
    >
      {children}
    </button>
  );
}

function AccessButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="min-w-[96px] text-center">
      <span className="mx-auto grid h-20 w-20 place-items-center rounded-[34px] bg-[#f7f4ef] text-2xl font-black text-[#ff8a18] shadow-[0_14px_24px_rgba(17,19,23,0.06)]">
        {icon}
      </span>
      <span className="mt-3 block text-sm font-bold leading-4 text-[#55565b]">{label}</span>
    </button>
  );
}

export default function ClienteConsultaPage() {
  const [documento, setDocumento] = useState("");
  const [activeDocumento, setActiveDocumento] = useState("");
  const [items, setItems] = useState<ClientCredit[]>([]);
  const [openCreditId, setOpenCreditId] = useState<number | null>(null);
  const [selectedLimit, setSelectedLimit] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [payingCreditId, setPayingCreditId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const consultar = async (rawDocument = documento, silent = false) => {
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
  };

  useEffect(() => {
    const savedDocument = normalizeDocument(localStorage.getItem(STORAGE_KEY) || "");
    if (savedDocument) {
      setDocumento(savedDocument);
      void consultar(savedDocument, true).finally(() => setBootstrapped(true));
      return;
    }

    setBootstrapped(true);
  }, []);

  const cuotasSeleccionadas = (credit: ClientCredit) => {
    const limit = selectedLimit[credit.id] || 0;
    return getPayableInstallments(credit).filter((item) => item.numero <= limit);
  };

  const selectedTotal = (credit: ClientCredit) =>
    cuotasSeleccionadas(credit).reduce((sum, item) => sum + item.saldoPendiente, 0);

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
    setNotice(null);
  };

  const activeCredit = items.find((item) => item.id === openCreditId) || items[0] || null;
  const paidCount = activeCredit ? getPaidInstallments(activeCredit).length : 0;
  const payable = activeCredit ? getPayableInstallments(activeCredit) : [];
  const totalCount = activeCredit?.cuotas.length || 0;
  const progress = totalCount ? Math.round((paidCount / totalCount) * 100) : 0;
  const nextInstallment = payable[0] || null;
  const selectedCuotas = activeCredit ? cuotasSeleccionadas(activeCredit) : [];
  const totalToPay = activeCredit ? selectedTotal(activeCredit) : 0;
  const canSubmit = normalizeDocument(documento).length >= 5 && bootstrapped && !loading;
  const firstName = activeCredit ? getFirstName(activeCredit.clienteNombre) : "";

  if (!items.length) {
    return (
      <main className="min-h-screen overflow-x-hidden bg-white text-[#252a35]">
        <div className="mx-auto flex min-h-screen w-full max-w-full flex-col px-8 py-10 sm:max-w-[430px]">
          <div className="flex flex-1 flex-col justify-center">
            <FinserLogo large />

            <section className="mt-12 text-center">
              <h1 className="text-3xl font-black leading-tight">
                Bienvenido a FINSER PAY
              </h1>
              <p className="mt-4 text-lg font-medium text-[#929292]">
                Ingresa tu documento para continuar
              </p>
            </section>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void consultar();
              }}
              className="mt-10 rounded-[32px] bg-white p-6 shadow-[0_22px_48px_rgba(17,19,23,0.14)]"
            >
              <label
                htmlFor="documento"
                className="mb-3 block text-sm font-bold text-[#9a9a9a]"
              >
                Documento de identidad
              </label>
              <div className="flex h-16 items-center rounded-[24px] border border-[#e0e0e0] bg-[#f8f9fb] px-4">
                <div className="mr-3 flex items-center gap-2 border-r border-[#dddddd] pr-3">
                  <span className="grid h-6 w-8 overflow-hidden rounded-[3px] border border-black/5">
                    <span className="bg-[#fcd116]" />
                    <span className="bg-[#003893]" />
                    <span className="bg-[#ce1126]" />
                  </span>
                  <span className="font-black text-[#3b4251]">CC</span>
                </div>
                <input
                  id="documento"
                  value={documento}
                  onChange={(event) =>
                    setDocumento(normalizeDocument(event.target.value))
                  }
                  inputMode="numeric"
                  placeholder="Documento"
                  className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-[#30343d] outline-none placeholder:text-[#b4b4b4]"
                />
              </div>
              <div className="mt-8">
                <PrimaryButton disabled={!canSubmit} type="submit">
                  {loading ? "Consultando..." : "Continuar"}
                </PrimaryButton>
              </div>
            </form>

            {notice ? (
              <div
                className={[
                  "mt-5 rounded-2xl border px-4 py-3 text-sm font-bold",
                  notice.tone === "emerald"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-red-200 bg-red-50 text-red-700",
                ].join(" ")}
              >
                {notice.text}
              </div>
            ) : null}
          </div>

          <div className="pb-4 pt-8 text-center">
            <p className="text-sm font-black text-[#ff8a18]">Soy cliente</p>
            <p className="mt-4 text-sm font-medium text-[#a1a1a1]">Version 1.0</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-[#323337]">
      <div className="mx-auto min-h-screen w-full max-w-full bg-white pb-28 sm:max-w-[430px]">
        <header className="relative overflow-hidden px-8 pb-8 pt-10">
          <div className="absolute -left-20 -top-24 h-56 w-[340px] rounded-br-[180px] bg-[#111317]" />
          <div className="relative flex items-start justify-between">
            <div className="flex items-center gap-3 text-white">
              <img
                src="/icons/finserpay-client-192.png"
                alt="FINSER PAY"
                className="h-11 w-11 rounded-2xl object-cover"
              />
              <div className="max-w-[190px]">
                <p className="text-lg font-black">Hola,</p>
                <p className="truncate text-2xl font-light">{firstName}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={forgetDocument}
              className="rounded-full bg-[#f7f4ef] px-4 py-2 text-xs font-black text-[#525252] shadow-sm"
            >
              Cambiar
            </button>
          </div>

          <section className="mt-16 text-center">
            <p className="text-2xl font-light">
              Cuota{" "}
              <span className="font-black">
                {nextInstallment ? nextInstallment.numero : paidCount}
              </span>{" "}
              de <span className="font-black">{totalCount}</span>
            </p>
            <p className="mt-5 text-6xl font-black leading-none text-[#383838]">
              {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
            </p>
            <span
              className={[
                "mt-5 inline-flex rounded-full border px-5 py-2 text-base font-medium",
                activeCredit ? stateClasses(activeCredit.estadoPago) : "",
              ].join(" ")}
            >
              {activeCredit ? stateLabel(activeCredit.estadoPago) : "Sin credito"}
            </span>

            <div className="mt-8 h-3 rounded-full bg-[#e1dfdb]">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#111317_0%,#ff8a18_100%)]"
                style={{ width: `${progress}%` }}
              />
            </div>

            <div className="mt-8 flex items-center justify-between rounded-[28px] border border-[#cfcac4] bg-white p-3 pl-5">
              <div className="text-left">
                <p className="text-sm font-medium text-[#666]">Fecha limite</p>
                <p className="text-lg font-black">
                  {nextInstallment ? dateLabel(nextInstallment.fechaVencimiento) : "-"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => activeCredit && void payWithWompi(activeCredit)}
                disabled={!activeCredit || !payable.length || payingCreditId === activeCredit.id}
                className="h-16 rounded-[24px] bg-[#ff8a18] px-8 text-lg font-black text-white shadow-[0_14px_28px_rgba(255,138,24,0.25)] disabled:bg-[#dedede] disabled:text-[#999]"
              >
                {payingCreditId === activeCredit?.id ? "Abriendo" : "Pagar"}
              </button>
            </div>
          </section>
        </header>

        {notice ? (
          <div
            className={[
              "mx-8 mb-5 rounded-2xl border px-4 py-3 text-sm font-bold",
              notice.tone === "emerald"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700",
            ].join(" ")}
          >
            {notice.text}
          </div>
        ) : null}

        <section className="px-8">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-[24px] bg-[#f8f8f8] p-4 text-center">
              <p className="text-2xl font-black">{paidCount}</p>
              <p className="mt-1 text-xs font-bold text-[#858585]">Pagadas</p>
            </div>
            <div className="rounded-[24px] bg-[#f8f8f8] p-4 text-center">
              <p className="text-2xl font-black">{payable.length}</p>
              <p className="mt-1 text-xs font-bold text-[#858585]">Pendientes</p>
            </div>
            <div className="rounded-[24px] bg-[#f8f8f8] p-4 text-center">
              <p className="text-xl font-black">
                {activeCredit ? money(getAvailableBalance(activeCredit)) : money(0)}
              </p>
              <p className="mt-1 text-xs font-bold text-[#858585]">Disponible</p>
            </div>
          </div>

          <div className="mt-8 flex items-center justify-between">
            <h2 className="text-2xl font-black">Explora</h2>
          </div>
          <div className="mt-5 flex gap-5 overflow-x-auto pb-2">
            <AccessButton
              icon="$"
              label="Pagar cuota"
              onClick={() =>
                document.getElementById("pago-en-linea")?.scrollIntoView({
                  behavior: "smooth",
                })
              }
            />
            <AccessButton
              icon="P"
              label="Medios de pago"
              onClick={() =>
                document.getElementById("medios-pago")?.scrollIntoView({
                  behavior: "smooth",
                })
              }
            />
            <AccessButton
              icon="C"
              label="Plan de pagos"
              onClick={() =>
                document.getElementById("plan-pagos")?.scrollIntoView({
                  behavior: "smooth",
                })
              }
            />
            <AccessButton
              icon="H"
              label="Historial"
              onClick={() =>
                document.getElementById("historial")?.scrollIntoView({
                  behavior: "smooth",
                })
              }
            />
          </div>
        </section>

        {activeCredit ? (
          <section className="mt-8 space-y-5 px-8">
            <article className="rounded-[30px] bg-[#f3f5ff] p-5">
              <p className="text-sm font-black text-[#717ab3]">Tu equipo financiado</p>
              <p className="mt-2 text-2xl font-black text-[#545b91]">
                {activeCredit.referenciaEquipo || "Equipo financiado"}
              </p>
              <p className="mt-3 text-sm font-bold text-[#7a7f9e]">
                IMEI: {activeCredit.imei || activeCredit.deviceUid || "No registrado"}
              </p>
            </article>

            <article
              id="pago-en-linea"
              className="rounded-[30px] border border-[#ececec] bg-white p-5 shadow-[0_16px_36px_rgba(17,19,23,0.08)]"
            >
              <h2 className="text-2xl font-black">Pagar cuota</h2>
              {payable.length ? (
                <>
                  <label className="mt-4 block text-sm font-bold text-[#858585]">
                    Selecciona hasta que cuota deseas pagar
                  </label>
                  <select
                    value={selectedLimit[activeCredit.id] || payable[0]?.numero || ""}
                    onChange={(event) =>
                      setSelectedLimit((current) => ({
                        ...current,
                        [activeCredit.id]: Number(event.target.value),
                      }))
                    }
                    className="mt-3 h-14 w-full rounded-[22px] border border-[#e4e4e4] bg-[#fafafa] px-4 text-base font-black outline-none"
                  >
                    {payable.map((item) => (
                      <option key={item.numero} value={item.numero}>
                        Hasta cuota {item.numero} - {money(item.saldoPendiente)}
                      </option>
                    ))}
                  </select>
                  <div className="mt-4 rounded-[24px] bg-[#111317] p-4 text-white">
                    <p className="text-sm font-bold text-white/60">Total a pagar</p>
                    <p className="mt-1 text-3xl font-black">{money(totalToPay)}</p>
                    <p className="mt-2 text-xs font-bold text-white/55">
                      Cuotas:{" "}
                      {selectedCuotas.length
                        ? selectedCuotas.map((item) => item.numero).join(", ")
                        : "-"}
                    </p>
                  </div>
                  <div className="mt-4">
                    <PrimaryButton
                      disabled={payingCreditId === activeCredit.id || totalToPay <= 0}
                      onClick={() => void payWithWompi(activeCredit)}
                    >
                      {payingCreditId === activeCredit.id ? "Abriendo Wompi..." : "Pagar con Wompi"}
                    </PrimaryButton>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-sm font-bold text-[#777]">
                  No tienes cuotas pendientes para pagar.
                </p>
              )}
            </article>

            <article id="medios-pago" className="rounded-[30px] bg-[#f8f8f8] p-5">
              <h2 className="text-2xl font-black">Medios de pago</h2>
              <div className="mt-4 grid gap-3">
                <div className="rounded-[24px] bg-white p-4 shadow-sm">
                  <p className="text-lg font-black">Efecty</p>
                  <p className="mt-1 text-sm font-bold text-[#777]">
                    Pago presencial. Referencia: cedula del cliente.
                  </p>
                </div>
                <div className="rounded-[24px] bg-white p-4 shadow-sm">
                  <p className="text-lg font-black">Bancolombia Ahorros</p>
                  <p className="mt-1 text-2xl font-black text-[#111317]">71800000458</p>
                </div>
                <div className="rounded-[24px] bg-white p-4 shadow-sm">
                  <p className="text-lg font-black">Wompi</p>
                  <p className="mt-1 text-sm font-bold text-[#777]">
                    Pago en linea desde la cuota seleccionada.
                  </p>
                </div>
              </div>
            </article>

            <article className="rounded-[30px] bg-white p-5 shadow-[0_16px_36px_rgba(17,19,23,0.08)]">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black">Mis creditos</h2>
                <span className="text-sm font-black text-[#ff8a18]">{items.length}</span>
              </div>
              <div className="mt-4 grid gap-3">
                {items.map((credit) => {
                  const isActive = credit.id === activeCredit.id;
                  const creditPaid = getPaidInstallments(credit).length;
                  const creditTotal = credit.cuotas.length;

                  return (
                    <button
                      key={credit.id}
                      type="button"
                      onClick={() => setOpenCreditId(credit.id)}
                      className={[
                        "rounded-[24px] p-4 text-left transition",
                        isActive ? "bg-[#111317] text-white" : "bg-[#f8f8f8] text-[#323337]",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black">{credit.folio}</p>
                          <p className="mt-1 truncate text-sm font-bold opacity-70">
                            {credit.referenciaEquipo || "Equipo financiado"}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs font-black">
                          {creditPaid}/{creditTotal}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </article>

            <details
              id="plan-pagos"
              className="rounded-[30px] bg-white p-5 shadow-[0_16px_36px_rgba(17,19,23,0.08)]"
            >
              <summary className="cursor-pointer text-2xl font-black">Plan de pagos</summary>
              <div className="mt-4 grid gap-3">
                {activeCredit.cuotas.map((item) => (
                  <div
                    key={item.numero}
                    className="flex items-center justify-between gap-3 rounded-[22px] bg-[#f8f8f8] px-4 py-3"
                  >
                    <div>
                      <p className="font-black">Cuota {item.numero}</p>
                      <p className="text-sm font-bold text-[#858585]">
                        {dateLabel(item.fechaVencimiento)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-black">{money(item.saldoPendiente)}</p>
                      <p className="text-xs font-black text-[#858585]">
                        {item.saldoPendiente <= 0
                          ? "Pagada"
                          : item.estaEnMora
                            ? "Mora"
                            : "Pendiente"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </details>

            <article id="historial" className="rounded-[30px] bg-white p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black">Transacciones</h2>
              </div>
              <div className="mt-4 grid gap-3">
                {activeCredit.abonos.length ? (
                  activeCredit.abonos.map((abono) => (
                    <div
                      key={abono.id}
                      className="flex items-center justify-between rounded-[22px] bg-[#f8f8f8] px-4 py-3"
                    >
                      <div>
                        <p className="font-black">{abono.metodoPago}</p>
                        <p className="text-sm font-bold text-[#858585]">
                          {dateLabel(abono.fechaAbono)}
                        </p>
                      </div>
                      <p className="font-black">{money(abono.valor)}</p>
                    </div>
                  ))
                ) : (
                  <p className="rounded-[22px] bg-[#f8f8f8] px-4 py-4 text-sm font-bold text-[#777]">
                    Aun no hay pagos registrados.
                  </p>
                )}
              </div>
            </article>
          </section>
        ) : null}

        <nav className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-[430px] -translate-x-1/2 items-center justify-around border-t border-[#efefef] bg-white px-8 py-4 shadow-[0_-18px_38px_rgba(17,19,23,0.08)]">
          <button type="button" className="text-center text-[#111317]">
            <span className="mx-auto block h-1 w-12 rounded-full bg-[#111317]" />
            <span className="mt-2 block text-sm font-black">Inicio</span>
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById("plan-pagos")?.scrollIntoView({ behavior: "smooth" })
            }
            className="text-center text-[#8a8a8a]"
          >
            <span className="mx-auto grid h-10 w-10 place-items-center rounded-2xl bg-[#f4f4f4] text-sm font-black">
              P
            </span>
            <span className="mt-1 block text-sm font-bold">Plan</span>
          </button>
          <button
            type="button"
            onClick={() => activeCredit && void payWithWompi(activeCredit)}
            disabled={!activeCredit || !payable.length || payingCreditId === activeCredit.id}
            className="grid h-20 w-20 -translate-y-7 place-items-center rounded-full bg-[#ff8a18] text-sm font-black text-white shadow-[0_16px_32px_rgba(255,138,24,0.28)] disabled:bg-[#dedede]"
          >
            Pagar
          </button>
        </nav>
      </div>
    </main>
  );
}
