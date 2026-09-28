import { createHash, randomUUID } from "node:crypto";
import { readCommissionBags } from "./commission-portfolio";
import {
  COMMISSION_STARTS_AT, COMMISSION_RECEIPT_MAX_BYTES, CommissionError,
  calculateCommissionPeriod, commissionPeriodAt, commissionsAreActive, validateCommissionRequest,
  type AdminCommissionBag, type AdminCommissionRequest, type CommissionPeriod, type CommissionRequest,
  type CommissionReceiptInput, type CreateCommissionRequestInput, type SellerCommissionDashboard,
} from "./commissions";

export { CommissionError } from "./commissions";

/** Narrow interface allows real PostgreSQL integration tests without global state. */
export interface CommissionDbClient {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}
export interface CommissionDatabase extends CommissionDbClient {
  $transaction<T>(fn: (tx: CommissionDbClient) => Promise<T>, options?: { timeout: number; maxWait: number }): Promise<T>;
}
type Credit = { id: number; code: string; finalizedAt: string; branchName: string; branchId?: number; allyId?: number | null };
type RequestRow = {
  id: string; sellerId: number; period: string; amount: bigint | number; nequi: string;
  status: CommissionRequest["status"]; createdAt: Date | string;
  rejectionReason: string | null; paidAt: Date | string | null;
  receiptFileName: string | null; credits: Credit[]; idempotencyKey: string;
};
type PeriodRow = { period: string; creditCount: number; rate: number; generated: bigint | number; credits: Credit[] };
const iso = (value: Date | string) => new Date(value).toISOString();
const requestSelection = `SELECT r.*, p."receiptFileName" FROM "CommissionRequest" r
  LEFT JOIN "CommissionPayment" p ON p."requestId" = r.id`;
const finalizedStates = "'ENTREGABLE','ENTREGADO','FINALIZADO','ACTIVO','AL_DIA','MORA','MORA_BLOQUEADO','ROBO_BLOQUEADO','PAGADO','PAZ_Y_SALVO'";

function serializeRequest(row: RequestRow): CommissionRequest {
  return {
    id: row.id, period: row.period, amount: Number(row.amount), nequi: row.nequi,
    status: row.status, createdAt: iso(row.createdAt),
    // Free-form internal review notes may contain private portfolio indicators.
    rejectionReason: row.status === "REJECTED" ? "La solicitud fue rechazada. Revisa tus datos e intenta nuevamente." : null,
    paidAt: row.paidAt ? iso(row.paidAt) : null, receiptFileName: row.receiptFileName,
    receiptUrl: row.status === "PAID" && row.receiptFileName
      ? `/api/comisiones/solicitudes/${row.id}/comprobante` : null,
  };
}

function requireActive(now: Date) {
  if (!commissionsAreActive(now)) throw new CommissionError("Las comisiones comienzan el 1 de octubre de 2026.", 409, "COMMISSION_NOT_STARTED");
}
function validateId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new CommissionError("Solicitud no encontrada.", 404);
  }
}

function validateReceipt(receipt: CommissionReceiptInput) {
  if (!receipt || typeof receipt.base64 !== "string" || receipt.base64.length > Math.ceil(COMMISSION_RECEIPT_MAX_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.base64)) {
    throw new CommissionError("Debes adjuntar un comprobante válido de máximo 5 MB.");
  }
  const bytes = Buffer.from(receipt.base64, "base64");
  const mime = receipt.mimeType;
  const valid = mime === "application/pdf" ? bytes.subarray(0, 5).toString() === "%PDF-"
    : mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : false;
  if (!valid || bytes.length < 12 || bytes.length > COMMISSION_RECEIPT_MAX_BYTES) {
    throw new CommissionError("El comprobante debe ser PDF, PNG o JPEG, de máximo 5 MB.");
  }
  const name = String(receipt.fileName || "comprobante").replace(/[\x00-\x1f\x7f/\\"<>]/g, "_").slice(0, 150);
  return { fileName: name || "comprobante", mimeType: mime, base64: bytes.toString("base64"), hash: createHash("sha256").update(bytes).digest("hex") };
}

async function lockSeller(tx: CommissionDbClient, sellerId: number, requireActiveSeller = true) {
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0) throw new CommissionError("Vendedor no válido.", 403);
  await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(721042, 1)`);
  await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(721041, $1::integer)`, sellerId);
  const sellers = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM "Vendedor" WHERE id=$1 AND (activo=true OR $2::boolean=false)`, sellerId, requireActiveSeller);
  if (!sellers.length) throw new CommissionError("Vendedor no disponible.", 403);
}

async function assertAdmin(tx: CommissionDbClient, actorId: number) {
  const rows = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT u.id FROM "Usuario" u
    JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.id=$1 AND u.activo=true AND upper(trim(r.nombre))='ADMIN' AND upper(trim(a.codigo))='FINSERPAY'`, actorId);
  if (!rows.length) throw new CommissionError("Solo el administrador central FINSER PAY puede gestionar pagos.", 403);
}

