"use client";

import Link from "next/link";
import {
  useMemo,
  useState,
  type ChangeEvent,
  type HTMLInputTypeAttribute,
} from "react";

type MassCreditInputRow = {
  aliado: string;
  cedula: string;
  cliente: string;
  cuota: string;
  fecha: string;
  fechaPago: string;
  frecuencia: string;
  imei: string;
  inicial: string;
  plazo: string;
  referencia: string;
  sede: string;
  telefono: string;
  valorCredito: string;
  vendedor: string;
};

type ValidationRow = {
  createdCreditoId?: number;
  createdFolio?: string;
  errors: string[];
  normalized: {
    aliado: string;
    cedula: string;
    cliente: string;
    cuota: number;
    fecha: string | null;
    fechaPago: string | null;
    frecuencia: string;
    imei: string;
    inicial: number;
    plazo: number;
    referencia: string;
    sede: string;
    telefono: string;
    valorCredito: number;
    vendedor: string;
  };
  ok: boolean;
  rowNumber: number;
  warnings: string[];
};

type ValidationResponse = {
  batchId?: string;
  commit: boolean;
  created?: number;
  error?: string;
  ok: boolean;
  rows: ValidationRow[];
  summary: {
    created?: number;
    invalid: number;
    total: number;
    valid: number;
    warnings: number;
  };
};

type CatalogResponse = {
  aliados?: Array<{ id: number; nombre: string; codigo: string | null }>;
  ok?: boolean;
  sedes?: Array<{ aliadoId: number | null; id: number; nombre: string }>;
  vendedores?: Array<{
    documento: string | null;
    id: number;
    nombre: string;
    sedeId: number;
  }>;
};

type FieldKey = keyof MassCreditInputRow;
type InputMode = "bulk" | "single";

const FIELD_ORDER: FieldKey[] = [
  "fecha",
  "cedula",
  "cliente",
  "telefono",
  "referencia",
  "imei",
  "aliado",
  "sede",
  "vendedor",
  "inicial",
  "valorCredito",
  "cuota",
  "plazo",
  "frecuencia",
  "fechaPago",
];

const FIELD_LABELS: Record<FieldKey, string> = {
  aliado: "ALIADO",
  cedula: "CEDULA",
  cliente: "CLIENTE",
  cuota: "CUOTA",
  fecha: "FECHA",
  fechaPago: "FECHA DE PAGO",
  frecuencia: "FRECUENCIA",
  imei: "IMEI",
  inicial: "INICIAL",
  plazo: "PLAZO",
  referencia: "REFERENCIA",
  sede: "SEDE",
  telefono: "TELEFONO",
  valorCredito: "VALOR DEL CREDITO",
  vendedor: "VENDEDOR",
};

const TEMPLATE_HEADER = FIELD_ORDER.map((key) => FIELD_LABELS[key]).join("\t");
const TEMPLATE_EXAMPLE_ROW = [
  "2026-06-27",
  "1234567890",
  "NOMBRE CLIENTE",
  "3001234567",
  "Samsung A15",
  "123456789012345",
  "CONECTAMOS",
  "SEDE CENTRO",
  "VENDEDOR UNO",
  "100000",
  "600000",
  "50000",
  "12",
  "CATORCENAL",
  "2026-07-11",
];
const TEMPLATE_ROWS = [TEMPLATE_HEADER, TEMPLATE_EXAMPLE_ROW.join("\t")].join("\n");
const TEMPLATE_CSV = [
  FIELD_ORDER.map((key) => FIELD_LABELS[key]).join(";"),
  TEMPLATE_EXAMPLE_ROW.join(";"),
].join("\n");

