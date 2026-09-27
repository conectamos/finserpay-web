import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { resolveCreditPaymentSummary } from "@/lib/credit-factory";
import { secondCreditAuthorizationSchemaStatements } from "../scripts/second-credit-authorization-schema.mjs";
import {
  normalizeSecondCreditDocument,
  secondCreditAuthorizationUnavailable,
  SecondCreditAuthorizationError,
  type SecondCreditMutation,
} from "@/lib/second-credit-authorization-core";

export { normalizeSecondCreditDocument, SecondCreditAuthorizationError, parseSecondCreditMutation } from "@/lib/second-credit-authorization-core";
export type SecondCreditDatabase = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};
export type SecondCreditAuthorization = {
  id: string;
  documento: string;
  active: boolean;
  version: number;
  reason: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdByName: string;
  updatedByName: string;
};
export type SecondCreditEligibility = {
  documento: string;
  activeCredits: number;
  activeCreditIds: number[];
  activeFolios: string[];
  authorization: SecondCreditAuthorization | null;
  canCreate: boolean;
};
export type SecondCreditCreationAuthorization = {
  id: string;
  documento: string;
  version: number;
  reason: string;
  authorizedByName: string;
  authorizedAt: string;
  activeCreditIds: number[];
  activeFolios: string[];
};
const columns = `"id", "documento", "active", "version", "reason", "createdAt", "updatedAt", "createdByName", "updatedByName"`;
let schemaReady: Promise<void> | null = null;

/** Run outside credit-creation transactions; schema locks must precede document/identity locks. */
export function ensureSecondCreditAuthorizationSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-second-credit-authorization-schema'))");
      for (const statement of secondCreditAuthorizationSchemaStatements) await tx.$executeRawUnsafe(statement);
    }, { timeout: 30_000 }).catch(() => {
      schemaReady = null;
      throw secondCreditAuthorizationUnavailable();
    });
  }
  return schemaReady;
}

/** Same lock as blacklist and all credit-creation paths, inside their existing transaction. */
export async function lockSecondCreditDocument(db: SecondCreditDatabase, document: unknown) {
  const documento = normalizeSecondCreditDocument(document);
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `DOCUMENT_BLACKLIST:${documento}`);
}

/** Never consult legacy exception rows; an explicit new central authorization is required. */
export async function getSecondCreditEligibility(db: SecondCreditDatabase, documents: unknown[]): Promise<Map<string, SecondCreditEligibility>> {
  const normalized = [...new Set(documents.map(normalizeSecondCreditDocument))].sort();
  const result = new Map<string, SecondCreditEligibility>(normalized.map((documento) => [documento, {
    documento, activeCredits: 0, activeCreditIds: [], activeFolios: [], authorization: null, canCreate: true,
  }]));
  if (!normalized.length) return result;
  try {
    const authorizations = await db.$queryRawUnsafe<SecondCreditAuthorization[]>(
      `SELECT ${columns} FROM public."SecondCreditAuthorization" WHERE "documento" = ANY($1::text[])`, normalized,
    );
    const credits = await db.$queryRawUnsafe<Array<{
      id: number; folio: string; documento: string; montoCredito: number; cuotaInicial: number; totalAbonado: number; abonosCount: number;
    }>>(
      `SELECT c."id", c."folio", LTRIM(REGEXP_REPLACE(c."clienteDocumento", '[^0-9]', '', 'g'), '0') AS "documento",
        c."montoCredito", c."cuotaInicial", COALESCE(p."totalAbonado",0)::float8 AS "totalAbonado", COALESCE(p."abonosCount",0)::int AS "abonosCount"
       FROM public."Credito" c
       LEFT JOIN LATERAL (
         SELECT SUM(a."valor") AS "totalAbonado", COUNT(*) AS "abonosCount"
         FROM public."CreditoAbono" a WHERE a."creditoId"=c."id" AND a."estado" <> 'ANULADO'
       ) p ON TRUE
       WHERE c."estado" <> 'ANULADO'
         AND LTRIM(REGEXP_REPLACE(c."clienteDocumento", '[^0-9]', '', 'g'), '0') = ANY($1::text[])
       ORDER BY c."id"`, normalized,
    );
    for (const authorization of authorizations) {
      const item = result.get(authorization.documento);
      if (item) item.authorization = authorization;
    }
    for (const credit of credits) {
      const item = result.get(credit.documento);
      if (!item) continue;
      if ([credit.montoCredito, credit.cuotaInicial, credit.totalAbonado, credit.abonosCount].some((value) => value === null || value === undefined || !Number.isFinite(Number(value)))) {
        throw secondCreditAuthorizationUnavailable();
      }
      // Preserve the balance rule used by ordinary creation; revised totals are stored on Credito.
      const saldo = resolveCreditPaymentSummary({
        montoCredito: Number(credit.montoCredito), cuotaInicial: Number(credit.cuotaInicial),
        totalAbonado: Number(credit.totalAbonado), abonosCount: Number(credit.abonosCount),
      }).saldoPendiente;
      if (!Number.isFinite(saldo)) throw secondCreditAuthorizationUnavailable();
      if (saldo > 0) {
        item.activeCreditIds.push(credit.id);
        item.activeFolios.push(credit.folio);
        item.activeCredits += 1;
      }
    }
    for (const item of result.values()) {
      item.canCreate = item.activeCredits === 0 || (item.activeCredits === 1 && item.authorization?.active === true);
    }
    return result;
  } catch (error) {
    if (error instanceof SecondCreditAuthorizationError) throw error;
    throw secondCreditAuthorizationUnavailable();
  }
}

