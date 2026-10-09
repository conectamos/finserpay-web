import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { moraCreditSelect, moraCreditSummary, readMoraCredit } from "@/lib/analyst-mora-credit";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { MORA_ACTIONS, MORA_MANAGEMENT_STATES, moraResultsForAction, moraResultLabel, type MoraManagementEvent, type MoraManagementInput } from "@/lib/analyst-mora-types";
import { colombiaDateKey } from "@/lib/colombia-date";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const historicalManagementStates = ["PENDIENTE", "PROMESA_PAGO", "SOPORTE_RECIBIDO", "ESCALADO"];
const maxAgreementAmount = 999999999999.99;
export function parseMoraManagement(value: unknown, now = new Date()): MoraManagementInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreditApprovalError("INVALID_REQUEST","Gestión inválida.");
  const body = value as Record<string,unknown>;
  const allowed = ["action","actedAt","responsibleUserId","result","agreementDate","agreementAmount","comment","nextFollowUpAt","managementStatus","idempotencyKey"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new CreditApprovalError("INVALID_REQUEST","La gestión contiene campos no permitidos.");
  const text = (key: string, min: number, max: number) => {
    const result = typeof body[key] === "string" ? body[key].trim() : "";
    if (result.length < min || result.length > max) throw new CreditApprovalError("INVALID_REQUEST", "Completa el resultado y el comentario de la gestión.");
    return result;
  };
  const actedAt = text("actedAt",20,35), nextFollowUpAt = text("nextFollowUpAt",20,35);
  const acted = Date.parse(actedAt), next = Date.parse(nextFollowUpAt);
  if (!Number.isFinite(acted) || !Number.isFinite(next) || !/(Z|[+-]\d{2}:\d{2})$/.test(actedAt) || !/(Z|[+-]\d{2}:\d{2})$/.test(nextFollowUpAt) || acted > now.getTime()+300000 || next <= acted)
    throw new CreditApprovalError("INVALID_DATE","Indica fecha y hora válidas; el seguimiento debe ser posterior a la gestión.");
  if (!MORA_ACTIONS.includes(body.action as MoraManagementInput["action"]) || !MORA_MANAGEMENT_STATES.includes(body.managementStatus as MoraManagementInput["managementStatus"]) || !Number.isSafeInteger(body.responsibleUserId) || Number(body.responsibleUserId)<1 || !uuid.test(String(body.idempotencyKey)))
    throw new CreditApprovalError("INVALID_REQUEST","Selecciona acción, estado y responsable válidos.");
  if (!moraResultsForAction(body.action as MoraManagementInput["action"]).includes(body.result as MoraManagementInput["result"]))
    throw new CreditApprovalError("INVALID_REQUEST", "Selecciona el resultado obtenido en la gestión.");
  let agreementDate: string | null = null;
  let agreementAmount: number | null = null;
  if (body.result === "ACUERDO_PAGO") {
    const date = typeof body.agreementDate === "string" ? body.agreementDate.trim() : "";
    const dateTime = Date.parse(date + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateTime) || new Date(dateTime).toISOString().slice(0,10) !== date || date < colombiaDateKey(new Date(acted)))
      throw new CreditApprovalError("INVALID_DATE", "Indica la fecha del acuerdo de pago, igual o posterior al día de la gestión.");
    const amount = body.agreementAmount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > maxAgreementAmount || Number(amount.toFixed(2)) !== amount)
      throw new CreditApprovalError("INVALID_REQUEST", "Indica un valor de acuerdo de pago positivo, con máximo dos decimales.");
    agreementDate = date;
    agreementAmount = Math.round(amount * 100) / 100;
  } else if ((body.agreementDate !== undefined && body.agreementDate !== null && body.agreementDate !== "") || (body.agreementAmount !== undefined && body.agreementAmount !== null)) {
    throw new CreditApprovalError("INVALID_REQUEST", "La fecha y el valor del acuerdo solo aplican al resultado Acuerdo de pago.");
  }
  return { action: body.action as MoraManagementInput["action"], actedAt: new Date(acted).toISOString(), nextFollowUpAt: new Date(next).toISOString(), responsibleUserId: Number(body.responsibleUserId), result: body.result as MoraManagementInput["result"], agreementDate, agreementAmount, comment: text("comment",5,2000), managementStatus: body.managementStatus as MoraManagementInput["managementStatus"], idempotencyKey: String(body.idempotencyKey) };
}
type StoredEvent = Omit<MoraManagementEvent,"actedAt"|"nextFollowUpAt"|"createdAt"|"agreementDate"|"agreementAmount"> & { actedAt: Date; nextFollowUpAt: Date; createdAt: Date; agreementDate?: Date | string | null; agreementAmount?: number | string | null; requestHash?: string };
const eventSql = `SELECT * FROM "CreditMoraManagementEvent"`;
function eventDto(event: StoredEvent): MoraManagementEvent {
  const { requestHash: _hash, ...item } = event;
  void _hash;
  return { ...item, resultCode: event.resultCode || null, agreementDate: event.agreementDate instanceof Date ? event.agreementDate.toISOString().slice(0,10) : event.agreementDate || null,
    agreementAmount: event.agreementAmount === null || event.agreementAmount === undefined ? null : Number(event.agreementAmount),
    actedAt: event.actedAt.toISOString(), nextFollowUpAt: event.nextFollowUpAt.toISOString(), createdAt: event.createdAt.toISOString() };
}
function resultSummary(input: MoraManagementInput) {
  const label = moraResultLabel(input.result, input.action);
  if (input.result !== "ACUERDO_PAGO") return label;
  const [year, month, day] = input.agreementDate!.split("-");
  const amount = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(input.agreementAmount!);
  return `${label} · ${day}/${month}/${year} · ${amount}`;
}
export async function moraResponsibles() {
  return prisma.$queryRawUnsafe<Array<{ id: number; nombre: string }>>(`SELECT u."id",u."nombre" FROM "Usuario" u JOIN "Rol" r ON r."id"=u."rolId"
    JOIN "Sede" s ON s."id"=u."sedeId" JOIN "Aliado" a ON a."id"=s."aliadoId"
    WHERE u."activo"=TRUE AND s."activa"=TRUE AND a."activo"=TRUE AND UPPER(BTRIM(a."codigo"))='FINSERPAY'
      AND UPPER(BTRIM(r."nombre")) IN ('ADMIN','ANALISTA_APROBACION') ORDER BY u."nombre",u."id"`);
}
export async function listMoraPortfolio(search: URLSearchParams) {
  await ensureAnalystMoraSchema();
  const q = (search.get("q") || "").trim();
  if (q.length > 100) throw new CreditApprovalError("INVALID_FILTER","Búsqueda demasiado extensa.");
  const credits = await prisma.credito.findMany({ where: { estado: { notIn: ["ANULADO","ANULADA","CANCELADO","CANCELADA"] }, pazYSalvoEmitidoAt: null }, select: moraCreditSelect });
  const events = await prisma.$queryRawUnsafe<StoredEvent[]>(`SELECT DISTINCT ON ("creditoId") * FROM "CreditMoraManagementEvent" ORDER BY "creditoId","createdAt" DESC,"id" DESC`);
  const latest = new Map(events.map(event => [event.creditoId,eventDto(event)]));
  const summaries = credits.map(credit => ({ ...moraCreditSummary(credit), ultimaGestion: latest.get(credit.id) || null })).filter(credit => credit.enMora);
  const idFilter = (key: string) => {
    const raw = search.get(key); if (!raw) return null;
    const result = Number(raw);
    if (!Number.isSafeInteger(result) || result < 1) throw new CreditApprovalError("INVALID_FILTER","Filtro inválido.");
    return result;
  };
  const ally = idFilter("ally"), responsible = idFilter("responsible");
  const days = (key: string) => { const raw = search.get(key); if (!raw) return null; const result = Number(raw); if (!Number.isSafeInteger(result)||result<0) throw new CreditApprovalError("INVALID_FILTER","Días de mora inválidos."); return result; };
  const min = days("minDays"), max = days("maxDays");
  if (min !== null && max !== null && min > max) throw new CreditApprovalError("INVALID_FILTER", "El rango de días de mora es inválido.");
  const status = search.get("status") || "";
  if (status && !MORA_MANAGEMENT_STATES.includes(status as typeof MORA_MANAGEMENT_STATES[number]) && !historicalManagementStates.includes(status)) throw new CreditApprovalError("INVALID_FILTER","Estado inválido.");
  const follow = search.get("followUp") || "";
  if (follow && (!/^\d{4}-\d{2}-\d{2}$/.test(follow) || !Number.isFinite(Date.parse(follow+"T12:00:00Z")) || new Date(follow+"T12:00:00Z").toISOString().slice(0,10)!==follow)) throw new CreditApprovalError("INVALID_FILTER","Fecha inválida.");
  const items = summaries.filter(credit => (!q || [credit.folio,credit.numeroCreditoVisible,credit.clienteNombre,credit.clienteDocumento,credit.imei].some(value=>value?.toLocaleLowerCase("es").includes(q.toLocaleLowerCase("es"))))
    && (!ally || credit.aliadoId === ally) && (!responsible || credit.ultimaGestion?.responsibleUserId===responsible)
    && (min===null||credit.diasMora>=min) && (max===null||credit.diasMora<=max)
    && (!status || (credit.ultimaGestion?.managementStatus||"PENDIENTE")===status)
    && (!follow || (credit.ultimaGestion && colombiaDateKey(credit.ultimaGestion.nextFollowUpAt)===follow))).sort((a,b)=>b.diasMora-a.diasMora||a.id-b.id);
  const page = Number(search.get("page") || 1);
  if (!Number.isSafeInteger(page)||page<1) throw new CreditApprovalError("INVALID_FILTER","Página inválida.");
  return { items: items.slice((page-1)*25,page*25), total: items.length, page, pageSize:25, hasMore:page*25<items.length,
    allies:[...new Map(summaries.map(item=>[item.aliadoId,{id:item.aliadoId,nombre:item.aliadoNombre}])).values()], responsibles:await moraResponsibles() };
}
export async function getMoraManagement(id: number) {
  await ensureAnalystMoraSchema();
  const credit = moraCreditSummary(await readMoraCredit(id));
  const events = await prisma.$queryRawUnsafe<StoredEvent[]>(eventSql+` WHERE "creditoId"=$1 ORDER BY "createdAt" DESC,"id" DESC`,id);
  return { credit, history:events.map(eventDto), responsibles:await moraResponsibles() };
}
export async function createMoraManagement(id: number, input: MoraManagementInput, actor: MoraActor) {
  if (!Number.isSafeInteger(id) || id < 1) throw new CreditApprovalError("INVALID_CREDIT", "Crédito inválido.");
  await ensureAnalystMoraSchema();
  const hash=createHash("sha256").update(JSON.stringify({id,input,actorId:actor.id})).digest("hex");
  return prisma.$transaction(async db=>{
    const verified = await assertMoraActor(db,actor);
    await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`,id);
    const prior=await db.$queryRawUnsafe<StoredEvent[]>(eventSql+` WHERE "idempotencyKey"=$1::uuid`,input.idempotencyKey);
    if(prior[0]) { if(prior[0].requestHash!==hash) throw new CreditApprovalError("IDEMPOTENCY_CONFLICT","Este envío ya se utilizó para otra gestión.",409); return {item:eventDto(prior[0]),unchanged:true}; }
    const credit=await db.credito.findUnique({where:{id},select:moraCreditSelect});
    if(!credit||!moraCreditSummary(credit).enMora) throw new CreditApprovalError("NOT_OVERDUE","El crédito ya no tiene cuotas en mora.",409);
    if (input.responsibleUserId !== verified.id) throw new CreditApprovalError("RESPONSIBLE_MISMATCH", "El responsable debe ser el usuario que inició sesión.", 403);
    const responsible=verified;
    const rows=await db.$queryRawUnsafe<StoredEvent[]>(`INSERT INTO "CreditMoraManagementEvent"
      ("id","creditoId","action","actedAt","responsibleUserId","responsibleName","result","comment","nextFollowUpAt","managementStatus","actorUserId","actorName","idempotencyKey","requestHash","resultCode","agreementDate","agreementAmount")
      VALUES ($1::uuid,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13::uuid,$14,$15,$16::date,$17::numeric) RETURNING *`,
      randomUUID(),id,input.action,input.actedAt,responsible.id,responsible.nombre,resultSummary(input),input.comment,input.nextFollowUpAt,input.managementStatus,verified.id,verified.nombre,input.idempotencyKey,hash,input.result,input.agreementDate || null,input.agreementAmount ?? null);
    return {item:eventDto(rows[0]),unchanged:false};
  });
}