async function audit(tx: CommissionDbClient, sellerId: number, period: string, action: string, payload: unknown, now: Date, requestId: string | null = null, actorId: number | null = null) {
  await tx.$executeRawUnsafe(`INSERT INTO "CommissionAudit"("sellerId","period","requestId","actorId","action","payload","createdAt")
    VALUES($1,$2,$3::uuid,$4,$5,$6::jsonb,$7::timestamptz)`, sellerId, period, requestId, actorId, action, JSON.stringify(payload), now.toISOString());
}

/** Canonical credits are ranked globally before filtering seller, so replays
 * assigned to another seller cannot create a second commission. */
async function readCredits(tx: CommissionDbClient, sellerId: number, now: Date) {
  return tx.$queryRawUnsafe<(Credit & { period: string })[]>(`
    WITH candidates AS (
      SELECT c.id, c.folio AS code, c."vendedorId", origin_s.nombre AS "branchName",origin_s.id AS "branchId",
        COALESCE((j.snapshot->>'originAllyId')::integer,origin_s."aliadoId") AS "allyId",
        COALESCE(j."finalizedAt", GREATEST(c."createdAt",c."contratoAceptadoAt",c."pagareAceptadoAt") AT TIME ZONE 'UTC') AS finalized,
        COALESCE('solicitud:'||NULLIF(c."contratoSnapshot"#>>'{comisiones,solicitudId}',''),
          'solicitud:'||NULLIF(c."contratoSnapshot"->>'solicitudId',''),
          'firma:'||NULLIF(c."contratoSnapshot"#>>'{firma,procesoUuid}',''),
          'assessment:'||NULLIF(c."contratoSnapshot"#>>'{comisiones,dataCreditoAssessmentId}',''), 'folio:'||c.folio) AS operation,
        regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g') || ':' || c.imei AS identity,
        c."createdAt",
        (c."vendedorId" IS NOT NULL AND c."contratoAceptadoAt" IS NOT NULL AND c."pagareAceptadoAt" IS NOT NULL
        AND (c."deliverableReady"=true OR j."finalizedAt" IS NOT NULL) AND c."montoCredito">0
        AND (upper(c.estado) IN (${finalizedStates}) OR (upper(c.estado) IN ('GENERADO','INSCRITO') AND j."finalizedAt" IS NOT NULL))
        AND c."createdAt" >= $2::timestamptz AT TIME ZONE 'UTC'
        AND c."fechaCredito" >= $2::timestamptz AT TIME ZONE 'UTC'
        AND COALESCE(j."isTest",false)=false
        AND COALESCE(c."contratoSnapshot"#>>'{comisiones,isTest}','false') <> 'true'
        AND COALESCE(c."contratoSnapshot"->>'isTest','false') <> 'true'
        AND COALESCE(c."contratoSnapshot"->>'testMode','false') <> 'true'
        AND COALESCE(c."contratoSnapshot"->>'modoPrueba','false') <> 'true'
        AND COALESCE(c."contratoSnapshot"->>'duplicateOfCreditId','') = ''
        AND upper(c."clienteNombre") !~ '(^|[^A-Z])(PRUEBA[S]?|TEST|DEMO)([^A-Z]|$)'
        AND COALESCE(c."observacionAdmin",'') NOT ILIKE '%modo prueba%') AS eligible
      FROM "Credito" c JOIN "Sede" s ON s.id=c."sedeId"
      LEFT JOIN "CommissionCreditSource" j ON j."creditId"=c.id
      LEFT JOIN "Sede" origin_s ON origin_s.id=COALESCE((j.snapshot->>'originBranchId')::integer,(j.snapshot->>'branchId')::integer,c."sedeId")
    ), ranked AS (
      SELECT *,row_number() OVER(PARTITION BY operation ORDER BY "createdAt",id) AS operation_rank,
        row_number() OVER(PARTITION BY identity ORDER BY "createdAt",id) AS identity_rank FROM candidates
    ) SELECT id,code,"branchName","branchId","allyId",finalized AS "finalizedAt",to_char(finalized AT TIME ZONE 'America/Bogota','YYYY-MM') AS period
      FROM ranked WHERE "vendedorId"=$1 AND eligible=true AND operation_rank=1 AND identity_rank=1 AND finalized >= $2::timestamptz AND finalized <= $3::timestamptz
      ORDER BY finalized,id`, sellerId, COMMISSION_STARTS_AT, now.toISOString());
}

