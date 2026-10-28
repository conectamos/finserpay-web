import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { assertDocumentNotBlacklisted } from "@/lib/document-blacklist";
import { hasCurrentCreditOriginationTerms } from "@/lib/credit-current-origination-terms";
import {
  buildDataCreditoIdentityHashes, dataCreditoAssessmentMatchesScope, ensureDataCreditoSchema,
  getApprovedDataCreditoAssessmentForCredit, getAssignedDataCreditoPolicy,
  getDataCreditoAssessmentById, hmacDataCreditoValue, normalizeDataCreditoDocument,
  readDataCreditoIdentitySource, type DataCreditoAssessmentMatchInput, type DataCreditoAssessmentRow,
} from "./storage";
import { parseDataCreditoPolicyFinancialSettings, resolveDataCreditoOfferFinancingTerms, type DataCreditoOffer, type DataCreditoPolicy } from "./policy";

// This operational grant is deliberately limited to the one expressly authorized
// source and active request. It is not a general risk-approval endpoint.
export const SINGLE_CASE_RISK_ASSESSMENT_ID = "4d14cb36-dec9-4b08-9532-ed0739bdcbc4";
export const SINGLE_CASE_RISK_SOLICITUD_ID = 4098;
type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Match = DataCreditoAssessmentMatchInput & { solicitudId: number };
export type CreditRiskExceptionRow = {
  id: string; mutationId: string; requestHash: string; solicitudId: number; assessmentId: string;
  documentHash: string; surnameHash: string; platform: "ANDROID" | "IPHONE"; providerEnvironment: string;
  userId: number; sellerId: number | null; sedeId: number; aliadoId: number | null;
  actorUserId: number; reason: string; riskAcknowledged: boolean;
  policyVersion: number; policyRevisionId: string; offer: DataCreditoOffer;
  providerStatus: string; transactionCode: string; historyCode: string; errorCode: string;
  expiresAt: Date; createdAt: Date; updatedAt: Date; revokedAt: Date | null;
  claimedAt: Date | null; claimTokenHash: string | null; claimExpiresAt: Date | null;
  consumedAt: Date | null; creditId: number | null;
};
export type CreditRiskAuthorization = {
  source: "DATACREDITO" | "INTERNAL_EXCEPTION"; assessment: DataCreditoAssessmentRow;
  offer: DataCreditoOffer; policyVersion: number; policyRevisionId: string;
  expiresAt: Date; exceptionId: string | null;
};
export class CreditRiskExceptionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CreditRiskExceptionError"; }
}
function fail(code: string): never { throw new CreditRiskExceptionError(code); }
function uuid(value: unknown) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")); }
function asDate(value: Date | string) { return value instanceof Date ? value : new Date(value); }
function normalizeRow(row: CreditRiskExceptionRow): CreditRiskExceptionRow {
  return { ...row, expiresAt: asDate(row.expiresAt), createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt),
    revokedAt: row.revokedAt ? asDate(row.revokedAt) : null, claimedAt: row.claimedAt ? asDate(row.claimedAt) : null,
    claimExpiresAt: row.claimExpiresAt ? asDate(row.claimExpiresAt) : null, consumedAt: row.consumedAt ? asDate(row.consumedAt) : null };
}
export function buildInternalExceptionOffer(policy: DataCreditoPolicy, platform: "ANDROID" | "IPHONE"): DataCreditoOffer {
  const bands = policy.bands.filter(band => band.platform === platform && band.scoreMin === -1 && band.scoreMax === -1);
  const band = bands[0];
  if (bands.length !== 1 || band.decision !== "APROBADO") fail("RISK_EXCEPTION_NO_INFORMATION_TERMS_NOT_APPROVED");
  const terms = resolveDataCreditoOfferFinancingTerms(platform, band);
  const financialSettings = parseDataCreditoPolicyFinancialSettings(policy.financialSettings);
  if (!terms || !financialSettings || !hasCurrentCreditOriginationTerms(financialSettings) || !Number.isSafeInteger(policy.version) || policy.version < 1 ||
      !Number.isSafeInteger(band.maxFinancedAmount) || band.maxFinancedAmount < 1 || band.maxFinancedAmount > 100_000_000 ||
      !Number.isFinite(band.initialPaymentPercentage) || band.initialPaymentPercentage < 0 || band.initialPaymentPercentage > 100 ||
      !Number.isFinite(band.suretyPercentage) || band.suretyPercentage < 0 || band.suretyPercentage > 100) fail("RISK_EXCEPTION_INVALID_TERMS");
  // Only borrow explicitly authorized financial terms. Never run scoring with a
  // fabricated -1 score or add a SCORE_BAND decision to the provider assessment.
  return { initialPaymentPercentage: band.initialPaymentPercentage, suretyPercentage: band.suretyPercentage,
    maxFinancedAmount: band.maxFinancedAmount, installmentCount: terms.installmentCount,
    maxInstallmentAmount: terms.maxInstallmentAmount, policyVersion: policy.version, financialSettings };
}
function validOffer(row: CreditRiskExceptionRow) {
  try { const offer = row.offer; return !!offer && offer.policyVersion === row.policyVersion &&
    Number.isFinite(offer.initialPaymentPercentage) && offer.initialPaymentPercentage >= 0 && offer.initialPaymentPercentage <= 100 &&
    Number.isFinite(offer.suretyPercentage) && offer.suretyPercentage >= 0 && offer.suretyPercentage <= 100 &&
    Number.isSafeInteger(offer.maxFinancedAmount) && offer.maxFinancedAmount > 0 && offer.maxFinancedAmount <= 100_000_000 &&
    !!resolveDataCreditoOfferFinancingTerms(row.platform, offer) && !!parseDataCreditoPolicyFinancialSettings(offer.financialSettings) && hasCurrentCreditOriginationTerms(offer.financialSettings);
  } catch { return false; }
}
async function lockDocument(db: Database, documentHash: string, providerEnvironment: string) {
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))", `datacredito-document:${providerEnvironment}:${documentHash}`);
}
async function lockDraft(db: Database, solicitudId: number) {
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(177, $1::integer)", solicitudId);
}
async function audit(db: Database, row: CreditRiskExceptionRow, action: string, actorUserId: number | null = null) {
  await db.$executeRawUnsafe('INSERT INTO "CreditRiskExceptionAudit" ("exceptionId","action","actorUserId","solicitudId","assessmentId","documentHash") VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6)', row.id, action, actorUserId, row.solicitudId, row.assessmentId, row.documentHash);
}
// All competing ordinary approvals and exceptions use the same document lock.
async function hasCompetition(db: Database, row: CreditRiskExceptionRow) {
  const rows = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(`SELECT (
    EXISTS (
      SELECT 1 FROM "DataCreditoAssessment" a
      WHERE a."documentHash"=$1 AND a."providerEnvironment"=$2 AND (
        (a."status" IN ('APROBADO','RECHAZADO') AND a."consumedAt" IS NULL AND a."expiresAt">clock_timestamp())
        OR (a."claimTokenHash" IS NOT NULL AND a."claimExpiresAt">clock_timestamp())
        OR (a."consumedAt" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "Credito" c WHERE c."id"=a."creditId" AND (
            c."estado"='ANULADO' OR c."montoCredito"<=GREATEST(0,COALESCE((
              SELECT SUM(p."valor") FROM "CreditoAbono" p WHERE p."creditoId"=c."id" AND p."estado"<>'ANULADO'
            ),0))
          )
        ))
      )
    ) OR EXISTS (
      SELECT 1 FROM "CreditRiskException" e
      WHERE e."documentHash"=$1 AND e."providerEnvironment"=$2 AND e."id"<>$3::uuid AND (
        (e."claimTokenHash" IS NOT NULL AND e."claimExpiresAt">clock_timestamp())
        OR (e."consumedAt" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "Credito" c WHERE c."id"=e."creditId" AND (
            c."estado"='ANULADO' OR c."montoCredito"<=GREATEST(0,COALESCE((
              SELECT SUM(p."valor") FROM "CreditoAbono" p WHERE p."creditoId"=c."id" AND p."estado"<>'ANULADO'
            ),0))
          )
        ))
      )
    )
  ) AS "blocked"`, row.documentHash, row.providerEnvironment, row.id);
  return rows[0]?.blocked !== false;
}async function activeException(input: Omit<Match, "firstSurname"> & { firstSurname?: string }, db: Database) {
  if (input.assessmentId !== SINGLE_CASE_RISK_ASSESSMENT_ID || input.solicitudId !== SINGLE_CASE_RISK_SOLICITUD_ID || !uuid(input.assessmentId) || !Number.isInteger(input.solicitudId) || input.solicitudId < 1 || !/^\d{3,13}$/.test(input.documentNumber)) return null;
  const documentHash = hmacDataCreditoValue("document", input.documentNumber);
  const surnameHash = input.firstSurname === undefined ? null : buildDataCreditoIdentityHashes({ documentNumber: input.documentNumber, firstSurname: input.firstSurname }).surnameHash;
  const rows = await db.$queryRawUnsafe<CreditRiskExceptionRow[]>(`SELECT e.* FROM "CreditRiskException" e
    JOIN "CreditoBorrador" d ON d."id"=e."solicitudId" AND d."creditRiskExceptionId"=e."id"
    JOIN "Sede" s ON s."id"=d."sedeId"
    JOIN "DataCreditoAssessment" a ON a."id"=e."assessmentId"
    WHERE e."solicitudId"=$1 AND e."assessmentId"=$2::uuid AND e."documentHash"=$3 AND ($4::text IS NULL OR e."surnameHash"=$4)
      AND e."platform"=$5 AND e."providerEnvironment"=$6 AND e."userId"=$7
      AND e."sellerId" IS NOT DISTINCT FROM $8::integer AND e."sedeId"=$9 AND e."aliadoId" IS NOT DISTINCT FROM $10::integer
      AND d."estado"='ABIERTO' AND d."creditoId" IS NULL
      AND COALESCE(d."expiresAt",d."createdAt"+INTERVAL '15 days')>clock_timestamp()
      AND d."usuarioId"=e."userId" AND d."vendedorId" IS NOT DISTINCT FROM e."sellerId" AND d."sedeId"=e."sedeId" AND s."aliadoId" IS NOT DISTINCT FROM e."aliadoId"
      AND REGEXP_REPLACE(COALESCE(d."clienteDocumento",''),'[^0-9]','','g')=$11
      AND UPPER(COALESCE(NULLIF(d."plataforma",''),d."payload"->>'plataformaDispositivo'))=e."platform"
      AND d."dataCreditoAssessmentId"=a."id" AND COALESCE(NULLIF(d."payload"->>'dataCreditoAssessmentId',''),a."id"::text)=a."id"::text
      AND a."documentHash"=e."documentHash" AND a."surnameHash"=e."surnameHash" AND a."platform"=e."platform" AND a."providerEnvironment"=e."providerEnvironment"
      AND a."userId"=e."userId" AND a."sellerId" IS NOT DISTINCT FROM e."sellerId" AND a."sedeId"=e."sedeId" AND a."aliadoId" IS NOT DISTINCT FROM e."aliadoId"
      AND a."status"='NO_EVALUADO' AND a."errorCode"='NO_EVALUABLE_INFORMATION' AND a."providerStatus"='ACCEPTED' AND a."transactionCode"='07'
      AND a."score" IS NULL AND a."decision" IS NULL AND a."offer" IS NULL AND a."reusedFromAssessmentId" IS NULL
      AND a."consumedAt" IS NULL AND a."creditId" IS NULL AND a."retainedUntil">clock_timestamp() AND a."expiresAt">clock_timestamp()
      AND e."riskAcknowledged"=TRUE AND e."providerStatus"='ACCEPTED' AND e."transactionCode"='07' AND e."historyCode"='09' AND e."errorCode"='NO_EVALUABLE_INFORMATION'
      AND e."expiresAt">clock_timestamp() AND e."revokedAt" IS NULL AND e."consumedAt" IS NULL AND e."creditId" IS NULL
    LIMIT 1`, input.solicitudId,input.assessmentId,documentHash,surnameHash,input.platform,input.providerEnvironment,input.userId,input.sellerId,input.sedeId,input.aliadoId,input.documentNumber);
  const row = rows[0] ? normalizeRow(rows[0]) : null;
  return row && validOffer(row) ? row : null;
}
export async function getActiveCreditRiskExceptionForDraft(input: Omit<Match, "firstSurname"> & { firstSurname?: string }) {
  await ensureDataCreditoSchema();
  return activeException(input, prisma);
}
export async function getCreditRiskAuthorizationForDraft(input: Match): Promise<CreditRiskAuthorization | null> {
  await ensureDataCreditoSchema();
  const exception = await activeException(input, prisma);
  if (exception) {
    const assessment = await getDataCreditoAssessmentById(exception.assessmentId);
    if (!assessment) return null;
    return { source: "INTERNAL_EXCEPTION", assessment, offer: exception.offer, policyVersion: exception.policyVersion,
      policyRevisionId: exception.policyRevisionId, expiresAt: exception.expiresAt, exceptionId: exception.id };
  }
  // Preserve the normal matching path; an invalid exception cannot turn an
  // original NO_EVALUADO assessment into an ordinary approval.
  const assessment = await getApprovedDataCreditoAssessmentForCredit(input);
  if (!assessment?.offer) return null;
  const drafts = await prisma.$queryRawUnsafe<Array<{ id: number }>>(`SELECT d."id" FROM "CreditoBorrador" d JOIN "Sede" s ON s."id"=d."sedeId"
    WHERE d."id"=$1 AND d."estado"='ABIERTO' AND d."creditoId" IS NULL AND COALESCE(d."expiresAt",d."createdAt"+INTERVAL '15 days')>clock_timestamp()
    AND COALESCE(d."dataCreditoAssessmentId"::text,NULLIF(d."payload"->>'dataCreditoAssessmentId',''))=$2::text AND (NULLIF(d."payload"->>'dataCreditoAssessmentId','') IS NULL OR d."payload"->>'dataCreditoAssessmentId'=$2::text) AND REGEXP_REPLACE(COALESCE(d."clienteDocumento",''),'[^0-9]','','g')=$3
    AND d."usuarioId"=$4 AND d."vendedorId" IS NOT DISTINCT FROM $5::integer AND d."sedeId"=$6 AND s."aliadoId" IS NOT DISTINCT FROM $7::integer
    AND UPPER(COALESCE(NULLIF(d."plataforma",''),d."payload"->>'plataformaDispositivo'))=$8 LIMIT 1`,
    input.solicitudId,input.assessmentId,input.documentNumber,input.userId,input.sellerId,input.sedeId,input.aliadoId,input.platform);
  return drafts[0] ? { source: "DATACREDITO", assessment, offer: assessment.offer, policyVersion: assessment.policyVersion,
    policyRevisionId: assessment.policyRevisionId, expiresAt: asDate(assessment.expiresAt), exceptionId: null } : null;
}
function transactionCode(payload: unknown, key: string) {
  const root = payload as { content?: { infoTransaccion?: { codigosRespuesta?: Array<{ clave?: unknown; valor?: unknown }> } } };
  const codes = root?.content?.infoTransaccion?.codigosRespuesta;
  if (!Array.isArray(codes)) return null;
  const matches = codes.filter(item => item && typeof item.clave === "string" && item.clave.trim().toUpperCase() === key);
  return matches.length === 1 && typeof matches[0].valor === "string" ? matches[0].valor.trim() : null;
}
export async function createSingleCaseCreditRiskException(input: {
  solicitudId: number; assessmentId: string; documentNumber: string; actorUserId: number;
  reason: string; riskAcknowledged: true; mutationId: string;
}) {
  if (input.solicitudId !== SINGLE_CASE_RISK_SOLICITUD_ID || input.assessmentId !== SINGLE_CASE_RISK_ASSESSMENT_ID ||
      !uuid(input.mutationId) || input.riskAcknowledged !== true || !Number.isInteger(input.actorUserId) || input.actorUserId < 1 ||
      normalizeDataCreditoDocument(input.documentNumber) !== input.documentNumber || !/^\d{3,13}$/.test(input.documentNumber)) fail("RISK_EXCEPTION_CASE_NOT_AUTHORIZED");
  const reason = String(input.reason || "").normalize("NFC").replace(/\s+/g," ").trim();
  if (reason.length < 10 || reason.length > 500) fail("RISK_EXCEPTION_REASON_REQUIRED");
  await ensureDataCreditoSchema();
  const assessment = await getDataCreditoAssessmentById(input.assessmentId);
  if (!assessment || assessment.status !== "NO_EVALUADO" || assessment.errorCode !== "NO_EVALUABLE_INFORMATION" ||
      assessment.providerStatus !== "ACCEPTED" || assessment.transactionCode !== "07" || assessment.score !== null || assessment.decision !== null ||
      assessment.offer !== null || assessment.reusedFromAssessmentId || assessment.consumedAt || assessment.creditId || assessment.claimTokenHash) fail("RISK_EXCEPTION_SOURCE_NOT_ELIGIBLE");
  const source = await readDataCreditoIdentitySource(assessment);
  if (!source || source.documentNumber !== input.documentNumber || transactionCode(source.providerPayload,"HC") !== "09" || transactionCode(source.providerPayload,"TX") !== "07") fail("RISK_EXCEPTION_PROVIDER_SOURCE_MISMATCH");
  const hashes = buildDataCreditoIdentityHashes({ documentNumber: input.documentNumber, firstSurname: source.firstSurname });
  if (hashes.documentHash !== assessment.documentHash || hashes.surnameHash !== assessment.surnameHash) fail("RISK_EXCEPTION_PROVIDER_SOURCE_MISMATCH");
  const assigned = await getAssignedDataCreditoPolicy(assessment.aliadoId);
  if (assigned.kind !== "READY") fail("RISK_EXCEPTION_POLICY_UNAVAILABLE");
  const offer = buildInternalExceptionOffer(assigned.policy, assessment.platform);
  const requestHash = createHash("sha256").update(JSON.stringify([input.solicitudId,input.assessmentId,hashes.documentHash,input.actorUserId,reason,true])).digest("hex");
  return prisma.$transaction(async tx => {
    await lockDraft(tx,input.solicitudId); await lockDocument(tx,assessment.documentHash,assessment.providerEnvironment);
    const actors = await tx.$queryRawUnsafe<Array<{ id: number }>>(`SELECT u."id" FROM "Usuario" u JOIN "Rol" r ON r."id"=u."rolId" JOIN "Sede" s ON s."id"=u."sedeId" JOIN "Aliado" a ON a."id"=s."aliadoId"
      WHERE u."id"=$1 AND u."activo"=TRUE AND s."activa"=TRUE AND a."activo"=TRUE AND UPPER(r."nombre")='ADMIN' AND UPPER(a."codigo")='FINSERPAY' FOR SHARE OF u,s,a`,input.actorUserId);
    if (!actors[0]) fail("RISK_EXCEPTION_CENTRAL_ADMIN_REQUIRED");
    const replay = await tx.$queryRawUnsafe<CreditRiskExceptionRow[]>('SELECT * FROM "CreditRiskException" WHERE "mutationId"=$1::uuid FOR UPDATE',input.mutationId);
    if (replay[0]) { if(replay[0].requestHash !== requestHash) fail("RISK_EXCEPTION_MUTATION_CONFLICT"); return { exception: normalizeRow(replay[0]), idempotent:true }; }
    const drafts = await tx.$queryRawUnsafe<Array<{ id: number; expiresAt: Date }>>(`SELECT d."id",LEAST(COALESCE(d."expiresAt",d."createdAt"+INTERVAL '15 days'),a."expiresAt",a."retainedUntil",clock_timestamp()+INTERVAL '15 days') AS "expiresAt"
      FROM "CreditoBorrador" d JOIN "Sede" s ON s."id"=d."sedeId" JOIN "DataCreditoAssessment" a ON a."id"=$2::uuid
      WHERE d."id"=$1 AND d."estado"='ABIERTO' AND d."creditoId" IS NULL AND COALESCE(d."expiresAt",d."createdAt"+INTERVAL '15 days')>clock_timestamp()
      AND d."usuarioId"=a."userId" AND d."vendedorId" IS NOT DISTINCT FROM a."sellerId" AND d."sedeId"=a."sedeId" AND s."aliadoId" IS NOT DISTINCT FROM a."aliadoId"
      AND REGEXP_REPLACE(COALESCE(d."clienteDocumento",''),'[^0-9]','','g')=$3 AND UPPER(COALESCE(NULLIF(d."plataforma",''),d."payload"->>'plataformaDispositivo'))=a."platform"
      AND (d."dataCreditoAssessmentId" IS NULL OR d."dataCreditoAssessmentId"=a."id")
      AND (NULLIF(d."payload"->>'dataCreditoAssessmentId','') IS NULL OR d."payload"->>'dataCreditoAssessmentId'=a."id"::text)
      AND d."creditRiskExceptionId" IS NULL AND a."documentHash"=$4 AND a."surnameHash"=$5 AND a."status"='NO_EVALUADO'
      AND a."errorCode"='NO_EVALUABLE_INFORMATION' AND a."providerStatus"='ACCEPTED' AND a."transactionCode"='07'
      AND a."score" IS NULL AND a."decision" IS NULL AND a."offer" IS NULL AND a."reusedFromAssessmentId" IS NULL
      AND a."claimTokenHash" IS NULL AND a."consumedAt" IS NULL AND a."creditId" IS NULL AND a."expiresAt">clock_timestamp() AND a."retainedUntil">clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM "FirmaSeguroProcess" f WHERE f."draftId"=d."id")
      FOR UPDATE OF d,a`,input.solicitudId,input.assessmentId,input.documentNumber,hashes.documentHash,hashes.surnameHash);
    if (!drafts[0]) fail("RISK_EXCEPTION_DRAFT_NOT_ELIGIBLE");
    await assertDocumentNotBlacklisted(input.documentNumber,tx);
    const profiles = await tx.$queryRawUnsafe<Array<{id:string}>>('SELECT "id" FROM "DataCreditoPolicyProfile" WHERE "id"=$1::uuid AND "active"=TRUE FOR SHARE',assigned.policy.profileId);
    if (!profiles[0]) fail("RISK_EXCEPTION_POLICY_CHANGED");
    const policies = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT r."id" FROM "Aliado" a JOIN "DataCreditoPolicyRevision" r ON r."profileId"=a."dataCreditoPolicyId"
      WHERE a."id"=$1 AND r."id"=$2::uuid AND NOT EXISTS(SELECT 1 FROM "DataCreditoPolicyRevision" n WHERE n."profileId"=r."profileId" AND n."version">r."version") FOR SHARE OF a`,assessment.aliadoId,assigned.policy.revisionId);
    if (!policies[0]) fail("RISK_EXCEPTION_POLICY_CHANGED");
    const id=randomUUID();
    const row: CreditRiskExceptionRow = { id,mutationId:input.mutationId,requestHash,solicitudId:input.solicitudId,assessmentId:assessment.id,
      documentHash:assessment.documentHash,surnameHash:assessment.surnameHash,platform:assessment.platform,providerEnvironment:assessment.providerEnvironment,
      userId:assessment.userId,sellerId:assessment.sellerId,sedeId:assessment.sedeId,aliadoId:assessment.aliadoId,actorUserId:input.actorUserId,reason,riskAcknowledged:true,
      policyVersion:assigned.policy.version,policyRevisionId:assigned.policy.revisionId,offer,providerStatus:"ACCEPTED",transactionCode:"07",historyCode:"09",errorCode:"NO_EVALUABLE_INFORMATION",
      expiresAt:asDate(drafts[0].expiresAt),createdAt:new Date(),updatedAt:new Date(),revokedAt:null,claimedAt:null,claimTokenHash:null,claimExpiresAt:null,consumedAt:null,creditId:null };
    if (await hasCompetition(tx,row)) fail("RISK_EXCEPTION_DOCUMENT_IN_USE");
    const inserted=await tx.$queryRawUnsafe<CreditRiskExceptionRow[]>(`INSERT INTO "CreditRiskException" ("id","mutationId","requestHash","solicitudId","assessmentId","documentHash","surnameHash","platform","providerEnvironment","userId","sellerId","sedeId","aliadoId","actorUserId","reason","riskAcknowledged","policyVersion","policyRevisionId","offer","providerStatus","transactionCode","historyCode","errorCode","expiresAt")
      VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$16,$17::uuid,$18::jsonb,'ACCEPTED','07','09','NO_EVALUABLE_INFORMATION',$19) RETURNING *`,id,input.mutationId,requestHash,row.solicitudId,row.assessmentId,row.documentHash,row.surnameHash,row.platform,row.providerEnvironment,row.userId,row.sellerId,row.sedeId,row.aliadoId,row.actorUserId,row.reason,row.policyVersion,row.policyRevisionId,JSON.stringify(offer),row.expiresAt);
    const exception=normalizeRow(inserted[0]);
    await tx.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "creditRiskExceptionId"=$2::uuid,"dataCreditoAssessmentId"=$3::uuid,"dataCreditoStatus"='NO_EVALUADO',"dataCreditoErrorCode"='NO_EVALUABLE_INFORMATION',
      "payload"="payload"||jsonb_build_object('creditRiskExceptionId',$2::text,'creditAuthorizationSource','INTERNAL_EXCEPTION','dataCreditoAssessmentId',$3::text,'dataCreditoStatus','NO_EVALUADO','dataCreditoErrorCode','NO_EVALUABLE_INFORMATION'),"updatedAt"=clock_timestamp() WHERE "id"=$1`,input.solicitudId,id,assessment.id);
    await audit(tx,exception,"AUTHORIZED",input.actorUserId);
    return { exception,idempotent:false };
  });
}
export async function claimCreditRiskException(input: Match & { exceptionId: string; actorUserId?: number }) {
  if (!uuid(input.exceptionId)) return null;
  await ensureDataCreditoSchema();
  return prisma.$transaction(async tx => {
    await lockDocument(tx,hmacDataCreditoValue("document",input.documentNumber),input.providerEnvironment);
    const exception=await activeException(input,tx);
    if (!exception || exception.id!==input.exceptionId || await hasCompetition(tx,exception)) return null;
    const claimToken=randomBytes(32).toString("base64url"); const hash=hmacDataCreditoValue("risk-exception-claim",claimToken);
    const rows=await tx.$queryRawUnsafe<CreditRiskExceptionRow[]>(`UPDATE "CreditRiskException" SET "claimedAt"=clock_timestamp(),"claimTokenHash"=$2,"claimExpiresAt"=LEAST("expiresAt",clock_timestamp()+INTERVAL '5 minutes'),"updatedAt"=clock_timestamp()
      WHERE "id"=$1::uuid AND "consumedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp() AND ("claimTokenHash" IS NULL OR "claimExpiresAt"<=clock_timestamp()) RETURNING *`,exception.id,hash);
    if(!rows[0]) return null;
    const row=normalizeRow(rows[0]); await audit(tx,row,"CLAIMED",input.actorUserId??null); return {exception:row,claimToken};
  });
}
export async function consumeCreditRiskException(input: Match & {exceptionId:string;claimToken:string;creditId:number;actorUserId?:number},tx:Prisma.TransactionClient) {
  if(!uuid(input.exceptionId)||!input.claimToken||!Number.isInteger(input.creditId)||input.creditId<1)return false;
  await lockDocument(tx,hmacDataCreditoValue("document",input.documentNumber),input.providerEnvironment);
  const exception=await activeException(input,tx);
  if(!exception||exception.id!==input.exceptionId||await hasCompetition(tx,exception))return false;
  const credits=await tx.$queryRawUnsafe<Array<{id:number}>>(`SELECT "id" FROM "Credito" WHERE "id"=$1 AND REGEXP_REPLACE(COALESCE("clienteDocumento",''),'[^0-9]','','g')=$2 AND "usuarioId"=$3 AND "sedeId"=$4 LIMIT 1`,input.creditId,input.documentNumber,input.userId,input.sedeId);
  if(!credits[0])return false;
  const rows=await tx.$queryRawUnsafe<CreditRiskExceptionRow[]>(`UPDATE "CreditRiskException" SET "consumedAt"=clock_timestamp(),"creditId"=$3,"claimTokenHash"=NULL,"claimExpiresAt"=NULL,"updatedAt"=clock_timestamp()
    WHERE "id"=$1::uuid AND "claimTokenHash"=$2 AND "claimExpiresAt">clock_timestamp() AND "consumedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp() RETURNING *`,exception.id,hmacDataCreditoValue("risk-exception-claim",input.claimToken),input.creditId);
  if(!rows[0])return false;
  await audit(tx,normalizeRow(rows[0]),"CONSUMED",input.actorUserId??null);return true;
}
export async function releaseCreditRiskException(input: Match & {exceptionId:string;claimToken:string;actorUserId?:number}) {
  if(!uuid(input.exceptionId)||!input.claimToken)return;
  await ensureDataCreditoSchema();
  await prisma.$transaction(async tx=>{
    await lockDocument(tx,hmacDataCreditoValue("document",input.documentNumber),input.providerEnvironment);
    const rows=await tx.$queryRawUnsafe<CreditRiskExceptionRow[]>(`UPDATE "CreditRiskException" SET "claimTokenHash"=NULL,"claimExpiresAt"=NULL,"updatedAt"=clock_timestamp()
      WHERE "id"=$1::uuid AND "claimTokenHash"=$2 AND "solicitudId"=$3 AND "assessmentId"=$4::uuid AND "documentHash"=$5 AND "userId"=$6 AND "sellerId" IS NOT DISTINCT FROM $7::integer AND "sedeId"=$8 AND "aliadoId" IS NOT DISTINCT FROM $9::integer AND "platform"=$10 AND "providerEnvironment"=$11 AND "consumedAt" IS NULL RETURNING *`,
      input.exceptionId,hmacDataCreditoValue("risk-exception-claim",input.claimToken),input.solicitudId,input.assessmentId,hmacDataCreditoValue("document",input.documentNumber),input.userId,input.sellerId,input.sedeId,input.aliadoId,input.platform,input.providerEnvironment);
    if(rows[0])await audit(tx,normalizeRow(rows[0]),"RELEASED",input.actorUserId??null);
  });
}
