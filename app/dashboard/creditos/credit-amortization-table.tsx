"use client";

import type { FrenchAmortizationResult } from "@/lib/credit-amortization";

const exactCurrency = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function money(value: number) {
  return exactCurrency.format(Number(value || 0));
}

function dueDate(value: string) {
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

export default function CreditAmortizationTable({
  plan,
}: {
  plan: FrenchAmortizationResult;
}) {
  if (!plan.cuotas.length) return null;

  return (
    <details
      className="mt-6 overflow-hidden rounded-[24px] border border-slate-200 bg-white"
      open
    >
      <summary className="cursor-pointer list-none px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Sistema frances · {plan.version}
            </p>
            <h4 className="mt-1 text-lg font-black text-slate-950">
              Tabla de amortizacion completa
            </h4>
          </div>
          <span className="w-fit rounded-full bg-[var(--fp-lime)] px-3 py-1 text-xs font-black text-slate-950">
            {plan.numeroCuotas} cuotas
          </span>
        </div>
      </summary>

      <div className="border-t border-slate-200">
        <div className="grid gap-3 bg-slate-50 px-5 py-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <p>
            <span className="block text-xs font-semibold text-slate-500">Cuota credito</span>
            <strong className="tabular-nums text-slate-950">{money(plan.cuotaCredito)}</strong>
          </p>
          <p>
            <span className="block text-xs font-semibold text-slate-500">Fianza por cuota</span>
            <strong className="tabular-nums text-slate-950">{money(plan.cuotaFianza)}</strong>
          </p>
          <p>
            <span className="block text-xs font-semibold text-slate-500">Seguro por cuota</span>
            <strong className="tabular-nums text-slate-950">{money(plan.cuotaSeguro)}</strong>
          </p>
          <p>
            <span className="block text-xs font-semibold text-slate-500">Cuota exacta</span>
            <strong className="tabular-nums text-slate-950">{money(plan.cuotaTotal)}</strong>
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[1240px] w-full border-collapse text-sm">
            <thead className="bg-slate-950 text-left text-[11px] uppercase tracking-[0.12em] text-white">
              <tr>
                {[
                  "Cuota",
                  "Vencimiento",
                  "Saldo inicial",
                  "Interes",
                  "Capital",
                  "Fianza",
                  "Seguro",
                  "Total exacto",
                  "Valor a pagar",
                  "Saldo final",
                ].map((label, index) => (
                  <th
                    key={label}
                    className={index > 1 ? "px-4 py-3 text-right" : "px-4 py-3"}
                    scope="col"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plan.cuotas.map((cuota) => (
                <tr key={cuota.numero} className="bg-white even:bg-slate-50/70">
                  <th className="px-4 py-3 text-left font-black text-slate-950" scope="row">
                    {cuota.numero}
                  </th>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                    {dueDate(cuota.fechaVencimiento)}
                  </td>
                  {[
                    cuota.saldoInicial,
                    cuota.interes,
                    cuota.abonoCapital,
                    cuota.fianza,
                    cuota.seguro,
                    cuota.cuotaTotal,
                    cuota.cuotaCobro,
                    cuota.saldoFinal,
                  ].map((value, index) => (
                    <td
                      key={index}
                      className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-700"
                    >
                      {money(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