async function syncPeriods(tx: CommissionDbClient, sellerId: number, now: Date): Promise<CommissionPeriod[]> {
  const credits = await readCredits(tx, sellerId, now);
  const existing = await tx.$queryRawUnsafe<PeriodRow[]>(`SELECT * FROM "CommissionPeriod" WHERE "sellerId"=$1`, sellerId);
  const periods = new Set([commissionPeriodAt(now), ...existing.map(row => row.period), ...credits.map(credit => credit.period)]);
  const result: CommissionPeriod[] = [];
  for (const period of Array.from(periods).sort().reverse()) {
    const included: Credit[] = credits.filter(credit => credit.period === period).map(credit => ({
      id: credit.id, code: credit.code, finalizedAt: iso(credit.finalizedAt), branchName: credit.branchName, branchId: credit.branchId, allyId: credit.allyId,
    }));
    const previous = existing.find(row => row.period === period);
    const calculated = calculateCommissionPeriod(period, included.length);
    const previousCredits = previous?.credits.map(credit => ({ id: credit.id, code: credit.code, finalizedAt: iso(credit.finalizedAt), branchName: credit.branchName, branchId: credit.branchId, allyId: credit.allyId }));
    if (!previous || previous.creditCount !== included.length || JSON.stringify(previousCredits) !== JSON.stringify(included)) {
      await tx.$executeRawUnsafe(`INSERT INTO "CommissionPeriod"("sellerId","period","creditCount","rate","generated","credits","updatedAt")
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
        ON CONFLICT ("sellerId","period") DO UPDATE SET "creditCount"=EXCLUDED."creditCount","rate"=EXCLUDED."rate",
        "generated"=EXCLUDED."generated","credits"=EXCLUDED."credits","updatedAt"=EXCLUDED."updatedAt"`,
        sellerId, period, included.length, calculated.rate, calculated.generated, JSON.stringify(included), now.toISOString());
      await audit(tx, sellerId, period, previous && previous.rate !== calculated.rate ? "RATE_CHANGED" : "CREDITS_RECALCULATED",
        { previous: previous ? { count: previous.creditCount, rate: previous.rate, generated: Number(previous.generated), credits: previous.credits } : null,
          current: { count: included.length, rate: calculated.rate, generated: calculated.generated, credits: included } }, now);
    }
    const requests = await tx.$queryRawUnsafe<RequestRow[]>(`${requestSelection} WHERE r."sellerId"=$1 AND r.period=$2 ORDER BY r."createdAt",r.id`, sellerId, period);
    const paid = requests.filter(row => row.status === "PAID").reduce((sum, row) => sum + Number(row.amount), 0);
    let capacity = Math.max(0, calculated.generated - paid);
    let reserved = 0;
    for (const request of requests.filter(row => row.status === "PENDING")) {
      const amount = Number(request.amount);
      if (amount > capacity) {
        const reason = "Reserva liberada por anulación o ajuste de los créditos que respaldaban la comisión.";
        await tx.$executeRawUnsafe(`UPDATE "CommissionRequest" SET status='REJECTED',"rejectionReason"=$2,"reviewedAt"=$3::timestamptz WHERE id=$1::uuid AND status='PENDING'`, request.id, reason, now.toISOString());
        await audit(tx, sellerId, period, "REQUEST_ADJUSTED", { amount, reason }, now, request.id);
      } else { reserved += amount; capacity -= amount; }
    }
    result.push(calculateCommissionPeriod(period, included.length, paid, reserved));
  }
  return result;
}

