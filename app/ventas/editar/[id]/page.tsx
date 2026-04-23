"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  calcularValorNetoFinanciera,
  extraerFinancierasDetalle,
  type CatalogoFinanciera,
} from "@/lib/ventas-financieras";

const SERVICIOS = ["ACTIVACIÓN", "CONTADO CLARO", "CONTADO LIBRES", "FINANCIERA"];
type FilaFin = {
  nombre: string;
  valor: string;
};

type CatalogoPersonalResponse = {
  jaladores: Array<{ nombre: string }>;
  cerradores: Array<{ nombre: string }>;
  financieras: CatalogoFinanciera[];
};

type VentaDetalle = {
  id: number;
  idVenta: string;
  fecha: string;
  hora: string | null;
  servicio: string;
  descripcion: string | null;
  serial: string;
  jalador: string | null;
  cerrador: string | null;
  ingreso1: string | null;
  ingreso2: string | null;
  primerValor: string | number | null;
  segundoValor: string | number | null;
  alcanos: string | number | null;
  payjoy: string | number | null;
  sistecredito: string | number | null;
  addi: string | number | null;
  sumaspay: string | number | null;
  celya: string | number | null;
  bogota: string | number | null;
  alocredit: string | number | null;
  esmio: string | number | null;
  kaiowa: string | number | null;
  finser: string | number | null;
  gora: string | number | null;
  financierasDetalle?: unknown;
  comision: string | number | null;
  salida: string | number | null;
  sede: { id: number; nombre: string } | null;
  inventarioSede: {
    id: number;
    referencia: string;
    color: string | null;
    costo: number;
  } | null;
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
  const s = String(servicio || "").trim().toUpperCase();
  return s.includes("ACTIVACI") || s === "CONTADO CLARO" || s === "CONTADO LIBRES";
}

function inputBaseClass(readOnly = false) {
  return `w-full rounded-2xl border px-4 py-3 text-sm outline-none transition ${
    readOnly
      ? "border-slate-200 bg-slate-50 text-slate-700"
      : "border-slate-300 bg-white text-slate-900 shadow-sm focus:border-red-500 focus:ring-2 focus:ring-red-200"
  }`;
}

function sectionTitleClass() {
  return "mb-4 text-xs font-bold uppercase tracking-[0.18em] text-slate-500";
}

function normalizeServicio(servicio: string) {
  const upper = String(servicio || "").trim().toUpperCase();

  if (upper.includes("ACTIVACI")) return "ACTIVACIÓN";
  if (upper === "CONTADO CLARO") return "CONTADO CLARO";
  if (upper === "CONTADO LIBRES") return "CONTADO LIBRES";
  return "FINANCIERA";
}

function reverseIngresoBase(valorGuardado: string | number | null, tipo: string | null) {
  const numero = Number(valorGuardado || 0);

  if (!numero) {
    return "";
  }

  if (String(tipo || "").toUpperCase() === "VOUCHER") {
    return String(Math.round(numero / 0.95));
  }

  return String(Math.round(numero));
}

function finanzasDesdeVenta(venta: VentaDetalle): FilaFin[] {
  const items = extraerFinancierasDetalle(venta as Record<string, unknown>).map((item) => ({
    nombre: item.nombre,
    valor: String(Math.round(Number(item.valorBruto || 0))),
  }));

  while (items.length < 4) {
    items.push({ nombre: "", valor: "" });
  }

  return items.slice(0, 4);
}

