import "server-only";

import { randomUUID } from "node:crypto";
import {
  approvalDataChangedFields,
  approvalDataRequestHash,
  approvalDataSnapshot,
  formatApprovalEquipmentReference,
  type ApprovalDataSnapshot,
  type ParsedApprovalDataCorrection,
} from "@/lib/credit-approval-data-core";
import {
  CreditApprovalError,
  getCreditApprovalDetail,
  type ApprovalActor,
  type ApprovalDatabase,
} from "@/lib/credit-approval";
import {
  approvalActorAudit,
  assertApprovalActorActive,
  assertApprovalActorCreditAccess,
} from "@/lib/credit-approval-actor";
import { resolveAllyPaymentPlatform, type AllyPaymentPlatform } from "@/lib/ally-payments-core";
import { isIphoneEquipmentCatalogBrand } from "@/lib/credit-factory";
import { COLOMBIA_DEPARTMENT_OPTIONS } from "@/lib/colombia-locations";
import { getCreditApprovalReissueState } from "@/lib/credit-approval-reissue-state";

type LockedCredit = {
  id: number;
  clienteCorreo: string | null;
  clienteTelefono: string | null;
  clienteDepartamento: string | null;
  clienteCiudad: string | null;
  clienteDireccion: string | null;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  contratoSnapshot: unknown;
  estado: string;
  required: boolean;
  paid: boolean;
};
type LockedReview = { status: string; revision: number; reviewHash: string | null; reviewHashVersion: number };
type CatalogRow = {
  id: number;
  marca: string;
  modelo: string;
  precioBaseVenta: number;
  activo: boolean;
};
type CorrectionRow = {
  id: string;
  creditoId: number;
  idempotencyKey: string;
  requestHash: string;
  requestedRevision: number;
  requestedReviewHash: string;
  requestedHashVersion: number;
  resultingRevision: number;
  resultingReviewHash: string;
  resultingHashVersion: number;
  before: unknown;
  after: unknown;
  reason: string;
  actorKind: "USER" | "SHARED_LINK";
  actorUserId: number | null;
  actorName: string;
  actorGrantId: string | null;
  actorSessionId: string | null;
  catalogSnapshot: unknown;
  createdAt: Date;
};

const CANCELLED_STATES = new Set(["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"]);
const departmentCodeByKey = new Map<string, string>();

function locationKey(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().replace(/[\s_-]+/g, " ").toUpperCase();
}
for (const { value, label } of COLOMBIA_DEPARTMENT_OPTIONS) {
  departmentCodeByKey.set(locationKey(value), value);
  departmentCodeByKey.set(locationKey(label), value);
}

function normalizedNullable(value: unknown) {
  if (typeof value !== "string") return null;
  return value.normalize("NFKC").trim().replace(/\s+/g, " ") || null;
}

function snapshotFromCredit(credit: LockedCredit): ApprovalDataSnapshot {
  return {
    clienteCorreo: normalizedNullable(credit.clienteCorreo),
    clienteTelefono: normalizedNullable(credit.clienteTelefono),
    clienteDepartamento: normalizedNullable(credit.clienteDepartamento),
    clienteCiudad: normalizedNullable(credit.clienteCiudad),
    clienteDireccion: normalizedNullable(credit.clienteDireccion),
    referenciaEquipo: normalizedNullable(credit.referenciaEquipo),
  };
}

function catalogPlatform(marca: unknown): AllyPaymentPlatform {
  return isIphoneEquipmentCatalogBrand(marca) ? "IPHONE" : "ANDROID";
}

function catalogReference(item: Pick<CatalogRow, "marca" | "modelo">) {
  return formatApprovalEquipmentReference(item.marca, item.modelo);
}

function correctionNotAllowed(message: string) {
  return new CreditApprovalError("DATA_CORRECTION_NOT_ALLOWED", message, 409);
}

async function readLockedCredit(db: ApprovalDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<LockedCredit[]>(`SELECT credit."id",credit."clienteCorreo",credit."clienteTelefono",
    credit."clienteDepartamento",credit."clienteCiudad",credit."clienteDireccion",credit."referenciaEquipo",
    credit."equipoMarca",credit."contratoSnapshot",credit."estado",
    EXISTS (SELECT 1 FROM "CreditApprovalPolicy" policy WHERE policy."id"=1
      AND credit."createdAt">=policy."activatedAt"
      AND NOT (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA'
        AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA')) AS required,
    EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id") AS paid
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId"
    JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    WHERE credit."id"=$1 AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY'
    FOR UPDATE OF credit`, id);
  if (!rows[0]) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  return rows[0];
}

