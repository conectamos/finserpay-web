"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import {
  ARQUEO_DENOMINACIONES,
  calcularTotalArqueo,
  clasificarArqueo,
  type ArqueoDenominacionKey,
} from "@/lib/arqueo";
import { getTodayBogotaDateKey } from "@/lib/ventas-utils";

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

type Sede = {
  id: number;
  nombre: string;
};

type ArqueoRegistro = {
  id: number;
  sedeId: number;
  usuarioId: number;
  fechaCorte: string;
  voucher: number;
  cheques: number;
  totalContado: number;
  cajaSistema: number;
  diferencia: number;
  estado: string;
  observacion: string | null;
  usuario?: {
    nombre: string;
  };
} & Record<ArqueoDenominacionKey, number>;

type ArqueoResponse = {
  ok: boolean;
  fecha: string;
  sedeId: number;
  cajaSistema: number;
  registro: ArqueoRegistro | null;
  historial: ArqueoRegistro[];
};

type FormState = Record<ArqueoDenominacionKey, number> & {
  voucher: number;
  cheques: number;
  observacion: string;
};

const FORM_BASE: FormState = {
  billetes100000: 0,
  billetes50000: 0,
  billetes20000: 0,
  billetes10000: 0,
  billetes5000: 0,
  billetes2000: 0,
  billetes1000: 0,
  monedas500: 0,
  monedas200: 0,
  monedas100: 0,
  monedas50: 0,
  voucher: 0,
  cheques: 0,
  observacion: "",
};

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

function toSafeInt(value: string) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.trunc(parsed);
}

