"use client";

import { useEffect, useMemo, useState } from "react";
import {
  calcularValorNetoFinanciera,
  type CatalogoFinanciera,
} from "@/lib/ventas-financieras";

const SERVICIOS = [
  "CONTADO CLARO",
  "CONTADO LIBRES",
  "FINANCIERA",
];

type EquipoInfo = {
  id: number;
  imei: string;
  referencia: string;
  color: string | null;
  costo: number;
  mensaje?: string;
  origen?: string;
  sedeNombre?: string | null;
};

type FilaFin = {
  nombre: string;
  valor: string;
};

type CatalogoPersonalResponse = {
  jaladores: Array<{ nombre: string }>;
  cerradores: Array<{ nombre: string }>;
  financieras: CatalogoFinanciera[];
};

function limpiarNumero(v: string) {
  return v.replace(/\D/g, "");
}

function formatoPesos(v: string | number) {
  if (v === "" || v === null || v === undefined) return "";
  const num = Number(v);
  if (!Number.isFinite(num)) return "";
  return `$ ${num.toLocaleString("es-CO")}`;
}

function netoIngreso(valor: number, tipo: string) {
  return tipo.toUpperCase() === "VOUCHER" ? valor * 0.95 : valor;
}

function cajaIngreso(valor: number, tipo: string) {
  const t = tipo.toUpperCase();
  if (t === "TRANSFERENCIA") return 0;
  if (t === "VOUCHER") return valor * 0.95;
  return valor;
}

function ocultaFinancieras(servicio: string) {
  const s = servicio.toUpperCase();
  return s === "CONTADO CLARO" || s === "CONTADO LIBRES";
}

function inputBaseClass(readOnly = false) {
  return `w-full rounded-2xl border px-4 py-3 text-sm outline-none transition ${
    readOnly
      ? "border-slate-200 bg-slate-50 text-slate-700"
      : "border-slate-300 bg-white text-slate-900 shadow-sm focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
  }`;
}

function sectionTitleClass() {
  return "mb-5 text-xs font-bold uppercase tracking-[0.22em] text-slate-500";
}

function sectionCardClass() {
  return "rounded-[30px] border border-slate-200/80 bg-white p-6 shadow-[0_18px_60px_rgba(15,23,42,0.08)]";
}

