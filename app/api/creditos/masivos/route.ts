import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  generateCreditFolio,
  generatePaymentReference,
  MAX_CREDIT_INSTALLMENTS,
  sanitizeDeviceValue,
  sanitizeText,
} from "@/lib/credit-factory";
import {
  buildMassCreditObservation,
  MASS_CREDIT_SOURCE,
} from "@/lib/credit-import-flags";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMPORT_ROWS = 250;
const ALLOWED_FREQUENCIES = new Set(["CATORCENAL", "MENSUAL"]);

type MassCreditInputRow = {
  aliado?: unknown;
  cedula?: unknown;
  cliente?: unknown;
  cuota?: unknown;
  fecha?: unknown;
  fechaPago?: unknown;
  frecuencia?: unknown;
  imei?: unknown;
  inicial?: unknown;
  plazo?: unknown;
  referencia?: unknown;
  sede?: unknown;
  telefono?: unknown;
  valorCredito?: unknown;
  vendedor?: unknown;
};

type MassCreditBody = {
  commit?: boolean;
  rows?: MassCreditInputRow[];
};

type LookupAliado = {
  activo: boolean;
  codigo: string | null;
  id: number;
  nombre: string;
};

type LookupSede = {
  activa: boolean;
  aliadoId: number | null;
  codigo: string | null;
  id: number;
  nombre: string;
};

type LookupSellerAssignment = {
  sedeId: number;
  vendedor: {
    activo: boolean;
    documento: string | null;
    id: number;
    nombre: string;
  };
};

