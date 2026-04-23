import prisma from "@/lib/prisma";
import {
  claveFinanciera,
  normalizarNombreFinanciera,
  type CatalogoFinanciera,
} from "@/lib/ventas-financieras";

export const TIPOS_PERSONAL_VENTA = [
  "JALADOR",
  "CERRADOR",
  "FINANCIERA",
] as const;

export type TipoPersonalVenta = (typeof TIPOS_PERSONAL_VENTA)[number];

type RegistroCatalogo = {
  id: number;
  tipo: string;
  nombre: string;
  aplicaIntermediacion: boolean;
  porcentajeIntermediacion: number;
};

function toNumber(value: unknown) {
  const numero = Number(value);
  return Number.isFinite(numero) ? numero : 0;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  return String(value || "").trim().toLowerCase() === "true";
}

function toRegistroCatalogo(row: Record<string, unknown>): RegistroCatalogo {
  return {
    id: toNumber(row.id),
    tipo: String(row.tipo || ""),
    nombre: String(row.nombre || ""),
    aplicaIntermediacion: toBoolean(row.aplicaIntermediacion),
    porcentajeIntermediacion: toNumber(row.porcentajeIntermediacion),
  };
}

async function consultarRegistrosCatalogo() {
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT id, tipo, nombre, "aplicaIntermediacion", "porcentajeIntermediacion" FROM "CatalogoPersonalVenta" ORDER BY tipo ASC, id ASC'
  )) as Array<Record<string, unknown>>;

  return rows.map(toRegistroCatalogo);
}

export function normalizarTipoPersonalVenta(
  valor: unknown
): TipoPersonalVenta | null {
  const tipo = String(valor || "").trim().toUpperCase();
  return TIPOS_PERSONAL_VENTA.includes(tipo as TipoPersonalVenta)
    ? (tipo as TipoPersonalVenta)
    : null;
}

export function normalizarNombrePersonalVenta(valor: unknown) {
  return normalizarNombreFinanciera(valor);
}

export function claveNombrePersonalVenta(valor: unknown) {
  return claveFinanciera(valor);
}

export async function obtenerCatalogoPersonalVenta() {
  const registros = await consultarRegistrosCatalogo();

  const agrupado = {
    jaladores: [] as Array<{ id: number; nombre: string }>,
    cerradores: [] as Array<{ id: number; nombre: string }>,
    financieras: [] as CatalogoFinanciera[],
  };

  for (const registro of registros) {
    if (registro.tipo === "JALADOR") {
      agrupado.jaladores.push({
        id: registro.id,
        nombre: registro.nombre,
      });
      continue;
    }

    if (registro.tipo === "CERRADOR") {
      agrupado.cerradores.push({
        id: registro.id,
        nombre: registro.nombre,
      });
      continue;
    }

    if (registro.tipo === "FINANCIERA") {
      agrupado.financieras.push({
        id: registro.id,
        nombre: registro.nombre,
        aplicaIntermediacion: registro.aplicaIntermediacion,
        porcentajeIntermediacion: registro.porcentajeIntermediacion,
      });
    }
  }

  return agrupado;
}

export async function buscarRegistroPersonalVenta(params: {
  tipo: TipoPersonalVenta;
  nombreNormalizado: string;
}) {
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT id, tipo, nombre, "aplicaIntermediacion", "porcentajeIntermediacion" FROM "CatalogoPersonalVenta" WHERE tipo = $1 AND "nombreNormalizado" = $2 LIMIT 1',
    params.tipo,
    params.nombreNormalizado
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toRegistroCatalogo(rows[0]) : null;
}

export async function crearRegistroPersonalVenta(params: {
  tipo: TipoPersonalVenta;
  nombre: string;
  nombreNormalizado: string;
  aplicaIntermediacion?: boolean;
  porcentajeIntermediacion?: number;
}) {
  const rows = (await prisma.$queryRawUnsafe(
    'INSERT INTO "CatalogoPersonalVenta" (tipo, nombre, "nombreNormalizado", "aplicaIntermediacion", "porcentajeIntermediacion", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id, tipo, nombre, "aplicaIntermediacion", "porcentajeIntermediacion"',
    params.tipo,
    params.nombre,
    params.nombreNormalizado
    ,
    params.tipo === "FINANCIERA" ? Boolean(params.aplicaIntermediacion) : false,
    params.tipo === "FINANCIERA" && params.aplicaIntermediacion
      ? Math.max(0, toNumber(params.porcentajeIntermediacion))
      : 0
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toRegistroCatalogo(rows[0]) : null;
}

export async function obtenerRegistroPersonalVentaPorId(id: number) {
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT id, tipo, nombre, "aplicaIntermediacion", "porcentajeIntermediacion" FROM "CatalogoPersonalVenta" WHERE id = $1 LIMIT 1',
    id
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toRegistroCatalogo(rows[0]) : null;
}

export async function eliminarRegistroPersonalVentaPorId(id: number) {
  await prisma.$executeRawUnsafe(
    'DELETE FROM "CatalogoPersonalVenta" WHERE id = $1',
    id
  );
}
