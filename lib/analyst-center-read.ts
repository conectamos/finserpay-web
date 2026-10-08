import "server-only";
import prisma from "@/lib/prisma";
import { getOperationalCase, searchOperationalCases } from "@/lib/approval-operations-read";
import type { AnalystCenterCase, AnalystCenterCaseDetail, AnalystCenterWelcome } from "@/lib/analyst-center-types";

type Database = Pick<typeof prisma, "$queryRawUnsafe">;
type IdentityRow = {
  id: number;
  folio: string | null;
  numeroSadmin: string | null;
  clientName: string | null;
  document: string | null;
  phone: string | null;
  email: string | null;
  status: string | null;
  equipment: string | null;
  imei: string | null;
  updatedAt: Date | string;
};
type CreditCreationRow = {
  folio: string;
  numeroSadmin: string | null;
  hasFinishedDraft: boolean;
  hasCommittedImport: boolean;
};

const creditIdentities = `SELECT credit."id",credit."folio",
  NULLIF(BTRIM(sadmin."numeroCredito"),'') AS "numeroSadmin",
  credit."clienteNombre" AS "clientName",credit."clienteDocumento" AS "document",
  credit."clienteTelefono" AS "phone",credit."clienteCorreo" AS "email",credit."estado" AS "status",
  COALESCE(NULLIF(BTRIM(credit."referenciaEquipo"),''),
    NULLIF(BTRIM(CONCAT_WS(' ',credit."equipoMarca",credit."equipoModelo")),'')) AS "equipment",
  credit."imei",credit."updatedAt"
  FROM "Credito" credit
  LEFT JOIN "CreditSadminRegistration" sadmin ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"
  WHERE credit."id"=ANY($1::int[])`;

const draftIdentities = `SELECT draft."id",NULL::text AS "folio",NULL::text AS "numeroSadmin",
  COALESCE(NULLIF(BTRIM(draft."clienteNombre"),''),draft."payload"->>'clienteNombre') AS "clientName",
  COALESCE(NULLIF(BTRIM(draft."clienteDocumento"),''),draft."payload"->>'clienteDocumento') AS "document",
  COALESCE(NULLIF(BTRIM(draft."clienteTelefono"),''),draft."payload"->>'clienteTelefono') AS "phone",
  draft."payload"->>'clienteCorreo' AS "email",
  CASE WHEN draft."currentStep"=3 THEN 'Identidad y firma' ELSE 'Paso '||draft."currentStep"::text END AS "status",
  COALESCE(NULLIF(BTRIM(draft."payload"->>'referenciaEquipo'),''),
    NULLIF(BTRIM(CONCAT_WS(' ',draft."payload"->>'equipoMarca',draft."payload"->>'equipoModelo')),'')) AS "equipment",
  COALESCE(NULLIF(BTRIM(draft."imei"),''),draft."payload"->>'imei') AS "imei",draft."updatedAt"
  FROM "CreditoBorrador" draft
  WHERE draft."id"=ANY($1::int[]) AND draft."estado"='ABIERTO' AND draft."creditoId" IS NULL
    AND draft."currentStep" IN (3,4,5)
    AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP`;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The existing search supplies the allowed case set. Only nominal center GETs use this full DTO. */
export async function searchAnalystCenterCases(value: unknown, db: Database = prisma): Promise<AnalystCenterCase[]> {
  const candidates = await searchOperationalCases(value, db);
  const creditIds = candidates.filter(item => item.kind === "CREDIT").map(item => item.id);
  const draftIds = candidates.filter(item => item.kind === "DRAFT").map(item => item.id);
  const [credits, drafts] = await Promise.all([
    creditIds.length ? db.$queryRawUnsafe<IdentityRow[]>(creditIdentities, creditIds) : Promise.resolve([]),
    draftIds.length ? db.$queryRawUnsafe<IdentityRow[]>(draftIdentities, draftIds) : Promise.resolve([]),
  ]);
  const identities = new Map([
    ...credits.map(row => [`CREDIT:${row.id}`, row] as const),
    ...drafts.map(row => [`DRAFT:${row.id}`, row] as const),
  ]);
  return candidates.flatMap(item => {
    const row = identities.get(`${item.kind}:${item.id}`);
    // A draft that closed/expired between the two reads must disappear.
    if (!row) return [];
    const numeroSadmin = text(row.numeroSadmin);
    const folio = text(row.folio);
    return [{ ...item, creditId: item.kind === "CREDIT" ? item.id : null, folio, numeroSadmin,
      number: numeroSadmin || folio || item.number,
      clientName: text(row.clientName) || item.clientName,
      document: text(row.document)?.replace(/[.\s]/g, "") || null,
      phone: text(row.phone), email: text(row.email), status: text(row.status) || item.status,
      equipment: text(row.equipment) || item.equipment, imei: text(row.imei) || "",
      updatedAt: new Date(row.updatedAt).toISOString(),
    }];
  });
}

const creditCreation = `SELECT credit."folio",NULLIF(BTRIM(sadmin."numeroCredito"),'') AS "numeroSadmin",
  EXISTS (SELECT 1 FROM "CreditoBorrador" draft WHERE draft."creditoId"=credit."id"
    AND draft."estado"='CERRADO' AND draft."closedReason"='FINALIZADA') AS "hasFinishedDraft",
  (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA'
    AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA') AS "hasCommittedImport"
  FROM "Credito" credit
  LEFT JOIN "CreditSadminRegistration" sadmin ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"
  WHERE credit."id"=$1`;

export async function getAnalystCenterCase(kind: unknown, id: unknown, db: Database = prisma): Promise<{
  item: AnalystCenterCaseDetail; welcome: AnalystCenterWelcome;
}> {
  // Preserve the operational reader's real permission gates and stored signature evidence.
  const detail = await getOperationalCase(kind, id, db);
  const row = detail.kind === "CREDIT"
    ? (await db.$queryRawUnsafe<CreditCreationRow[]>(creditCreation, detail.id))[0] : null;
  const creditFinalized = detail.kind === "CREDIT" &&
    (row?.hasFinishedDraft === true || row?.hasCommittedImport === true);
  return {
    item: { ...detail, document: text(detail.document)?.replace(/[.\s]/g, "") || null,
      folio: text(row?.folio), numeroSadmin: text(row?.numeroSadmin) },
    welcome: {
      creditFinalized, available: false,
      // Welcome delivery is automatic at commit. There is no manual send endpoint or reliable welcome ledger.
      reason: creditFinalized ? "Bienvenida se gestiona dentro de Aprobaciones."
        : "Disponible cuando finalice la creación del crédito.",
    },
  };
}
