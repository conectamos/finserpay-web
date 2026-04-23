"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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

type ImeiResponse = {
  referencia?: string;
  color?: string | null;
  costo?: number;
  error?: string;
};

function formatoPesos(valor: string | number) {
  const num = Number(valor || 0);
  return num > 0 ? `$ ${num.toLocaleString("es-CO")}` : "$ 0";
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-2 block text-[12px] font-bold uppercase tracking-[0.14em] text-slate-600">
      {children}
    </label>
  );
}

function SectionCard({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
      <div className="inline-flex rounded-full border border-[#e4dccd] bg-[#faf7f1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
        {eyebrow}
      </div>
      <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default function NuevoPrestamoPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sedes, setSedes] = useState<Sede[]>([]);

  const [imei, setImei] = useState("");
  const [referencia, setReferencia] = useState("");
  const [color, setColor] = useState("");
  const [costo, setCosto] = useState("");

  const [sedeOrigenId, setSedeOrigenId] = useState("");
  const [sedeDestinoId, setSedeDestinoId] = useState("");

  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [consultandoImei, setConsultandoImei] = useState(false);

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const mensajeEsOk = mensaje.startsWith("OK:");

  const inputClass =
    "w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200";

  const inputReadOnlyClass =
    "w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base text-slate-700 outline-none";

  useEffect(() => {
    void cargarUsuario();
    void cargarSedes();
  }, []);

  const cargarUsuario = async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error cargando sesion"}`);
        return;
      }

      setUser(data);

      if (data.rolNombre?.toUpperCase() !== "ADMIN") {
        setSedeOrigenId(String(data.sedeId));
      }
    } catch {
      setMensaje("Error: cargando sesion.");
    }
  };

  const cargarSedes = async () => {
    try {
      const res = await fetch("/api/sedes", { cache: "no-store" });
      const data = await res.json();

      if (res.ok) {
        setSedes(Array.isArray(data) ? data : []);
      }
    } catch {
      setMensaje("Error: cargando sedes.");
    }
  };

  const limpiarDatosEquipo = () => {
    setReferencia("");
    setColor("");
    setCosto("");
  };

  const consultarImei = async (valor: string) => {
    const imeiLimpio = valor.replace(/\D/g, "").slice(0, 15);

    if (!imeiLimpio) {
      limpiarDatosEquipo();
      return;
    }

    try {
      setConsultandoImei(true);
      setMensaje("");

      const res = await fetch("/api/prestamos/buscar-imei", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ imei: imeiLimpio }),
      });

      const data: ImeiResponse = await res.json();

      if (!res.ok) {
        limpiarDatosEquipo();
        setMensaje(`Error: ${data.error || "No se encontro el IMEI"}`);
        return;
      }

      setReferencia(data.referencia || "");
      setColor(data.color || "");
      setCosto(String(data.costo || ""));
    } catch {
      limpiarDatosEquipo();
      setMensaje("Error: consultando IMEI.");
    } finally {
      setConsultandoImei(false);
    }
  };

  const sedesDestinoDisponibles = useMemo(() => {
    return sedes.filter((sede) => String(sede.id) !== String(sedeOrigenId));
  }, [sedes, sedeOrigenId]);

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      if (!imei) return setMensaje("Error: el IMEI es obligatorio.");
      if (!referencia) return setMensaje("Error: la referencia es obligatoria.");
      if (!costo) return setMensaje("Error: el costo es obligatorio.");
      if (!sedeOrigenId) return setMensaje("Error: la sede origen es obligatoria.");
      if (!sedeDestinoId) return setMensaje("Error: la sede destino es obligatoria.");
      if (sedeOrigenId === sedeDestinoId) {
        return setMensaje("Error: la sede origen no puede ser igual a la sede destino.");
      }

      const res = await fetch("/api/prestamos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imei,
          referencia,
          color,
          costo: Number(costo),
          sedeOrigenId: Number(sedeOrigenId),
          sedeDestinoId: Number(sedeDestinoId),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "Error al guardar prestamo"}`);
        return;
      }

      setMensaje("OK: solicitud de prestamo enviada. La sede destino debe aprobarla.");
      setImei("");
      setReferencia("");
      setColor("");
      setCosto("");
      setSedeDestinoId("");

      if (esAdmin) {
        setSedeOrigenId("");
      } else if (user?.sedeId) {
        setSedeOrigenId(String(user.sedeId));
      }
    } catch (error) {
      console.error(error);
      setMensaje("Error: al guardar prestamo.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1480px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                Prestamos entre sedes
              </div>
              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Nuevo prestamo
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                Crea una solicitud de traslado entre sedes. La sede destino debe aprobarla antes de recibir el equipo en inventario.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Usuario: <span className="font-semibold text-white">{user?.nombre || "Cargando..."}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Sede origen:{" "}
                  <span className="font-semibold text-white">
                    {esAdmin
                      ? sedes.find((sede) => String(sede.id) === sedeOrigenId)?.nombre || "Pendiente"
                      : user?.sedeNombre || "Tu sede"}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 xl:items-end">
              <Link
                href="/prestamos"
                className="inline-flex h-[56px] min-w-[180px] items-center justify-center rounded-2xl border border-white/12 bg-white/95 px-6 text-center text-[15px] font-bold text-slate-900 transition hover:bg-white"
              >
                Volver
              </Link>
            </div>
          </div>
        </section>

        {mensaje && (
          <div
            className={[
              "mt-6 rounded-[26px] border px-5 py-4 text-sm font-medium shadow-sm",
              mensajeEsOk
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800",
            ].join(" ")}
          >
            {mensaje.replace(/^OK:\s*/, "")}
          </div>
        )}

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_360px]">
          <div className="space-y-6">
            <SectionCard
              eyebrow="Equipo"
              title="Identificacion del IMEI"
              description="Ingresa el IMEI para precargar referencia, color y costo del equipo antes de generar el traslado."
            >
              <div className="grid gap-5 md:grid-cols-2">
                <div className="md:col-span-2">
                  <FieldLabel>IMEI</FieldLabel>
                  <input
                    value={imei}
                    onChange={(e) => {
                      const valor = e.target.value.replace(/\D/g, "").slice(0, 15);
                      setImei(valor);

                      if (valor.length === 15) {
                        void consultarImei(valor);
                      } else {
                        limpiarDatosEquipo();
                      }
                    }}
                    placeholder="IMEI (15 digitos)"
                    className={inputClass}
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    {consultandoImei
                      ? "Consultando IMEI..."
                      : "Al completar el IMEI se cargan referencia, color y costo."}
                  </p>
                </div>

                <div>
                  <FieldLabel>Referencia</FieldLabel>
                  <input
                    value={referencia}
                    readOnly
                    placeholder="Ej: iPhone 14"
                    className={inputReadOnlyClass}
                  />
                </div>

                <div>
                  <FieldLabel>Color</FieldLabel>
                  <input
                    value={color}
                    readOnly
                    placeholder="Ej: Negro"
                    className={inputReadOnlyClass}
                  />
                </div>

                <div>
                  <FieldLabel>Costo</FieldLabel>
                  <input
                    value={formatoPesos(costo)}
                    readOnly
                    className={inputReadOnlyClass}
                  />
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Cobertura"
              title="Origen y destino del traslado"
              description="Define la sede que entrega el equipo y la sede que recibira el prestamo."
            >
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel>Sede origen</FieldLabel>
                  {esAdmin ? (
                    <select
                      value={sedeOrigenId}
                      onChange={(e) => {
                        setSedeOrigenId(e.target.value);
                        setSedeDestinoId("");
                      }}
                      className={inputClass}
                    >
                      <option value="">Seleccionar sede origen</option>
                      {sedes.map((sede) => (
                        <option key={sede.id} value={sede.id}>
                          {sede.nombre}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={user?.sedeNombre || ""}
                      readOnly
                      className={inputReadOnlyClass}
                    />
                  )}
                </div>

                <div>
                  <FieldLabel>Sede destino</FieldLabel>
                  <select
                    value={sedeDestinoId}
                    onChange={(e) => setSedeDestinoId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Seleccionar sede destino</option>
                    {sedesDestinoDisponibles.map((sede) => (
                      <option key={sede.id} value={sede.id}>
                        {sede.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </SectionCard>
          </div>

          <div className="space-y-6">
            <SectionCard
              eyebrow="Revision"
              title="Resumen del prestamo"
              description="Valida rapido el equipo y el recorrido antes de guardar."
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Equipo
                  </p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {referencia || "Sin referencia"}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Valor del traslado
                  </p>
                  <p className="mt-2 text-2xl font-black text-slate-950">
                    {formatoPesos(costo)}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Destino final
                  </p>
                  <p className="mt-2 text-lg font-bold text-slate-950">
                    {sedes.find((sede) => String(sede.id) === sedeDestinoId)?.nombre || "Pendiente"}
                  </p>
                </div>
              </div>
            </SectionCard>

            <div className="rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
              <div className="flex flex-col gap-3">
                <button
                  onClick={guardar}
                  disabled={guardando}
                  className="inline-flex h-[58px] items-center justify-center rounded-2xl bg-[#111318] px-6 text-center text-[15px] font-bold text-white transition hover:bg-[#1d2330] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {guardando ? "Guardando..." : "Guardar prestamo"}
                </button>

                <Link
                  href="/prestamos"
                  className="inline-flex h-[58px] items-center justify-center rounded-2xl border border-slate-300 bg-white px-6 text-center text-[15px] font-bold text-slate-700 transition hover:bg-slate-50"
                >
                  Cancelar
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
