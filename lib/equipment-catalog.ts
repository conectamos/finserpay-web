import prisma from "@/lib/prisma";

let equipmentCatalogTableReady = false;

export type EquipmentCatalogItem = {
  id: number;
  marca: string;
  modelo: string;
  precioBaseVenta: number;
  activo: boolean;
};

function toNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  return String(value || "").trim().toLowerCase() === "true";
}

function toCatalogItem(row: Record<string, unknown>): EquipmentCatalogItem {
  return {
    id: toNumber(row.id),
    marca: String(row.marca || ""),
    modelo: String(row.modelo || ""),
    precioBaseVenta: toNumber(row.precioBaseVenta),
    activo: toBoolean(row.activo),
  };
}

export function normalizeEquipmentCatalogText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function equipmentCatalogKey(value: unknown) {
  return normalizeEquipmentCatalogText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

export async function ensureEquipmentCatalogTable() {
  if (equipmentCatalogTableReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CatalogoEquipoModelo" (
      id SERIAL PRIMARY KEY,
      marca TEXT NOT NULL,
      "marcaNormalizada" TEXT NOT NULL,
      modelo TEXT NOT NULL,
      "modeloNormalizado" TEXT NOT NULL,
      "precioBaseVenta" DOUBLE PRECISION NOT NULL,
      activo BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "CatalogoEquipoModelo_marcaNormalizada_modeloNormalizado_key" ON "CatalogoEquipoModelo" ("marcaNormalizada", "modeloNormalizado")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "CatalogoEquipoModelo_activo_marcaNormalizada_idx" ON "CatalogoEquipoModelo" (activo, "marcaNormalizada")'
  );

  equipmentCatalogTableReady = true;
}

export async function getEquipmentCatalog(options?: { includeInactive?: boolean }) {
  await ensureEquipmentCatalogTable();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, marca, modelo, "precioBaseVenta", activo
     FROM "CatalogoEquipoModelo"
     ${options?.includeInactive ? "" : "WHERE activo = true"}
     ORDER BY "marcaNormalizada" ASC, "modeloNormalizado" ASC`
  )) as Array<Record<string, unknown>>;

  return rows.map(toCatalogItem);
}

export async function findEquipmentCatalogItem(params: {
  marca: string;
  modelo: string;
}) {
  await ensureEquipmentCatalogTable();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, marca, modelo, "precioBaseVenta", activo
     FROM "CatalogoEquipoModelo"
     WHERE "marcaNormalizada" = $1 AND "modeloNormalizado" = $2
     LIMIT 1`,
    equipmentCatalogKey(params.marca),
    equipmentCatalogKey(params.modelo)
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toCatalogItem(rows[0]) : null;
}

export async function createEquipmentCatalogItem(params: {
  marca: string;
  modelo: string;
  precioBaseVenta: number;
}) {
  await ensureEquipmentCatalogTable();

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO "CatalogoEquipoModelo"
      (marca, "marcaNormalizada", modelo, "modeloNormalizado", "precioBaseVenta", activo, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
     RETURNING id, marca, modelo, "precioBaseVenta", activo`,
    params.marca,
    equipmentCatalogKey(params.marca),
    params.modelo,
    equipmentCatalogKey(params.modelo),
    params.precioBaseVenta
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toCatalogItem(rows[0]) : null;
}

export async function updateEquipmentCatalogItem(params: {
  id: number;
  marca: string;
  modelo: string;
  precioBaseVenta: number;
  activo?: boolean;
}) {
  await ensureEquipmentCatalogTable();

  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE "CatalogoEquipoModelo"
     SET marca = $2,
         "marcaNormalizada" = $3,
         modelo = $4,
         "modeloNormalizado" = $5,
         "precioBaseVenta" = $6,
         activo = COALESCE($7, activo),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, marca, modelo, "precioBaseVenta", activo`,
    params.id,
    params.marca,
    equipmentCatalogKey(params.marca),
    params.modelo,
    equipmentCatalogKey(params.modelo),
    params.precioBaseVenta,
    params.activo ?? null
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toCatalogItem(rows[0]) : null;
}

export async function deleteEquipmentCatalogItem(id: number) {
  await ensureEquipmentCatalogTable();

  await prisma.$executeRawUnsafe(
    'DELETE FROM "CatalogoEquipoModelo" WHERE id = $1',
    id
  );
}