async function readLockedReview(db: ApprovalDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<LockedReview[]>(`SELECT "status","revision","reviewHash","reviewHashVersion"
    FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE`, id);
  if (!rows[0]) throw correctionNotAllowed("El crédito no tiene una revisión activa.");
  return rows[0];
}

async function ensureReview(db: ApprovalDatabase, id: number) {
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalReview"
    ("creditoId","status","revision","createdAt","updatedAt")
    VALUES ($1,'PENDING',1,CURRENT_TIMESTAMP AT TIME ZONE 'UTC',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    ON CONFLICT ("creditoId") DO NOTHING`, id);
}

async function readCatalogItemForShare(db: ApprovalDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<CatalogRow[]>(`SELECT "id","marca","modelo","precioBaseVenta","activo"
    FROM "CatalogoEquipoModelo" WHERE "id"=$1 FOR SHARE`, id);
  if (!rows[0]) throw new CreditApprovalError("EQUIPMENT_CATALOG_NOT_FOUND", "El equipo seleccionado ya no existe en el catálogo.", 409);
  if (!rows[0].activo) throw new CreditApprovalError("EQUIPMENT_CATALOG_INACTIVE", "El equipo seleccionado está inactivo en el catálogo.", 409);
  return rows[0];
}

async function readCorrectionByKey(db: ApprovalDatabase, idempotencyKey: string) {
  const rows = await db.$queryRawUnsafe<CorrectionRow[]>(`SELECT * FROM "CreditApprovalDataCorrection"
    WHERE "idempotencyKey"=$1::uuid`, idempotencyKey);
  return rows[0] || null;
}

function sameActor(row: CorrectionRow, actor: ReturnType<typeof approvalActorAudit>) {
  return row.actorKind === actor.actorKind && row.actorUserId === actor.actorUserId
    && row.actorGrantId === actor.actorGrantId && row.actorSessionId === actor.actorSessionId;
}

function assertSameRequest(row: CorrectionRow, creditoId: number, requestHash: string, actor: ReturnType<typeof approvalActorAudit>) {
  if (row.creditoId !== creditoId || row.requestHash !== requestHash || !sameActor(row, actor)) {
    throw new CreditApprovalError("IDEMPOTENCY_KEY_CONFLICT", "Esta confirmación ya fue usada para otra corrección.", 409);
  }
}

function resolveLocationChanges(before: ApprovalDataSnapshot, input: ParsedApprovalDataCorrection) {
  const departmentRequested = Object.hasOwn(input.changes, "clienteDepartamento");
  const cityRequested = Object.hasOwn(input.changes, "clienteCiudad");
  if (!departmentRequested && !cityRequested) return {};
  const rawDepartment = departmentRequested ? input.changes.clienteDepartamento : before.clienteDepartamento;
  const department = departmentCodeByKey.get(locationKey(rawDepartment));
  if (!department) throw new CreditApprovalError("INVALID_DEPARTMENT", "Selecciona un departamento válido.");
  const currentDepartment = departmentCodeByKey.get(locationKey(before.clienteDepartamento));
  if (departmentRequested && department !== currentDepartment && !cityRequested) {
    throw new CreditApprovalError("INVALID_CITY", "Confirma la ciudad o municipio al cambiar el departamento.");
  }
  const city = cityRequested ? input.changes.clienteCiudad : before.clienteCiudad;
  if (!city?.trim()) throw new CreditApprovalError("INVALID_CITY", "Ingresa la ciudad o municipio.");
  return {
    ...(departmentRequested ? { clienteDepartamento: department } : {}),
    ...(cityRequested ? { clienteCiudad: city } : {}),
  };
}

function historyItem(row: CorrectionRow) {
  const before = approvalDataSnapshot(row.before);
  const after = approvalDataSnapshot(row.after);
  return {
    id: row.id,
    changes: before && after ? approvalDataChangedFields(before, after) : [],
    reason: row.reason,
    actorName: row.actorName,
    actorKind: row.actorKind,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export async function listCreditApprovalDataHistory(db: ApprovalDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<CorrectionRow[]>(`SELECT * FROM "CreditApprovalDataCorrection"
    WHERE "creditoId"=$1 ORDER BY "resultingRevision" DESC,"createdAt" DESC,"id" DESC`, id);
  return rows.map(historyItem);
}

export async function getCreditApprovalDataDetail(db: ApprovalDatabase, id: number, actor: ApprovalActor) {
  const detail = await getCreditApprovalDetail(db, id, actor);
  const history = await listCreditApprovalDataHistory(db, id);
  return { item: { ...detail,
    clienteDepartamentoLabel: detail.clienteDepartamento,
    clienteDepartamento: detail.clienteDepartamentoCodigo,
    capabilities: { ...detail.capabilities,
      correctionBlockedReason: detail.capabilities.dataCorrectionBlockedReason } }, history };
}

export async function listApprovalEquipmentCatalog(db: ApprovalDatabase) {
  const rows = await db.$queryRawUnsafe<CatalogRow[]>(`SELECT "id","marca","modelo","precioBaseVenta","activo"
    FROM "CatalogoEquipoModelo" WHERE "activo"=TRUE ORDER BY "marcaNormalizada","modeloNormalizado","id"`);
  return rows.map((item) => ({
    id: item.id,
    marca: item.marca,
    modelo: item.modelo,
    referenciaEquipo: catalogReference(item),
    plataforma: catalogPlatform(item.marca),
  }));
}

/** Caller supplies a transaction. Lock order: actor, Credito, access, Review, catalog. */
export async function correctCreditApprovalData(
  db: ApprovalDatabase,
  id: number,
  input: ParsedApprovalDataCorrection,
  actor: ApprovalActor,
) {
  await assertApprovalActorActive(db, actor);
  const credit = await readLockedCredit(db, id);
  await assertApprovalActorCreditAccess(db, id, actor);
  await ensureReview(db, id);
  const review = await readLockedReview(db, id);
  const auditActor = approvalActorAudit(actor);
  const requestHash = approvalDataRequestHash(id, input);
  const previousRequest = await readCorrectionByKey(db, input.idempotencyKey);
  if (previousRequest) {
    assertSameRequest(previousRequest, id, requestHash, auditActor);
    return { ...(await getCreditApprovalDataDetail(db, id, actor)), unchanged: true, replayed: true };
  }

  if (!credit.required) throw correctionNotAllowed("Este crédito conserva las reglas anteriores a la activación.");
  if (credit.paid) throw correctionNotAllowed("Este crédito ya está incluido en una liquidación pagada.");
  if (CANCELLED_STATES.has(String(credit.estado || "").trim().toUpperCase())) {
    throw correctionNotAllowed("El crédito está anulado o cancelado.");
  }
  if (review.status !== "PENDING" && review.status !== "APPROVED") throw correctionNotAllowed("El expediente no admite correcciones.");
  const reissue = await getCreditApprovalReissueState(db, id);
  if (!reissue.available || reissue.blocked) {
    throw correctionNotAllowed("Resuelve el reenvío de firma en curso antes de corregir este expediente.");
  }
  const currentDetail = await getCreditApprovalDetail(db, id, actor);
  if (currentDetail.review.revision !== input.revision || currentDetail.review.reviewHash !== input.reviewHash) {
    throw new CreditApprovalError("REVIEW_CHANGED", "El expediente cambió. Actualiza los datos antes de guardar la corrección.", 409);
  }

  const before = snapshotFromCredit(credit);
  let catalog: CatalogRow | null = null;
  let catalogSnapshot: Record<string, unknown> | null = null;
  if (Object.hasOwn(input.changes, "catalogItemId")) {
    catalog = await readCatalogItemForShare(db, input.changes.catalogItemId!);
    const platform = resolveAllyPaymentPlatform(credit.contratoSnapshot, credit.equipoMarca);
    const selectedPlatform = catalogPlatform(catalog.marca);
    if (!platform) throw new CreditApprovalError("EQUIPMENT_PLATFORM_UNAVAILABLE", "No se pudo verificar la plataforma del crédito.", 409);
    if (platform !== selectedPlatform) {
      throw new CreditApprovalError("EQUIPMENT_PLATFORM_MISMATCH", `El equipo seleccionado corresponde a ${selectedPlatform} y este crédito es ${platform}.`, 409);
    }
    const reference = catalogReference(catalog);
    if (!reference || reference.length > 180) throw new CreditApprovalError("EQUIPMENT_CATALOG_INVALID", "El equipo seleccionado no tiene una referencia válida.", 409);
    catalogSnapshot = { id: catalog.id, marca: catalog.marca, modelo: catalog.modelo,
      precioBaseVenta: Number(catalog.precioBaseVenta), activo: catalog.activo,
      plataforma: selectedPlatform, referenciaEquipo: reference };
  }

  const locationChanges = resolveLocationChanges(before, input);
  const after: ApprovalDataSnapshot = {
    ...before,
    ...(input.changes.clienteCorreo !== undefined ? { clienteCorreo: input.changes.clienteCorreo } : {}),
    ...(input.changes.clienteTelefono !== undefined ? { clienteTelefono: input.changes.clienteTelefono } : {}),
    ...locationChanges,
    ...(input.changes.clienteDireccion !== undefined ? { clienteDireccion: input.changes.clienteDireccion } : {}),
    ...(catalog ? { referenciaEquipo: catalogReference(catalog) } : {}),
  };
  const changedFields = approvalDataChangedFields(before, after);
  if (!changedFields.length) {
    throw new CreditApprovalError("NO_DATA_CHANGES", "Los datos indicados ya están guardados en el expediente.", 409);
  }
  if (!changedFields.some(({ field }) => field === "referenciaEquipo")) catalogSnapshot = null;

  const updated = await db.$executeRawUnsafe(`UPDATE "Credito" SET
    "clienteCorreo"=CASE WHEN $2::boolean THEN $3::text ELSE "clienteCorreo" END,
    "clienteTelefono"=CASE WHEN $4::boolean THEN $5::text ELSE "clienteTelefono" END,
    "clienteDepartamento"=CASE WHEN $6::boolean THEN $7::text ELSE "clienteDepartamento" END,
    "clienteCiudad"=CASE WHEN $8::boolean THEN $9::text ELSE "clienteCiudad" END,
    "clienteDireccion"=CASE WHEN $10::boolean THEN $11::text ELSE "clienteDireccion" END,
    "referenciaEquipo"=CASE WHEN $12::boolean THEN $13::text ELSE "referenciaEquipo" END,
    "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1`, id,
    Object.hasOwn(input.changes, "clienteCorreo"), after.clienteCorreo,
    Object.hasOwn(input.changes, "clienteTelefono"), after.clienteTelefono,
    Object.hasOwn(input.changes, "clienteDepartamento"), after.clienteDepartamento,
    Object.hasOwn(input.changes, "clienteCiudad"), after.clienteCiudad,
    Object.hasOwn(input.changes, "clienteDireccion"), after.clienteDireccion,
    Object.hasOwn(input.changes, "catalogItemId"), after.referenciaEquipo);
  if (updated !== 1) throw new CreditApprovalError("REVIEW_CHANGED", "El expediente cambió. Actualiza los datos.", 409);

  const resultingReview = await readLockedReview(db, id);
  if (resultingReview.status !== "PENDING" || resultingReview.revision !== input.revision + 1
      || resultingReview.reviewHash !== null || resultingReview.reviewHashVersion !== 2) {
    throw new CreditApprovalError("APPROVAL_DATA_SCHEMA_OUTDATED", "La corrección no pudo abrir una nueva revisión. Intenta de nuevo después de actualizar el servicio.", 503);
  }
  const updatedDetail = await getCreditApprovalDetail(db, id, actor);
  if (updatedDetail.review.revision !== resultingReview.revision || !/^[a-f0-9]{64}$/.test(updatedDetail.review.reviewHash)) {
    throw new CreditApprovalError("REVIEW_CHANGED", "No se pudo verificar la nueva revisión del expediente.", 409);
  }
  const inserted = await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalDataCorrection"
    ("id","creditoId","idempotencyKey","requestHash","requestedRevision","requestedReviewHash","requestedHashVersion",
     "resultingRevision","resultingReviewHash","resultingHashVersion","before","after","reason","actorKind",
     "actorUserId","actorName","actorGrantId","actorSessionId","catalogSnapshot","createdAt")
    VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17::uuid,$18::uuid,$19::jsonb,CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    ON CONFLICT ("idempotencyKey") DO NOTHING`, randomUUID(), id, input.idempotencyKey, requestHash,
    input.revision, input.reviewHash, review.reviewHashVersion,
    resultingReview.revision, updatedDetail.review.reviewHash, resultingReview.reviewHashVersion,
    JSON.stringify(before), JSON.stringify(after), input.reason, auditActor.actorKind, auditActor.actorUserId,
    auditActor.actorName, auditActor.actorGrantId, auditActor.actorSessionId,
    catalogSnapshot ? JSON.stringify(catalogSnapshot) : null);
  if (inserted !== 1) {
    const conflict = await readCorrectionByKey(db, input.idempotencyKey);
    if (conflict) assertSameRequest(conflict, id, requestHash, auditActor);
    throw new CreditApprovalError("IDEMPOTENCY_KEY_CONFLICT", "Esta confirmación ya fue usada para otra corrección.", 409);
  }
  const response = await getCreditApprovalDataDetail(db, id, actor);
  return { ...response, unchanged: false, replayed: false };
}