const HEADER_ALIASES: Record<string, FieldKey> = {
  aliado: "aliado",
  cedula: "cedula",
  ccdocumento: "cedula",
  cliente: "cliente",
  cuota: "cuota",
  fechadepago: "fechaPago",
  fechapago: "fechaPago",
  fecha: "fecha",
  frecuencia: "frecuencia",
  imei: "imei",
  inicial: "inicial",
  plazo: "plazo",
  referencia: "referencia",
  sede: "sede",
  telefono: "telefono",
  tel: "telefono",
  valorcredito: "valorCredito",
  valordelcredito: "valorCredito",
  vendedor: "vendedor",
};

function normalizeHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
}

function detectDelimiter(line: string) {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  return ",";
}

function parseDelimitedLine(line: string, delimiter: string) {
  if (delimiter === "\t") {
    return line.split("\t").map((cell) => cell.trim());
  }

  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function emptyRow(): MassCreditInputRow {
  return {
    aliado: "",
    cedula: "",
    cliente: "",
    cuota: "",
    fecha: "",
    fechaPago: "",
    frecuencia: "",
    imei: "",
    inicial: "",
    plazo: "",
    referencia: "",
    sede: "",
    telefono: "",
    valorCredito: "",
    vendedor: "",
  };
}

function defaultManualRow(): MassCreditInputRow {
  const today = new Date();
  const offset = today.getTimezoneOffset();
  const localDate = new Date(today.getTime() - offset * 60 * 1000);

  return {
    ...emptyRow(),
    fecha: localDate.toISOString().slice(0, 10),
    frecuencia: "CATORCENAL",
    inicial: "0",
  };
}

function hasManualCreditData(row: MassCreditInputRow) {
  return FIELD_ORDER.some((field) => {
    if (field === "fecha" || field === "frecuencia" || field === "inicial") {
      return false;
    }

    return String(row[field] || "").trim();
  });
}

function parseRows(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const delimiter = detectDelimiter(lines[0]);
  const firstCells = parseDelimitedLine(lines[0], delimiter);
  const headerFields = firstCells.map((cell) => HEADER_ALIASES[normalizeHeader(cell)]);
  const hasHeader = headerFields.filter(Boolean).length >= 5;
  const rows = hasHeader ? lines.slice(1) : lines;
  const positions = hasHeader ? headerFields : FIELD_ORDER;

  return rows
    .map((line) => {
      const cells = parseDelimitedLine(line, delimiter);
      const row = emptyRow();

      positions.forEach((field, index) => {
        if (field) {
          row[field] = cells[index] || "";
        }
      });

      return row;
    })
    .filter((row) => FIELD_ORDER.some((field) => String(row[field] || "").trim()));
}

function money(value: number) {
  return `$ ${Math.round(Number(value || 0)).toLocaleString("es-CO")}`;
}

function statusClasses(ok: boolean) {
  return ok
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-red-200 bg-red-50 text-red-800";
}

async function postRows(rows: MassCreditInputRow[], commit: boolean) {
  const response = await fetch("/api/creditos/masivos", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commit, rows }),
  });
  const data = (await response.json().catch(() => null)) as
    | ValidationResponse
    | null;

  if (!response.ok || !data) {
    throw new Error(data?.error || "No se pudo procesar la carga");
  }

  return data;
}