export default function NuevaVentaPage() {
  const [jaladores, setJaladores] = useState<string[]>([]);
  const [cerradores, setCerradores] = useState<string[]>([]);
  const [financierasCatalogo, setFinancierasCatalogo] = useState<CatalogoFinanciera[]>([]);
  const [serial, setSerial] = useState("");
  const [servicio, setServicio] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [jalador, setJalador] = useState("");
  const [cerrador, setCerrador] = useState("");

  const [referencia, setReferencia] = useState("");
  const [color, setColor] = useState("");
  const [costoEquipo, setCostoEquipo] = useState(0);

  const [ingreso1Base, setIngreso1Base] = useState("");
  const [ingreso2Base, setIngreso2Base] = useState("");
  const [tipoIngreso1] = useState("EFECTIVO");
  const [tipoIngreso2, setTipoIngreso2] = useState("");
  const [usarIngreso2, setUsarIngreso2] = useState(false);

  const [comision, setComision] = useState("");
  const [salida, setSalida] = useState("");

  const [finanzas, setFinanzas] = useState<FilaFin[]>([
    { nombre: "", valor: "" },
    { nombre: "", valor: "" },
    { nombre: "", valor: "" },
    { nombre: "", valor: "" },
  ]);

  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);

  const mostrarFinancieras = !ocultaFinancieras(servicio);

  useEffect(() => {
    const cargarCatalogoPersonal = async () => {
      try {
        const res = await fetch("/api/ventas/catalogo-personal", {
          cache: "no-store",
        });
        const data = await res.json();

        if (!res.ok) {
          return;
        }

        const catalogo = data as CatalogoPersonalResponse;

        setJaladores(
          Array.isArray(catalogo?.jaladores) && catalogo.jaladores.length
            ? catalogo.jaladores.map((item) => item.nombre)
            : []
        );
        setCerradores(
          Array.isArray(catalogo?.cerradores) && catalogo.cerradores.length
            ? catalogo.cerradores.map((item) => item.nombre)
            : []
        );
        setFinancierasCatalogo(
          Array.isArray(catalogo?.financieras) && catalogo.financieras.length
            ? catalogo.financieras
            : []
        );
      } catch {}
    };

    void cargarCatalogoPersonal();
  }, []);

  useEffect(() => {
    if (!mostrarFinancieras) {
      setFinanzas([
        { nombre: "", valor: "" },
        { nombre: "", valor: "" },
        { nombre: "", valor: "" },
        { nombre: "", valor: "" },
      ]);
    }
  }, [mostrarFinancieras]);

  useEffect(() => {
    if (!usarIngreso2) {
      setIngreso2Base("");
      setTipoIngreso2("");
    }
  }, [usarIngreso2]);

  const ingreso1Neto = useMemo(
    () => netoIngreso(Number(ingreso1Base || 0), tipoIngreso1),
    [ingreso1Base, tipoIngreso1]
  );

  const ingreso2Neto = useMemo(
    () => netoIngreso(Number(ingreso2Base || 0), tipoIngreso2 || ""),
    [ingreso2Base, tipoIngreso2]
  );

  const ingreso2Mostrado = useMemo(() => {
    const base = Number(ingreso2Base || 0);
    if (!base) return "";

    if (String(tipoIngreso2 || "").toUpperCase() === "VOUCHER") {
      return formatoPesos(base * 0.95);
    }

    return formatoPesos(base);
  }, [ingreso2Base, tipoIngreso2]);

  const totalIngresosNetos = ingreso1Neto + (usarIngreso2 ? ingreso2Neto : 0);

  const totalIngresosCaja = useMemo(
    () =>
      cajaIngreso(Number(ingreso1Base || 0), tipoIngreso1) +
      (usarIngreso2
        ? cajaIngreso(Number(ingreso2Base || 0), tipoIngreso2 || "")
        : 0),
    [ingreso1Base, ingreso2Base, tipoIngreso1, tipoIngreso2, usarIngreso2]
  );

  const totalFinancierasNetas = useMemo(() => {
    if (!mostrarFinancieras) return 0;
    return finanzas.reduce(
      (acc, f) =>
        acc +
        calcularValorNetoFinanciera(
          f.nombre,
          Number(f.valor || 0),
          financierasCatalogo
        ),
      0
    );
  }, [finanzas, financierasCatalogo, mostrarFinancieras]);

  const utilidad = useMemo(() => {
    return (
      totalIngresosNetos +
      totalFinancierasNetas -
      Number(costoEquipo || 0) -
      Number(comision || 0) -
      Number(salida || 0)
    );
  }, [
    totalIngresosNetos,
    totalFinancierasNetas,
    costoEquipo,
    comision,
    salida,
  ]);

  const cajaOficina = useMemo(() => {
    return totalIngresosCaja - Number(comision || 0) - Number(salida || 0);
  }, [totalIngresosCaja, comision, salida]);

  const buscarIMEI = async (imei: string) => {
    try {
      const res = await fetch("/api/ventas/buscar-imei", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serial: imei }),
      });

      const data = await res.json();

      if (!res.ok) {
        setReferencia(data.referencia || "");
        setColor(data.color || "");
        setCostoEquipo(Number(data.costo || 0));
        setDescripcion(data.referencia || "");
        setMensaje(`No se puede vender este equipo. ${data.mensaje || data.error || ""}`.trim());
        return;
      }

      const item = data as EquipoInfo & { mensaje?: string };
      setReferencia(item.referencia || "");
      setColor(item.color || "");
      setCostoEquipo(Number(item.costo || 0));
      setDescripcion(item.referencia || "");

      if (item.mensaje) {
        setMensaje(item.mensaje);
      } else {
        setMensaje("");
      }
    } catch {
      setReferencia("");
      setColor("");
      setCostoEquipo(0);
      setDescripcion("");
      setMensaje("Error consultando el IMEI");
    }
  };

  const actualizarFin = (
    index: number,
    campo: "nombre" | "valor",
    valor: string
  ) => {
    const copia = [...finanzas];
    copia[index] = { ...copia[index], [campo]: valor };
    setFinanzas(copia);
  };

  const visibleFin = (index: number) => {
    if (!mostrarFinancieras) return false;
    if (index === 0) return true;
    return Number(finanzas[index - 1].valor || 0) > 0;
  };

  const limpiarTodo = () => {
    setSerial("");
    setServicio("");
    setDescripcion("");
    setJalador("");
    setCerrador("");
    setReferencia("");
    setColor("");
    setCostoEquipo(0);
    setIngreso1Base("");
    setIngreso2Base("");
    setTipoIngreso2("");
    setUsarIngreso2(false);
    setComision("");
    setSalida("");
    setFinanzas([
      { nombre: "", valor: "" },
      { nombre: "", valor: "" },
      { nombre: "", valor: "" },
      { nombre: "", valor: "" },
    ]);
  };

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      if (!serial) return setMensaje("Ingrese el IMEI");
      if (!servicio) return setMensaje("Seleccione el servicio");
      if (!descripcion) return setMensaje("La descripcion es obligatoria");
      if (!jalador) return setMensaje("Seleccione el jalador");
      if (!cerrador) return setMensaje("Seleccione el cerrador");
      if (ingreso1Base === "") return setMensaje("Ingrese el valor del ingreso 1");
      if (usarIngreso2 && !ingreso2Base) {
        return setMensaje("Ingrese el valor del ingreso 2");
      }
      if (usarIngreso2 && !tipoIngreso2) {
        return setMensaje("Seleccione el tipo del ingreso 2");
      }

      const resValidacion = await fetch("/api/ventas/buscar-imei", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serial }),
      });

      const dataValidacion = await resValidacion.json();

      if (!resValidacion.ok) {
        setMensaje(
          `No se puede vender este equipo. ${dataValidacion.mensaje || dataValidacion.error || ""}`.trim()
        );
        return;
      }

      const res = await fetch("/api/ventas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          serial,
          servicio,
          descripcion,
          jalador,
          cerrador,
          ingreso1Base: Number(ingreso1Base || 0),
          ingreso2Base: usarIngreso2 ? Number(ingreso2Base || 0) : 0,
          tipoIngreso2: usarIngreso2 ? tipoIngreso2 : "",
          comision: Number(comision || 0),
          salida: Number(salida || 0),
          fin1Nombre: finanzas[0].nombre,
          fin1Valor: Number(finanzas[0].valor || 0),
          fin2Nombre: finanzas[1].nombre,
          fin2Valor: Number(finanzas[1].valor || 0),
          fin3Nombre: finanzas[2].nombre,
          fin3Valor: Number(finanzas[2].valor || 0),
          fin4Nombre: finanzas[3].nombre,
          fin4Valor: Number(finanzas[3].valor || 0),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMensaje(data.error || "Error al guardar");
        return;
      }

      setMensaje("Venta guardada correctamente");
      limpiarTodo();
    } catch {
      setMensaje("Error al guardar la venta");
    } finally {
      setGuardando(false);
    }
  };

  const salirFormulario = () => {
    window.location.href = "/dashboard";
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#fff7eb_0%,#f3f6fb_36%,#eef2f7_100%)] px-4 py-10 lg:px-8 2xl:px-10">
      <div className="mx-auto max-w-[1920px]">
        <div className="overflow-hidden rounded-[36px] border border-white/50 bg-white/90 shadow-[0_30px_90px_rgba(15,23,42,0.12)] backdrop-blur-sm">
          <div className="bg-[linear-gradient(135deg,#0f172a_0%,#111827_55%,#57534e_100%)] px-8 py-8 md:px-10">
            <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90">
                  Venta
                </div>
                <h1 className="mt-4 text-4xl font-black tracking-tight text-white md:text-5xl">
                  Nueva venta
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-200 md:text-base">
                  Registro comercial y financiero de la operacion con una vista
                  mas clara para equipo, ingresos, financieras y cierre.
                </p>
              </div>

              <div className="flex flex-col gap-3 md:items-end">
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-semibold tracking-[0.12em] text-white/90">
                  PASO 1: EQUIPO · PASO 2: VENTA · PASO 3: PAGO
                </div>
                <div className="text-xs uppercase tracking-[0.2em] text-slate-300">
                  Flujo guiado en tiempo real
                </div>
              </div>
            </div>
          </div>

          <div className="p-6 md:p-8 xl:p-10">
            {mensaje && (
              <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                {mensaje}
              </div>
            )}

            <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.85fr)_420px] xl:gap-10">
              <div className="space-y-6">
                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Equipo</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        IMEI
                      </label>
                      <input
                        value={serial}
                        onChange={(e) => {
                          const v = limpiarNumero(e.target.value).slice(0, 15);
                          setSerial(v);
                          if (v.length === 15) void buscarIMEI(v);
                          if (v.length < 15) {
                            setReferencia("");
                            setColor("");
                            setCostoEquipo(0);
                          }
                        }}
                        className={inputBaseClass()}
                        placeholder="Ingrese IMEI"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Servicio
                      </label>
                      <select
                        value={servicio}
                        onChange={(e) => setServicio(e.target.value)}
                        className={inputBaseClass()}
                      >
                        <option value="">Seleccionar</option>
                        {SERVICIOS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Descripcion
                      </label>
                      <input
                        value={descripcion}
                        onChange={(e) => setDescripcion(e.target.value)}
                        className={inputBaseClass(true)}
                        placeholder="Descripcion automatica"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Costo equipo
                      </label>
                      <input
                        value={costoEquipo ? formatoPesos(costoEquipo) : ""}
                        readOnly
                        className={inputBaseClass(true)}
                        placeholder="$ 0"
                      />
                    </div>

                    <div className="md:col-span-2">
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Color
                      </label>
                      <input
                        value={color || ""}
                        readOnly
                        className={inputBaseClass(true)}
                        placeholder="Color del equipo"
                      />
                    </div>
                  </div>
                </div>

                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Equipo comercial</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Jalador
                      </label>
                      <select
                        value={jalador}
                        onChange={(e) => setJalador(e.target.value)}
                        className={inputBaseClass()}
                      >
                        <option value="">Seleccionar</option>
                        {jaladores.map((j) => (
                          <option key={j} value={j}>
                            {j}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Cerrador
                      </label>
                      <select
                        value={cerrador}
                        onChange={(e) => setCerrador(e.target.value)}
                        className={inputBaseClass()}
                      >
                        <option value="">Seleccionar</option>
                        {cerradores.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Ingresos</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Ingreso 1
                      </label>
                      <input
                        value={ingreso1Base ? formatoPesos(ingreso1Base) : ""}
                        onChange={(e) => setIngreso1Base(limpiarNumero(e.target.value))}
                        className={inputBaseClass()}
                        placeholder="$ 0"
                      />
                      <p className="mt-1 text-xs text-slate-500">Tipo fijo: EFECTIVO</p>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Ingreso 1 neto
                      </label>
                      <input
                        value={formatoPesos(ingreso1Neto)}
                        readOnly
                        className={inputBaseClass(true)}
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    {!usarIngreso2 ? (
                      <button
                        type="button"
                        onClick={() => setUsarIngreso2(true)}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50"
                      >
                        + Agregar ingreso 2
                      </button>
                    ) : (
                      <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-2 block text-sm font-semibold text-slate-700">
                              Ingreso 2
                            </label>
                            <input
                              value={ingreso2Mostrado}
                              onChange={(e) =>
                                setIngreso2Base(limpiarNumero(e.target.value))
                              }
                              className={inputBaseClass()}
                              placeholder="$ 0"
                            />
                          </div>

                          <div>
                            <label className="mb-2 block text-sm font-semibold text-slate-700">
                              Tipo ingreso 2
                            </label>
                            <select
                              value={tipoIngreso2}
                              onChange={(e) => setTipoIngreso2(e.target.value)}
                              className={inputBaseClass()}
                            >
                              <option value="">Seleccionar</option>
                              <option value="VOUCHER">VOUCHER</option>
                              <option value="TRANSFERENCIA">TRANSFERENCIA</option>
                            </select>
                          </div>
                        </div>

                        <div className="mt-4 flex justify-end">
                          <button
                            type="button"
                            onClick={() => setUsarIngreso2(false)}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                          >
                            Quitar ingreso 2
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Financieras</h3>

                  {!mostrarFinancieras ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                      Este servicio no utiliza financieras.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3">
                      {[0, 1, 2, 3].map((i) =>
                        visibleFin(i) ? (
                          <div key={i} className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <select
                              value={finanzas[i].nombre}
                              onChange={(e) => actualizarFin(i, "nombre", e.target.value)}
                              className={inputBaseClass()}
                            >
                              <option value="">Seleccionar financiera</option>
                              {financierasCatalogo.map((f) => (
                                <option key={f.id} value={f.nombre}>
                                  {f.nombre}
                                </option>
                              ))}
                            </select>

                            <input
                              value={finanzas[i].valor ? formatoPesos(finanzas[i].valor) : ""}
                              onChange={(e) =>
                                actualizarFin(i, "valor", limpiarNumero(e.target.value))
                              }
                              className={inputBaseClass()}
                              placeholder="$ 0"
                            />
                          </div>
                        ) : null
                      )}
                    </div>
                  )}
                </div>

                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Descuentos y salida</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Comision
                      </label>
                      <input
                        value={comision ? formatoPesos(comision) : ""}
                        onChange={(e) => setComision(limpiarNumero(e.target.value))}
                        className={inputBaseClass()}
                        placeholder="$ 0"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Salida
                      </label>
                      <input
                        value={salida ? formatoPesos(salida) : ""}
                        onChange={(e) => setSalida(limpiarNumero(e.target.value))}
                        className={inputBaseClass()}
                        placeholder="$ 0"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-6 xl:sticky xl:top-8 xl:self-start">
                <div className="overflow-hidden rounded-[30px] border border-slate-200/80 bg-white shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
                  <div className="border-b border-white/5 bg-[linear-gradient(135deg,#111827_0%,#0f172a_60%,#374151_100%)] px-5 py-5 text-white">
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-300">
                      Resumen de venta
                    </p>
                    <h3 className="mt-3 text-2xl font-black tracking-tight">
                      Cierre proyectado
                    </h3>
                    <p className="mt-2 text-sm text-slate-300">
                      El resumen se actualiza a medida que completas la venta.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-4 p-5">
                    <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/80">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Caja oficina
                      </p>
                      <p className="mt-2 text-3xl font-black text-slate-900">
                        {formatoPesos(cajaOficina)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-100">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Utilidad
                      </p>
                      <p className="mt-2 text-3xl font-black text-emerald-600">
                        {formatoPesos(utilidad)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-blue-50 p-4 ring-1 ring-blue-100">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Ingresos netos
                      </p>
                      <p className="mt-2 text-2xl font-bold text-blue-700">
                        {formatoPesos(totalIngresosNetos)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-indigo-50 p-4 ring-1 ring-indigo-100">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Financieras netas
                      </p>
                      <p className="mt-2 text-2xl font-bold text-indigo-700">
                        {formatoPesos(totalFinancierasNetas)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Acciones</h3>

                  <div className="flex flex-col gap-3">
                    <button
                      onClick={guardar}
                      disabled={guardando}
                      className="rounded-2xl bg-gradient-to-r from-red-600 to-red-500 px-6 py-4 text-base font-semibold text-white shadow-sm transition hover:from-red-700 hover:to-red-600 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {guardando ? "Guardando..." : "Guardar venta"}
                    </button>

                    <button
                      type="button"
                      onClick={salirFormulario}
                      className="rounded-2xl bg-slate-100 px-6 py-4 text-base font-semibold text-slate-700 transition hover:bg-slate-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>

                <div className={sectionCardClass()}>
                  <h3 className={sectionTitleClass()}>Vista rapida</h3>

                  <div className="space-y-3 text-sm text-slate-600">
                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Servicio</span>
                      <span className="font-semibold text-slate-900">
                        {servicio || "-"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Jalador</span>
                      <span className="font-semibold text-slate-900">
                        {jalador || "-"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Cerrador</span>
                      <span className="font-semibold text-slate-900">
                        {cerrador || "-"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Equipo</span>
                      <span className="font-semibold text-slate-900">
                        {descripcion || referencia || "-"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Costo</span>
                      <span className="font-semibold text-slate-900">
                        {formatoPesos(costoEquipo)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
