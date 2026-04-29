"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DEFAULT_CREDIT_INSTALLMENTS,
  DEFAULT_MAX_CREDIT_INSTALLMENTS,
  DEFAULT_PAYMENT_FREQUENCY,
  MAX_CREDIT_INSTALLMENTS,
  PAYMENT_FREQUENCY_OPTIONS,
  getPaymentFrequencyLabel,
  getCreditInstallmentOptions,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
} from "@/lib/credit-factory";

type SessionUser = {
  rolNombre: string;
};

type CreditSettings = {
  tasaInteresEa: number;
  fianzaPorcentaje: number;
  plazoCuotas: number;
  plazoMaximoCuotas: number;
  frecuenciaPago: string;
  updatedAt: string | null;
};

type CreditSettingsResponse = {
  ok?: boolean;
  settings?: CreditSettings;
  error?: string;
};

const inputClass =
  "w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base font-semibold text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";

function percentValue(value: number | string) {
  const normalized = String(value ?? "").replace(",", ".");
  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? String(parsed) : "";
}

function installmentValue(
  value: number | string,
  maxInstallments: number | string = DEFAULT_MAX_CREDIT_INSTALLMENTS
) {
  return String(
    normalizeCreditInstallments(
      value,
      DEFAULT_CREDIT_INSTALLMENTS,
      maxInstallments
    )
  );
}

function installmentLimitValue(value: number | string) {
  return String(
    normalizeCreditInstallmentLimit(value, DEFAULT_MAX_CREDIT_INSTALLMENTS)
  );
}

function dateTime(value: string | null) {
  if (!value) {
    return "Sin cambios registrados";
  }

  return new Date(value).toLocaleString("es-CO");
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });

  const data = (await response.json().catch(() => ({}))) as T;

  return { ok: response.ok, data };
}

