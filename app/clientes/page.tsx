"use client";

import { useState } from "react";
import FinserBrand from "@/app/_components/finser-brand";

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
  fechaCredito: string;
  montoCredito: number;
  valorCuota: number;
  sedeNombre: string;
  estadoPago: "PAGADO" | "AL_DIA" | "MORA";
  saldoPendiente: number;
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

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function dateLabel(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("es-CO");
}

function installmentStateLabel(item: ClientInstallment) {
  return item.estaEnMora ? "MORA" : item.estado;
}

function installmentStateClasses(item: ClientInstallment) {
  if (item.estaEnMora) {
    return "border-[#ffb08a] bg-[#ffefe4] text-[#c85216]";
  }

  if (item.estado === "PAGO") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  return "border-slate-200 bg-slate-100 text-slate-700";
}

function getPayableInstallments(credit: ClientCredit) {
  return credit.cuotas.filter((item) => item.saldoPendiente > 0);
}

function getPaidInstallments(credit: ClientCredit) {
  return credit.cuotas.filter(
    (item) => item.estado === "PAGO" || item.saldoPendiente <= 0
  );
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
}

export default function ClienteConsultaPage() {
  const [documento, setDocumento] = useState("");
  const [items, setItems] = useState<ClientCredit[]>([]);
  const [selectedInstallments, setSelectedInstallments] = useState<Record<number, number[]>>(
    {}
  );
  const [payingCreditId, setPayingCreditId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const consultar = async () => {
    try {
      setLoading(true);
      setNotice(null);
      const normalized = documento.replace(/\D/g, "");
      const result = await requestJson<ClientCreditsResponse>(
        `/api/clientes/creditos?documento=${encodeURIComponent(normalized)}`
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo consultar la cedula");
      }

      const nextItems = result.data.items || [];
      setItems(nextItems);
      setSelectedInstallments(
        Object.fromEntries(
          nextItems
            .map((credit) => {
              const nextInstallment = getPayableInstallments(credit)[0];
              return nextInstallment ? [credit.id, [nextInstallment.numero]] : null;
            })
            .filter((item): item is [number, number[]] => Boolean(item))
        )
      );
      setNotice({
        text: result.data.items?.length
          ? "Consulta cargada correctamente."
          : "No encontramos creditos con esa cedula.",
        tone: result.data.items?.length ? "emerald" : "red",
      });
    } catch (error) {
      setItems([]);
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo consultar la cedula",
        tone: "red",
      });
    } finally {
      setLoading(false);
    }
  };

  const updateSelectedInstallments = (
    credit: ClientCredit,
    numero: number,
    checked: boolean
  ) => {
    const payableNumbers = getPayableInstallments(credit).map((item) => item.numero);
    const currentSet = new Set(selectedInstallments[credit.id] || []);
    const nextNumbers = checked
      ? payableNumbers.filter((item) => item <= numero)
      : payableNumbers.filter((item) => item < numero && currentSet.has(item));

    setSelectedInstallments((current) => ({
      ...current,
      [credit.id]: nextNumbers,
    }));
  };

  const selectedTotal = (credit: ClientCredit) => {
    const selected = new Set(selectedInstallments[credit.id] || []);

    return getPayableInstallments(credit)
      .filter((item) => selected.has(item.numero))
      .reduce((sum, item) => sum + item.saldoPendiente, 0);
  };

  const payWithWompi = async (credit: ClientCredit) => {
    try {
      const cuotaNumeros = selectedInstallments[credit.id] || [];

      if (!cuotaNumeros.length) {
        setNotice({
          text: "Selecciona al menos una cuota para pagar.",
          tone: "red",
        });
        return;
      }

      setPayingCreditId(credit.id);
      setNotice(null);

      const result = await requestJson<WompiCheckoutResponse>(
        "/api/clientes/wompi-checkout",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            creditoId: credit.id,
            cuotaNumeros,
            documento: credit.clienteDocumento || documento,
          }),
        }
      );

      if (!result.ok || !result.data.checkoutUrl) {
        throw new Error(result.data.error || "No se pudo preparar el pago con Wompi");
      }

      window.location.assign(result.data.checkoutUrl);
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : "No se pudo abrir Wompi",
        tone: "red",
      });
    } finally {
      setPayingCreditId(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#eaf4f2] px-4 py-8 text-slate-950">
      <section className="mx-auto max-w-6xl overflow-hidden rounded-[34px] border border-emerald-950/10 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.10)]">
        <div className="relative overflow-hidden bg-[linear-gradient(135deg,#10231f_0%,#145a5a_58%,#18a7b5_100%)] px-6 py-7 text-white md:px-8">
          <div className="relative z-10">
            <FinserBrand dark />
            <div className="mt-7 grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
              <div>
                <p className="inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-emerald-50">
                  Portal clientes
                </p>
                <h1 className="mt-4 text-3xl font-black tracking-tight md:text-5xl">
                  Consulta tus cuotas
                </h1>
                <p className="mt-3 max-w-xl text-sm leading-6 text-emerald-50">
                  Revisa tu credito, pagos realizados y saldo disponible para pagar en linea.
                </p>
              </div>

              <div className="fp-client-query rounded-[28px] border border-white/20 bg-white/95 p-4 text-slate-950 shadow-[0_24px_60px_rgba(8,28,24,0.24)] md:p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#0f766e]">
                      Identificacion
                    </p>
                    <h2 className="mt-1 text-xl font-black">Ingresa tu cedula</h2>
                  </div>
                  <span className="inline-flex w-fit rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-700">
                    Consulta segura
                  </span>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
                  <label className="sr-only" htmlFor="cliente-documento">
                    Numero de cedula
                  </label>
                  <div className="fp-client-input-shell relative rounded-[22px] border border-slate-200 bg-white shadow-[0_14px_30px_rgba(15,23,42,0.08)]">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-[#10231f] px-3 py-1 text-[11px] font-black text-white">
                      CC
                    </span>
                    <input
                      id="cliente-documento"
                      value={documento}
                      onChange={(event) =>
                        setDocumento(event.target.value.replace(/\D/g, ""))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !loading) {
                          void consultar();
                        }
                      }}
                      inputMode="numeric"
                      placeholder="Numero de cedula"
                      className="h-14 w-full rounded-[22px] border-0 bg-transparent py-3 pl-16 pr-4 text-lg font-black text-slate-950 outline-none placeholder:text-slate-400"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void consultar()}
                    disabled={loading}
                    className="rounded-[22px] bg-[#101319] px-7 py-3 text-sm font-black text-white shadow-[0_16px_34px_rgba(15,23,42,0.28)] transition hover:-translate-y-0.5 hover:bg-[#145a5a] disabled:opacity-70"
                  >
                    {loading ? "Consultando..." : "Consultar"}
                  </button>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  {["Cedula", "Credito", "Pago"].map((label, index) => (
                    <div
                      key={label}
                      className="fp-client-step rounded-2xl border border-slate-200 bg-[#f8fbfb] px-3 py-2"
                      style={{ animationDelay: `${index * 80}ms` }}
                    >
                      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
                        Paso {index + 1}
                      </span>
                      <p className="mt-1 text-sm font-black text-slate-950">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {notice ? (
          <div
            className={[
              "mx-6 mt-5 rounded-2xl border px-4 py-3 text-sm font-semibold md:mx-8",
              notice.tone === "emerald"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700",
            ].join(" ")}
          >
            {notice.text}
          </div>
        ) : null}

        <div className="space-y-5 px-6 py-6 md:px-8">
          {!items.length ? (
            <div className="fp-client-empty rounded-[28px] border border-dashed border-emerald-200 bg-[#f8fdfb] p-5 shadow-[0_12px_32px_rgba(15,23,42,0.04)] md:p-6">
              <div className="grid gap-4 md:grid-cols-[auto_1fr] md:items-center">
                <div className="grid h-16 w-16 place-items-center rounded-[22px] bg-[#10231f] text-2xl font-black text-white shadow-[0_14px_30px_rgba(15,35,31,0.22)]">
                  CC
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#0f766e]">
                    Estado de cuenta
                  </p>
                  <h3 className="mt-2 text-2xl font-black text-slate-950">
                    Tu informacion aparecera aqui
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Veras saldo disponible, cuotas pagas, proxima cuota y acceso a pago en linea.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {items.map((credit) => {
            const payableInstallments = getPayableInstallments(credit);
            const selected = new Set(selectedInstallments[credit.id] || []);
            const selectedInstallmentsData = payableInstallments.filter((item) =>
              selected.has(item.numero)
            );
            const totalToPay = selectedTotal(credit);
            const selectedNumbers = Array.from(selected).sort((a, b) => a - b);
            const paymentReference = selectedNumbers.length
              ? `${credit.folio}-CUOTAS-${selectedNumbers.join("-")}`
              : credit.folio;
            const paidInstallments = getPaidInstallments(credit);
            const totalInstallments = credit.cuotas.length;
            const paidCount = paidInstallments.length;
            const progressPercent = totalInstallments
              ? Math.round((paidCount / totalInstallments) * 100)
              : 0;
            const nextInstallment = payableInstallments[0];

            return (
            <section
              key={credit.id}
              className="fp-client-result rounded-[30px] border border-slate-200 bg-[#fbfdfb] p-5 shadow-[0_18px_44px_rgba(15,23,42,0.07)]"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-700">
                    Credito {credit.folio}
                  </p>
                  <h2 className="mt-2 text-2xl font-black">{credit.clienteNombre}</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {credit.referenciaEquipo || "Equipo financiado"} | {credit.sedeNombre}
                  </p>
                </div>
                <span
                  className={[
                    "inline-flex rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em]",
                    credit.estadoPago === "MORA"
                      ? "border-red-200 bg-red-50 text-red-700"
                      : credit.estadoPago === "PAGADO"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-sky-200 bg-sky-50 text-sky-700",
                  ].join(" ")}
                >
                  {credit.estadoPago === "AL_DIA" ? "Al dia" : credit.estadoPago}
                </span>
              </div>

              <div className="mt-5 rounded-[24px] border border-emerald-100 bg-white p-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#0f766e]">
                      Avance del credito
                    </p>
                    <p className="mt-1 text-sm font-bold text-slate-700">
                      {paidCount} de {totalInstallments || 0} cuotas pagas realizadas
                    </p>
                  </div>
                  <div className="rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-sm font-black text-emerald-800">
                    {progressPercent}%
                  </div>
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#12b886_0%,#18a7b5_70%,#b7e45c_100%)] transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-4">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4">
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-emerald-700">
                    Saldo disponible
                  </p>
                  <p className="mt-2 text-xl font-black">{money(credit.saldoPendiente)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    Cuotas pagas
                  </p>
                  <p className="mt-2 text-xl font-black">
                    {paidCount}
                    <span className="text-sm font-bold text-slate-500">
                      {" "}
                      / {totalInstallments || 0}
                    </span>
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    Total pagado
                  </p>
                  <p className="mt-2 text-xl font-black">{money(credit.totalPagado)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    Proxima cuota
                  </p>
                  <p className="mt-2 text-xl font-black">
                    {nextInstallment ? money(nextInstallment.saldoPendiente) : money(0)}
                  </p>
                </div>
              </div>

              <div className="mt-5 rounded-[24px] border border-[#d7e3e5] bg-white p-5 shadow-[0_12px_32px_rgba(15,23,42,0.06)]">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex-1">
                    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#1d5b63]">
                      Pago en linea
                    </p>
                    <h3 className="mt-2 text-2xl font-black text-slate-950">
                      Selecciona tu saldo disponible
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-700">
                      Referencia sugerida:{" "}
                      <span className="font-bold text-slate-950">{paymentReference}</span>
                    </p>
                  </div>

                  {payableInstallments.length ? (
                    <div className="w-full lg:max-w-[420px]">
                      <div className="rounded-[22px] border border-[#0f5654] bg-[#0f5654] px-5 py-4 text-white shadow-[0_16px_40px_rgba(15,86,84,0.22)]">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#98ece0]">
                              Cuotas seleccionadas
                            </p>
                            <p className="mt-2 text-2xl font-black">
                              {selectedNumbers.length
                                ? selectedNumbers.join(", ")
                                : "Ninguna"}
                            </p>
                          </div>
                          <div className="rounded-full bg-[#ff7a30] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white">
                            {selectedInstallmentsData.some((item) => item.estaEnMora)
                              ? "Con mora"
                              : "Al dia"}
                          </div>
                        </div>
                        <div className="mt-4 rounded-[18px] bg-[#111111] px-4 py-3">
                          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#8ff0df]">
                            Saldo disponible
                          </p>
                          <p className="mt-1 text-2xl font-black">
                            {money(totalToPay)}
                          </p>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {selectedInstallmentsData.length ? (
                            selectedInstallmentsData.map((item) => (
                              <span
                                key={item.numero}
                                className={[
                                  "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em]",
                                  item.estaEnMora
                                    ? "border-[#ffb08a] bg-[#ffefe4] text-[#ff7a30]"
                                    : item.estado === "PAGO"
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : "border-white/20 bg-white/10 text-white",
                                ].join(" ")}
                              >
                                Cuota {item.numero}: {installmentStateLabel(item)}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs font-semibold text-[#c6e8e3]">
                              Marca una cuota para ver el detalle del pago.
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void payWithWompi(credit)}
                        disabled={payingCreditId === credit.id || totalToPay <= 0}
                        className="mt-4 inline-flex w-full items-center justify-center rounded-[18px] bg-[#6b7280] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#4b5563] disabled:opacity-70"
                      >
                        {payingCreditId === credit.id ? "Abriendo..." : "Pagar con Wompi"}
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
                      No tienes cuotas pendientes para pagar.
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-[#171717] text-[11px] uppercase tracking-[0.16em] text-white">
                    <tr>
                      <th className="px-4 py-4">Cuota</th>
                      <th className="px-4 py-4">Fecha</th>
                      <th className="px-4 py-4">Valor</th>
                      <th className="px-4 py-4">Abonado</th>
                      <th className="px-4 py-4">Saldo disponible</th>
                      <th className="px-4 py-4">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {credit.cuotas.map((item, index) => (
                      <tr
                        key={item.numero}
                        className={index % 2 === 0 ? "bg-[#eef8f9]" : "bg-white"}
                      >
                        <td className="px-4 py-3.5 font-bold text-slate-950">
                          <label className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={selected.has(item.numero)}
                              disabled={item.saldoPendiente <= 0 || payingCreditId === credit.id}
                              onChange={(event) =>
                                updateSelectedInstallments(
                                  credit,
                                  item.numero,
                                  event.target.checked
                                )
                              }
                              className="h-5 w-5 rounded border-slate-300 text-[#145a5a] focus:ring-[#145a5a]"
                            />
                            <span>{item.numero}</span>
                          </label>
                        </td>
                        <td className="px-4 py-3.5 text-slate-700">
                          {dateLabel(item.fechaVencimiento)}
                        </td>
                        <td className="px-4 py-3.5 text-slate-700">
                          {money(item.valorProgramado)}
                        </td>
                        <td className="px-4 py-3.5 text-slate-700">
                          {money(item.valorAbonado)}
                        </td>
                        <td className="px-4 py-3.5 font-bold text-slate-950">
                          {money(item.saldoPendiente)}
                        </td>
                        <td className="px-4 py-3.5">
                          <span
                            className={[
                              "inline-flex rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em]",
                              installmentStateClasses(item),
                            ].join(" ")}
                          >
                            {installmentStateLabel(item)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            );
          })}
        </div>
      </section>
    </main>
  );
}
