"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const OPCIONES_PROVEEDOR_SEDE = [
  "Proveedor FINSER",
  "Proveedor BUNQUER",
  "Proveedor TECNOSUPER",
  "Proveedor IPHONE ANGIE",
  "Proveedor SEDE 1",
  "Proveedor SEDE 2",
  "Proveedor SEDE 3",
  "Proveedor SEDE 4",
  "Proveedor SEDE 5",
  "Proveedor SEDE 6",
  "Proveedor SEDE 7",
  "Proveedor EMOVIL",
  "Proveedor POLLO",
  "Proveedor ANDRES",
  "Proveedor EMMATECH",
];

const OPCIONES_PROVEEDOR_BODEGA = [
  "COMUNICARIBE",
  "HOLA PLAZA",
  "CONMOVIL",
  "CORBETA",
  "OPORTUNIDADES",
];

type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  rolId: number;
  rolNombre: string;
};

function formatearPesos(valor: string) {
  const limpio = valor.replace(/\D/g, "");
  if (!limpio) return "";
  return `$ ${Number(limpio).toLocaleString("es-CO")}`;
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

export default function NuevoInventarioPage() {
  const [user, setUser] = useState<SessionUser | null>(null);

  const [imei, setImei] = useState("");
  const [imeisMasivos, setImeisMasivos] = useState("");

  const [referencia, setReferencia] = useState("");
  const [color, setColor] = useState("");
  const [costo, setCosto] = useState("");
  const [numeroFactura, setNumeroFactura] = useState("");
  const [distribuidor, setDistribuidor] = useState("");
  const [estadoFinanciero, setEstadoFinanciero] = useState("PAGO");
  const [deboA, setDeboA] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);

  const esAdmin = user?.rolNombre?.toUpperCase() === "ADMIN";
  const opcionesDistribuidor = esAdmin
    ? OPCIONES_PROVEEDOR_BODEGA
    : OPCIONES_PROVEEDOR_SEDE;

  const mensajeEsOk = useMemo(() => mensaje.startsWith("OK:"), [mensaje]);
  const cantidadImeisMasivos = useMemo(
    () =>
      imeisMasivos
        .split("\n")
        .map((valor) => valor.replace(/\D/g, "").trim())
        .filter(Boolean).length,
    [imeisMasivos]
  );

  const cargarUsuario = async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setUser(data);
      }
    } catch (error) {
      console.error("Error cargando usuario:", error);
    }
  };

  useEffect(() => {
    void cargarUsuario();
  }, []);

  const buscarIMEI = async (imeiValor: string) => {
    try {
      const res = await fetch("/api/inventario-principal/buscar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ imei: imeiValor }),
      });

      if (!res.ok) {
        return;
      }

      const data = await res.json();

      setReferencia(data.referencia || "");
      setColor(data.color || "");
      setCosto(data.costo ? String(data.costo) : "");

      if (esAdmin) {
        setNumeroFactura(data.numeroFactura || "");
        setDistribuidor(data.distribuidor || "");
      }
    } catch (error) {
      console.error("Error buscando IMEI:", error);
    }
  };

  const limpiarFormulario = () => {
    setImei("");
    setImeisMasivos("");
    setReferencia("");
    setColor("");
    setCosto("");
    setNumeroFactura("");
    setDistribuidor("");
    setEstadoFinanciero("PAGO");
    setDeboA("");
  };

  const obtenerImeisAdmin = () => {
    const listaMasiva = imeisMasivos
      .split("\n")
      .map((valor) => valor.replace(/\D/g, "").trim())
      .filter((valor) => valor.length > 0);

    const imeiUnico = imei.replace(/\D/g, "").trim();

    if (listaMasiva.length > 0) return listaMasiva;
    if (imeiUnico) return [imeiUnico];
    return [];
  };

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      if (!user) {
        setMensaje("Error: no se pudo identificar el usuario.");
        return;
      }

      if (!referencia) {
        setMensaje("Error: la referencia es obligatoria.");
        return;
      }

      if (!costo) {
        setMensaje("Error: el costo es obligatorio.");
        return;
      }

      if (!distribuidor) {
        setMensaje("Error: debes seleccionar un distribuidor.");
        return;
      }

      if (esAdmin) {
        const imeis = obtenerImeisAdmin();

        if (imeis.length === 0) {
          setMensaje("Error: debes ingresar al menos un IMEI.");
          return;
        }

        const imeiInvalido = imeis.find((valor) => valor.length > 15);
        if (imeiInvalido) {
          setMensaje("Error: hay IMEIs con mas de 15 digitos.");
          return;
        }

        if (!numeroFactura) {
          setMensaje("Error: el numero de factura es obligatorio.");
          return;
        }

        const res = await fetch("/api/inventario-principal", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            imeis,
            referencia,
            color,
            costo: Number(costo),
            numeroFactura,
            distribuidor,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setMensaje(`Error: ${data.error || "No se pudo guardar en bodega principal."}`);
          return;
        }

        setMensaje(
          `OK: ${data.insertados ?? imeis.length} equipo(s) guardado(s) correctamente en bodega principal.`
        );
        limpiarFormulario();
        return;
      }

      if (!imei) {
        setMensaje("Error: el IMEI es obligatorio.");
        return;
      }

      if (imei.length > 15) {
        setMensaje("Error: el IMEI no puede tener mas de 15 digitos.");
        return;
      }

      if (!estadoFinanciero) {
        setMensaje("Error: debes seleccionar el estado financiero.");
        return;
      }

      if (estadoFinanciero === "DEUDA" && !deboA) {
        setMensaje("Error: debes seleccionar a quien se debe.");
        return;
      }

      const res = await fetch("/api/inventario", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imei,
          referencia,
          color,
          costo: Number(costo),
          distribuidor,
          estadoFinanciero,
          deboA: estadoFinanciero === "DEUDA" ? deboA : null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(`Error: ${data.error || "No se pudo guardar el equipo."}`);
        return;
      }

      setMensaje("OK: equipo guardado correctamente.");
      limpiarFormulario();
    } catch (error) {
      console.error(error);
      setMensaje("Error: ocurrio un problema guardando el equipo.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7f4ee_0%,#edf2f7_100%)] px-4 py-8">
      <div className="mx-auto max-w-[1480px]">
        <section className="relative overflow-hidden rounded-[36px] border border-[#1f2430] bg-[linear-gradient(135deg,#111318_0%,#1c2330_58%,#7c2d12_100%)] px-6 py-7 text-white shadow-[0_30px_90px_rgba(15,23,42,0.22)] md:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(199,154,87,0.18),transparent_28%)]" />

          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <div className="inline-flex rounded-full border border-white/12 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#f2d7a6]">
                {esAdmin ? "Bodega principal" : "Registro de sede"}
              </div>

              <h1 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                {esAdmin ? "Ingreso a inventario principal" : "Nuevo ingreso de inventario"}
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-200 md:text-base">
                {esAdmin
                  ? "Carga uno o varios equipos para bodega principal con una vista mas ordenada para IMEIs, factura y distribucion."
                  : "Registra equipos en tu sede con control de costo, distribuidor y estado financiero desde una sola vista."}
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Usuario: <span className="font-semibold text-white">{user?.nombre || "Cargando..."}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Rol: <span className="font-semibold text-white">{user?.rolNombre || "-"}</span>
                </div>
                <div className="rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-slate-100">
                  Destino:{" "}
                  <span className="font-semibold text-white">
                    {esAdmin ? "Bodega principal" : user?.sedeNombre || "Tu sede"}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-[30px] border border-white/10 bg-white/8 p-5 backdrop-blur">
              <div className="inline-flex rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">
                Resumen de captura
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                    Modo de carga
                  </p>
                  <p className="mt-2 text-2xl font-black text-white">
                    {esAdmin ? (cantidadImeisMasivos > 0 ? "Masivo" : "Individual") : "Sede"}
                  </p>
                  <p className="mt-2 text-sm text-slate-200">
                    {esAdmin
                      ? cantidadImeisMasivos > 0
                        ? `${cantidadImeisMasivos} IMEI(s) listos para guardar`
                        : "Carga por IMEI o lote"
                      : "Registro con validacion financiera"}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                    Costo capturado
                  </p>
                  <p className="mt-2 text-2xl font-black text-white">
                    {costo ? formatearPesos(costo) : "$ 0"}
                  </p>
                  <p className="mt-2 text-sm text-slate-200">
                    Valor base para el registro actual.
                  </p>
                </div>
              </div>
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
              eyebrow="Captura principal"
              title={esAdmin ? "Identificacion de equipos" : "Identificacion del equipo"}
              description={
                esAdmin
                  ? "Puedes registrar un solo IMEI o cargar varios en lote cuando comparten referencia, costo, factura y distribuidor."
                  : "Ingresa el IMEI y completa la informacion base del equipo para registrarlo correctamente en tu sede."
              }
            >
              <div className="grid gap-5">
                <div>
                  <FieldLabel>{esAdmin ? "IMEI individual (opcional)" : "IMEI"}</FieldLabel>
                  <input
                    placeholder="IMEI (15 digitos)"
                    value={imei}
                    onChange={(event) => {
                      const value = event.target.value.replace(/\D/g, "").slice(0, 15);
                      setImei(value);
                      if (!esAdmin && value.length === 15) {
                        void buscarIMEI(value);
                      }
                    }}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-lg font-semibold text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Solo numeros, maximo 15 digitos.
                  </p>
                </div>

                {esAdmin && (
                  <div>
                    <FieldLabel>IMEIs masivos (uno por linea)</FieldLabel>
                    <textarea
                      placeholder={`352041714273552\n352041714273553\n352041714273554`}
                      value={imeisMasivos}
                      onChange={(event) => setImeisMasivos(event.target.value)}
                      rows={7}
                      className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-4 text-base leading-8 text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      Usa esta carga solo cuando referencia, costo, factura y distribuidor sean los mismos.
                    </p>
                  </div>
                )}
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Ficha comercial"
              title="Datos del equipo"
              description="Completa la referencia, color, costo y datos de soporte para guardar el inventario con mejor trazabilidad."
            >
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel>Referencia</FieldLabel>
                  <input
                    placeholder="Ej: iPhone 13"
                    value={referencia}
                    onChange={(event) => setReferencia(event.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </div>

                <div>
                  <FieldLabel>Color</FieldLabel>
                  <input
                    placeholder="Ej: Negro"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </div>

                <div>
                  <FieldLabel>Costo</FieldLabel>
                  <input
                    placeholder="$ 0"
                    value={costo ? formatearPesos(costo) : ""}
                    onChange={(event) => {
                      const value = event.target.value.replace(/\D/g, "");
                      setCosto(value);
                    }}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base font-semibold text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </div>

                {esAdmin && (
                  <div>
                    <FieldLabel>Numero de factura</FieldLabel>
                    <input
                      placeholder="Ej: FAC-001245"
                      value={numeroFactura}
                      onChange={(event) => setNumeroFactura(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                    />
                  </div>
                )}

                <div className={esAdmin ? "md:col-span-2" : ""}>
                  <FieldLabel>Distribuidor</FieldLabel>
                  <select
                    value={distribuidor}
                    onChange={(event) => setDistribuidor(event.target.value)}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="">Seleccionar distribuidor</option>
                    {opcionesDistribuidor.map((opcion) => (
                      <option key={opcion} value={opcion}>
                        {opcion}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </SectionCard>

            {!esAdmin && (
              <SectionCard
                eyebrow="Cobertura financiera"
                title="Estado financiero de la sede"
                description="Define si el equipo entra pagado, en deuda o cancelado, y a quien se le debe cuando aplica."
              >
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <FieldLabel>Estado financiero</FieldLabel>
                    <select
                      value={estadoFinanciero}
                      onChange={(event) => {
                        const valor = event.target.value;
                        setEstadoFinanciero(valor);
                        if (valor !== "DEUDA") {
                          setDeboA("");
                        }
                      }}
                      className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                    >
                      <option value="PAGO">PAGO</option>
                      <option value="DEUDA">DEUDA</option>
                      <option value="CANCELADO">CANCELADO</option>
                    </select>
                  </div>

                  {estadoFinanciero === "DEUDA" && (
                    <div>
                      <FieldLabel>Debe a</FieldLabel>
                      <select
                        value={deboA}
                        onChange={(event) => setDeboA(event.target.value)}
                        className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3.5 text-base text-slate-900 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      >
                        <option value="">Seleccionar proveedor</option>
                        {OPCIONES_PROVEEDOR_SEDE.map((opcion) => (
                          <option key={opcion} value={opcion}>
                            {opcion}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </SectionCard>
            )}
          </div>

          <div className="space-y-6">
            <SectionCard
              eyebrow="Control de carga"
              title="Revision final"
              description="Haz una ultima verificacion antes de guardar el inventario."
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Referencia actual
                  </p>
                  <p className="mt-2 text-xl font-black text-slate-950">
                    {referencia || "Sin referencia"}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Distribuidor
                  </p>
                  <p className="mt-2 text-lg font-bold text-slate-950">
                    {distribuidor || "Pendiente"}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Estado de captura
                  </p>
                  <p className="mt-2 text-lg font-bold text-slate-950">
                    {guardando
                      ? "Guardando..."
                      : esAdmin
                      ? cantidadImeisMasivos > 0
                        ? `${cantidadImeisMasivos} equipo(s) listos`
                        : imei
                        ? "1 equipo listo"
                        : "Esperando IMEI"
                      : imei
                      ? "Formulario listo para validar"
                      : "Pendiente por completar"}
                  </p>
                </div>
              </div>
            </SectionCard>

            <div className="rounded-[30px] border border-[#e4dccd] bg-[linear-gradient(180deg,#ffffff_0%,#fbf8f2_100%)] p-5 shadow-sm">
              <div className="flex flex-col gap-3">
                <button
                  onClick={guardar}
                  disabled={guardando}
                  className="inline-flex min-h-[58px] items-center justify-center rounded-2xl bg-[#111318] px-6 py-4 text-center text-[15px] font-bold text-white transition hover:bg-[#1d2330] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {guardando
                    ? "Guardando..."
                    : esAdmin
                    ? "Guardar en bodega principal"
                    : "Guardar inventario"}
                </button>

                <Link
                  href={esAdmin ? "/inventario-principal" : "/inventario"}
                  className="inline-flex min-h-[58px] items-center justify-center rounded-2xl border border-slate-300 bg-white px-6 py-4 text-center text-[15px] font-bold text-slate-700 transition hover:bg-slate-50"
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