export default function EditarVentaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const ventaId = Number(params?.id);

  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [ventaIdTexto, setVentaIdTexto] = useState("");
  const [puedeEditar, setPuedeEditar] = useState(false);
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
  const [sedeNombre, setSedeNombre] = useState("");

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

  const mostrarFinancieras = !ocultaFinancieras(servicio);

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
    const cargarVenta = async () => {
      if (!Number.isInteger(ventaId) || ventaId <= 0) {
        setMensaje("La venta no es valida");
        setCargando(false);
        return;
      }

      try {
        const sessionRes = await fetch("/api/session", { cache: "no-store" });
        const sessionData = await sessionRes.json();

        if (!sessionRes.ok || String(sessionData?.rolNombre || "").toUpperCase() !== "ADMIN") {
          setMensaje("Solo el administrador puede editar ventas");
          setCargando(false);
          return;
        }

        setPuedeEditar(true);

        const res = await fetch(`/api/ventas?id=${ventaId}`, { cache: "no-store" });
        const data = await res.json();

        if (!res.ok) {
          setMensaje(data.error || "No se pudo cargar la venta");
          setCargando(false);
          return;
        }

        const venta = data as VentaDetalle;
        setVentaIdTexto(venta.idVenta);
        setSerial(venta.serial || "");
        setServicio(normalizeServicio(venta.servicio || ""));
        setDescripcion(venta.descripcion || venta.inventarioSede?.referencia || "");
        setJalador(venta.jalador || "");
        setCerrador(venta.cerrador || "");
        setReferencia(venta.inventarioSede?.referencia || venta.descripcion || "");
        setColor(venta.inventarioSede?.color || "");
        setCostoEquipo(Number(venta.inventarioSede?.costo || 0));
        setSedeNombre(venta.sede?.nombre || "");
        setIngreso1Base(String(Math.round(Number(venta.primerValor || 0))));

        const baseIngreso2 = reverseIngresoBase(venta.segundoValor, venta.ingreso2);
        setIngreso2Base(baseIngreso2);
        setTipoIngreso2(venta.ingreso2 || "");
        setUsarIngreso2(Boolean(baseIngreso2 && Number(baseIngreso2) > 0));

        setComision(String(Math.round(Number(venta.comision || 0))));
        setSalida(String(Math.round(Number(venta.salida || 0))));
        setFinanzas(finanzasDesdeVenta(venta));
      } catch {
        setMensaje("Error cargando la venta");
      } finally {
        setCargando(false);
      }
    };

    void cargarVenta();
  }, [ventaId]);

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
      return formatoPesos(base);
    }

    return formatoPesos(base);
  }, [ingreso2Base, tipoIngreso2]);

  const totalIngresosNetos = ingreso1Neto + (usarIngreso2 ? ingreso2Neto : 0);

  const totalIngresosCaja = useMemo(
    () =>
      cajaIngreso(Number(ingreso1Base || 0), tipoIngreso1) +
      (usarIngreso2 ? cajaIngreso(Number(ingreso2Base || 0), tipoIngreso2 || "") : 0),
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
  }, [totalIngresosNetos, totalFinancierasNetas, costoEquipo, comision, salida]);

  const cajaOficina = useMemo(() => {
    return totalIngresosCaja - Number(comision || 0) - Number(salida || 0);
  }, [totalIngresosCaja, comision, salida]);

  const actualizarFin = (index: number, campo: "nombre" | "valor", valor: string) => {
    const copia = [...finanzas];
    copia[index] = { ...copia[index], [campo]: valor };
    setFinanzas(copia);
  };

  const visibleFin = (index: number) => {
    if (!mostrarFinancieras) return false;
    if (index === 0) return true;
    return Number(finanzas[index - 1].valor || 0) > 0;
  };

  const guardar = async () => {
    try {
      setGuardando(true);
      setMensaje("");

      if (!puedeEditar) {
        setMensaje("Solo el administrador puede editar ventas");
        return;
      }

      if (!servicio) return setMensaje("Selecciona el servicio");
      if (!descripcion) return setMensaje("La descripcion es obligatoria");
      if (!jalador) return setMensaje("Selecciona el jalador");
      if (!cerrador) return setMensaje("Selecciona el cerrador");
      if (ingreso1Base === "") return setMensaje("Ingresa el valor del ingreso 1");
      if (usarIngreso2 && !ingreso2Base) return setMensaje("Ingresa el valor del ingreso 2");
      if (usarIngreso2 && !tipoIngreso2) return setMensaje("Selecciona el tipo del ingreso 2");

      const res = await fetch("/api/ventas", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: ventaId,
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
        setMensaje(data.error || "No se pudo actualizar la venta");
        return;
      }

      router.push("/ventas");
      router.refresh();
    } catch {
      setMensaje("Error actualizando la venta");
    } finally {
      setGuardando(false);
    }
  };

  if (cargando) {
    return (
      <div className="min-h-screen bg-[#f4f6f8] px-4 py-10">
        <div className="mx-auto max-w-6xl rounded-[30px] bg-white px-8 py-12 shadow-xl ring-1 ring-slate-200">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            Ventas
          </p>
          <h1 className="mt-3 text-3xl font-black text-slate-950">Cargando venta...</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f6f8] px-4 py-10">
      <div className="mx-auto max-w-6xl">
        <div className="overflow-hidden rounded-[30px] bg-white shadow-2xl ring-1 ring-slate-200">
          <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-red-700 px-8 py-7">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="inline-flex rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90">
                  Venta
                </div>
                <h1 className="mt-3 text-3xl font-black text-white">Editar venta</h1>
                <p className="mt-2 text-sm text-slate-200">
                  Ajuste administrativo de la venta {ventaIdTexto || `#${ventaId}`}.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/ventas"
                  className="rounded-2xl border border-white/10 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/15"
                >
                  Volver a ventas
                </Link>
              </div>
            </div>
          </div>

          <div className="p-6 md:p-8">
            {mensaje && (
              <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                {mensaje}
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <div className="space-y-6 xl:col-span-2">
                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Equipo</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        ID venta
                      </label>
                      <input value={ventaIdTexto} readOnly className={inputBaseClass(true)} />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        IMEI
                      </label>
                      <input value={serial} readOnly className={inputBaseClass(true)} />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Servicio
                      </label>
                      <select
                        value={servicio}
                        onChange={(event) => setServicio(event.target.value)}
                        className={inputBaseClass()}
                      >
                        <option value="">Seleccionar</option>
                        {SERVICIOS.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Sede
                      </label>
                      <input value={sedeNombre} readOnly className={inputBaseClass(true)} />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Descripción
                      </label>
                      <input
                        value={descripcion}
                        onChange={(event) => setDescripcion(event.target.value)}
                        className={inputBaseClass()}
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
                      />
                    </div>

                    <div className="md:col-span-2">
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Color
                      </label>
                      <input
                        value={color || referencia || ""}
                        readOnly
                        className={inputBaseClass(true)}
                      />
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Equipo comercial</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Jalador
                      </label>
                      <select
                        value={jalador}
                        onChange={(event) => setJalador(event.target.value)}
                        className={inputBaseClass()}
                      >
                        <option value="">Seleccionar</option>
                        {jaladores.map((item) => (
                          <option key={item} value={item}>
                            {item}
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
                        onChange={(event) => setCerrador(event.target.value)}
                        className={inputBaseClass()}
                      >
                        <option value="">Seleccionar</option>
                        {cerradores.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Ingresos</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Ingreso 1
                      </label>
                      <input
                        value={ingreso1Base ? formatoPesos(ingreso1Base) : ""}
                        onChange={(event) => setIngreso1Base(limpiarNumero(event.target.value))}
                        className={inputBaseClass()}
                        placeholder="$ 0"
                      />
                      <p className="mt-1 text-xs text-slate-500">Tipo fijo: EFECTIVO</p>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Ingreso 1 neto
                      </label>
                      <input value={formatoPesos(ingreso1Neto)} readOnly className={inputBaseClass(true)} />
                    </div>
                  </div>

                  <div className="mt-4">
                    {!usarIngreso2 ? (
                      <button
                        type="button"
                        onClick={() => setUsarIngreso2(true)}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                      >
                        + Agregar ingreso 2
                      </button>
                    ) : (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-2 block text-sm font-semibold text-slate-700">
                              Ingreso 2
                            </label>
                            <input
                              value={ingreso2Mostrado}
                              onChange={(event) =>
                                setIngreso2Base(limpiarNumero(event.target.value))
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
                              onChange={(event) => setTipoIngreso2(event.target.value)}
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

                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Financieras</h3>

                  {!mostrarFinancieras ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                      Este servicio no utiliza financieras.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3">
                      {[0, 1, 2, 3].map((index) =>
                        visibleFin(index) ? (
                          <div key={index} className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <select
                              value={finanzas[index].nombre}
                              onChange={(event) =>
                                actualizarFin(index, "nombre", event.target.value)
                              }
                              className={inputBaseClass()}
                            >
                              <option value="">Seleccionar financiera</option>
                              {financierasCatalogo.map((item) => (
                                <option key={item.id} value={item.nombre}>
                                  {item.nombre}
                                </option>
                              ))}
                            </select>

                            <input
                              value={finanzas[index].valor ? formatoPesos(finanzas[index].valor) : ""}
                              onChange={(event) =>
                                actualizarFin(index, "valor", limpiarNumero(event.target.value))
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

                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Descuentos y salida</h3>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold text-slate-700">
                        Comisión
                      </label>
                      <input
                        value={comision ? formatoPesos(comision) : ""}
                        onChange={(event) => setComision(limpiarNumero(event.target.value))}
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
                        onChange={(event) => setSalida(limpiarNumero(event.target.value))}
                        className={inputBaseClass()}
                        placeholder="$ 0"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Resumen</h3>

                  <div className="grid grid-cols-1 gap-4">
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Caja oficina
                      </p>
                      <p className="mt-2 text-3xl font-black text-slate-900">
                        {formatoPesos(cajaOficina)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-emerald-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Utilidad
                      </p>
                      <p className="mt-2 text-3xl font-black text-emerald-600">
                        {formatoPesos(utilidad)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-blue-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Ingresos netos
                      </p>
                      <p className="mt-2 text-2xl font-bold text-blue-700">
                        {formatoPesos(totalIngresosNetos)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-indigo-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Financieras netas
                      </p>
                      <p className="mt-2 text-2xl font-bold text-indigo-700">
                        {formatoPesos(totalFinancierasNetas)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Acciones</h3>

                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => void guardar()}
                      disabled={guardando || !puedeEditar}
                      className="rounded-2xl bg-red-600 px-6 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {guardando ? "Guardando..." : "Guardar cambios"}
                    </button>

                    <button
                      type="button"
                      onClick={() => router.push("/ventas")}
                      className="rounded-2xl bg-slate-100 px-6 py-4 text-base font-semibold text-slate-700 transition hover:bg-slate-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>

                <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <h3 className={sectionTitleClass()}>Vista rápida</h3>

                  <div className="space-y-3 text-sm text-slate-600">
                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Servicio</span>
                      <span className="font-semibold text-slate-900">{servicio || "-"}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Jalador</span>
                      <span className="font-semibold text-slate-900">{jalador || "-"}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Cerrador</span>
                      <span className="font-semibold text-slate-900">{cerrador || "-"}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>Equipo</span>
                      <span className="font-semibold text-slate-900">{descripcion || referencia || "-"}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                      <span>IMEI</span>
                      <span className="font-semibold text-slate-900">{serial || "-"}</span>
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