type PreparedCreditRow = {
  aliadoId: number;
  aliadoNombre: string;
  cedula: string;
  cliente: string;
  cuota: number;
  fecha: Date;
  fechaPago: Date;
  frecuencia: "CATORCENAL" | "MENSUAL";
  imei: string;
  inicial: number;
  plazo: number;
  referencia: string;
  rowNumber: number;
  sedeId: number;
  sedeNombre: string;
  telefono: string;
  valorCredito: number;
  vendedorId: number;
  vendedorNombre: string;
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

function normalizeLookup(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function normalizeCompact(value: unknown) {
  return normalizeLookup(value).replace(/\s+/g, "");
}

function digitsOnly(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function normalizeFrequency(value: unknown) {
  const normalized = normalizeLookup(value);

  if (normalized === "14" || normalized === "CADA 14 DIAS") {
    return "CATORCENAL";
  }

  if (normalized === "30" || normalized === "CADA 30 DIAS") {
    return "MENSUAL";
  }

  return normalized;
}

function parseMoney(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  }

  const raw = String(value ?? "").trim();

  if (!raw) {
    return 0;
  }

  let normalized = raw.replace(/[^\d,.-]/g, "");

  if (!normalized || normalized === "-" || normalized === "." || normalized === ",") {
    return 0;
  }

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? normalized.replace(/\./g, "").replace(",", ".")
        : normalized.replace(/,/g, "");
  } else if (lastComma >= 0) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(normalized)
      ? normalized.replace(/,/g, "")
      : normalized.replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function parseInteger(value: unknown) {
  const parsed = Math.trunc(parseMoney(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateAtNoon(year: number, month: number, day: number) {
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDate(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value);
  }

  const raw = String(value ?? "").trim();

  if (!raw) {
    return null;
  }

  if (/^\d{5}$/.test(raw)) {
    const serial = Number(raw);

    if (serial > 20_000 && serial < 90_000) {
      const date = new Date(1899, 11, 30 + serial, 12, 0, 0, 0);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  const ymd = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);

  if (ymd) {
    return dateAtNoon(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);

  if (dmy) {
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    return dateAtNoon(year, Number(dmy[2]), Number(dmy[1]));
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setHours(12, 0, 0, 0);
  return parsed;
}

function dateOnly(value: Date | null) {
  if (!value) {
    return null;
  }

  return value.toISOString().slice(0, 10);
}

function addLookup<T>(
  map: Map<string, T>,
  value: unknown,
  item: T
) {
  const normalized = normalizeLookup(value);
  const compact = normalizeCompact(value);

  if (normalized) {
    map.set(normalized, item);
  }

  if (compact) {
    map.set(compact, item);
  }
}

async function requireCentralAdmin() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo admin central FINSER PAY puede crear creditos masivos" },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, user };
}

async function loadCatalogs() {
  const aliados = await prisma.aliado.findMany({
    where: {
      activo: true,
      codigo: {
        not: "FINSERPAY",
      },
    },
    select: {
      activo: true,
      codigo: true,
      id: true,
      nombre: true,
    },
    orderBy: {
      nombre: "asc",
    },
  });
  const aliadoIds = aliados.map((item) => item.id);
  const sedes = await prisma.sede.findMany({
    where: {
      activa: true,
      aliadoId: {
        in: aliadoIds,
      },
    },
    select: {
      activa: true,
      aliadoId: true,
      codigo: true,
      id: true,
      nombre: true,
    },
    orderBy: [
      {
        aliadoId: "asc",
      },
      {
        nombre: "asc",
      },
    ],
  });
  const assignments = await prisma.sedeVendedor.findMany({
    where: {
      activo: true,
      sedeId: {
        in: sedes.map((item) => item.id),
      },
      vendedor: {
        activo: true,
      },
    },
    select: {
      sedeId: true,
      vendedor: {
        select: {
          activo: true,
          documento: true,
          id: true,
          nombre: true,
        },
      },
    },
    orderBy: [
      {
        sedeId: "asc",
      },
      {
        vendedor: {
          nombre: "asc",
        },
      },
    ],
  });

  return { aliados, sedes, assignments };
}

function buildLookupMaps(
  aliados: LookupAliado[],
  sedes: LookupSede[],
  assignments: LookupSellerAssignment[]
) {
  const aliadoMap = new Map<string, LookupAliado>();
  const sedeMap = new Map<string, LookupSede>();
  const vendedorMap = new Map<string, LookupSellerAssignment>();

  for (const aliado of aliados) {
    addLookup(aliadoMap, aliado.nombre, aliado);
    addLookup(aliadoMap, aliado.codigo, aliado);
  }

  for (const sede of sedes) {
    const names = [sede.nombre, sede.codigo].filter(Boolean);

    for (const name of names) {
      const key = `${sede.aliadoId || 0}:${normalizeLookup(name)}`;
      const compactKey = `${sede.aliadoId || 0}:${normalizeCompact(name)}`;
      sedeMap.set(key, sede);
      sedeMap.set(compactKey, sede);
    }
  }

  for (const assignment of assignments) {
    const names = [
      assignment.vendedor.nombre,
      assignment.vendedor.documento,
      digitsOnly(assignment.vendedor.documento),
    ].filter(Boolean);

    for (const name of names) {
      const key = `${assignment.sedeId}:${normalizeLookup(name)}`;
      const compactKey = `${assignment.sedeId}:${normalizeCompact(name)}`;
      vendedorMap.set(key, assignment);
      vendedorMap.set(compactKey, assignment);
    }
  }

  return { aliadoMap, sedeMap, vendedorMap };
}

function getRowValue(row: MassCreditInputRow, key: keyof MassCreditInputRow) {
  return row[key];
}

async function validateRows(rows: MassCreditInputRow[]) {
  const catalogs = await loadCatalogs();
  const { aliadoMap, sedeMap, vendedorMap } = buildLookupMaps(
    catalogs.aliados,
    catalogs.sedes,
    catalogs.assignments
  );
  const normalizedImeis = rows.map((row) =>
    sanitizeDeviceValue(getRowValue(row, "imei")).replace(/\D/g, "").slice(0, 15)
  );
  const duplicateImeis = new Set<string>();
  const seenImeis = new Set<string>();

  for (const imei of normalizedImeis) {
    if (!imei) {
      continue;
    }

    if (seenImeis.has(imei)) {
      duplicateImeis.add(imei);
    }

    seenImeis.add(imei);
  }

  const existingDevices = normalizedImeis.length
    ? await prisma.credito.findMany({
        where: {
          estado: {
            not: "ANULADO",
          },
          OR: [
            {
              imei: {
                in: [...seenImeis],
              },
            },
            {
              deviceUid: {
                in: [...seenImeis],
              },
            },
          ],
        },
        select: {
          deviceUid: true,
          folio: true,
          imei: true,
        },
      })
    : [];
  const existingDeviceMap = new Map<string, string>();

  for (const device of existingDevices) {
    if (device.imei) {
      existingDeviceMap.set(device.imei, device.folio);
    }

    if (device.deviceUid) {
      existingDeviceMap.set(device.deviceUid, device.folio);
    }
  }

  const prepared: PreparedCreditRow[] = [];
  const resultRows: ValidationRow[] = rows.map((row, index) => {
    const rowNumber = index + 1;
    const errors: string[] = [];
    const warnings: string[] = [];
    const aliadoInput = sanitizeText(getRowValue(row, "aliado"));
    const sedeInput = sanitizeText(getRowValue(row, "sede"));
    const vendedorInput = sanitizeText(getRowValue(row, "vendedor"));
    const cliente = sanitizeText(getRowValue(row, "cliente"));
    const cedula = digitsOnly(getRowValue(row, "cedula"));
    const telefono = normalizePhone(getRowValue(row, "telefono"));
    const referencia = sanitizeText(getRowValue(row, "referencia"));
    const imei = normalizedImeis[index] || "";
    const inicial = parseMoney(getRowValue(row, "inicial"));
    const valorCredito = parseMoney(getRowValue(row, "valorCredito"));
    const cuota = parseMoney(getRowValue(row, "cuota"));
    const plazo = parseInteger(getRowValue(row, "plazo"));
    const frecuencia = normalizeFrequency(getRowValue(row, "frecuencia"));
    const fecha = parseDate(getRowValue(row, "fecha"));
    const fechaPago = parseDate(getRowValue(row, "fechaPago"));
    const aliado = aliadoMap.get(normalizeLookup(aliadoInput)) ||
      aliadoMap.get(normalizeCompact(aliadoInput));
    const sede = aliado
      ? sedeMap.get(`${aliado.id}:${normalizeLookup(sedeInput)}`) ||
        sedeMap.get(`${aliado.id}:${normalizeCompact(sedeInput)}`)
      : null;
    const seller = sede
      ? vendedorMap.get(`${sede.id}:${normalizeLookup(vendedorInput)}`) ||
        vendedorMap.get(`${sede.id}:${normalizeCompact(vendedorInput)}`) ||
        vendedorMap.get(`${sede.id}:${digitsOnly(vendedorInput)}`)
      : null;

    if (!fecha) errors.push("FECHA invalida");
    if (!cedula || cedula.length < 5) errors.push("CEDULA obligatoria");
    if (!cliente) errors.push("CLIENTE obligatorio");
    if (!telefono || digitsOnly(telefono).length < 7) errors.push("TELEFONO invalido");
    if (!referencia) errors.push("REFERENCIA obligatoria");
    if (!/^\d{15}$/.test(imei)) errors.push("IMEI debe tener 15 numeros");
    if (imei && duplicateImeis.has(imei)) errors.push("IMEI repetido en la carga");

    const existingFolio = existingDeviceMap.get(imei);

    if (existingFolio) {
      errors.push(`IMEI ya existe en el credito ${existingFolio}`);
    }

    if (!aliado) errors.push("ALIADO no encontrado o inactivo");
    if (aliado && !sede) errors.push("SEDE no encontrada para el aliado");
    if (sede && !seller) errors.push("VENDEDOR no asignado a la sede");
    if (inicial < 0) errors.push("INICIAL no puede ser negativa");
    if (valorCredito <= 0) errors.push("VALOR DEL CREDITO debe ser mayor a 0");
    if (cuota <= 0) errors.push("CUOTA debe ser mayor a 0");
    if (plazo <= 0 || plazo > MAX_CREDIT_INSTALLMENTS) {
      errors.push(`PLAZO debe estar entre 1 y ${MAX_CREDIT_INSTALLMENTS}`);
    }

    if (!ALLOWED_FREQUENCIES.has(frecuencia)) {
      errors.push("FRECUENCIA debe ser CATORCENAL o MENSUAL");
    }

    if (fecha && fechaPago && fechaPago.getTime() < fecha.getTime()) {
      warnings.push("FECHA DE PAGO es anterior a FECHA");
    }

    const plannedTotal = cuota * Math.max(1, plazo);
    const tolerance = Math.max(1000, plazo * 100);
    const difference = Math.abs(plannedTotal - valorCredito);

    if (valorCredito > 0 && cuota > 0 && plazo > 0 && difference > tolerance) {
      errors.push("CUOTA x PLAZO no cuadra con VALOR DEL CREDITO");
    } else if (difference > 0) {
      warnings.push("CUOTA x PLAZO tiene diferencia menor por redondeo");
    }

    if (
      !errors.length &&
      aliado &&
      sede &&
      seller &&
      fecha &&
      fechaPago &&
      ALLOWED_FREQUENCIES.has(frecuencia)
    ) {
      prepared.push({
        aliadoId: aliado.id,
        aliadoNombre: aliado.nombre,
        cedula,
        cliente,
        cuota,
        fecha,
        fechaPago,
        frecuencia: frecuencia as "CATORCENAL" | "MENSUAL",
        imei,
        inicial,
        plazo,
        referencia,
        rowNumber,
        sedeId: sede.id,
        sedeNombre: sede.nombre,
        telefono,
        valorCredito,
        vendedorId: seller.vendedor.id,
        vendedorNombre: seller.vendedor.nombre,
      });
    }

    return {
      errors,
      normalized: {
        aliado: aliado?.nombre || aliadoInput,
        cedula,
        cliente,
        cuota,
        fecha: dateOnly(fecha),
        fechaPago: dateOnly(fechaPago),
        frecuencia,
        imei,
        inicial,
        plazo,
        referencia,
        sede: sede?.nombre || sedeInput,
        telefono,
        valorCredito,
        vendedor: seller?.vendedor.nombre || vendedorInput,
      },
      ok: errors.length === 0,
      rowNumber,
      warnings,
    };
  });

  return {
    catalogs,
    prepared,
    rows: resultRows,
    summary: {
      invalid: resultRows.filter((item) => !item.ok).length,
      total: resultRows.length,
      valid: resultRows.filter((item) => item.ok).length,
      warnings: resultRows.reduce((sum, item) => sum + item.warnings.length, 0),
    },
  };
}

async function generateUniqueFolio(usedFolios: Set<string>) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const folio = generateCreditFolio();

    if (usedFolios.has(folio)) {
      continue;
    }

    const existing = await prisma.credito.findUnique({
      where: {
        folio,
      },
      select: {
        id: true,
      },
    });

    if (!existing) {
      usedFolios.add(folio);
      return folio;
    }
  }

  const fallback = `FC-MASIVO-${Date.now()}-${usedFolios.size + 1}`;
  usedFolios.add(fallback);
  return fallback;
}

function buildContractSnapshot(
  row: PreparedCreditRow,
  options: {
    batchId: string;
    createdAt: Date;
    createdByUserId: number;
    createdByUserName: string;
  }
) {
  return {
    origen: {
      tipo: MASS_CREDIT_SOURCE,
      batchId: options.batchId,
      creadoAt: options.createdAt.toISOString(),
      creadoPorUsuarioId: options.createdByUserId,
      creadoPor: options.createdByUserName,
      sinBloqueo: true,
      sinValidacionEntrega: true,
      sinFirmaDigital: true,
    },
    cliente: {
      nombre: row.cliente,
      cedula: row.cedula,
      telefono: row.telefono,
    },
    equipo: {
      referencia: row.referencia,
      imei: row.imei,
    },
    financiero: {
      cuotaInicial: row.inicial,
      montoCredito: row.valorCredito,
      valorCuota: row.cuota,
      plazo: row.plazo,
      frecuenciaPago: row.frecuencia,
      fechaCredito: row.fecha.toISOString(),
      fechaPrimerPago: row.fechaPago.toISOString(),
    },
    asignacion: {
      aliadoId: row.aliadoId,
      aliado: row.aliadoNombre,
      sedeId: row.sedeId,
      sede: row.sedeNombre,
      vendedorId: row.vendedorId,
      vendedor: row.vendedorNombre,
    },
  };
}

export async function GET() {
  try {
    const access = await requireCentralAdmin();

    if (!access.ok) {
      return access.response;
    }

    const catalogs = await loadCatalogs();

    return NextResponse.json({
      ok: true,
      aliados: catalogs.aliados,
      sedes: catalogs.sedes,
      vendedores: catalogs.assignments.map((item) => ({
        id: item.vendedor.id,
        nombre: item.vendedor.nombre,
        documento: item.vendedor.documento,
        sedeId: item.sedeId,
      })),
    });
  } catch (error) {
    console.error("ERROR CARGANDO CREDITOS MASIVOS:", error);
    return NextResponse.json(
      { error: "No se pudo cargar la configuracion de creditos masivos" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = await requireCentralAdmin();

    if (!access.ok) {
      return access.response;
    }

    const body = (await req.json()) as MassCreditBody;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const commit = Boolean(body.commit);

    if (!rows.length) {
      return NextResponse.json(
        { error: "Debes cargar al menos una fila" },
        { status: 400 }
      );
    }

    if (rows.length > MAX_IMPORT_ROWS) {
      return NextResponse.json(
        { error: `Solo puedes cargar hasta ${MAX_IMPORT_ROWS} creditos por lote` },
        { status: 400 }
      );
    }

    const validation = await validateRows(rows);

    if (!commit || validation.summary.invalid > 0) {
      return NextResponse.json({
        ok: validation.summary.invalid === 0,
        commit: false,
        rows: validation.rows,
        summary: validation.summary,
      });
    }

    const batchId = new Date()
      .toISOString()
      .replace(/\D/g, "")
      .slice(0, 14);
    const createdAt = new Date();
    const usedFolios = new Set<string>();
    const foliosByRowNumber = new Map<number, string>();

    for (const row of validation.prepared) {
      foliosByRowNumber.set(row.rowNumber, await generateUniqueFolio(usedFolios));
    }

    const createdRows = await prisma.$transaction(async (tx) => {
      const created: Array<{ id: number; folio: string; rowNumber: number }> = [];

      for (const row of validation.prepared) {
        const folio = foliosByRowNumber.get(row.rowNumber) || generateCreditFolio();
        const referenciaPago = generatePaymentReference(folio, row.cedula);
        const observation = buildMassCreditObservation({
          batchId,
          createdBy: access.user.nombre,
          rowNumber: row.rowNumber,
        });
        const snapshot = buildContractSnapshot(row, {
          batchId,
          createdAt,
          createdByUserId: access.user.id,
          createdByUserName: access.user.nombre,
        });
        const credit = await tx.credito.create({
          data: {
            folio,
            clienteNombre: row.cliente,
            clientePrimerNombre: row.cliente.split(/\s+/)[0] || row.cliente,
            clientePrimerApellido:
              row.cliente.split(/\s+/).slice(1).join(" ") || null,
            clienteTipoDocumento: "CC",
            clienteDocumento: row.cedula,
            clienteTelefono: row.telefono,
            imei: row.imei,
            deviceUid: row.imei,
            referenciaEquipo: row.referencia,
            valorEquipoTotal: row.valorCredito + row.inicial,
            saldoBaseFinanciado: row.valorCredito,
            montoCredito: row.valorCredito,
            cuotaInicial: row.inicial,
            plazoMeses: row.plazo,
            frecuenciaPago: row.frecuencia,
            tasaInteresEa: 0,
            valorInteres: 0,
            fianzaPorcentaje: 0,
            valorFianza: 0,
            valorCuota: row.cuota,
            fechaCredito: row.fecha,
            fechaPrimerPago: row.fechaPago,
            fechaProximoPago: row.fechaPago,
            referenciaPago,
            estado: "GENERADO",
            deliverableLabel: "Credito historico importado",
            deliverableReady: false,
            equalityService: MASS_CREDIT_SOURCE,
            equalityLastCheckAt: null,
            observacionAdmin: observation,
            contratoSnapshot: snapshot as Prisma.InputJsonValue,
            usuarioId: access.user.id,
            vendedorId: row.vendedorId,
            sedeId: row.sedeId,
          },
          select: {
            folio: true,
            id: true,
          },
        });

        created.push({
          folio: credit.folio,
          id: credit.id,
          rowNumber: row.rowNumber,
        });
      }

      return created;
    });
    const createdMap = new Map(
      createdRows.map((item) => [item.rowNumber, item])
    );

    return NextResponse.json({
      ok: true,
      commit: true,
      created: createdRows.length,
      batchId,
      rows: validation.rows.map((row) => {
        const created = createdMap.get(row.rowNumber);

        return created
          ? {
              ...row,
              createdCreditoId: created.id,
              createdFolio: created.folio,
            }
          : row;
      }),
      summary: {
        ...validation.summary,
        created: createdRows.length,
      },
    });
  } catch (error) {
    console.error("ERROR CREANDO CREDITOS MASIVOS:", error);
    return NextResponse.json(
      { error: "No se pudo procesar la carga de creditos masivos" },
      { status: 500 }
    );
  }
}
