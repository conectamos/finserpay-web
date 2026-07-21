"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
  type DragEvent,
  type HTMLInputTypeAttribute,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Building2,
  Check,
  ChevronDown,
  CircleCheck,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Store,
  Trash2,
  UploadCloud,
  UserRound,
  UsersRound,
  WalletCards,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Tabs,
} from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";

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
type PreviewFilter = "all" | "errors" | "valid";
type AssignmentDefaults = Pick<MassCreditInputRow, "aliado" | "sede" | "vendedor">;
type LoadedFile = { name: string; selectedAt: Date; size: number };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 250;

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
  fecha: "fecha",
  fechadepago: "fechaPago",
  fechapago: "fechaPago",
  frecuencia: "frecuencia",
  imei: "imei",
  inicial: "inicial",
  plazo: "plazo",
  referencia: "referencia",
  sede: "sede",
  tel: "telefono",
  telefono: "telefono",
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
    if (field === "fecha" || field === "frecuencia" || field === "inicial") return false;
    return String(row[field] || "").trim();
  });
}

function parseRows(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

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
        if (field) row[field] = cells[index] || "";
      });

      return row;
    })
    .filter((row) => FIELD_ORDER.some((field) => String(row[field] || "").trim()));
}

function money(value: number) {
  return `$ ${Math.round(Number(value || 0)).toLocaleString("es-CO")}`;
}

function inputMoney(value: unknown) {
  const normalized = String(value || "").replace(/[^\d]/g, "");
  return Number(normalized || 0);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function postRows(rows: MassCreditInputRow[], commit: boolean) {
  const response = await fetch("/api/creditos/masivos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commit, rows }),
  });
  const data = (await response.json().catch(() => null)) as ValidationResponse | null;

  if (!response.ok || !data) {
    throw new Error(data?.error || "No se pudo procesar la carga");
  }

  return data;
}

