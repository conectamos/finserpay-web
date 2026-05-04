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

type CreditDocumentException = {
  id: number;
  documento: string;
  documentoNormalizado: string;
  tasaInteresEa: number | null;
  fianzaPorcentaje: number | null;
  plazoCuotas: number | null;
  plazoMaximoCuotas: number | null;
  frecuenciaPago: string | null;
  permiteMultiplesCreditos: boolean;
  activo: boolean;
  observacion: string | null;
  updatedAt: string | null;
  effectiveSettings: CreditSettings;
};

type CreditSettingsResponse = {
  ok?: boolean;
  settings?: CreditSettings;
  globalSettings?: CreditSettings;
  documentException?: CreditDocumentException | null;
  exceptions?: CreditDocumentException[];
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
  const [exceptions, setExceptions] = useState<CreditDocumentException[]>([]);
  const [exceptionDocumento, setExceptionDocumento] = useState("");
  const [exceptionTasaInteresEa, setExceptionTasaInteresEa] = useState("");
  const [exceptionFianzaPorcentaje, setExceptionFianzaPorcentaje] = useState("");
  const [exceptionPlazoCuotas, setExceptionPlazoCuotas] = useState("");
  const [exceptionPlazoMaximoCuotas, setExceptionPlazoMaximoCuotas] = useState("");
  const [exceptionFrecuenciaPago, setExceptionFrecuenciaPago] = useState("");
  const [exceptionPermiteMultiples, setExceptionPermiteMultiples] = useState(false);
  const [exceptionActivo, setExceptionActivo] = useState(true);
  const [exceptionObservacion, setExceptionObservacion] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingException, setSavingException] = useState(false);
  const [deletingException, setDeletingException] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "red" | "emerald" } | null>(
    null
  );

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const plazoMaximoNormalizado = normalizeCreditInstallmentLimit(plazoMaximoCuotas);
  const plazoCuotasOptions = getCreditInstallmentOptions(plazoMaximoNormalizado);
  const exceptionMaxInstallments = exceptionPlazoMaximoCuotas
    ? normalizeCreditInstallmentLimit(exceptionPlazoMaximoCuotas)
    : plazoMaximoNormalizado;
  const exceptionInstallmentOptions = getCreditInstallmentOptions(exceptionMaxInstallments);

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

  const handleExceptionMaxInstallmentsChange = (value: string) => {
    const cleanValue = value.replace(/\D/g, "");
    const nextMax = cleanValue
      ? normalizeCreditInstallmentLimit(cleanValue)
      : plazoMaximoNormalizado;

    setExceptionPlazoMaximoCuotas(cleanValue);
    setExceptionPlazoCuotas((current) =>
      current ? installmentValue(current, nextMax) : current
    );
  };

  const resetExceptionForm = () => {
    setExceptionDocumento("");
    setExceptionTasaInteresEa("");
    setExceptionFianzaPorcentaje("");
    setExceptionPlazoCuotas("");
    setExceptionPlazoMaximoCuotas("");
    setExceptionFrecuenciaPago("");
    setExceptionPermiteMultiples(false);
    setExceptionActivo(true);
    setExceptionObservacion("");
  };

  const editException = (item: CreditDocumentException) => {
    setExceptionDocumento(item.documentoNormalizado);
    setExceptionTasaInteresEa(item.tasaInteresEa === null ? "" : String(item.tasaInteresEa));
    setExceptionFianzaPorcentaje(
      item.fianzaPorcentaje === null ? "" : String(item.fianzaPorcentaje)
    );
    setExceptionPlazoCuotas(item.plazoCuotas === null ? "" : String(item.plazoCuotas));
    setExceptionPlazoMaximoCuotas(
      item.plazoMaximoCuotas === null ? "" : String(item.plazoMaximoCuotas)
    );
    setExceptionFrecuenciaPago(item.frecuenciaPago || "");
    setExceptionPermiteMultiples(item.permiteMultiplesCreditos);
    setExceptionActivo(item.activo);
    setExceptionObservacion(item.observacion || "");
  };

  const loadSettings = async () => {
    try {
      setLoading(true);
      const result = await requestJson<CreditSettingsResponse>(
        "/api/creditos/configuracion?includeExceptions=true"
      );

      if (!result.ok || !result.data.settings) {
        throw new Error(result.data.error || "No se pudo cargar la configuracion");
      }

      applySettings(result.data.settings);
      setExceptions(result.data.exceptions || []);
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
      setExceptions(result.data.exceptions || exceptions);
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

  const saveException = async () => {
    try {
      setSavingException(true);
      setNotice(null);

      const result = await requestJson<CreditSettingsResponse>(
        "/api/creditos/configuracion",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documento: exceptionDocumento,
            tasaInteresEa: exceptionTasaInteresEa || null,
            fianzaPorcentaje: exceptionFianzaPorcentaje || null,
            plazoCuotas: exceptionPlazoCuotas || null,
            plazoMaximoCuotas: exceptionPlazoMaximoCuotas || null,
            frecuenciaPago: exceptionFrecuenciaPago || null,
            permiteMultiplesCreditos: exceptionPermiteMultiples,
            activo: exceptionActivo,
            observacion: exceptionObservacion,
          }),
        }
      );

      if (!result.ok || !result.data.documentException) {
        throw new Error(result.data.error || "No se pudo guardar la excepcion");
      }

      setExceptions(result.data.exceptions || []);
      resetExceptionForm();
      setNotice({ text: "Excepcion por cedula guardada", tone: "emerald" });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo guardar la excepcion",
        tone: "red",
      });
    } finally {
      setSavingException(false);
    }
  };

  const deleteException = async (documento: string) => {
    try {
      setDeletingException(documento);
      setNotice(null);

      const result = await requestJson<CreditSettingsResponse>(
        `/api/creditos/configuracion?documento=${encodeURIComponent(documento)}`,
        {
          method: "DELETE",
        }
      );

      if (!result.ok) {
        throw new Error(result.data.error || "No se pudo eliminar la excepcion");
      }

      setExceptions(result.data.exceptions || []);
      if (exceptionDocumento.replace(/\D/g, "") === documento.replace(/\D/g, "")) {
        resetExceptionForm();
      }
      setNotice({ text: "Excepcion eliminada", tone: "emerald" });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "No se pudo eliminar la excepcion",
        tone: "red",
      });
    } finally {
      setDeletingException("");
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

        <section className="border-t border-[#dcebe8] px-6 py-6 sm:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
                Excepciones por cedula
              </p>
              <h2 className="mt-3 text-2xl font-black text-slate-950">
                Parametros especificos por cliente
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Si una cedula no tiene excepcion activa, la fabrica usa los
                parametros globales. Los campos vacios heredan el valor global.
              </p>
            </div>
            <button
              type="button"
              onClick={resetExceptionForm}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Nueva excepcion
            </button>
          </div>

          <div className="mt-5 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <section className="rounded-[26px] border border-slate-200 bg-[#fbfefd] p-5">
              <div className="grid gap-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">
                    Cedula
                  </span>
                  <input
                    value={exceptionDocumento}
                    onChange={(event) =>
                      setExceptionDocumento(event.target.value.replace(/\D/g, ""))
                    }
                    inputMode="numeric"
                    className={inputClass}
                    placeholder="1023028341"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block text-sm font-semibold text-slate-700">
                      Interes E.A. (%)
                    </span>
                    <input
                      value={exceptionTasaInteresEa}
                      onChange={(event) => setExceptionTasaInteresEa(event.target.value)}
                      inputMode="decimal"
                      className={inputClass}
                      placeholder={`${settings?.tasaInteresEa ?? 0}`}
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-semibold text-slate-700">
                      Fianza (%)
                    </span>
                    <input
                      value={exceptionFianzaPorcentaje}
                      onChange={(event) =>
                        setExceptionFianzaPorcentaje(event.target.value)
                      }
                      inputMode="decimal"
                      className={inputClass}
                      placeholder={`${settings?.fianzaPorcentaje ?? 0}`}
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
                      value={exceptionPlazoMaximoCuotas}
                      onChange={(event) =>
                        handleExceptionMaxInstallmentsChange(event.target.value)
                      }
                      className={inputClass}
                      placeholder={`${settings?.plazoMaximoCuotas ?? DEFAULT_MAX_CREDIT_INSTALLMENTS}`}
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-semibold text-slate-700">
                      Plazo sugerido
                    </span>
                    <select
                      value={exceptionPlazoCuotas}
                      onChange={(event) => setExceptionPlazoCuotas(event.target.value)}
                      className={inputClass}
                    >
                      <option value="">Usar global</option>
                      {exceptionInstallmentOptions.map((option) => {
                        return (
                          <option key={option} value={option}>
                            {option} cuota{option === "1" ? "" : "s"}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">
                    Frecuencia de pago
                  </span>
                  <select
                    value={exceptionFrecuenciaPago}
                    onChange={(event) => setExceptionFrecuenciaPago(event.target.value)}
                    className={inputClass}
                  >
                    <option value="">Usar global</option>
                    {PAYMENT_FREQUENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">
                    Observacion
                  </span>
                  <textarea
                    value={exceptionObservacion}
                    onChange={(event) => setExceptionObservacion(event.target.value)}
                    rows={3}
                    className={inputClass}
                    placeholder="Motivo administrativo de la excepcion"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      checked={exceptionPermiteMultiples}
                      onChange={(event) =>
                        setExceptionPermiteMultiples(event.target.checked)
                      }
                      className="h-4 w-4 rounded border-slate-300 text-[#0f5d59] focus:ring-emerald-100"
                    />
                    Permitir mas de 1 credito activo
                  </label>

                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      checked={exceptionActivo}
                      onChange={(event) => setExceptionActivo(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-[#0f5d59] focus:ring-emerald-100"
                    />
                    Excepcion activa
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => void saveException()}
                  disabled={savingException}
                  className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white shadow-[0_14px_30px_rgba(15,23,42,0.18)] transition hover:bg-slate-800 disabled:opacity-70"
                >
                  {savingException ? "Guardando..." : "Guardar excepcion"}
                </button>
              </div>
            </section>

            <section className="rounded-[26px] border border-slate-200 bg-white p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
                Cedulas configuradas
              </p>
              <div className="mt-4 space-y-3">
                {exceptions.length ? (
                  exceptions.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-[22px] border border-slate-200 bg-[#fbfefd] px-4 py-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-lg font-black text-slate-950">
                            {item.documentoNormalizado}
                          </p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">
                            {item.activo ? "Activa" : "Inactiva"} -{" "}
                            {item.permiteMultiplesCreditos
                              ? "Multiples creditos permitidos"
                              : "Un credito activo"}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => editException(item)}
                            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700"
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteException(item.documentoNormalizado)}
                            disabled={deletingException === item.documentoNormalizado}
                            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-60"
                          >
                            {deletingException === item.documentoNormalizado
                              ? "Eliminando"
                              : "Eliminar"}
                          </button>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-2 text-xs font-semibold text-slate-600 sm:grid-cols-2">
                        <span>Interes: {item.effectiveSettings.tasaInteresEa}%</span>
                        <span>Fianza: {item.effectiveSettings.fianzaPorcentaje}%</span>
                        <span>
                          Plazo: {item.effectiveSettings.plazoCuotas}/
                          {item.effectiveSettings.plazoMaximoCuotas} cuotas
                        </span>
                        <span>
                          Frecuencia:{" "}
                          {getPaymentFrequencyLabel(item.effectiveSettings.frecuenciaPago)}
                        </span>
                      </div>

                      {item.observacion ? (
                        <p className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-500">
                          {item.observacion}
                        </p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="rounded-[22px] border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm font-semibold text-slate-500">
                    Aun no hay excepciones por cedula.
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      </section>
    </main>
  );
}