export function createCommissionStore(db: CommissionDatabase, clock: () => Date = () => new Date()) {
  const transaction = <T>(fn: (tx: CommissionDbClient) => Promise<T>) => db.$transaction(fn, { timeout: 30000, maxWait: 15000 });
  async function findRequest(tx: CommissionDbClient, id: string) {
    const rows = await tx.$queryRawUnsafe<RequestRow[]>(`${requestSelection} WHERE r.id=$1::uuid`, id);
    if (!rows[0]) throw new CommissionError("Solicitud no encontrada.", 404);
    return rows[0];
  }
  return {
    async getSellerCommissionDashboard(sellerId: number): Promise<SellerCommissionDashboard> {
      const now = clock();
      const base = { active: commissionsAreActive(now), startsAt: COMMISSION_STARTS_AT, serverNow: now.toISOString(), currentPeriod: commissionPeriodAt(now), payoutsPaused: false };
      if (!base.active) return { ...base, periods: [], requests: [] };
      return transaction(async tx => {
        await lockSeller(tx, sellerId);
        const periods = await syncPeriods(tx, sellerId, now);
        const payoutsPaused = (await readCommissionBags(tx, now, sellerId)).some(bag => bag.paused);
        const rows = await tx.$queryRawUnsafe<RequestRow[]>(`${requestSelection} WHERE r."sellerId"=$1 ORDER BY r."createdAt" DESC,r.id`, sellerId);
        return { ...base, payoutsPaused, periods, requests: rows.map(serializeRequest) };
      });
    },
    async createCommissionRequest(sellerId: number, rawInput: CreateCommissionRequestInput) {
      const now = clock(); requireActive(now);
      const input = validateCommissionRequest(rawInput, commissionPeriodAt(now));
      return transaction(async tx => {
        await lockSeller(tx, sellerId);
        const prior = await tx.$queryRawUnsafe<RequestRow[]>(`${requestSelection} WHERE r."sellerId"=$1 AND r."idempotencyKey"=$2`, sellerId, input.idempotencyKey);
        if (prior[0]) {
          if (Number(prior[0].amount) !== input.amount || prior[0].nequi !== input.nequi || prior[0].period !== input.period) {
            throw new CommissionError("La clave de esta operación ya se utilizó con otros datos.", 409);
          }
          return serializeRequest(prior[0]);
        }
        const periods = await syncPeriods(tx, sellerId, now);
        if ((await readCommissionBags(tx, now, sellerId)).some(bag => bag.paused)) {
          throw new CommissionError("Comisiones temporalmente en pausa", 409, "COMMISSION_PAUSED");
        }
        const period = periods.find(row => row.period === input.period);
        if (!period || period.adjustment > 0 || input.amount > period.available) {
          throw new CommissionError("El monto supera el saldo disponible. Actualiza tus comisiones.", 409, "COMMISSION_INSUFFICIENT_BALANCE");
        }
        const id = randomUUID();
        await tx.$executeRawUnsafe(`INSERT INTO "CommissionRequest"(id,"sellerId",period,amount,nequi,"idempotencyKey",credits,"createdAt")
          SELECT $1::uuid,$2::integer,$3::varchar(7),$4::bigint,$5::varchar(10),$6::varchar(100),credits,$7::timestamptz
          FROM "CommissionPeriod" WHERE "sellerId"=$2::integer AND period=$3::varchar(7)`,
          id, sellerId, input.period, input.amount, input.nequi, input.idempotencyKey, now.toISOString());
        await audit(tx, sellerId, input.period, "REQUEST_CREATED", { amount: input.amount, availableAfter: period.available - input.amount }, now, id);
        return serializeRequest(await findRequest(tx, id));
      });
    },
    async listAdminCommissionBags(actorId: number): Promise<AdminCommissionBag[]> {
      const now = clock();
      return transaction(async tx => {
        await assertAdmin(tx, actorId);
        if (!commissionsAreActive(now)) return [];
        await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(721042, 1)`);
        return readCommissionBags(tx, now);
      });
    },
    async listAdminCommissionRequests(actorId: number): Promise<AdminCommissionRequest[]> {
      const now = clock();
      await assertAdmin(db, actorId);
      if (!commissionsAreActive(now)) return [];
      const sellers = await db.$queryRawUnsafe<{ sellerId: number }[]>(`SELECT DISTINCT "sellerId" FROM "CommissionRequest" ORDER BY "sellerId"`);
      for (const seller of sellers) await transaction(async tx => { await lockSeller(tx, seller.sellerId, false); await syncPeriods(tx, seller.sellerId, now); });
      const rows = await db.$queryRawUnsafe<(RequestRow & { sellerName: string })[]>(`SELECT r.*,p."receiptFileName",v.nombre AS "sellerName"
        FROM "CommissionRequest" r JOIN "Vendedor" v ON v.id=r."sellerId" LEFT JOIN "CommissionPayment" p ON p."requestId"=r.id ORDER BY r."createdAt" DESC,r.id`);
      const events = await db.$queryRawUnsafe<{ id: bigint; sellerId: number; period: string; requestId: string | null; action: string; createdAt: Date; actorName: string | null; payload: unknown }[]>(
        `SELECT a.*,u.nombre AS "actorName" FROM "CommissionAudit" a LEFT JOIN "Usuario" u ON u.id=a."actorId" ORDER BY a.id DESC`);
      return rows.map(row => ({ ...serializeRequest(row), sellerId: row.sellerId, sellerName: row.sellerName,
        rejectionReason: row.rejectionReason,
        branchName: Array.from(new Set(row.credits.map(credit => credit.branchName))).join(", ") || "Sin sede",
        credits: row.credits.map(credit => ({ id: credit.id, code: credit.code, finalizedAt: credit.finalizedAt })),
        audit: events.filter(event => event.requestId === row.id || (!event.requestId && event.sellerId === row.sellerId && event.period === row.period))
          .map(event => ({ id: String(event.id), action: event.action, createdAt: iso(event.createdAt), actorName: event.actorName || "Sistema", detail: JSON.stringify(event.payload) })),
      }));
    },
    async rejectCommissionRequest(id: string, actorId: number, reason: string) {
      validateId(id); const now = clock(); requireActive(now);
      const cleaned = String(reason || "").trim();
      if (cleaned.length < 3 || cleaned.length > 1000) throw new CommissionError("Indica un motivo de rechazo entre 3 y 1000 caracteres.");
      return transaction(async tx => {
        await assertAdmin(tx, actorId);
        const initial = await findRequest(tx, id); await lockSeller(tx, initial.sellerId, false);
        const request = await findRequest(tx, id);
        if (request.status === "REJECTED") return serializeRequest(request);
        if (request.status !== "PENDING") throw new CommissionError("La solicitud ya está pagada.", 409);
        await tx.$executeRawUnsafe(`UPDATE "CommissionRequest" SET status='REJECTED',"rejectionReason"=$2,"reviewedAt"=$3::timestamptz,"reviewedBy"=$4 WHERE id=$1::uuid AND status='PENDING'`, id, cleaned, now.toISOString(), actorId);
        await audit(tx, request.sellerId, request.period, "REQUEST_REJECTED", { amount: Number(request.amount), reason: cleaned }, now, id, actorId);
        return serializeRequest(await findRequest(tx, id));
      });
    },
    async confirmCommissionPayment(id: string, actorId: number, receiptInput: CommissionReceiptInput) {
      validateId(id); const now = clock(); requireActive(now); const receipt = validateReceipt(receiptInput);
      return transaction(async tx => {
        await assertAdmin(tx, actorId);
        const initial = await findRequest(tx, id); await lockSeller(tx, initial.sellerId, false);
        // Recalculate before confirming; a cancelled underlying credit invalidates
        // the reservation instead of authorizing an uncovered payment.
        const periods = await syncPeriods(tx, initial.sellerId, now);
        const request = await findRequest(tx, id);
        if (request.status === "PAID") return serializeRequest(request);
        if (request.status !== "PENDING") throw new CommissionError("La solicitud ya no está en trámite.", 409);
        const period = periods.find(row => row.period === request.period);
        if (!period || period.adjustment > 0) throw new CommissionError("La comisión tiene un ajuste pendiente; no se puede pagar.", 409);
        const repeated = await tx.$queryRawUnsafe<{ requestId: string }[]>(`SELECT "requestId" FROM "CommissionPayment" WHERE "receiptHash"=$1`, receipt.hash);
        if (repeated.length) throw new CommissionError("Este comprobante ya respalda otro pago.", 409);
        await tx.$executeRawUnsafe(`INSERT INTO "CommissionPayment"("requestId","actorId",amount,"receiptFileName","receiptMimeType","receiptBase64","receiptHash","createdAt")
          VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`, id, actorId, Number(request.amount), receipt.fileName, receipt.mimeType, receipt.base64, receipt.hash, now.toISOString());
        await tx.$executeRawUnsafe(`UPDATE "CommissionRequest" SET status='PAID',"paidAt"=$2::timestamptz,"reviewedAt"=$2::timestamptz,"reviewedBy"=$3 WHERE id=$1::uuid AND status='PENDING'`, id, now.toISOString(), actorId);
        await audit(tx, request.sellerId, request.period, "PAYMENT_CONFIRMED", { amount: Number(request.amount), receiptFileName: receipt.fileName, receiptHash: receipt.hash }, now, id, actorId);
        return serializeRequest(await findRequest(tx, id));
      });
    },
    async getCommissionReceipt(id: string, scope: { sellerId: number } | { adminUserId: number }) {
      validateId(id);
      if ("adminUserId" in scope) await assertAdmin(db, scope.adminUserId);
      const rows = await db.$queryRawUnsafe<{ sellerId: number; receiptFileName: string; receiptMimeType: string; receiptBase64: string }[]>(
        `SELECT r."sellerId",p."receiptFileName",p."receiptMimeType",p."receiptBase64" FROM "CommissionPayment" p
        JOIN "CommissionRequest" r ON r.id=p."requestId" WHERE r.id=$1::uuid AND r.status='PAID'
        AND ($2::integer IS NULL OR r."sellerId"=$2::integer)`, id, "sellerId" in scope ? scope.sellerId : null);
      if (!rows[0]) throw new CommissionError("Comprobante no encontrado.", 404);
      return { fileName: rows[0].receiptFileName, mimeType: rows[0].receiptMimeType, bytes: Buffer.from(rows[0].receiptBase64, "base64") };
    },
  };
}

async function defaultStore() {
  const { default: prisma } = await import("./prisma");
  return createCommissionStore(prisma as unknown as CommissionDatabase);
}
export async function getSellerCommissionDashboard(sellerId: number) {
  // Prelaunch works even before the explicitly installed schema exists.
  const now = new Date();
  if (!commissionsAreActive(now)) return { active: false, startsAt: COMMISSION_STARTS_AT, serverNow: now.toISOString(), currentPeriod: commissionPeriodAt(now), payoutsPaused: false, periods: [], requests: [] } satisfies SellerCommissionDashboard;
  return (await defaultStore()).getSellerCommissionDashboard(sellerId);
}
export async function createCommissionRequest(sellerId: number, input: CreateCommissionRequestInput) { return (await defaultStore()).createCommissionRequest(sellerId, input); }
export async function listAdminCommissionRequests(actorId: number) { return (await defaultStore()).listAdminCommissionRequests(actorId); }
export async function listAdminCommissionBags(actorId: number) { return (await defaultStore()).listAdminCommissionBags(actorId); }
export async function rejectCommissionRequest(id: string, actorId: number, reason: string) { return (await defaultStore()).rejectCommissionRequest(id, actorId, reason); }
export async function confirmCommissionPayment(id: string, actorId: number, receipt: CommissionReceiptInput) { return (await defaultStore()).confirmCommissionPayment(id, actorId, receipt); }
export async function getCommissionReceipt(id: string, scope: { sellerId: number } | { adminUserId: number }) { return (await defaultStore()).getCommissionReceipt(id, scope); }
