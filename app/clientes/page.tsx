"use client";

import { useState } from "react";
import FinserBrand from "@/app/_components/finser-brand";

type ClientInstallment = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonado: number;
  saldoPendiente: number;
  estado: "PAGADA" | "AL_DIA" | "MORA";
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

const WOMPI_PAYMENT_LINK = "https://checkout.wompi.co/l/4banHJ";

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

function getPayableInstallments(credit: ClientCredit) {
  return credit.cuotas.filter((item) => item.saldoPendiente > 0);
}

async function requestJson<T>(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
}

export default function ClienteConsultaPage() {
  const [documento, setDocumento] = useState("");
  const [items, setItems] = useState<ClientCredit[]>([]);
  const [selectedInstallments, setSelectedInstallments] = useState<Record<number, number>>(
    {}
  );
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
              return nextInstallment ? [credit.id, nextInstallment.numero] : null;
            })
            .filter((item): item is [number, number] => Boolean(item))
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

  return (
    <main className="min-h-screen bg-[#edf7f3] px-4 py-8 text-slate-950">
      <section className="mx-auto max-w-6xl overflow-hidden rounded-[32px] border border-emerald-950/10 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.10)]">
        <div className="bg-[linear-gradient(135deg,#0f3d36_0%,#145a5a_55%,#18b6a7_100%)] px-6 py-7 text-white md:px-8">
          <FinserBrand dark />
          <h1 className="mt-6 text-3xl font-black tracking-tight md:text-4xl">
            Consulta de cuotas
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50">
            Ingresa tu cedula para ver pagos realizados, cuotas pendientes y estado de tu credito.
          </p>
        </div>

        <div className="grid gap-4 border-b border-slate-200 px-6 py-5 md:grid-cols-[1fr_auto] md:px-8">
          <input
            value={documento}
            onChange={(event) => setDocumento(event.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="Numero de cedula"
            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
          />
          <button
            type="button"
            onClick={() => void consultar()}
            disabled={loading}
            className="rounded-2xl bg-[#145a5a] px-6 py-3 text-sm font-bold text-white transition hover:bg-[#0f4a4a] disabled:opacity-70"
          >
            {loading ? "Consultando..." : "Consultar"}
          </button>
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
          {items.map((credit) => {
            const payableInstallments = getPayableInstallments(credit);
            const selectedInstallment =
              payableInstallments.find(
                (item) => item.numero === selectedInstallments[credit.id]
              ) ||
              payableInstallments[0] ||
              null;
            const paymentReference = selectedInstallment
              ? `${credit.folio}-CUOTA-${selectedInstallment.numero}`
              : credit.folio;

            return (
            <section
              key={credit.id}
              className="rounded-[28px] border border-slate-200 bg-[#fbfdfb] p-5 shadow-sm"
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

              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold text-slate-500">Saldo pendiente</p>
                  <p className="mt-2 text-xl font-black">{money(credit.saldoPendiente)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold text-slate-500">Pagado</p>
                  <p className="mt-2 text-xl font-black">{money(credit.totalPagado)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold text-slate-500">Valor cuota</p>
                  <p className="mt-2 text-xl font-black">{money(credit.valorCuota)}</p>
                </div>
              </div>

              <div className="mt-5 rounded-[24px] border border-emerald-200 bg-emerald-50 px-4 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div className="flex-1">
                    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-800">
                      Pago en linea
                    </p>
                    <h3 className="mt-2 text-xl font-black text-slate-950">
                      Elige la cuota que vas a pagar
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-700">
                      Referencia sugerida:{" "}
                      <span className="font-bold text-slate-950">{paymentReference}</span>
                    </p>
                  </div>

                  {selectedInstallment ? (
                    <div className="grid w-full gap-3 lg:w-auto lg:min-w-[460px] lg:grid-cols-[1fr_1fr_auto]">
                      <select
                        value={selectedInstallment.numero}
                        onChange={(event) =>
                          setSelectedInstallments((current) => ({
                            ...current,
                            [credit.id]: Number(event.target.value),
                          }))
                        }
                        className="rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100"
                      >
                        {payableInstallments.map((item) => (
                          <option key={item.numero} value={item.numero}>
                            Cuota {item.numero} - {money(item.saldoPendiente)}
                          </option>
                        ))}
                      </select>

                      <div className="rounded-2xl border border-emerald-200 bg-white px-4 py-3">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-700">
                          Valor a pagar
                        </p>
                        <p className="mt-1 text-lg font-black text-slate-950">
                          {money(selectedInstallment.saldoPendiente)}
                        </p>
                      </div>

                      <a
                        href={WOMPI_PAYMENT_LINK}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center justify-center rounded-2xl bg-[#145a5a] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#0f4a4a]"
                      >
                        Pagar en Wompi
                      </a>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-sm font-bold text-emerald-800">
                      No tienes cuotas pendientes para pagar.
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Cuota</th>
                      <th className="px-4 py-3">Vence</th>
                      <th className="px-4 py-3">Valor</th>
                      <th className="px-4 py-3">Abonado</th>
                      <th className="px-4 py-3">Saldo</th>
                      <th className="px-4 py-3">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {credit.cuotas.map((item) => (
                      <tr key={item.numero}>
                        <td className="px-4 py-3 font-bold">{item.numero}</td>
                        <td className="px-4 py-3">{dateLabel(item.fechaVencimiento)}</td>
                        <td className="px-4 py-3">{money(item.valorProgramado)}</td>
                        <td className="px-4 py-3">{money(item.valorAbonado)}</td>
                        <td className="px-4 py-3 font-bold">{money(item.saldoPendiente)}</td>
                        <td className="px-4 py-3">{item.estado === "AL_DIA" ? "Al dia" : item.estado}</td>
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
