import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AppPrismaClient } from "@/lib/prisma";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";

type Client = Pick<AppPrismaClient, "$queryRaw" | "$executeRawUnsafe">;
export type MerchantRecord = { id: string; nombre: string; direccion: string; telefono: string; imagen: string; publicado: boolean };

export function canManagePublicMerchants(user: { rolNombre: string; aliadoAccesoCodigo?: string | null } | null) {
  return Boolean(user && isAdminRole(user.rolNombre) && isFinserPayCentralAlly(user.aliadoAccesoCodigo));
}

export function validatePublicMerchant(body: Record<string, unknown>) {
  const nombre = String(body.nombre ?? "").trim();
  const direccion = String(body.direccion ?? "").trim();
  let telefono = String(body.telefono ?? "").replace(/[\s()+.-]/g, "");
  if (/^3\d{9}$/.test(telefono)) telefono = `57${telefono}`;
  if (nombre.length < 2 || nombre.length > 120) throw new Error("El nombre debe tener entre 2 y 120 caracteres.");
  if (direccion.length < 5 || direccion.length > 240) throw new Error("Escribe una dirección de entre 5 y 240 caracteres.");
  if (!/^\d{8,15}$/.test(telefono)) throw new Error("Escribe un teléfono válido; incluye el indicativo si no es un celular colombiano.");
  if (typeof body.publicado !== "boolean") throw new Error("Selecciona si el comercio debe mostrarse en la página.");
  return { nombre, direccion, telefono, publicado: body.publicado };
}

export async function prepareMerchantImage(value: unknown) {
  if (typeof value !== "string" || value.length > 3_000_000) throw new Error("La imagen debe pesar máximo 2 MB.");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error("Selecciona una imagen JPG, PNG o WebP.");
  const input = Buffer.from(match[2], "base64");
  if (input.length > 2 * 1024 * 1024) throw new Error("La imagen debe pesar máximo 2 MB.");
  try {
    const image = await sharp(input, { limitInputPixels: 20_000_000 }).rotate().resize({ width: 960, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return `data:image/webp;base64,${image.toString("base64")}`;
  } catch { throw new Error("No pudimos leer esa imagen. Usa otra foto JPG, PNG o WebP."); }
}

let schemaReady: Promise<void> | null = null;
export async function ensurePublicMerchantSchema(client: Client) {
  schemaReady ??= client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "PublicMerchant" (
    "id" TEXT PRIMARY KEY,
    "nombre" VARCHAR(120) NOT NULL,
    "direccion" VARCHAR(240) NOT NULL,
    "telefono" VARCHAR(20) NOT NULL,
    "imagen" TEXT NOT NULL,
    "publicado" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  await schemaReady;
}

export async function listManagedMerchants(client: Client) {
  await ensurePublicMerchantSchema(client);
  return client.$queryRaw<MerchantRecord[]>`SELECT "id", "nombre", "direccion", "telefono", "imagen", "publicado" FROM "PublicMerchant" ORDER BY "nombre", "id"`;
}

async function hasDirectory(client: Client) {
  const rows = await client.$queryRaw<{ name: string | null }[]>`SELECT to_regclass('"PublicMerchant"')::text AS name`;
  return Boolean(rows[0]?.name);
}

export async function loadPublicMerchants(client: Client) {
  if (!await hasDirectory(client)) return [];
  return client.$queryRaw<Omit<MerchantRecord, "imagen" | "publicado">[]>`SELECT "id", "nombre", "direccion", "telefono" FROM "PublicMerchant" WHERE "publicado" = true ORDER BY "nombre", "id"`;
}

export async function loadPublicMerchantImage(client: Client, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id) || !await hasDirectory(client)) return null;
  const rows = await client.$queryRaw<{ imagen: string }[]>`SELECT "imagen" FROM "PublicMerchant" WHERE "id" = ${id} AND "publicado" = true LIMIT 1`;
  return rows[0]?.imagen ?? null;
}

export async function saveManagedMerchant(client: Client, body: Record<string, unknown>, editing: boolean) {
  const id = editing ? String(body.id ?? "") : randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("El comercio no es válido.");
  // Validate all input before touching the database.
  const visibilityOnly = editing && Object.keys(body).every((key) => ["id", "publicado"].includes(key));
  if (visibilityOnly && typeof body.publicado !== "boolean") throw new Error("El estado no es válido.");
  const data = visibilityOnly ? null : validatePublicMerchant(body);
  const imagen = body.imagen ? await prepareMerchantImage(body.imagen) : null;
  if (!editing && !imagen) throw new Error("Selecciona la imagen del comercio.");
  await ensurePublicMerchantSchema(client);
  if (visibilityOnly) {
    return client.$queryRaw<{ id: string }[]>`UPDATE "PublicMerchant" SET "publicado" = ${body.publicado as boolean}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} RETURNING "id"`;
  }
  if (!data) throw new Error("Los datos del comercio no son válidos.");
  if (editing) {
    return client.$queryRaw<{ id: string }[]>`UPDATE "PublicMerchant" SET "nombre" = ${data.nombre}, "direccion" = ${data.direccion}, "telefono" = ${data.telefono}, "publicado" = ${data.publicado}, "imagen" = COALESCE(${imagen}, "imagen"), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} RETURNING "id"`;
  }
  return client.$queryRaw<{ id: string }[]>`INSERT INTO "PublicMerchant" ("id", "nombre", "direccion", "telefono", "imagen", "publicado") VALUES (${id}, ${data.nombre}, ${data.direccion}, ${data.telefono}, ${imagen}, ${data.publicado}) RETURNING "id"`;
}