export default function MassCreditImportConsole() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<InputMode>("bulk");
  const [rawText, setRawText] = useState(TEMPLATE_HEADER);
  const [fileInfo, setFileInfo] = useState<LoadedFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [bulkDefaults, setBulkDefaults] = useState<AssignmentDefaults>({
    aliado: "",
    sede: "",
    vendedor: "",
  });
  const [manualRow, setManualRow] = useState<MassCreditInputRow>(defaultManualRow());
  const [validations, setValidations] = useState<Record<InputMode, ValidationResponse | null>>({
    bulk: null,
    single: null,
  });
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState<"catalog" | "create" | "file" | "validate" | null>(null);
  const [notice, setNotice] = useState("");
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("all");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const parsedRows = useMemo(() => parseRows(rawText), [rawText]);
  const bulkRows = useMemo(
    () =>
      parsedRows.map((row) => ({
        ...row,
        aliado: row.aliado || bulkDefaults.aliado,
        sede: row.sede || bulkDefaults.sede,
        vendedor: row.vendedor || bulkDefaults.vendedor,
      })),
    [bulkDefaults, parsedRows]
  );
  const activeRows = mode === "single" ? (hasManualCreditData(manualRow) ? [manualRow] : []) : bulkRows;
  const validation = validations[mode];
  const totalAmount = activeRows.reduce((sum, row) => sum + inputMoney(row.valorCredito), 0);
  const assignmentValues = mode === "bulk" ? bulkDefaults : manualRow;

  const setModeValidation = (target: InputMode, value: ValidationResponse | null) => {
    setValidations((current) => ({ ...current, [target]: value }));
  };

  const sedesById = useMemo(() => {
    const map = new Map<number, CatalogSede>();
    for (const sede of catalog?.sedes || []) map.set(sede.id, sede);
    return map;
  }, [catalog?.sedes]);

  const selectedAliado = useMemo(() => {
    const current = normalizeOption(assignmentValues.aliado);
    if (!current) return null;
    return (
      catalog?.aliados?.find(
        (aliado) =>
          normalizeOption(aliado.nombre) === current || normalizeOption(aliado.codigo) === current
      ) || null
    );
  }, [assignmentValues.aliado, catalog?.aliados]);

  const availableSedes = useMemo(() => {
    if (!selectedAliado) return [];
    return (catalog?.sedes || []).filter((sede) => sede.aliadoId === selectedAliado.id);
  }, [catalog?.sedes, selectedAliado]);

  const selectedSede = useMemo(() => {
    const current = normalizeOption(assignmentValues.sede);
    if (!current) return null;
    return availableSedes.find((sede) => normalizeOption(sede.nombre) === current) || null;
  }, [assignmentValues.sede, availableSedes]);

  const availableVendedores = useMemo(() => {
    if (!selectedAliado) return [];
    const sedeIds = new Set(
      selectedSede ? [selectedSede.id] : availableSedes.map((sede) => sede.id)
    );
    return (catalog?.vendedores || []).filter((vendedor) => sedeIds.has(vendedor.sedeId));
  }, [availableSedes, catalog?.vendedores, selectedAliado, selectedSede]);

  const canCreate =
    Boolean(validation) &&
    validation?.summary.invalid === 0 &&
    validation?.summary.total === activeRows.length &&
    activeRows.length > 0 &&
    !validation?.commit;

  const bulkStage = validation?.commit
    ? 4
    : validation?.summary.invalid
      ? 3
      : validation?.summary.valid
        ? 4
        : parsedRows.length
          ? 2
          : 1;

  const visibleRows = useMemo(() => {
    const rows = validation?.rows || [];
    if (previewFilter === "valid") return rows.filter((row) => row.ok);
    if (previewFilter === "errors") return rows.filter((row) => !row.ok);
    return rows;
  }, [previewFilter, validation?.rows]);

  const involvedAllies = new Set(activeRows.map((row) => normalizeOption(row.aliado)).filter(Boolean)).size;
  const involvedStores = new Set(activeRows.map((row) => normalizeOption(row.sede)).filter(Boolean)).size;

  const validationDisabledReason = !activeRows.length
    ? mode === "bulk"
      ? "Carga un archivo CSV para continuar."
      : "Completa los datos del credito para continuar."
    : mode === "bulk" && activeRows.length > MAX_IMPORT_ROWS
      ? `El lote supera el limite de ${MAX_IMPORT_ROWS} registros.`
      : loading
        ? "Hay un proceso en curso."
        : "";

  const createDisabledReason = validation?.commit
    ? "Este lote ya fue creado."
    : !validation
      ? "Primero valida la informacion."
      : validation.summary.invalid > 0
        ? "Corrige los errores y valida nuevamente."
        : !validation.summary.valid
          ? "No hay filas validas para crear."
          : "";

  const loadCatalog = useCallback(async (showNotice = true) => {
    try {
      setLoading("catalog");
      const response = await fetch("/api/creditos/masivos", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as CatalogResponse & { error?: string };

      if (!response.ok) throw new Error(data?.error || "No se pudo cargar el catalogo");
      setCatalog(data);
      if (showNotice) setNotice("Catalogo actualizado.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Error cargando catalogo");
    } finally {
      setLoading(null);
    }
  }, []);

  useEffect(() => {
    void loadCatalog(false);
  }, [loadCatalog]);

  const switchMode = (nextMode: InputMode) => {
    if (loading || nextMode === mode) return;
    setMode(nextMode);
    setPreviewFilter("all");
    setNotice("");
  };

  const updateManualField = (field: FieldKey, value: string) => {
    setManualRow((current) => ({ ...current, [field]: value }));
    setModeValidation("single", null);
  };

  const updateAssignment = (field: keyof AssignmentDefaults, value: string) => {
    const patch: Partial<AssignmentDefaults> = { [field]: value };
    if (field === "aliado") {
      patch.sede = "";
      patch.vendedor = "";
    } else if (field === "sede") {
      patch.vendedor = "";
    }

    if (mode === "bulk") {
      setBulkDefaults((current) => ({ ...current, ...patch }));
      setModeValidation("bulk", null);
    } else {
      setManualRow((current) => ({ ...current, ...patch }));
      setModeValidation("single", null);
    }
  };

  const processFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setNotice("El archivo debe estar en formato CSV.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setNotice("El archivo supera el limite de 5 MB.");
      return;
    }

    try {
      setLoading("file");
      setNotice("");
      const text = await file.text();
      const rows = parseRows(text);

      if (!rows.length) throw new Error("El archivo no contiene registros para validar.");
      if (rows.length > MAX_IMPORT_ROWS) {
        throw new Error(`Solo puedes cargar hasta ${MAX_IMPORT_ROWS} creditos por lote.`);
      }

      setRawText(text);
      setFileInfo({ name: file.name, selectedAt: new Date(), size: file.size });
      setModeValidation("bulk", null);
      setMode("bulk");
      setPreviewFilter("all");
      setNotice(`${file.name} cargado correctamente.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo leer el archivo.");
    } finally {
      setLoading(null);
    }
  };

  const loadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void processFile(file);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && !loading) void processFile(file);
  };

  const loadExample = () => {
    setRawText(TEMPLATE_ROWS);
    setFileInfo({ name: "ejemplo-creditos-masivos.csv", selectedAt: new Date(), size: TEMPLATE_ROWS.length });
    setModeValidation("bulk", null);
    setNotice("Ejemplo cargado. Reemplaza sus datos antes de crear creditos.");
  };

  const removeBulkFile = () => {
    setRawText(TEMPLATE_HEADER);
    setFileInfo(null);
    setModeValidation("bulk", null);
    setNotice("");
    setPreviewFilter("all");
  };

  const validate = async () => {
    if (validationDisabledReason) return;
    try {
      setLoading("validate");
      setNotice("");
      const data = await postRows(activeRows, false);
      setModeValidation(mode, data);
      setPreviewFilter(data.summary.invalid ? "errors" : "all");
      setNotice(
        data.summary.invalid
          ? `${data.summary.invalid} fila(s) requieren correccion.`
          : `${data.summary.valid} fila(s) listas para crear.`
      );
    } catch (error) {
      setModeValidation(mode, null);
      setNotice(error instanceof Error ? error.message : "No se pudo validar");
    } finally {
      setLoading(null);
    }
  };

  const createCredits = async () => {
    if (!canCreate) return;
    try {
      setLoading("create");
      setNotice("");
      const data = await postRows(activeRows, true);
      setModeValidation(mode, data);
      setNotice(`Lote ${data.batchId || ""}: ${data.created || 0} credito(s) creados.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo crear");
    } finally {
      setLoading(null);
      setConfirmOpen(false);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "plantilla-creditos-masivos.csv";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Plantilla descargada: plantilla-creditos-masivos.csv");
  };

  const downloadResult = () => {
    if (!validation?.rows.length) return;
    const header = ["FILA", "ESTADO", "FOLIO", "CLIENTE", "CEDULA", "SEDE", "VENDEDOR", "CREDITO", "CUOTA", "NOTAS"];
    const rows = validation.rows.map((row) => [
      row.rowNumber,
      row.createdFolio ? "CREADO" : row.ok ? "VALIDO" : "ERROR",
      row.createdFolio || "",
      row.normalized.cliente,
      row.normalized.cedula,
      row.normalized.sede,
      row.normalized.vendedor,
      row.normalized.valorCredito,
      row.normalized.cuota,
      [...row.errors, ...row.warnings].join(" | "),
    ]);
    const content = [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\n");
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `resultado-creditos-${validation.batchId || "validacion"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearCurrentMode = () => {
    if (mode === "bulk") {
      removeBulkFile();
      setBulkDefaults({ aliado: "", sede: "", vendedor: "" });
    } else {
      setManualRow(defaultManualRow());
      setModeValidation("single", null);
      setNotice("");
    }
  };

  const noticeDanger = /error|no se pudo|debe|supera|solo puedes|corrige/i.test(notice);

  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <PageHeader
        eyebrow="Creacion de creditos"
        title="Creditos masivos"
        description="Carga, valida y crea multiples creditos en un solo proceso."
        actions={
          <>
            <Button variant="secondary" onClick={() => void loadCatalog()} disabled={loading !== null}>
              <RefreshCw className={loading === "catalog" ? "h-4 w-4 animate-spin" : "h-4 w-4"} strokeWidth={1.8} />
              {loading === "catalog" ? "Actualizando" : "Catalogo"}
            </Button>
            <Button variant="secondary" onClick={downloadTemplate}>
              <Download className="h-4 w-4" strokeWidth={1.8} />
              Descargar plantilla CSV
            </Button>
          </>
        }
      />

      <Tabs className="mt-4" aria-label="Modo de creacion">
        <button type="button" role="tab" aria-selected={mode === "bulk"} onClick={() => switchMode("bulk")}>
          Carga CSV
        </button>
        <button type="button" role="tab" aria-selected={mode === "single"} onClick={() => switchMode("single")}>
          Credito individual
        </button>
      </Tabs>

      {mode === "bulk" ? <BulkStepper stage={bulkStage} committed={Boolean(validation?.commit)} /> : null}

      <section className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
        <Card className="!rounded-lg !p-0">
          {mode === "bulk" ? (
            <>
              <div className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-black text-[#151a21]">Carga de archivo</h2>
                    <p className="mt-1 text-sm text-[#667085]">Importa la informacion con la plantilla oficial.</p>
                  </div>
                  <button type="button" onClick={loadExample} className="text-sm font-bold text-[#526f0e] underline underline-offset-4">
                    Ver ejemplo
                  </button>
                </div>

                <div
                  className={[
                    "mt-5 grid min-h-56 place-items-center border border-dashed px-5 py-8 text-center transition",
                    dragging ? "border-[#8caf27] bg-[#f7fbe9]" : "border-[#cfd6de] bg-[#fbfcfd]",
                  ].join(" ")}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  {fileInfo ? (
                    <div className="w-full max-w-xl">
                      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eef7da] text-[#6f9417]">
                        <FileSpreadsheet className="h-7 w-7" strokeWidth={1.7} />
                      </span>
                      <h3 className="mt-4 break-all text-base font-black text-[#151a21]">{fileInfo.name}</h3>
                      <p className="mt-1 text-sm text-[#667085]">
                        {formatBytes(fileInfo.size)} · {parsedRows.length} registro(s) · seleccionado a las {fileInfo.selectedAt.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                      </p>
                      <div className="mt-5 flex flex-wrap justify-center gap-2">
                        <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={Boolean(loading)}>
                          <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
                          Reemplazar
                        </Button>
                        <Button variant="ghost" onClick={removeBulkFile} disabled={Boolean(loading)}>
                          <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                          Retirar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <UploadCloud className="mx-auto h-12 w-12 text-[#344054]" strokeWidth={1.45} />
                      <h3 className="mt-3 text-base font-black text-[#151a21]">Arrastra tu archivo CSV aqui</h3>
                      <p className="mt-1 text-sm text-[#667085]">o selecciona un archivo desde tu equipo</p>
                      <Button className="mt-5" onClick={() => fileInputRef.current?.click()} disabled={Boolean(loading)}>
                        {loading === "file" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" strokeWidth={1.8} />}
                        Seleccionar archivo
                      </Button>
                    </div>
                  )}
                  <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={loadFile} className="sr-only" />
                </div>
                <p className="mt-3 text-center text-xs font-semibold text-[#667085]">
                  Formato CSV · Maximo 5 MB · Hasta {MAX_IMPORT_ROWS} registros
                </p>
              </div>

              <div className="border-t border-[#e4e7ec] p-5 sm:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-black text-[#151a21]">Configuracion predeterminada</h3>
                  <span title="Solo se aplica cuando la fila no incluye el dato.">
                    <Info className="h-4 w-4 text-[#98a2b3]" strokeWidth={1.8} />
                  </span>
                  <p className="text-xs text-[#667085]">Se aplica solo a columnas vacias.</p>
                </div>
                <AssignmentFields
                  className="mt-4"
                  values={bulkDefaults}
                  catalog={catalog}
                  loading={loading}
                  selectedAliado={selectedAliado}
                  selectedSede={selectedSede}
                  availableSedes={availableSedes}
                  availableVendedores={availableVendedores}
                  sedesById={sedesById}
                  onChange={updateAssignment}
                />
                {!selectedAliado ? (
                  <p className="mt-3 text-xs text-[#667085]">Selecciona primero un aliado para habilitar sede y vendedor.</p>
                ) : null}
                <details className="group mt-5 border-t border-[#e4e7ec] pt-4">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold text-[#344054] [&::-webkit-details-marker]:hidden">
                    <ChevronDown className="h-4 w-4 transition group-open:rotate-180" strokeWidth={1.8} />
                    Ver campos requeridos y contenido del CSV
                  </summary>
                  <p className="mt-3 text-xs leading-5 text-[#667085]">{FIELD_ORDER.map((field) => FIELD_LABELS[field]).join(" · ")}</p>
                  <textarea
                    value={rawText}
                    onChange={(event) => {
                      setRawText(event.target.value);
                      setModeValidation("bulk", null);
                    }}
                    spellCheck={false}
                    wrap="off"
                    aria-label="Contenido editable del archivo CSV"
                    className="mt-4 h-56 w-full resize-y rounded-md border border-[#d8dee5] bg-[#fbfcfd] p-3 font-mono text-xs leading-5 text-[#344054] outline-none focus:border-[#8caf27] focus:ring-2 focus:ring-[#b7e63d]/20"
                  />
                </details>
              </div>
            </>
          ) : (
            <div className="p-5 sm:p-6">
              <div>
                <h2 className="text-lg font-black text-[#151a21]">Credito individual</h2>
                <p className="mt-1 text-sm text-[#667085]">Registra un credito con las mismas validaciones del lote masivo.</p>
              </div>

              <FormSection icon={UsersRound} title="Cliente" description="Identificacion y datos de contacto.">
                <ManualField label="Fecha" type="date" value={manualRow.fecha} onChange={(value) => updateManualField("fecha", value)} />
                <ManualField label="Cedula" inputMode="numeric" value={manualRow.cedula} onChange={(value) => updateManualField("cedula", value)} />
                <ManualField label="Cliente" value={manualRow.cliente} onChange={(value) => updateManualField("cliente", value)} />
                <ManualField label="Telefono" inputMode="tel" value={manualRow.telefono} onChange={(value) => updateManualField("telefono", value)} />
              </FormSection>

              <FormSection icon={Smartphone} title="Equipo" description="Referencia e identificador unico.">
                <ManualField label="Referencia" value={manualRow.referencia} onChange={(value) => updateManualField("referencia", value)} />
                <ManualField label="IMEI" inputMode="numeric" value={manualRow.imei} onChange={(value) => updateManualField("imei", value)} />
              </FormSection>

              <FormSection icon={Store} title="Asignacion comercial" description="Aliado, sede y vendedor responsables.">
                <AssignmentFields
                  className="md:col-span-2 xl:col-span-3"
                  values={manualRow}
                  catalog={catalog}
                  loading={loading}
                  selectedAliado={selectedAliado}
                  selectedSede={selectedSede}
                  availableSedes={availableSedes}
                  availableVendedores={availableVendedores}
                  sedesById={sedesById}
                  onChange={updateAssignment}
                />
              </FormSection>

              <FormSection icon={WalletCards} title="Condiciones del credito" description="Valores y calendario de recaudo.">
                <ManualField label="Inicial" inputMode="numeric" value={manualRow.inicial} onChange={(value) => updateManualField("inicial", value)} />
                <ManualField label="Valor del credito" inputMode="numeric" value={manualRow.valorCredito} onChange={(value) => updateManualField("valorCredito", value)} />
                <ManualField label="Cuota" inputMode="numeric" value={manualRow.cuota} onChange={(value) => updateManualField("cuota", value)} />
                <ManualField label="Plazo" inputMode="numeric" value={manualRow.plazo} onChange={(value) => updateManualField("plazo", value)} />
                <label className="grid gap-1.5">
                  <span className="text-xs font-bold text-[#475467]">Frecuencia</span>
                  <Select value={manualRow.frecuencia} onChange={(event) => updateManualField("frecuencia", event.target.value)}>
                    <option value="CATORCENAL">Catorcenal</option>
                    <option value="MENSUAL">Mensual</option>
                  </Select>
                </label>
                <ManualField label="Fecha de pago" type="date" value={manualRow.fechaPago} onChange={(value) => updateManualField("fechaPago", value)} />
              </FormSection>
            </div>
          )}
        </Card>

        <Card className="!rounded-lg !p-5 xl:sticky xl:top-4">
          <h2 className="text-base font-black text-[#151a21]">Resumen de carga</h2>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <SummaryBox label="Filas" value={String(validation?.summary.total ?? activeRows.length)} />
            <SummaryBox label="Validas" value={String(validation?.summary.valid ?? 0)} tone="green" />
            <SummaryBox label="Con errores" value={String(validation?.summary.invalid ?? 0)} tone="red" />
            <SummaryBox label="Creadas" value={String(validation?.summary.created ?? 0)} />
          </div>
          <div className="mt-3 border border-[#d8dee5] bg-[#f8fafb] px-4 py-3">
            <p className="text-xs font-bold text-[#667085]">Monto total</p>
            <p className="mt-1 text-2xl font-black text-[#151a21]">{money(totalAmount)}</p>
          </div>

          <div className="mt-4 grid gap-2">
            <Button onClick={() => void validate()} disabled={Boolean(validationDisabledReason)} title={validationDisabledReason || undefined}>
              {loading === "validate" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" strokeWidth={1.8} />}
              {loading === "validate" ? "Validando" : mode === "bulk" ? "Validar archivo" : "Validar credito"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(true)}
              disabled={!canCreate || loading !== null}
              title={createDisabledReason || undefined}
            >
              {loading === "create" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" strokeWidth={1.8} />}
              {loading === "create" ? "Creando" : mode === "bulk" ? "Crear creditos" : "Crear credito"}
            </Button>
            <Button variant="ghost" onClick={clearCurrentMode} disabled={Boolean(loading)}>
              <Trash2 className="h-4 w-4" strokeWidth={1.8} />
              Limpiar
            </Button>
            {validation?.rows.length ? (
              <Button variant="ghost" onClick={downloadResult}>
                <Download className="h-4 w-4" strokeWidth={1.8} />
                Descargar resultado
              </Button>
            ) : null}
          </div>

          {validationDisabledReason || createDisabledReason ? (
            <p className="mt-3 text-center text-xs text-[#667085]">{validationDisabledReason || createDisabledReason}</p>
          ) : null}

          <div className="mt-5 grid grid-cols-3 border-t border-[#e4e7ec] pt-4 text-center">
            <CatalogMetric icon={Building2} label="aliados" value={catalog?.aliados?.length || 0} />
            <CatalogMetric icon={Store} label="sedes" value={catalog?.sedes?.length || 0} />
            <CatalogMetric icon={UserRound} label="vendedores" value={catalog?.vendedores?.length || 0} />
          </div>

          {notice ? (
            <div className={[
              "mt-4 flex items-start gap-2 border px-3 py-3 text-sm font-semibold",
              noticeDanger ? "border-[#f3b7b2] bg-[#fff1f0] text-[#b42318]" : "border-[#c9df91] bg-[#f5fae9] text-[#4f6f0c]",
            ].join(" ")} role="status" aria-live="polite">
              {noticeDanger ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{notice}</span>
            </div>
          ) : null}
        </Card>
      </section>

      <Card className="mt-4 !overflow-hidden !rounded-lg !p-0">
        <div className="flex flex-col gap-3 border-b border-[#e4e7ec] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-[#151a21]">Vista previa y validacion</h2>
              <Badge>{validation?.summary.total || 0} registros</Badge>
            </div>
            <p className="mt-1 text-sm text-[#667085]">La API conserva las reglas vigentes de validacion y duplicidad.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(["all", "valid", "errors"] as PreviewFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setPreviewFilter(filter)}
                aria-pressed={previewFilter === filter}
                className={[
                  "min-h-10 rounded-md border px-3 text-xs font-bold transition",
                  previewFilter === filter
                    ? "border-[#151a21] bg-[#151a21] text-white"
                    : filter === "errors"
                      ? "border-[#f3b7b2] bg-white text-[#b42318]"
                      : filter === "valid"
                        ? "border-[#c9df91] bg-white text-[#4f6f0c]"
                        : "border-[#d8dee5] bg-white text-[#475467]",
                ].join(" ")}
              >
                {filter === "all" ? "Todos" : filter === "valid" ? "Validos" : "Con errores"}
              </button>
            ))}
            <Button onClick={() => setConfirmOpen(true)} disabled={!canCreate || loading !== null} title={createDisabledReason || undefined}>
              Crear {validation?.summary.valid || 0} credito(s)
            </Button>
          </div>
        </div>

        {validation?.rows.length ? (
          <DataTable className="!rounded-none !border-0">
            <table className="min-w-[1120px] w-full text-left text-xs">
              <thead className="bg-[#f5f7f8] text-[#475467]">
                <tr>
                  {['Fila', 'Estado', 'Cliente', 'Cedula', 'Sede', 'Vendedor', 'Credito', 'Cuota', 'Notas'].map((label) => (
                    <th key={label} className="border-b border-[#d8dee5] px-4 py-3 font-black">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const warning = row.ok && row.warnings.length > 0;
                  return (
                    <tr key={row.rowNumber} className={row.ok ? (warning ? "bg-[#fffbeb]" : "bg-white") : "bg-[#fff7f6]"}>
                      <td className="border-b border-[#e4e7ec] px-4 py-3 font-black">{row.rowNumber}</td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3">
                        <Badge tone={row.ok ? (warning ? "warning" : "positive") : "danger"}>
                          {row.createdFolio || (row.ok ? (warning ? "Advertencia" : "Valido") : "Error")}
                        </Badge>
                      </td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3 font-bold text-[#151a21]">{row.normalized.cliente || "-"}</td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3">{row.normalized.cedula || "-"}</td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3">{row.normalized.sede || "-"}</td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3">{row.normalized.vendedor || "-"}</td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3 font-black">{money(row.normalized.valorCredito)}</td>
                      <td className="border-b border-[#e4e7ec] px-4 py-3">{money(row.normalized.cuota)} · {row.normalized.plazo} pagos</td>
                      <td className="max-w-sm border-b border-[#e4e7ec] px-4 py-3 leading-5 text-[#475467]">{[...row.errors, ...row.warnings].join(" | ") || "Sin novedades"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTable>
        ) : (
          <EmptyState
            className="!min-h-56 !rounded-none !border-0"
            title="Aun no hay registros"
            description={mode === "bulk" ? "Carga un archivo CSV para revisar y validar la informacion." : "Completa y valida el credito individual para ver el resultado."}
            action={<FileCheck2 className="h-9 w-9 text-[#98a2b3]" strokeWidth={1.5} />}
          />
        )}
      </Card>

      <div className="mt-4 flex items-center gap-2 border border-[#cfd9e3] bg-[#f6f9fc] px-4 py-3 text-sm text-[#475467]">
        <Info className="h-4 w-4 shrink-0 text-[#4f6f0c]" strokeWidth={1.8} />
        <span>Corrige el CSV y vuelve a cargarlo cuando existan errores. La creacion se habilita solo tras una validacion completa.</span>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Confirmar creacion de creditos"
        description={`Se crearan ${validation?.summary.valid || activeRows.length} credito(s) por ${money(totalAmount)}, distribuidos en ${involvedAllies} aliado(s) y ${involvedStores} sede(s). Esta es una operacion financiera y no debe repetirse.`}
        confirmLabel="Crear creditos"
        busy={loading === "create"}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void createCredits()}
      />
    </main>
  );
}

function BulkStepper({ stage, committed }: { stage: number; committed: boolean }) {
  const steps = [
    ["Cargar archivo", "Sube tu archivo CSV"],
    ["Validar informacion", "Revisamos los datos"],
    ["Corregir errores", "Ajusta los datos invalidos"],
    ["Crear creditos", "Genera los creditos validos"],
  ];

  return (
    <ol className="mt-4 grid gap-2 md:grid-cols-4" aria-label="Progreso de la carga">
      {steps.map(([title, description], index) => {
        const number = index + 1;
        const complete = committed || number < stage;
        const active = !committed && number === stage;
        return (
          <li key={title} className="relative flex min-h-16 items-center gap-3 border-b border-[#d8dee5] px-2 py-2">
            <span className={[
              "grid h-9 w-9 shrink-0 place-items-center rounded-full border text-sm font-black",
              complete
                ? "border-[#8caf27] bg-[#8caf27] text-white"
                : active
                  ? "border-[#b7e63d] bg-[#151a21] text-white shadow-[0_0_0_3px_rgba(183,230,61,0.18)]"
                  : "border-[#d8dee5] bg-[#eef1f4] text-[#667085]",
            ].join(" ")}>
              {complete ? <Check className="h-4 w-4" strokeWidth={2.2} /> : number}
            </span>
            <span className="min-w-0">
              <strong className="block text-sm text-[#151a21]">{title}</strong>
              <small className="mt-0.5 block text-xs text-[#667085]">{description}</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function FormSection({
  children,
  description,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  description: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
}) {
  return (
    <section className="mt-6 border-t border-[#e4e7ec] pt-5">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#eef7da] text-[#5f7f12]">
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <span>
          <h3 className="text-sm font-black text-[#151a21]">{title}</h3>
          <p className="mt-0.5 text-xs text-[#667085]">{description}</p>
        </span>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

function AssignmentFields({
  availableSedes,
  availableVendedores,
  catalog,
  className,
  loading,
  onChange,
  sedesById,
  selectedAliado,
  selectedSede,
  values,
}: {
  availableSedes: NonNullable<CatalogResponse["sedes"]>;
  availableVendedores: NonNullable<CatalogResponse["vendedores"]>;
  catalog: CatalogResponse | null;
  className?: string;
  loading: "catalog" | "create" | "file" | "validate" | null;
  onChange: (field: keyof AssignmentDefaults, value: string) => void;
  sedesById: Map<number, CatalogSede>;
  selectedAliado: NonNullable<CatalogResponse["aliados"]>[number] | null;
  selectedSede: CatalogSede | null;
  values: AssignmentDefaults;
}) {
  return (
    <div className={["grid gap-4 md:grid-cols-3", className].filter(Boolean).join(" ")}>
      <ManualSelect
        label="Aliado"
        value={values.aliado}
        onChange={(value) => onChange("aliado", value)}
        disabled={!catalog?.aliados?.length || loading === "catalog"}
        placeholder={loading === "catalog" ? "Cargando aliados..." : "Selecciona un aliado"}
        options={(catalog?.aliados || []).map((aliado) => ({
          value: aliado.nombre,
          label: aliado.codigo ? `${aliado.nombre} (${aliado.codigo})` : aliado.nombre,
        }))}
      />
      <ManualSelect
        label="Sede"
        value={values.sede}
        onChange={(value) => onChange("sede", value)}
        disabled={!selectedAliado || !availableSedes.length}
        placeholder={
          selectedAliado
            ? availableSedes.length
              ? "Selecciona una sede"
              : "Sin sedes disponibles"
            : "Primero selecciona aliado"
        }
        options={availableSedes.map((sede) => ({ value: sede.nombre, label: sede.nombre }))}
      />
      <ManualSelect
        label="Vendedor"
        value={values.vendedor}
        onChange={(value) => onChange("vendedor", value)}
        disabled={!selectedSede || !availableVendedores.length}
        placeholder={
          !selectedAliado
            ? "Primero selecciona aliado"
            : !selectedSede
              ? "Primero selecciona sede"
              : availableVendedores.length
                ? "Selecciona un vendedor"
                : "Sin vendedores disponibles"
        }
        options={availableVendedores.map((vendedor) => ({
          key: `${vendedor.sedeId}-${vendedor.id}`,
          value: vendedor.nombre,
          label: selectedSede
            ? vendedor.nombre
            : `${vendedor.nombre} - ${sedesById.get(vendedor.sedeId)?.nombre || "Sede"}`,
        }))}
      />
    </div>
  );
}

function SummaryBox({ label, tone = "default", value }: { label: string; tone?: "default" | "green" | "red"; value: string }) {
  const toneClass =
    tone === "green"
      ? "border-[#c9df91] bg-[#f5fae9] text-[#4f6f0c]"
      : tone === "red"
        ? "border-[#f3b7b2] bg-[#fff1f0] text-[#b42318]"
        : "border-[#d8dee5] bg-[#f8fafb] text-[#151a21]";
  return (
    <div className={["border px-3 py-3", toneClass].join(" ")}>
      <p className="text-xs font-bold opacity-75">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  );
}

function CatalogMetric({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string; strokeWidth?: number }>; label: string; value: number }) {
  return (
    <div className="border-r border-[#e4e7ec] px-2 last:border-0">
      <Icon className="mx-auto h-4 w-4 text-[#667085]" strokeWidth={1.7} />
      <strong className="mt-1 block text-base text-[#151a21]">{value}</strong>
      <span className="block text-[11px] text-[#667085]">{label}</span>
    </div>
  );
}

function ManualField({
  inputMode,
  label,
  onChange,
  type = "text",
  value,
}: {
  inputMode?: "decimal" | "email" | "none" | "numeric" | "search" | "tel" | "text" | "url";
  label: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  value: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold text-[#475467]">{label}</span>
      <Input type={type} inputMode={inputMode} value={value} onChange={(event) => onChange(event.target.value)} />
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
    <label className="grid gap-1.5">
      <span className="text-xs font-bold text-[#475467]">{label}</span>
      <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.key || option.value} value={option.value}>{option.label}</option>
        ))}
      </Select>
    </label>
  );
}