export default function CreditParametersConsole() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<CreditSettings | null>(null);
  const [tasaInteresEa, setTasaInteresEa] = useState("");
  const [fianzaPorcentaje, setFianzaPorcentaje] = useState("");
  const [plazoCuotas, setPlazoCuotas] = useState(String(DEFAULT_CREDIT_INSTALLMENTS));
  const [plazoMaximoCuotas, setPlazoMaximoCuotas] = useState(
    String(DEFAULT_MAX_CREDIT_INSTALLMENTS)
  );
  const [frecuenciaPago, setFrecuenciaPago] = useState(DEFAULT_PAYMENT_FREQUENCY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const plazoMaximoNormalizado = normalizeCreditInstallmentLimit(plazoMaximoCuotas);
  const plazoCuotasOptions = getCreditInstallmentOptions(plazoMaximoNormalizado);

  const loadSession = async () => {
    const result = await requestJson<SessionUser>("/api/session");

    if (result.ok) {
      setUser(result.data);
    }
  };

  const applySettings = (nextSettings: CreditSettings) => {
    const nextMaxInstallments = installmentLimitValue(
      nextSettings.plazoMaximoCuotas || DEFAULT_MAX_CREDIT_INSTALLMENTS
    );

    setSettings(nextSettings);
    setTasaInteresEa(percentValue(nextSettings.tasaInteresEa));
    setFianzaPorcentaje(percentValue(nextSettings.fianzaPorcentaje));
    setPlazoMaximoCuotas(nextMaxInstallments);
    setPlazoCuotas(installmentValue(nextSettings.plazoCuotas, nextMaxInstallments));
    setFrecuenciaPago(nextSettings.frecuenciaPago || DEFAULT_PAYMENT_FREQUENCY);
  };

  const handleMaxInstallmentsChange = (value: string) => {
    const cleanValue = value.replace(/\D/g, "");
    const nextMax = normalizeCreditInstallmentLimit(
      cleanValue || DEFAULT_MAX_CREDIT_INSTALLMENTS
    );

    setPlazoMaximoCuotas(cleanValue);
    setPlazoCuotas((current) => installmentValue(current, nextMax));
  };

  const loadSettings = async () => {
    try {
      setLoading(true);
      const result = await requestJson<CreditSettingsResponse>(
        "/api/creditos/configuracion"
      );

      if (!result.ok || !result.data.settings) {
        throw new Error(result.data.error || "No se pudo cargar la configuracion");
      }

      applySettings(result.data.settings);
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo cargar la configuracion",
        tone: "red",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSession();
    void loadSettings();
  }, []);

  const saveSettings = async () => {
    try {
      setSaving(true);
      setNotice(null);

      const result = await requestJson<CreditSettingsResponse>(
        "/api/creditos/configuracion",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tasaInteresEa,
            fianzaPorcentaje,
            plazoCuotas,
            plazoMaximoCuotas,
            frecuenciaPago,
          }),
        }
      );

      if (!result.ok || !result.data.settings) {
        throw new Error(result.data.error || "No se pudo guardar la configuracion");
      }

      applySettings(result.data.settings);
      setNotice({ text: "Parametros actualizados correctamente", tone: "emerald" });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo guardar la configuracion",
        tone: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading && !user) {
    return (
      <main className="min-h-screen bg-[#f4faf7] px-6 py-10 text-slate-900">
        <section className="mx-auto max-w-5xl rounded-[28px] border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold text-slate-500">
            Cargando parametros...
          </p>
        </section>
      </main>
    );
  }

  if (!esAdmin) {
    return (
      <main className="min-h-screen bg-[#f4faf7] px-6 py-10 text-slate-900">
        <section className="mx-auto max-w-5xl rounded-[28px] border border-red-100 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-600">
            Acceso restringido
          </p>
          <h1 className="mt-3 text-3xl font-black">Parametros de credito</h1>
          <p className="mt-2 text-sm text-slate-600">
            Solo el administrador puede cambiar fianza e interes.
          </p>
          <Link
            href="/dashboard"
            className="mt-6 inline-flex rounded-2xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700"
          >
            Volver al dashboard
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4faf7] px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-[32px] border border-[#cfe5e2] bg-white shadow-[0_22px_60px_rgba(15,23,42,0.08)]">
        <div className="border-b border-[#dcebe8] bg-[linear-gradient(135deg,#ecfff8_0%,#ffffff_48%,#f7fbff_100%)] px-6 py-7 sm:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="inline-flex rounded-full border border-emerald-200 bg-white px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#0f5d59]">
                Administracion
              </p>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950">
                Parametros de credito
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Define interes, fianza, plazo y frecuencia para el paso 2 de la
                fabrica de creditos.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/dashboard"
                className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/creditos?mode=create-client"
                className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Fabrica de creditos
              </Link>
            </div>
          </div>
        </div>

        {notice && (
          <div
            className={[
              "mx-6 mt-6 rounded-2xl border px-4 py-3 text-sm font-semibold sm:mx-8",
              notice.tone === "emerald"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700",
            ].join(" ")}
          >
            {notice.text}
          </div>
        )}

        <div className="grid gap-6 px-6 py-6 sm:px-8 lg:grid-cols-[0.95fr_1.05fr]">
          <section className="rounded-[26px] border border-slate-200 bg-[#fbfefd] p-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0f5d59]">
              Calculo del credito
            </p>
            <h2 className="mt-2 text-2xl font-black text-slate-950">
              Editar parametros
            </h2>

            <div className="mt-5 grid gap-4">
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Interes E.A. (%)
                </span>
                <input
                  value={tasaInteresEa}
                  onChange={(event) => setTasaInteresEa(event.target.value)}
                  inputMode="decimal"
                  className={inputClass}
                  placeholder="17.84"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Fianza (%)
                </span>
                <input
                  value={fianzaPorcentaje}
                  onChange={(event) => setFianzaPorcentaje(event.target.value)}
                  inputMode="decimal"
                  className={inputClass}
                  placeholder="60"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Plazo maximo
                </span>
                <input
                  type="number"
                  min={1}
                  max={MAX_CREDIT_INSTALLMENTS}
                  value={plazoMaximoCuotas}
                  onChange={(event) => handleMaxInstallmentsChange(event.target.value)}
                  className={inputClass}
                  placeholder="16"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Plazo sugerido
                </span>
                <select
                  value={plazoCuotas}
                  onChange={(event) => setPlazoCuotas(event.target.value)}
                  className={inputClass}
                >
                  {plazoCuotasOptions.map((option) => {
                    return (
                      <option key={option} value={option}>
                        {option} cuota{option === "1" ? "" : "s"}
                      </option>
                    );
                  })}
                </select>
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">
                  Frecuencia de pago
                </span>
                <select
                  value={frecuenciaPago}
                  onChange={(event) => setFrecuenciaPago(event.target.value)}
                  className={inputClass}
                >
                  {PAYMENT_FREQUENCY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                onClick={() => void saveSettings()}
                disabled={saving}
                className="rounded-2xl bg-[#0f5d59] px-5 py-3 text-sm font-bold text-white shadow-[0_14px_30px_rgba(15,93,89,0.22)] transition hover:bg-[#0b4744] disabled:opacity-70"
              >
                {saving ? "Guardando..." : "Guardar parametros"}
              </button>
            </div>
          </section>

          <section className="rounded-[26px] border border-slate-200 bg-white p-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Parametros actuales
            </p>
            <h2 className="mt-2 text-2xl font-black text-slate-950">
              Lo que usara el asesor
            </h2>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[22px] border border-slate-200 bg-[#fbfefd] px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Interes E.A.
                </p>
                <p className="mt-2 text-3xl font-black text-slate-950">
                  {settings?.tasaInteresEa ?? 0}%
                </p>
              </div>

              <div className="rounded-[22px] border border-slate-200 bg-[#fbfefd] px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Fianza
                </p>
                <p className="mt-2 text-3xl font-black text-slate-950">
                  {settings?.fianzaPorcentaje ?? 0}%
                </p>
              </div>

              <div className="rounded-[22px] border border-slate-200 bg-[#fbfefd] px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Plazo maximo
                </p>
                <p className="mt-2 text-3xl font-black text-slate-950">
                  {settings?.plazoMaximoCuotas ?? DEFAULT_MAX_CREDIT_INSTALLMENTS}
                </p>
                <p className="mt-1 text-xs font-semibold text-slate-500">cuotas</p>
              </div>

              <div className="rounded-[22px] border border-slate-200 bg-[#fbfefd] px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Plazo sugerido
                </p>
                <p className="mt-2 text-3xl font-black text-slate-950">
                  {settings?.plazoCuotas ?? DEFAULT_CREDIT_INSTALLMENTS}
                </p>
                <p className="mt-1 text-xs font-semibold text-slate-500">cuotas</p>
              </div>

              <div className="rounded-[22px] border border-slate-200 bg-[#fbfefd] px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Frecuencia
                </p>
                <p className="mt-2 text-3xl font-black text-slate-950">
                  {getPaymentFrequencyLabel(settings?.frecuenciaPago)}
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-[22px] border border-emerald-100 bg-emerald-50 px-4 py-4 text-sm leading-6 text-emerald-900">
              Al guardar, el paso 2 toma estos valores automaticamente para
              calcular cuotas, primer pago y total a pagar en nuevas ventas.
            </div>

            <p className="mt-4 text-xs font-semibold text-slate-400">
              Ultima actualizacion: {dateTime(settings?.updatedAt || null)}
            </p>
          </section>
        </div>
      </section>
    </main>
  );
}
