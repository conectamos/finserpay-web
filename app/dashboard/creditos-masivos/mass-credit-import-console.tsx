"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
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

type CatalogSede = NonNullable<CatalogResponse["sedes"]>[number];
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

function normalizeOption(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
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
  const [mode, setMode] = useState<InputMode>("single");
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
  const sedesById = useMemo(() => {
    const map = new Map<number, CatalogSede>();

    for (const sede of catalog?.sedes || []) {
      map.set(sede.id, sede);
    }

    return map;
  }, [catalog?.sedes]);
  const selectedAliado = useMemo(() => {
    const current = normalizeOption(manualRow.aliado);

    if (!current) {
      return null;
    }

    return (
      catalog?.aliados?.find(
        (aliado) =>
          normalizeOption(aliado.nombre) === current ||
          normalizeOption(aliado.codigo) === current
      ) || null
    );
  }, [catalog?.aliados, manualRow.aliado]);
  const availableSedes = useMemo(() => {
    if (!selectedAliado) {
      return [];
    }

    return (catalog?.sedes || []).filter(
      (sede) => sede.aliadoId === selectedAliado.id
    );
  }, [catalog?.sedes, selectedAliado]);
  const selectedSede = useMemo(() => {
    const current = normalizeOption(manualRow.sede);

    if (!current) {
      return null;
    }

    return (
      availableSedes.find((sede) => normalizeOption(sede.nombre) === current) ||
      null
    );
  }, [availableSedes, manualRow.sede]);
  const availableVendedores = useMemo(() => {
    if (!selectedAliado) {
      return [];
    }

    const sedeIds = new Set(
      selectedSede
        ? [selectedSede.id]
        : availableSedes.map((sede) => sede.id)
    );

    return (catalog?.vendedores || []).filter((vendedor) =>
      sedeIds.has(vendedor.sedeId)
    );
  }, [availableSedes, catalog?.vendedores, selectedAliado, selectedSede]);

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

  const selectAliado = (value: string) => {
    setManualRow((current) => ({
      ...current,
      aliado: value,
      sede: "",
      vendedor: "",
    }));
    setValidation(null);
  };

  const selectSede = (value: string) => {
    setManualRow((current) => ({
      ...current,
      sede: value,
      vendedor: "",
    }));
    setValidation(null);
  };

  const selectVendedor = (value: string) => {
    setManualRow((current) => ({
      ...current,
      vendedor: value,
    }));
    setValidation(null);
  };

  const loadCatalog = useCallback(async (showNotice = true) => {
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
      if (showNotice) {
        setNotice("Catalogo actualizado");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Error cargando catalogo");
    } finally {
      setLoading(null);
    }
  }, []);

  useEffect(() => {
    void loadCatalog(false);
  }, [loadCatalog]);

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
    <div className="min-h-screen bg-[#f3f6f7] px-4 py-5 text-[#182025] sm:px-6">
      <main className="mx-auto max-w-[1440px]">
        <header className="border-b border-[#d5dde2] pb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <span className="inline-flex rounded-md border border-[#b9ded9] bg-[#edf8f5] px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-[#0b6d63]">
                Admin FINSER PAY
              </span>
              <h1 className="mt-3 text-3xl font-black tracking-tight text-[#101418] sm:text-4xl">
                Creditos masivos
              </h1>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadCatalog()}
                disabled={loading !== null}
                className="h-10 rounded-lg border border-[#cdd7dd] bg-white px-4 text-sm font-black text-[#182025] transition hover:border-[#9fb2bd] disabled:opacity-50"
              >
                {loading === "catalog" ? "Cargando" : "Catalogo"}
              </button>
              <button
                type="button"
                onClick={downloadTemplate}
                className="h-10 rounded-lg border border-[#cdd7dd] bg-white px-4 text-sm font-black text-[#182025] transition hover:border-[#9fb2bd]"
              >
                Plantilla CSV
              </button>
              <Link
                href="/dashboard"
                className="inline-flex h-10 items-center rounded-lg border border-[#101418] bg-[#101418] px-4 text-sm font-black text-white"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </header>

        <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-hidden rounded-lg border border-[#d5dde2] bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-[#e1e7ea] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="inline-grid grid-cols-2 rounded-lg border border-[#d5dde2] bg-[#f7fafb] p-1">
                <button
                  type="button"
                  onClick={() => switchMode("single")}
                  className={[
                    "h-10 rounded-md px-4 text-sm font-black transition",
                    mode === "single"
                      ? "bg-[#101418] text-white shadow-sm"
                      : "text-[#53616b] hover:text-[#101418]",
                  ].join(" ")}
                >
                  Credito individual
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("bulk")}
                  className={[
                    "h-10 rounded-md px-4 text-sm font-black transition",
                    mode === "bulk"
                      ? "bg-[#101418] text-white shadow-sm"
                      : "text-[#53616b] hover:text-[#101418]",
                  ].join(" ")}
                >
                  Carga CSV
                </button>
              </div>

              {mode === "bulk" ? (
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex h-10 cursor-pointer items-center rounded-lg border border-[#cdd7dd] bg-white px-4 text-sm font-black text-[#182025] transition hover:border-[#9fb2bd]">
                    Subir CSV
                    <input
                      type="file"
                      accept=".csv,.tsv,.txt"
                      onChange={loadFile}
                      className="sr-only"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setRawText(TEMPLATE_ROWS);
                      setValidation(null);
                      setNotice("Ejemplo cargado");
                    }}
                    className="h-10 rounded-lg border border-[#cdd7dd] bg-white px-4 text-sm font-black text-[#182025] transition hover:border-[#9fb2bd]"
                  >
                    Ver ejemplo
                  </button>
                </div>
              ) : null}
            </div>

            {mode === "single" ? (
              <div className="p-5">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
                  <ManualSelect
                    label="Aliado"
                    value={manualRow.aliado}
                    onChange={selectAliado}
                    disabled={!catalog?.aliados?.length || loading === "catalog"}
                    placeholder={
                      loading === "catalog"
                        ? "Cargando aliados..."
                        : "Selecciona aliado"
                    }
                    options={(catalog?.aliados || []).map((aliado) => ({
                      value: aliado.nombre,
                      label: aliado.codigo
                        ? `${aliado.nombre} (${aliado.codigo})`
                        : aliado.nombre,
                    }))}
                  />
                  <ManualSelect
                    label="Sede"
                    value={manualRow.sede}
                    onChange={selectSede}
                    disabled={!selectedAliado || !availableSedes.length}
                    placeholder={
                      selectedAliado
                        ? availableSedes.length
                          ? "Selecciona sede"
                          : "Sin sedes disponibles"
                        : "Selecciona aliado primero"
                    }
                    options={availableSedes.map((sede) => ({
                      value: sede.nombre,
                      label: sede.nombre,
                    }))}
                  />
                  <ManualSelect
                    label="Vendedor"
                    value={manualRow.vendedor}
                    onChange={selectVendedor}
                    disabled={!selectedAliado || !availableVendedores.length}
                    placeholder={
                      selectedAliado
                        ? availableVendedores.length
                          ? "Selecciona vendedor"
                          : "Sin vendedores disponibles"
                        : "Selecciona aliado primero"
                    }
                    options={availableVendedores.map((vendedor) => ({
                      key: `${vendedor.sedeId}-${vendedor.id}`,
                      value: vendedor.nombre,
                      label: selectedSede
                        ? vendedor.nombre
                        : `${vendedor.nombre} - ${
                            sedesById.get(vendedor.sedeId)?.nombre || "Sede"
                          }`,
                    }))}
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
                    <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[#64717b]">
                      Frecuencia
                    </span>
                    <select
                      value={manualRow.frecuencia}
                      onChange={(event) =>
                        updateManualField("frecuencia", event.target.value)
                      }
                      className="h-11 rounded-lg border border-[#cdd7dd] bg-white px-3 text-sm font-bold text-[#182025] outline-none transition focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
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
              </div>
            ) : (
              <div className="p-5">
                <textarea
                  value={rawText}
                  onChange={(event) => {
                    setRawText(event.target.value);
                    setValidation(null);
                  }}
                  placeholder={TEMPLATE_HEADER}
                  spellCheck={false}
                  wrap="off"
                  className="h-[360px] w-full resize-none rounded-lg border border-[#cdd7dd] bg-[#fbfdfd] p-4 font-mono text-xs leading-5 text-[#182025] outline-none transition focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
                />
              </div>
            )}

          </div>

          <aside className="rounded-lg border border-[#d5dde2] bg-white p-5 shadow-sm">
            <div className="grid grid-cols-2 gap-3">
              <SummaryBox
                label="Filas"
                value={String(validation?.summary.total ?? activeRows.length)}
              />
              <SummaryBox
                label="Validas"
                value={String(validation?.summary.valid ?? 0)}
                tone="green"
              />
              <SummaryBox
                label="Errores"
                value={String(validation?.summary.invalid ?? 0)}
                tone="red"
              />
              <SummaryBox
                label="Creados"
                value={String(validation?.summary.created ?? 0)}
                tone="dark"
              />
            </div>

            <div className="mt-5 rounded-lg border border-[#d5dde2] bg-[#f8fbfa] px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#64717b]">
                Monto
              </p>
              <p className="mt-1 text-2xl font-black text-[#101418]">
                {money(totalAmount)}
              </p>
            </div>

            <div className="mt-5 grid gap-2">
              <button
                type="button"
                onClick={validate}
                disabled={!activeRows.length || loading !== null}
                className="h-11 rounded-lg border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-black text-white transition hover:bg-[#115e59] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading === "validate" ? "Validando" : "Validar"}
              </button>
              <button
                type="button"
                onClick={createCredits}
                disabled={!canCreate || loading !== null}
                className="h-11 rounded-lg border border-[#101418] bg-[#101418] px-4 text-sm font-black text-white transition hover:bg-[#242b31] disabled:cursor-not-allowed disabled:opacity-50"
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
                className="h-11 rounded-lg border border-[#cdd7dd] bg-white px-4 text-sm font-black text-[#182025] transition hover:border-[#9fb2bd]"
              >
                Limpiar
              </button>
            </div>

            {catalog ? (
              <div className="mt-5 grid grid-cols-3 gap-2">
                <MiniBox label="Aliados" value={String(catalog.aliados?.length || 0)} />
                <MiniBox label="Sedes" value={String(catalog.sedes?.length || 0)} />
                <MiniBox label="Vendedores" value={String(catalog.vendedores?.length || 0)} />
              </div>
            ) : null}

            {notice ? (
              <div className="mt-5 rounded-lg border border-[#d5dde2] bg-white px-4 py-3 text-sm font-bold text-[#182025]">
                {notice}
              </div>
            ) : null}
          </aside>
        </section>

        <section className="mt-5 overflow-hidden rounded-lg border border-[#d5dde2] bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-[#e1e7ea] px-5 py-4">
            <h2 className="text-sm font-black uppercase tracking-[0.16em] text-[#101418]">
              Validacion
            </h2>
            <span className="text-sm font-bold text-[#64717b]">
              {visibleRows.length} resultados
            </span>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="min-w-[1040px] w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#101418] text-white">
                <tr>
                  <th className="px-4 py-3 font-black">Fila</th>
                  <th className="px-4 py-3 font-black">Estado</th>
                  <th className="px-4 py-3 font-black">Cliente</th>
                  <th className="px-4 py-3 font-black">Cedula</th>
                  <th className="px-4 py-3 font-black">Sede</th>
                  <th className="px-4 py-3 font-black">Vendedor</th>
                  <th className="px-4 py-3 font-black">Credito</th>
                  <th className="px-4 py-3 font-black">Cuota</th>
                  <th className="px-4 py-3 font-black">Notas</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length ? (
                  visibleRows.map((row) => (
                    <tr
                      key={row.rowNumber}
                      className="border-b border-[#edf1f3] last:border-0"
                    >
                      <td className="px-4 py-3 font-black">{row.rowNumber}</td>
                      <td className="px-4 py-3">
                        <span
                          className={[
                            "rounded-md border px-2 py-1 text-[11px] font-black",
                            statusClasses(row.ok),
                          ].join(" ")}
                        >
                          {row.createdFolio || (row.ok ? "OK" : "ERROR")}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-bold text-[#20242a]">
                        {row.normalized.cliente || "-"}
                      </td>
                      <td className="px-4 py-3">{row.normalized.cedula || "-"}</td>
                      <td className="px-4 py-3">{row.normalized.sede || "-"}</td>
                      <td className="px-4 py-3">{row.normalized.vendedor || "-"}</td>
                      <td className="px-4 py-3 font-black">
                        {money(row.normalized.valorCredito)}
                      </td>
                      <td className="px-4 py-3">
                        {money(row.normalized.cuota)} / {row.normalized.plazo}
                      </td>
                      <td className="px-4 py-3">
                        {[...row.errors, ...row.warnings].join(" | ") || "-"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-12 text-center text-sm font-semibold text-[#687080]"
                    >
                      Sin validacion.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
    <div className={["rounded-lg border px-3 py-3", toneClass].join(" ")}>
      <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-70">
        {label}
      </p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}

function MiniBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#d8e0e3] bg-white px-3 py-3">
      <p className="text-[9px] font-black uppercase tracking-[0.12em] text-[#687080]">
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
  inputMode?:
    | "decimal"
    | "email"
    | "none"
    | "numeric"
    | "search"
    | "tel"
    | "text"
    | "url";
  label: string;
  list?: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  value: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[#64717b]">
        {label}
      </span>
      <input
        type={type}
        inputMode={inputMode}
        list={list}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-lg border border-[#cdd7dd] bg-white px-3 text-sm font-bold text-[#182025] outline-none transition focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
      />
    </label>
  );
}

function ManualSelect({
  disabled = false,
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: Array<{ key?: string; label: string; value: string }>;
  placeholder: string;
  value: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[#64717b]">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="h-11 rounded-lg border border-[#cdd7dd] bg-white px-3 text-sm font-bold text-[#182025] outline-none transition focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10 disabled:cursor-not-allowed disabled:bg-[#eef3f6] disabled:text-[#8a969e]"
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.key || option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