export function secondCreditCreationAuthorization(item: SecondCreditEligibility): SecondCreditCreationAuthorization | null {
  const authorization = item.authorization;
  if (item.activeCredits !== 1 || !item.canCreate || !authorization?.active) return null;
  const authorizedAt = new Date(authorization.updatedAt);
  if (!Number.isFinite(authorizedAt.getTime())) throw secondCreditAuthorizationUnavailable();
  return {
    id: authorization.id, documento: item.documento, version: authorization.version, reason: authorization.reason,
    authorizedByName: authorization.updatedByName, authorizedAt: authorizedAt.toISOString(),
    activeCreditIds: [...item.activeCreditIds], activeFolios: [...item.activeFolios],
  };
}

export async function assertSecondCreditEligibility(db: SecondCreditDatabase, document: unknown, options: { lock?: boolean } = {}): Promise<SecondCreditCreationAuthorization | null> {
  const documento = normalizeSecondCreditDocument(document);
  try {
    if (options.lock) await lockSecondCreditDocument(db, documento);
    const item = (await getSecondCreditEligibility(db, [documento])).get(documento)!;
    if (item.activeCredits >= 2) {
      throw new SecondCreditAuthorizationError("SECOND_CREDIT_LIMIT_REACHED", "La cédula ya tiene dos créditos vigentes. La autorización no permite un tercer crédito.", 409);
    }
    if (!item.canCreate) {
      throw new SecondCreditAuthorizationError("ACTIVE_CREDIT_EXISTS", `La cédula ya tiene saldo vigente en el crédito ${item.activeFolios[0]}. Requiere autorización del administrador central para un segundo crédito.`, 409);
    }
    return secondCreditCreationAuthorization(item);
  } catch (error) {
    if (error instanceof SecondCreditAuthorizationError) throw error;
    throw secondCreditAuthorizationUnavailable();
  }
}

/** Caller must use one transaction so permission and immutable event commit together. */
export async function mutateSecondCreditAuthorization(db: SecondCreditDatabase, input: SecondCreditMutation, actor: { id: number; nombre: string }) {
  const requestHash = createHash("sha256").update(JSON.stringify([input, actor.id])).digest("hex");
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `SECOND_CREDIT_AUTHORIZATION_MUTATION:${input.mutationId}`);
  const previous = await db.$queryRawUnsafe<Array<{ requestHash: string }>>(
    `SELECT "requestHash" FROM public."SecondCreditAuthorizationEvent" WHERE "mutationId"=$1::uuid`, input.mutationId,
  );
  if (previous[0] && previous[0].requestHash !== requestHash) {
    throw new SecondCreditAuthorizationError("MUTATION_CONFLICT", "La operación ya fue utilizada con otros datos.", 409);
  }
  await lockSecondCreditDocument(db, input.documento);
  if (previous[0]) {
    return { ...(await getSecondCreditEligibility(db, [input.documento])).get(input.documento)!, idempotent: true };
  }
  const rows = await db.$queryRawUnsafe<SecondCreditAuthorization[]>(
    `SELECT ${columns} FROM public."SecondCreditAuthorization" WHERE "documento"=$1 FOR UPDATE`, input.documento,
  );
  const before = rows[0] ?? null;
  if ((before?.version ?? 0) !== input.expectedVersion) {
    throw new SecondCreditAuthorizationError("VERSION_CONFLICT", "Otro administrador modificó esta autorización. Consulta de nuevo la cédula.", 409);
  }
  const active = input.action === "AUTHORIZE";
  if (!before && !active) throw new SecondCreditAuthorizationError("NOT_FOUND", "Esta cédula no tiene una autorización para revocar.", 404);
  if (before?.active === active) throw new SecondCreditAuthorizationError("STATE_CONFLICT", "La autorización ya tiene ese estado. Consulta de nuevo la cédula.", 409);
  const current = (await getSecondCreditEligibility(db, [input.documento])).get(input.documento)!;
  if (active && current.activeCredits >= 2) {
    throw new SecondCreditAuthorizationError("SECOND_CREDIT_LIMIT_REACHED", "La cédula ya tiene dos créditos vigentes. No es posible autorizar un tercero.", 409);
  }
  const id = before?.id ?? randomUUID();
  const saved = before
    ? await db.$queryRawUnsafe<SecondCreditAuthorization[]>(
      `UPDATE public."SecondCreditAuthorization" SET "active"=$2,"reason"=$3,"version"="version"+1,
        "updatedByUserId"=$4,"updatedByName"=$5,"updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1::uuid RETURNING ${columns}`, id, active, input.reason, actor.id, actor.nombre,
    )
    : await db.$queryRawUnsafe<SecondCreditAuthorization[]>(
      `INSERT INTO public."SecondCreditAuthorization" ("id","documento","active","reason","createdByUserId","createdByName","updatedByUserId","updatedByName")
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$5,$6) RETURNING ${columns}`, id, input.documento, active, input.reason, actor.id, actor.nombre,
    );
  const authorization = saved[0];
  if (!authorization) throw secondCreditAuthorizationUnavailable();
  const insertedEvents = await db.$executeRawUnsafe(
    `INSERT INTO public."SecondCreditAuthorizationEvent" ("id","authorizationId","mutationId","requestHash","action","reason","actorUserId","actorName","before","after")
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    randomUUID(), id, input.mutationId, requestHash, input.action, input.reason, actor.id, actor.nombre,
    before ? JSON.stringify(before) : null, JSON.stringify(authorization),
  );
  if (insertedEvents !== 1) throw secondCreditAuthorizationUnavailable();
  return { ...current, authorization, canCreate: current.activeCredits === 0 || (current.activeCredits === 1 && active), idempotent: false };
}