function toSafeMoney(value: string) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function estadoTone(estado: string) {
  const normalized = String(estado || "").toUpperCase();

  if (normalized === "CUADRADO") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (normalized === "SOBRANTE") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (normalized === "FALTANTE") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default function CajaArqueoPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [sedeId, setSedeId] = useState("0");
  const [fecha, setFecha] = useState(() => getTodayBogotaDateKey());
  const [cajaSistema, setCajaSistema] = useState(0);
  const [registroActual, setRegistroActual] = useState<ArqueoRegistro | null>(null);
  const [historial, setHistorial] = useState<ArqueoRegistro[]>([]);
  const [form, setForm] = useState<FormState>(FORM_BASE);
  const [formDirty, setFormDirty] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [cargando, setCargando] = useState(true);

  const esAdmin = String(user?.rolNombre || "").toUpperCase() === "ADMIN";

  const cargarUsuario = async () => {
    const res = await fetch("/api/session", { cache: "no-store" });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "No se pudo cargar la sesion");
    }

    setUser(data);
    setSedeId((actual) =>
      actual && actual !== "0" ? actual : String(data.sedeId || "0")
    );
    return data as SessionUser;
  };

  const cargarSedes = async () => {
    const res = await fetch("/api/sedes", { cache: "no-store" });
    const data = await res.json();

    if (res.ok) {
      setSedes(Array.isArray(data) ? data : []);
    }
  };

  const aplicarRegistroAlFormulario = (registro: ArqueoRegistro | null) => {
    if (!registro) {
      setForm(FORM_BASE);
      return;
    }

    setForm({
      billetes100000: registro.billetes100000 || 0,
      billetes50000: registro.billetes50000 || 0,
      billetes20000: registro.billetes20000 || 0,
      billetes10000: registro.billetes10000 || 0,
      billetes5000: registro.billetes5000 || 0,
      billetes2000: registro.billetes2000 || 0,
      billetes1000: registro.billetes1000 || 0,
      monedas500: registro.monedas500 || 0,
      monedas200: registro.monedas200 || 0,
      monedas100: registro.monedas100 || 0,
      monedas50: registro.monedas50 || 0,
      voucher: Number(registro.voucher || 0),
      cheques: Number(registro.cheques || 0),
      observacion: registro.observacion || "",
    });
  };

  const cargarArqueo = async (
    targetSedeId?: string,
    targetFecha?: string,
    options?: {
      preserveForm?: boolean;
    }
  ) => {
    const sedeConsulta = targetSedeId || sedeId;
    const fechaConsulta = targetFecha || fecha;

    if (!sedeConsulta || sedeConsulta === "0" || !fechaConsulta) {
      return;
    }

    setCargando(true);

    try {
      const params = new URLSearchParams({
        fecha: fechaConsulta,
      });

      if (sedeConsulta && sedeConsulta !== "0") {
        params.set("sedeId", sedeConsulta);
      }

      const res = await fetch(`/api/arqueo?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as ArqueoResponse & { error?: string };

      if (!res.ok) {
        setMensaje(data.error || "No se pudo cargar el arqueo");
        return;
      }

      setCajaSistema(Number(data.cajaSistema || 0));
      setRegistroActual(data.registro || null);
      setHistorial(Array.isArray(data.historial) ? data.historial : []);

      if (!(options?.preserveForm && formDirty)) {
        aplicarRegistroAlFormulario(data.registro || null);
        setFormDirty(false);
      }
    } catch {
      setMensaje("Error cargando arqueo");
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const session = await cargarUsuario();

        if (String(session.rolNombre || "").toUpperCase() === "ADMIN") {
          await cargarSedes();
        }

        const initialSedeId = String(session.sedeId || "0");
        await cargarArqueo(initialSedeId, getTodayBogotaDateKey(), {
          preserveForm: false,
        });
      } catch {
        setMensaje("No se pudo cargar la sesion de arqueo");
        setCargando(false);
      }
    };

    void init();
  }, []);

  useEffect(() => {
    if (!user || !sedeId || sedeId === "0") {
      return;
    }

    void cargarArqueo(sedeId, fecha, { preserveForm: false });
  }, [fecha, sedeId, user]);

  useLiveRefresh(async () => {
    if (!user || !sedeId || sedeId === "0") {
      return;
    }

    await cargarArqueo(sedeId, fecha, { preserveForm: true });
  }, { intervalMs: 12000 });

  const totalContado = useMemo(
    () =>
      calcularTotalArqueo({
        ...form,
      }),
    [form]
  );

  const diferencia = totalContado - cajaSistema;
  const estadoCalculado = clasificarArqueo(diferencia);

  const sedeActualNombre = useMemo(() => {
    if (!esAdmin) {
      return user?.sedeNombre || "Sede actual";
    }

    return (
      sedes.find((item) => String(item.id) === sedeId)?.nombre ||
      user?.sedeNombre ||
      "Sede actual"
    );
  }, [esAdmin, sedeId, sedes, user?.sedeNombre]);

  const actualizarCantidad = (key: ArqueoDenominacionKey, value: string) => {
    setFormDirty(true);
    setForm((current) => ({
      ...current,
      [key]: toSafeInt(value),
    }));
  };

  const actualizarDinero = (key: "voucher" | "cheques", value: string) => {
    const soloNumeros = String(value || "").replace(/[^\d]/g, "");
    setFormDirty(true);
    setForm((current) => ({
      ...current,
      [key]: toSafeMoney(soloNumeros),
    }));
  };

  const guardarArqueo = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      const res = await fetch("/api/arqueo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          sedeId,
          fecha,
          ...form,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "No se pudo guardar el arqueo");
        return;
      }

      setFormDirty(false);
      setMensaje(data.mensaje || "Arqueo registrado correctamente");
      await cargarArqueo(sedeId, fecha, { preserveForm: false });
    } catch {
      setMensaje("Error guardando arqueo");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#eef2f7_30%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1680px]">
        <section className="relative overflow-hidden rounded-[36px] bg-[linear-gradient(135deg,#0f172a_0%,#111827_50%,#7f1d1d_100%)] px-6 py-7 text-white shadow-[0_24px_80px_rgba(15,23,42,0.24)] md:px-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(251,191,36,0.16),transparent_24%)]" />

          <div className="relative flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/90">
                Caja / Arqueo
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Arqueo diario
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Cuenta el dinero fisico por denominacion, suma voucher y cheques,
                cruza contra la caja del mes y deja el registro diario de sobrante,
                faltante o cuadrado.
              </p>

              <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-200">
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Sede: <span className="font-semibold text-white">{sedeActualNombre}</span>
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Fecha: <span className="font-semibold text-white">{fecha}</span>
                </div>
                <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2">
                  Estado:{" "}
                  <span className="font-semibold text-white">
                    {registroActual?.estado || estadoCalculado}
                  </span>
                </div>
              </div>
            </div>

            <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
              {esAdmin && (
                <label className="flex min-w-[260px] flex-col gap-2 text-sm font-semibold text-white">
                  Sede
                  <select
                    value={sedeId}
                    onChange={(event) => setSedeId(event.target.value)}
                    className="rounded-2xl border border-white/15 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-white focus:ring-2 focus:ring-white/30"
                  >
                    {sedes.map((sede) => (
                      <option key={sede.id} value={String(sede.id)}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex min-w-[220px] flex-col gap-2 text-sm font-semibold text-white">
                Fecha corte
                <input
                  type="date"
                  value={fecha}
                  onChange={(event) => setFecha(event.target.value)}
                  className="rounded-2xl border border-white/15 bg-white px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-white focus:ring-2 focus:ring-white/30"
                />
              </label>

              <Link
                href="/caja"
                className="rounded-2xl border border-white/10 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
              >
                Volver
              </Link>
            </div>
          </div>
        </section>

        {mensaje && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm font-medium text-slate-700 shadow-sm">
            {mensaje}
          </div>
        )}

        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-[30px] border border-emerald-200 bg-[linear-gradient(180deg,#ffffff_0%,#f2fbf6_100%)] px-5 py-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Caja del mes
            </p>
            <p className="mt-3 text-3xl font-black text-emerald-600">
              {formatoPesos(cajaSistema)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Base del sistema para cruzar el arqueo diario.
            </p>
          </div>

          <div className="rounded-[30px] border border-slate-200 bg-white px-5 py-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Total contado
            </p>
            <p className="mt-3 text-3xl font-black text-slate-950">
              {formatoPesos(totalContado)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Suma de efectivo, voucher y cheques.
            </p>
          </div>

          <div
            className={[
              "rounded-[30px] border px-5 py-5 shadow-sm",
              estadoTone(estadoCalculado),
            ].join(" ")}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.18em]">
              Diferencia
            </p>
            <p className="mt-3 text-3xl font-black">{formatoPesos(diferencia)}</p>
            <p className="mt-2 text-sm">
              Estado actual:{" "}
              <span className="font-semibold">{estadoCalculado}</span>
            </p>
          </div>
        </section>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="rounded-[32px] border border-[#e8e0d1] bg-[linear-gradient(180deg,#ffffff_0%,#fbf9f4_100%)] p-6 shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
            <div className="flex flex-col gap-3 border-b border-[#ece5d8] pb-5">
              <div className="inline-flex w-fit rounded-full border border-[#ddd2bf] bg-[#faf6ee] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7b5b2b]">
                Conteo fisico
              </div>
              <h2 className="text-2xl font-black tracking-tight text-slate-950">
                Registro por denominacion
              </h2>
              <p className="text-sm leading-6 text-slate-500">
                Ingresa unidades por billete o moneda, luego agrega voucher,
                cheques y cualquier observacion del cierre.
              </p>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {ARQUEO_DENOMINACIONES.map((item) => (
                <label
                  key={item.key}
                  className="rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {item.label}
                  </p>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form[item.key]}
                    onChange={(event) => actualizarCantidad(item.key, event.target.value)}
                    className="mt-3 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-lg font-bold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Subtotal: {formatoPesos(form[item.key] * item.valor)}
                  </p>
                </label>
              ))}
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Voucher
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.voucher > 0 ? formatoPesos(form.voucher) : ""}
                  onChange={(event) => actualizarDinero("voucher", event.target.value)}
                  placeholder="$ 0"
                  className="mt-3 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-lg font-bold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </label>

              <label className="rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Cheques
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.cheques > 0 ? formatoPesos(form.cheques) : ""}
                  onChange={(event) => actualizarDinero("cheques", event.target.value)}
                  placeholder="$ 0"
                  className="mt-3 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-lg font-bold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                />
              </label>
            </div>

            <label className="mt-6 block rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Observacion
              </p>
              <textarea
                value={form.observacion}
                onChange={(event) =>
                  {
                    setFormDirty(true);
                    setForm((current) => ({
                      ...current,
                      observacion: event.target.value,
                    }));
                  }
                }
                rows={4}
                className="mt-3 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                placeholder="Notas del arqueo, faltantes explicados o sobrantes justificados..."
              />
            </label>
          </section>

          <aside className="space-y-6">
            <section className="rounded-[32px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-[0_20px_55px_rgba(15,23,42,0.08)]">
              <div className="inline-flex rounded-full border border-[#e7dccb] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Cierre del dia
              </div>

              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Caja del mes
                  </p>
                  <p className="mt-2 text-2xl font-black text-slate-950">
                    {formatoPesos(cajaSistema)}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Total arqueado
                  </p>
                  <p className="mt-2 text-2xl font-black text-slate-950">
                    {formatoPesos(totalContado)}
                  </p>
                </div>

                <div
                  className={[
                    "rounded-2xl border px-4 py-4",
                    estadoTone(estadoCalculado),
                  ].join(" ")}
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]">
                    Resultado
                  </p>
                  <p className="mt-2 text-2xl font-black">{estadoCalculado}</p>
                  <p className="mt-2 text-sm font-medium">
                    Diferencia: {formatoPesos(diferencia)}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void guardarArqueo()}
                disabled={guardando || cargando}
                className="mt-5 inline-flex w-full items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {guardando ? "Guardando arqueo..." : "Guardar arqueo diario"}
              </button>
            </section>

            <section className="rounded-[32px] border border-[#e7ddcd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-[0_20px_55px_rgba(15,23,42,0.08)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Historial reciente
                  </p>
                  <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                    Ultimos arqueos
                  </h3>
                </div>

                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {historial.length} registros
                </span>
              </div>

              <div className="mt-4 space-y-3">
                {historial.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[#e5dccd] bg-[#fcfaf6] px-4 py-4 text-sm text-slate-500">
                    Todavia no hay arqueos guardados para esta sede.
                  </div>
                ) : (
                  historial.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-2xl border border-[#eee5d7] bg-white/90 px-4 py-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-bold text-slate-950">
                            {item.fechaCorte.slice(0, 10)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Registrado por {item.usuario?.nombre || "Usuario"}
                          </p>
                        </div>

                        <span
                          className={[
                            "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
                            estadoTone(item.estado),
                          ].join(" ")}
                        >
                          {item.estado}
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <p className="text-slate-500">Caja sistema</p>
                          <p className="mt-1 font-semibold text-slate-950">
                            {formatoPesos(item.cajaSistema)}
                          </p>
                        </div>

                        <div>
                          <p className="text-slate-500">Total contado</p>
                          <p className="mt-1 font-semibold text-slate-950">
                            {formatoPesos(item.totalContado)}
                          </p>
                        </div>

                        <div className="col-span-2">
                          <p className="text-slate-500">Diferencia</p>
                          <p className="mt-1 font-semibold text-slate-950">
                            {formatoPesos(item.diferencia)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
