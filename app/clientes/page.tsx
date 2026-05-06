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

function stateLabel(estado: ClientCredit["estadoPago"]) {
  if (estado === "AL_DIA") return "Al dia";
  if (estado === "PAGADO") return "Pagado";
  return "En mora";
}

function stateClass(estado: ClientCredit["estadoPago"]) {
  if (estado === "MORA") return "bg-[#fff1ec] text-[#c2410c]";
  if (estado === "PAGADO") return "bg-[#e8fff4] text-[#047857]";
  return "bg-[#e7f8ff] text-[#0369a1]";
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
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
      className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-[#111317] px-5 text-sm font-black text-white shadow-[0_14px_30px_rgba(17,19,23,0.22)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
    >
      {children}
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
        silent
          ? null
          : {
              text: nextItems.length
                ? "Consulta cargada."
                : "No encontramos creditos con esa cedula.",
              tone: nextItems.length ? "emerald" : "red",
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

  const hasSavedSession = Boolean(activeDocumento && items.length);

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f4f7f6] text-[#101319]">
      <div className="mx-auto flex min-h-screen w-full max-w-full flex-col bg-[#f4f7f6] shadow-[0_0_60px_rgba(15,23,42,0.08)] sm:max-w-[430px]">
        <header className="sticky top-0 z-20 border-b border-black/5 bg-[#111317] px-5 pb-5 pt-4 text-white">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img
                src="/icons/finserpay-client-192.png"
                alt="FINSER PAY"
                className="h-11 w-11 rounded-2xl object-cover"
              />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.26em] text-white/55">
                  Portal cliente
                </p>
                <h1 className="text-lg font-black tracking-[0.04em]">FINSER PAY</h1>
              </div>
            </div>
            {activeDocumento ? (
              <button
                type="button"
                onClick={forgetDocument}
                className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-black text-white/80"
              >
                Cambiar
              </button>
            ) : null}
          </div>

          <div className="mt-5 rounded-[28px] bg-[linear-gradient(135deg,#2f3339_0%,#14161a_60%,#06070a_100%)] p-5 shadow-[0_20px_45px_rgba(0,0,0,0.26)]">
            <p className="w-fit rounded-full bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-white/70">
              Soy cliente
            </p>
            <h2 className="mt-4 text-2xl font-black leading-tight">
              Tus cuotas en una vista simple.
            </h2>
            <p className="mt-3 text-sm leading-6 text-white/72">
              Consulta tu credito, mira cuanto has pagado y elige como pagar.
            </p>
          </div>
        </header>

        <section className="flex-1 space-y-4 px-5 py-5">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void consultar();
            }}
            className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.06)]"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#0f766e]">
                  Acceso
                </p>
                <h3 className="mt-1 text-xl font-black">Soy cliente</h3>
              </div>
              {hasSavedSession ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-black text-emerald-700">
                  Activo
                </span>
              ) : null}
            </div>

            <div className="mt-4 grid gap-3">
              <label htmlFor="documento" className="text-xs font-black text-slate-500">
                Cedula
              </label>
              <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-[#f8faf9] px-4">
                <span className="text-xs font-black text-slate-400">CC</span>
                <input
                  id="documento"
                  value={documento}
                  onChange={(event) =>
                    setDocumento(normalizeDocument(event.target.value))
                  }
                  inputMode="numeric"
                  placeholder="Numero de cedula"
                  className="h-14 w-full bg-transparent py-4 text-lg font-black outline-none placeholder:text-slate-300"
                />
              </div>
              <PrimaryButton disabled={loading || !bootstrapped} type="submit">
                {loading ? "Consultando..." : "Consultar credito"}
              </PrimaryButton>
            </div>
          </form>

          {notice ? (
            <div
              className={[
                "rounded-2xl border px-4 py-3 text-sm font-bold",
                notice.tone === "emerald"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-red-200 bg-red-50 text-red-700",
              ].join(" ")}
            >
              {notice.text}
            </div>
          ) : null}

          {!items.length ? (
            <section className="rounded-[28px] border border-dashed border-slate-300 bg-white p-5 text-center">
              <p className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#111317] text-sm font-black text-white">
                FP
              </p>
              <h3 className="mt-4 text-xl font-black">Consulta lista</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Ingresa tu cedula una vez. La app la recordara en este celular.
              </p>
            </section>
          ) : null}

          {items.length ? (
            <section className="grid grid-cols-3 gap-2">
              <div className="rounded-2xl bg-white p-3 shadow-sm">
                <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">
                  Creditos
                </p>
                <p className="mt-1 text-xl font-black">{items.length}</p>
              </div>
              <div className="rounded-2xl bg-white p-3 shadow-sm">
                <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">
                  Pagadas
                </p>
                <p className="mt-1 text-xl font-black">
                  {items.reduce((sum, credit) => sum + getPaidInstallments(credit).length, 0)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-3 shadow-sm">
                <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">
                  Debes
                </p>
                <p className="mt-1 text-xl font-black">
                  {items.reduce((sum, credit) => sum + getPayableInstallments(credit).length, 0)}
                </p>
              </div>
            </section>
          ) : null}

          {items.map((credit) => {
            const paidCount = getPaidInstallments(credit).length;
            const payable = getPayableInstallments(credit);
            const totalCount = credit.cuotas.length;
            const progress = totalCount ? Math.round((paidCount / totalCount) * 100) : 0;
            const isOpen = openCreditId === credit.id;
            const nextInstallment = payable[0] || null;
            const selectedCuotas = cuotasSeleccionadas(credit);
            const totalToPay = selectedTotal(credit);
            const selectedText = selectedCuotas.length
              ? selectedCuotas.map((item) => item.numero).join(", ")
              : "-";

            return (
              <article
                key={credit.id}
                className="overflow-hidden rounded-[30px] border border-slate-200 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.06)]"
              >
                <button
                  type="button"
                  onClick={() => setOpenCreditId(isOpen ? null : credit.id)}
                  className="w-full p-4 text-left"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#0f766e]">
                        {credit.folio}
                      </p>
                      <h3 className="mt-2 text-xl font-black capitalize">
                        {credit.clienteNombre.toLowerCase()}
                      </h3>
                      <p className="mt-1 text-sm font-bold text-slate-500">
                        {credit.referenciaEquipo || "Equipo financiado"}
                      </p>
                    </div>
                    <span
                      className={[
                        "shrink-0 rounded-full px-3 py-1 text-[11px] font-black",
                        stateClass(credit.estadoPago),
                      ].join(" ")}
                    >
                      {stateLabel(credit.estadoPago)}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl bg-[#f5f7f7] p-3">
                      <p className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                        Pagadas
                      </p>
                      <p className="mt-1 text-lg font-black">
                        {paidCount}/{totalCount}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-[#f5f7f7] p-3">
                      <p className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                        Debes
                      </p>
                      <p className="mt-1 text-lg font-black">{payable.length}</p>
                    </div>
                    <div className="rounded-2xl bg-emerald-50 p-3">
                      <p className="text-[9px] font-black uppercase tracking-[0.12em] text-emerald-600">
                        Disponible
                      </p>
                      <p className="mt-1 text-lg font-black">
                        {money(getAvailableBalance(credit))}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-[#111317] transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </button>

                {isOpen ? (
                  <div className="border-t border-slate-100 px-4 pb-4">
                    <div className="mt-4 rounded-2xl bg-[#111317] p-4 text-white">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/50">
                        Proxima cuota
                      </p>
                      <div className="mt-2 flex items-end justify-between gap-3">
                        <div>
                          <p className="text-3xl font-black">
                            {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                          </p>
                          <p className="mt-1 text-xs font-bold text-white/55">
                            {nextInstallment
                              ? `Cuota ${nextInstallment.numero} vence ${dateLabel(nextInstallment.fechaVencimiento)}`
                              : "Credito sin saldo pendiente"}
                          </p>
                        </div>
                        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-black">
                          {progress}%
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3">
                      <div className="rounded-2xl border border-slate-200 p-4">
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                          Equipo
                        </p>
                        <p className="mt-1 text-sm font-black">
                          {credit.referenciaEquipo || "Equipo financiado"}
                        </p>
                        <p className="mt-1 text-xs font-bold text-slate-500">
                          IMEI: {credit.imei || credit.deviceUid || "No registrado"}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-slate-200 p-4">
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                          Medios de pago
                        </p>
                        <div className="mt-3 grid gap-2">
                          <div className="rounded-2xl bg-[#fff8dc] p-3">
                            <p className="text-sm font-black">Efecty</p>
                            <p className="mt-1 text-xs font-bold text-slate-600">
                              Pago presencial. Referencia: cedula del cliente.
                            </p>
                          </div>
                          <div className="rounded-2xl bg-[#eef6ff] p-3">
                            <p className="text-sm font-black">Bancolombia Ahorros</p>
                            <p className="mt-1 text-lg font-black">71800000458</p>
                          </div>
                          <div className="rounded-2xl bg-[#f1e9ff] p-3">
                            <p className="text-sm font-black">Wompi</p>
                            <p className="mt-1 text-xs font-bold text-slate-600">
                              Paga en linea con el valor de la cuota seleccionada.
                            </p>
                          </div>
                        </div>
                      </div>

                      {payable.length ? (
                        <div className="rounded-2xl border border-slate-200 p-4">
                          <label className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                            Elegir cuota a pagar
                          </label>
                          <select
                            value={selectedLimit[credit.id] || payable[0]?.numero || ""}
                            onChange={(event) =>
                              setSelectedLimit((current) => ({
                                ...current,
                                [credit.id]: Number(event.target.value),
                              }))
                            }
                            className="mt-3 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-black outline-none"
                          >
                            {payable.map((item) => (
                              <option key={item.numero} value={item.numero}>
                                Pagar hasta cuota {item.numero} - {money(item.saldoPendiente)}
                              </option>
                            ))}
                          </select>

                          <div className="mt-3 rounded-2xl bg-[#f5f7f7] p-3">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                              Cuotas seleccionadas
                            </p>
                            <p className="mt-1 text-sm font-black">{selectedText}</p>
                            <p className="mt-2 text-2xl font-black">{money(totalToPay)}</p>
                          </div>

                          <PrimaryButton
                            disabled={payingCreditId === credit.id || totalToPay <= 0}
                            onClick={() => void payWithWompi(credit)}
                          >
                            {payingCreditId === credit.id ? "Abriendo Wompi..." : "Pagar con Wompi"}
                          </PrimaryButton>
                        </div>
                      ) : null}

                      <details className="rounded-2xl border border-slate-200 p-4">
                        <summary className="cursor-pointer text-sm font-black">
                          Ver plan de pagos
                        </summary>
                        <div className="mt-3 grid gap-2">
                          {credit.cuotas.map((item) => (
                            <div
                              key={item.numero}
                              className="flex items-center justify-between gap-3 rounded-2xl bg-[#f7f9f9] px-3 py-3"
                            >
                              <div>
                                <p className="text-sm font-black">Cuota {item.numero}</p>
                                <p className="text-xs font-bold text-slate-500">
                                  {dateLabel(item.fechaVencimiento)}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="text-sm font-black">
                                  {money(item.saldoPendiente)}
                                </p>
                                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
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
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