export default function MassCreditImportConsole() {
  const [mode, setMode] = useState<InputMode>("bulk");
  const [rawText, setRawText] = useState(TEMPLATE_HEADER);
  const [manualRow, setManualRow] = useState<MassCreditInputRow>(
    defaultManualRow()
  );
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState<"catalog" | "validate" | "create" | null>(
    null
  );
  const [notice, setNotice] = useState("");
  const parsedRows = useMemo(() => parseRows(rawText), [rawText]);
  const activeRows =
    mode === "single"
      ? hasManualCreditData(manualRow)
        ? [manualRow]
        : []
      : parsedRows;
  const canCreate =
    Boolean(validation) &&
    validation?.summary.invalid === 0 &&
    validation?.summary.total === activeRows.length &&
    activeRows.length > 0 &&
    !validation?.commit;
  const totalAmount = activeRows.reduce((sum, row) => {
    const raw = String(row.valorCredito || "").replace(/\D/g, "");
    return sum + Number(raw || 0);
  }, 0);

  const switchMode = (nextMode: InputMode) => {
    setMode(nextMode);
    setValidation(null);
    setNotice("");
  };

  const updateManualField = (field: FieldKey, value: string) => {
    setManualRow((current) => ({
      ...current,
      [field]: value,
    }));
    setValidation(null);
  };

  const loadCatalog = async () => {
    try {
      setLoading("catalog");
      const response = await fetch("/api/creditos/masivos", {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as CatalogResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data?.error || "No se pudo cargar el catalogo");
      }

      setCatalog(data);
      setNotice("Catalogo actualizado");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Error cargando catalogo");
    } finally {
      setLoading(null);
    }
  };

  const validate = async () => {
    try {
      setLoading("validate");
      setNotice("");
      const data = await postRows(activeRows, false);
      setValidation(data);
      setNotice(
        data.summary.invalid
          ? `${data.summary.invalid} fila(s) con error`
          : `${data.summary.valid} fila(s) listas para crear`
      );
    } catch (error) {
      setValidation(null);
      setNotice(error instanceof Error ? error.message : "No se pudo validar");
    } finally {
      setLoading(null);
    }
  };

  const createCredits = async () => {
    const label = mode === "single" ? "credito" : "credito(s) masivo(s)";

    if (!window.confirm(`Crear ${activeRows.length} ${label}?`)) {
      return;
    }

    try {
      setLoading("create");
      setNotice("");
      const data = await postRows(activeRows, true);
      setValidation(data);
      setNotice(
        `Lote ${data.batchId || ""}: ${data.created || 0} credito(s) creados`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo crear");
    } finally {
      setLoading(null);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE_CSV], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "plantilla-creditos-masivos.csv";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Plantilla descargada: plantilla-creditos-masivos.csv");
  };

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setRawText(await file.text());
    setMode("bulk");
    setValidation(null);
    setNotice(`${file.name} cargado`);
  };

  const visibleRows = validation?.rows || [];

  return (
    <div className="min-h-screen bg-[#eef3f6] px-4 py-6 text-[#182025]">
      <main className="mx-auto max-w-7xl">
        <header className="rounded-[28px] border border-[#d8e0e3] bg-white p-5 shadow-[0_18px_55px_rgba(24,32,37,0.08)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-[#bfe9dd] bg-[#f0fbf7] px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-[#087061]">
                  Admin FINSER PAY
                </span>
                <span className="rounded-full border border-[#dde5e8] bg-[#f7fafb] px-3 py-1 text-xs font-bold text-[#64717b]">
                  {activeRows.length} filas
                </span>
                <span className="rounded-full border border-[#dde5e8] bg-[#f7fafb] px-3 py-1 text-xs font-bold text-[#64717b]">
                  {money(totalAmount)}
                </span>
              </div>
              <h1 className="mt-4 text-4xl font-black tracking-tight text-[#11161a]">
                Creditos masivos
              </h1>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={loadCatalog}
                disabled={loading !== null}
                className="min-h-11 rounded-2xl border border-[#d8e0e3] bg-white px-4 text-sm font-black text-[#182025]"
              >
                {loading === "catalog" ? "Cargando" : "Catalogo"}
              </button>
              <button
                type="button"
                onClick={downloadTemplate}
                className="min-h-11 rounded-2xl border border-[#d8e0e3] bg-white px-4 text-sm font-black text-[#182025]"
              >
                Descargar plantilla CSV
              </button>
              <Link
                href="/dashboard"
                className="inline-flex min-h-11 items-center rounded-2xl border border-[#11161a] bg-[#11161a] px-4 text-sm font-black text-white"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </header>

        <section className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.15fr]">
          <div className="rounded-[24px] border border-[#d8e0e3] bg-white p-4 shadow-[0_12px_34px_rgba(24,32,37,0.06)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#0f766e]">
                Datos
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => switchMode("bulk")}
                  className={[
                    "min-h-10 rounded-2xl border px-4 text-sm font-black",
                    mode === "bulk"
                      ? "border-[#11161a] bg-[#11161a] text-white"
                      : "border-[#d8e0e3] bg-[#f8fbfa] text-[#182025]",
                  ].join(" ")}
                >
                  Carga CSV
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("single")}
                  className={[
                    "min-h-10 rounded-2xl border px-4 text-sm font-black",
                    mode === "single"
                      ? "border-[#11161a] bg-[#11161a] text-white"
                      : "border-[#d8e0e3] bg-[#f8fbfa] text-[#182025]",
                  ].join(" ")}
                >
                  Credito individual
                </button>
                {mode === "bulk" ? (
                  <label className="inline-flex min-h-10 cursor-pointer items-center rounded-2xl border border-[#d8e0e3] bg-[#f8fbfa] px-4 text-sm font-black text-[#182025]">
                    Subir archivo CSV
                    <input
                      type="file"
                      accept=".csv,.tsv,.txt"
                      onChange={loadFile}
                      className="sr-only"
                    />
                  </label>
                ) : null}
              </div>
            </div>

            {mode === "bulk" ? (
              <textarea
                value={rawText}
                onChange={(event) => {
                  setRawText(event.target.value);
                  setValidation(null);
                }}
                placeholder={TEMPLATE_HEADER}
                spellCheck={false}
                wrap="off"
                className="mt-4 h-[460px] w-full resize-none rounded-2xl border border-[#d8e0e3] bg-[#fbfdfd] p-4 font-mono text-xs leading-5 text-[#20242a] outline-none focus:border-[#0f766e]"
              />
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <ManualField
                  label="Fecha"
                  type="date"
                  value={manualRow.fecha}
                  onChange={(value) => updateManualField("fecha", value)}
                />
                <ManualField
                  label="Cedula"
                  inputMode="numeric"
                  value={manualRow.cedula}
                  onChange={(value) => updateManualField("cedula", value)}
                />
                <ManualField
                  label="Cliente"
                  value={manualRow.cliente}
                  onChange={(value) => updateManualField("cliente", value)}
                />
                <ManualField
                  label="Telefono"
                  inputMode="tel"
                  value={manualRow.telefono}
                  onChange={(value) => updateManualField("telefono", value)}
                />
                <ManualField
                  label="Referencia"
                  value={manualRow.referencia}
                  onChange={(value) => updateManualField("referencia", value)}
                />
                <ManualField
                  label="IMEI"
                  inputMode="numeric"
                  value={manualRow.imei}
                  onChange={(value) => updateManualField("imei", value)}
                />
                <ManualField
                  label="Aliado"
                  list="mass-credit-aliados"
                  value={manualRow.aliado}
                  onChange={(value) => updateManualField("aliado", value)}
                />
                <ManualField
                  label="Sede"
                  list="mass-credit-sedes"
                  value={manualRow.sede}
                  onChange={(value) => updateManualField("sede", value)}
                />
                <ManualField
                  label="Vendedor"
                  list="mass-credit-vendedores"
                  value={manualRow.vendedor}
                  onChange={(value) => updateManualField("vendedor", value)}
                />
                <ManualField
                  label="Inicial"
                  inputMode="numeric"
                  value={manualRow.inicial}
                  onChange={(value) => updateManualField("inicial", value)}
                />
                <ManualField
                  label="Valor del credito"
                  inputMode="numeric"
                  value={manualRow.valorCredito}
                  onChange={(value) => updateManualField("valorCredito", value)}
                />
                <ManualField
                  label="Cuota"
                  inputMode="numeric"
                  value={manualRow.cuota}
                  onChange={(value) => updateManualField("cuota", value)}
                />
                <ManualField
                  label="Plazo"
                  inputMode="numeric"
                  value={manualRow.plazo}
                  onChange={(value) => updateManualField("plazo", value)}
                />
                <label className="grid gap-1">
                  <span className="text-[10px] font-black uppercase tracking-[0.18em] text-[#687080]">
                    Frecuencia
                  </span>
                  <select
                    value={manualRow.frecuencia}
                    onChange={(event) =>
                      updateManualField("frecuencia", event.target.value)
                    }
                    className="h-11 rounded-2xl border border-[#d8e0e3] bg-[#fbfdfd] px-3 text-sm font-bold text-[#20242a] outline-none focus:border-[#0f766e]"
                  >
                    <option value="CATORCENAL">Catorcenal</option>
                    <option value="MENSUAL">Mensual</option>
                  </select>
                </label>
                <ManualField
                  label="Fecha de pago"
                  type="date"
                  value={manualRow.fechaPago}
                  onChange={(value) => updateManualField("fechaPago", value)}
                />
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {mode === "bulk" ? (
                <button
                  type="button"
                  onClick={() => {
                    setRawText(TEMPLATE_ROWS);
                    setValidation(null);
                    setNotice("Ejemplo cargado en el cuadro de datos");
                  }}
                  className="min-h-11 rounded-2xl border border-[#d8e0e3] bg-white px-5 text-sm font-black text-[#182025]"
                >
                  Ver ejemplo
                </button>
              ) : null}
              <button
                type="button"
                onClick={validate}
                disabled={!activeRows.length || loading !== null}
                className="min-h-11 rounded-2xl border border-[#0f766e] bg-[#0f766e] px-5 text-sm font-black text-white disabled:opacity-50"
              >
                {loading === "validate" ? "Validando" : "Validar"}
              </button>
              <button
                type="button"
                onClick={createCredits}
                disabled={!canCreate || loading !== null}
                className="min-h-11 rounded-2xl border border-[#11161a] bg-[#11161a] px-5 text-sm font-black text-white disabled:opacity-50"
              >
                {loading === "create"
                  ? "Creando"
                  : mode === "single"
                    ? "Crear credito"
                    : "Crear creditos"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (mode === "single") {
                    setManualRow(defaultManualRow());
                  } else {
                    setRawText("");
                  }
                  setValidation(null);
                  setNotice("");
                }}
                className="min-h-11 rounded-2xl border border-[#d8e0e3] bg-white px-5 text-sm font-black text-[#182025]"
              >
                Limpiar
              </button>
            </div>

            <datalist id="mass-credit-aliados">
              {catalog?.aliados?.map((aliado) => (
                <option key={aliado.id} value={aliado.nombre} />
              ))}
            </datalist>
            <datalist id="mass-credit-sedes">
              {catalog?.sedes?.map((sede) => (
                <option key={sede.id} value={sede.nombre} />
              ))}
            </datalist>
            <datalist id="mass-credit-vendedores">
              {catalog?.vendedores?.map((vendedor) => (
                <option key={vendedor.id} value={vendedor.nombre} />
              ))}
            </datalist>
          </div>

          <div className="rounded-[24px] border border-[#d8e0e3] bg-white p-4 shadow-[0_12px_34px_rgba(24,32,37,0.06)]">
            <div className="grid gap-3 sm:grid-cols-4">
              <SummaryBox label="Filas" value={String(validation?.summary.total ?? activeRows.length)} />
              <SummaryBox label="Validas" value={String(validation?.summary.valid ?? 0)} tone="green" />
              <SummaryBox label="Errores" value={String(validation?.summary.invalid ?? 0)} tone="red" />
              <SummaryBox label="Creados" value={String(validation?.summary.created ?? 0)} tone="dark" />
            </div>

            {catalog ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <MiniBox label="Aliados" value={String(catalog.aliados?.length || 0)} />
                <MiniBox label="Sedes" value={String(catalog.sedes?.length || 0)} />
                <MiniBox label="Vendedores" value={String(catalog.vendedores?.length || 0)} />
              </div>
            ) : null}

            {notice ? (
              <div className="mt-4 rounded-2xl border border-[#d8e0e3] bg-[#f8fbfa] px-4 py-3 text-sm font-bold text-[#182025]">
                {notice}
              </div>
            ) : null}

            <div className="mt-4 overflow-hidden rounded-2xl border border-[#d8e0e3]">
              <div className="max-h-[560px] overflow-auto">
                <table className="min-w-[980px] w-full text-left text-xs">
                  <thead className="sticky top-0 bg-[#111318] text-white">
                    <tr>
                      <th className="px-3 py-3 font-black">Fila</th>
                      <th className="px-3 py-3 font-black">Estado</th>
                      <th className="px-3 py-3 font-black">Cliente</th>
                      <th className="px-3 py-3 font-black">Cedula</th>
                      <th className="px-3 py-3 font-black">Sede</th>
                      <th className="px-3 py-3 font-black">Vendedor</th>
                      <th className="px-3 py-3 font-black">Credito</th>
                      <th className="px-3 py-3 font-black">Cuota</th>
                      <th className="px-3 py-3 font-black">Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length ? (
                      visibleRows.map((row) => (
                        <tr key={row.rowNumber} className="border-b border-[#edf1f3] last:border-0">
                          <td className="px-3 py-3 font-black">{row.rowNumber}</td>
                          <td className="px-3 py-3">
                            <span
                              className={[
                                "rounded-full border px-2 py-1 text-[11px] font-black",
                                statusClasses(row.ok),
                              ].join(" ")}
                            >
                              {row.createdFolio || (row.ok ? "OK" : "ERROR")}
                            </span>
                          </td>
                          <td className="px-3 py-3 font-bold text-[#20242a]">
                            {row.normalized.cliente || "-"}
                          </td>
                          <td className="px-3 py-3">{row.normalized.cedula || "-"}</td>
                          <td className="px-3 py-3">{row.normalized.sede || "-"}</td>
                          <td className="px-3 py-3">{row.normalized.vendedor || "-"}</td>
                          <td className="px-3 py-3 font-black">
                            {money(row.normalized.valorCredito)}
                          </td>
                          <td className="px-3 py-3">
                            {money(row.normalized.cuota)} / {row.normalized.plazo}
                          </td>
                          <td className="px-3 py-3">
                            {[...row.errors, ...row.warnings].join(" | ") || "-"}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={9} className="px-4 py-12 text-center text-sm font-semibold text-[#687080]">
                          Sin validacion ejecutada.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function SummaryBox({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "red" | "dark";
}) {
  const toneClass =
    tone === "green"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : tone === "red"
        ? "border-red-200 bg-red-50 text-red-900"
        : tone === "dark"
          ? "border-[#111318] bg-[#111318] text-white"
          : "border-[#d8e0e3] bg-[#f8fbfa] text-[#20242a]";

  return (
    <div className={["rounded-2xl border px-4 py-4", toneClass].join(" ")}>
      <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-70">
        {label}
      </p>
      <p className="mt-2 text-3xl font-black">{value}</p>
    </div>
  );
}

function MiniBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#d8e0e3] bg-white px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#687080]">
        {label}
      </p>
      <p className="mt-1 text-xl font-black text-[#20242a]">{value}</p>
    </div>
  );
}

function ManualField({
  inputMode,
  label,
  list,
  onChange,
  type = "text",
  value,
}: {
  inputMode?: "decimal" | "email" | "none" | "numeric" | "search" | "tel" | "text" | "url";
  label: string;
  list?: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  value: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.18em] text-[#687080]">
        {label}
      </span>
      <input
        type={type}
        inputMode={inputMode}
        list={list}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-2xl border border-[#d8e0e3] bg-[#fbfdfd] px-3 text-sm font-bold text-[#20242a] outline-none focus:border-[#0f766e]"
      />
    </label>
  );
}
