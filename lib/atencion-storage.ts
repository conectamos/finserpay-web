import { createHash, randomUUID } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionText, attentionUuid, isAttentionSystemTag, normalizeAttentionPhone, parseAttentionMutation, parseAttentionRead } from "./atencion-core";
import { colombiaDateKey } from "./colombia-date";
import { buildCreditPaymentPlan } from "./credit-payment-plan";
import { attentionMetaSchemaReady, attentionMetaMessage, attentionMetaPendingMessages } from "./atencion-meta-storage";
import { attentionDocumentKey, attentionPhoneOrNull, attentionPhoneSql, resolveAttentionCreditIdentity } from "./atencion-classification";
import type { AttentionCreditIdentityRecord, AttentionCreditResolution } from "./atencion-classification";
import type { AttentionActor, AttentionAgenda, AttentionAgendaFilters, AttentionAssignee, AttentionConversation, AttentionCustomer, AttentionDetail, AttentionFilters, AttentionInbox, AttentionMutation, AttentionQuickReply, DaptaConversationSnapshot } from "./atencion-types";
import type { AttentionBoardCards } from "./atencion-board-types";

export interface AttentionDb { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>; }
export interface AttentionDatabase extends AttentionDb {
  $transaction<T>(fn: (tx: AttentionDb) => Promise<T>, options: { isolationLevel: "ReadCommitted"; timeout: number; maxWait: number }): Promise<T>;
}
type ConversationRow = Omit<AttentionConversation, "lastContactAt" | "updatedAt" | "preview" | "autoTags" | "creditClassification" | "customerIdentity" | "unreadCount" | "lastInboundAt" | "waitingSince"> & {
  lastContactAt: Date | string | null; updatedAt: Date | string; closedAt: Date | string | null;
  daptaMessagesCursor: string | null; preview?: string | null; historyTruncated: boolean;
  assigneeUserId: number | null; assigneeSellerId: number | null;
  metaManaged?: boolean; metaLastInboundAt?: Date | string | null;
  unreadCount?: number; lastInboundAt?: Date | string | null; waitingSince?: Date | string | null;
};
type CreditRow = AttentionCreditIdentityRecord & { folio: string; clienteNombre: string;
  referenciaEquipo: string | null; equipoMarca: string | null; equipoModelo: string | null;
  montoCredito: number; valorCuota: number; plazoMeses: number | null; frecuenciaPago: string;
  fechaPrimerPago: Date | string | null; fechaProximoPago: Date | string | null; pazYSalvoEmitidoAt: Date | string | null; planCapitalVigente: unknown;
};
type DraftRow = { id: number; clienteNombre: string | null; clienteDocumento: string | null; clienteTipoDocumento?: string | null; estado: string;
  dataCreditoAssessmentId: string | null; createdAt: Date | string };
const options = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const pageSize = 40;
const messagePreviewSql = `CASE WHEN NULLIF(btrim(m.text),'') IS NOT NULL THEN left(m.text,160)
  ELSE CASE to_jsonb(m)->'attachment'->>'kind' WHEN 'image' THEN 'Imagen' WHEN 'audio' THEN 'Audio'
    WHEN 'video' THEN 'Video' WHEN 'document' THEN 'Documento' WHEN 'sticker' THEN 'Sticker' ELSE left(m.text,160) END END`;
const iso = (value: Date | string) => new Date(value).toISOString();
const maskDocument = (value: string | null) => value ? `••••${value.replace(/[\s.-]/g, "").slice(-4)}` : "Sin documento";
const unassignedSql = `c."assigneeKey" IS NULL AND c."assigneeUserId" IS NULL AND c."assigneeSellerId" IS NULL`;
// Provider history and acknowledged API/app sends count as replies. Pending,
// uncertain and failed sends never clear a customer's unanswered message.
const operationJoin = `LEFT JOIN LATERAL (
  SELECT count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM "AttentionReadState" rs WHERE rs."userId"=$2 AND rs."messageId"=m.id))::integer AS "unreadCount",
    max(m."sentAt") AS "lastInboundAt",min(m."sentAt") FILTER(WHERE m."sentAt">COALESCE((SELECT max(o."sentAt") FROM "AttentionMessage" o
      WHERE o."conversationId"=c.id AND o.direction='outbound' AND (to_jsonb(o)->>'deliveryStatus' IS NULL OR to_jsonb(o)->>'deliveryStatus' IN ('accepted','sent','delivered','read'))),'-infinity'::timestamptz)) AS "waitingSince"
  FROM "AttentionMessage" m WHERE m."conversationId"=c.id AND m.direction='inbound'
) op ON true`;
const operationSelect = `op."unreadCount",op."lastInboundAt",op."waitingSince"`;
type ConversationIdentity = AttentionCreditResolution & { customerIdentity: AttentionConversation["customerIdentity"] };
function conversation(row: ConversationRow, identity: ConversationIdentity): AttentionConversation {
  return { id: row.id, externalId: row.externalId, channel: row.channel, phone: row.phone, name: row.name,
    status: row.status, mode: row.mode, assigneeKey: row.assigneeKey, assigneeName: row.assigneeName,
    sedeId: row.sedeId, lastContactAt: row.lastContactAt ? iso(row.lastContactAt) : null, updatedAt: iso(row.updatedAt),
    preview: row.preview ?? null, tags: row.tags.filter(tag => !isAttentionSystemTag(tag)),
    autoTags: identity.autoTags, creditClassification: identity.classification, customerIdentity: identity.customerIdentity, version: row.version, linkedCreditId: row.linkedCreditId,
    unreadCount: row.unreadCount ?? 0, lastInboundAt: row.lastInboundAt ? iso(row.lastInboundAt) : null, waitingSince: row.waitingSince ? iso(row.waitingSince) : null };
}

/** Resolve only scoped chats. Credit access stays central or explicitly linked for nominal analysts. */
async function conversationIdentities(tx: AttentionDb, actor: AttentionActor, rows: readonly Pick<ConversationRow, "id" | "phone" | "linkedCreditId">[]): Promise<Map<string, ConversationIdentity>> {
  const phones = [...new Set(rows.map(row => attentionPhoneOrNull(row.phone)).filter((phone): phone is string => phone !== null))];
  const records = phones.length ? await tx.$queryRawUnsafe<(AttentionCreditIdentityRecord & { clienteNombre: string | null })[]>(`SELECT c.id,c."clienteTelefono",c."clienteDocumento",c."clienteNombre",
    to_jsonb(c)->>'clienteTipoDocumento' AS "clienteTipoDocumento",c.estado FROM "Credito" c WHERE ${attentionPhoneSql("c")}=ANY($1::text[])`, phones) : [];
  return new Map(rows.map(row => {
    const resolved = resolveAttentionCreditIdentity(row, records);
    let customerIdentity: AttentionConversation["customerIdentity"] = null;
    if (resolved.classification.status === "finserpay" && (actor.central || row.linkedCreditId)) {
      const selected = records.filter(record => resolved.creditIds.includes(record.id) && (actor.central || record.id === row.linkedCreditId))
        .sort((a, b) => Number(b.id === row.linkedCreditId) - Number(a.id === row.linkedCreditId) || b.id - a.id)[0];
      const key = selected && attentionDocumentKey(selected);
      if (selected && key) {
        const type = key.split(":")[0];
        customerIdentity = { name: (selected.clienteNombre || "").trim().slice(0, 160), document: selected.clienteDocumento!.trim(),
          documentLabel: ({ CC: "C.C.", CE: "C.E.", PASAPORTE: "Pasaporte" } as Record<string, string>)[type] || "Documento" };
      }
    }
    return [row.id, { ...resolved, customerIdentity }];
  }));
}
/** All access predicates are evaluated on the server from the current session. */
function scope(actor: AttentionActor) {
  return { sql: `($1::boolean OR (c."assigneeUserId"=$2::integer AND c."assigneeKey"=$3::text AND c."assigneeSellerId" IS NULL))`,
    values: [actor.central, actor.userId, actor.key] };
}
/** Revalidate role and account state inside every read/write transaction. */
async function assertCurrentActor(tx: AttentionDb, actor: AttentionActor) {
  const rows = await tx.$queryRawUnsafe<{role: string}[]>(`SELECT upper(trim(r.nombre)) AS role FROM "Usuario" u
    JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.id=$1 AND u.activo=true AND s.activa=true AND a.activo=true AND upper(trim(a.codigo))='FINSERPAY'
    AND u."sedeId"=$2 AND s."aliadoId"=$3 FOR SHARE OF u,r,s,a`, actor.userId, actor.sedeId, actor.aliadoId);
  if (rows[0]?.role !== (actor.central ? "ADMIN" : "ANALISTA_APROBACION")) throw new AttentionError("La cuenta de atención ya no está autorizada.", 403);
}
export { assertCurrentActor as assertAttentionCurrentActor, scope as attentionConversationScope };

/** Shared inbox/board search: linked-credit names only for nominal analysts. */
export async function attentionConversationSearch(tx: AttentionDb, actor: AttentionActor, search: string) {
  const access=scope(actor);
  const [drafts]=await tx.$queryRawUnsafe<{present:boolean}[]>(`SELECT to_regclass('public."CreditoBorrador"') IS NOT NULL AS present`);
  const draftSearch=actor.central&&drafts?.present?`OR EXISTS(SELECT 1 FROM "CreditoBorrador" d WHERE ${attentionPhoneSql("d")}=c.phone AND d."clienteNombre" ILIKE $5)`:"";
  return {sql:`${access.sql} AND ($4::text='' OR c.name ILIKE $5 OR c.phone LIKE $5
    OR EXISTS(SELECT 1 FROM "Credito" k WHERE ${attentionPhoneSql("k")}=c.phone AND ($1::boolean OR k.id=c."linkedCreditId") AND k."clienteNombre" ILIKE $5) ${draftSearch})`,
    values:[...access.values,search,`%${search.replace(/[\\%_]/g,"\\$&")}%`]};
}

/** Read only the requested board page using the existing scoped card serializer. */
export async function readAttentionBoardCards(tx: AttentionDb, actor: AttentionActor, filters:{sectionId:string|null;search:string;page:number}):Promise<AttentionBoardCards> {
  await requireSchema(tx);
  const search=await attentionConversationSearch(tx,actor,filters.search),size=20;
  const where=`${search.sql} AND c."sectionId" IS NOT DISTINCT FROM $6::uuid`;
  const rows=await tx.$queryRawUnsafe<(ConversationRow&{sectionId:string|null;boardVersion:number})[]>(`SELECT c.*,${operationSelect},
    (SELECT ${messagePreviewSql} FROM "AttentionMessage" m WHERE m."conversationId"=c.id ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS preview
    FROM "AttentionConversation" c ${operationJoin} WHERE ${where} ORDER BY c."lastContactAt" DESC NULLS LAST,c.id LIMIT $7 OFFSET $8 FOR SHARE OF c`,
    ...search.values,filters.sectionId,size,(filters.page-1)*size);
  const [total]=await tx.$queryRawUnsafe<{count:number}[]>(`SELECT count(*)::integer AS count FROM "AttentionConversation" c WHERE ${where}`,...search.values,filters.sectionId);
  const identities=await conversationIdentities(tx,actor,rows);
  return {sectionId:filters.sectionId,conversations:rows.map(row=>({...conversation(row,identities.get(row.id)!),sectionId:row.sectionId,boardVersion:row.boardVersion})),total:total.count,page:filters.page,pageSize:size};
}
async function schemaReady(tx: AttentionDb) {
  const rows = await tx.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT
    to_regclass('public."AttentionConversation"') IS NOT NULL AND to_regclass('public."AttentionMessage"') IS NOT NULL
    AND to_regclass('public."AttentionNote"') IS NOT NULL AND to_regclass('public."AttentionTask"') IS NOT NULL
    AND to_regclass('public."AttentionQuickReply"') IS NOT NULL AND to_regclass('public."AttentionAudit"') IS NOT NULL
    AND to_regclass('public."AttentionRequest"') IS NOT NULL AND to_regclass('public."AttentionReadState"') IS NOT NULL AS ready`);
  return rows[0]?.ready === true;
}
async function requireSchema(tx: AttentionDb) { if (!await schemaReady(tx)) throw new AttentionError("Atención requiere preparar su esquema de base de datos.", 503); }
async function audit(tx: AttentionDb, actor: AttentionActor, action: string, id: string | null, metadata: object = {}) {
  await tx.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId",action,metadata)
    VALUES ($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`, id, actor.userId, actor.sellerId, action, JSON.stringify(metadata));
}
async function agendaCounts(tx: AttentionDb, actor: AttentionActor, today: string): Promise<AttentionAgenda["counts"]> {
  const access = scope(actor);
  const [row] = await tx.$queryRawUnsafe<AttentionAgenda["counts"][]>(`SELECT count(*)::integer AS total,
    count(*) FILTER(WHERE (t."dueAt" AT TIME ZONE 'America/Bogota')::date=$4::date)::integer AS today,
    count(*) FILTER(WHERE (t."dueAt" AT TIME ZONE 'America/Bogota')::date<$4::date)::integer AS overdue,
    count(*) FILTER(WHERE (t."dueAt" AT TIME ZONE 'America/Bogota')::date>$4::date)::integer AS upcoming,
    count(*) FILTER(WHERE t."dueAt" IS NULL)::integer AS undated
    FROM "AttentionTask" t JOIN "AttentionConversation" c ON c.id=t."conversationId" WHERE ${access.sql} AND t."completedAt" IS NULL`,...access.values,today);
  return row;
}
async function teamList(tx: AttentionDb, actor: AttentionActor): Promise<AttentionAssignee[]> {
  const rows = await tx.$queryRawUnsafe<{key: string; name: string}[]>(`SELECT 'analyst:'||u.id::text AS key,u.nombre AS name
    FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.activo=true AND s.activa=true AND a.activo=true AND upper(trim(a.codigo))='FINSERPAY'
    AND upper(trim(r.nombre))='ANALISTA_APROBACION' AND ($1::boolean OR u.id=$2) ORDER BY u.nombre,u.id`, actor.central, actor.userId);
  return rows.map(row => ({ ...row, sedeIds: [] }));
}
async function loadConversation(tx: AttentionDb, actor: AttentionActor, id: string, lock = false) {
  const access = scope(actor);
  const rows = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT c.* FROM "AttentionConversation" c
    WHERE ${access.sql} AND c.id=$4::uuid ${lock ? "FOR UPDATE OF c" : "FOR SHARE OF c"}`, ...access.values, attentionUuid(id));
  if (!rows[0]) throw new AttentionError("Conversación no encontrada o no autorizada.", 404);
  return rows[0];
}
async function idempotent(tx: AttentionDb, actor: AttentionActor, requestId: string, input: unknown): Promise<{ replay: boolean; resultId: string | null }> {
  const id = attentionUuid(requestId);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  // Advisory lock serializes duplicate HTTP retries before the request ledger is read.
  await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1::text,0::bigint))`, `attention:${actor.key}:${id}`);
  const prior = await tx.$queryRawUnsafe<{fingerprint: string; resultId: string | null}[]>(`SELECT fingerprint,"resultId" FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`, actor.key, id);
  if (prior[0]) {
    if (prior[0].fingerprint !== fingerprint) throw new AttentionError("Esta solicitud ya se utilizó con otros datos.", 409);
    return { replay: true, resultId: prior[0].resultId };
  }
  await tx.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES($1,$2::uuid,$3) RETURNING "requestId"`, actor.key, id, fingerprint);
  return { replay: false, resultId: null };
}
const phoneSql = attentionPhoneSql;
async function candidateCredits(tx: AttentionDb, actor: AttentionActor, row: ConversationRow): Promise<CreditRow[]> {
  if (!row.phone || (!actor.central && !row.linkedCreditId)) return [];
  return tx.$queryRawUnsafe(`SELECT c.id,c.folio,c."clienteNombre",c."clienteDocumento",c."clienteTelefono",
    to_jsonb(c)->>'clienteTipoDocumento' AS "clienteTipoDocumento",c.estado,c."referenciaEquipo",c."equipoMarca",c."equipoModelo",
    c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",c."fechaPrimerPago",c."fechaProximoPago",c."pazYSalvoEmitidoAt",
    to_jsonb(c)->'planCapitalVigente' AS "planCapitalVigente" FROM "Credito" c
    WHERE ${phoneSql("c")}=$1 AND ($2::boolean OR c.id=$3::integer) ORDER BY c.id DESC LIMIT 101`,
    row.phone, actor.central, row.linkedCreditId);
}
async function candidateDrafts(tx: AttentionDb, actor: AttentionActor, row: ConversationRow): Promise<DraftRow[]> {
  if (!actor.central || !row.phone) return [];
  const presence = await tx.$queryRawUnsafe<{present: boolean}[]>(`SELECT to_regclass('public."CreditoBorrador"') IS NOT NULL AS present`);
  if (!presence[0]?.present) return [];
  return tx.$queryRawUnsafe(`SELECT d.id,d."clienteNombre",d."clienteDocumento",to_jsonb(d)->>'clienteTipoDocumento' AS "clienteTipoDocumento",d.estado,d."dataCreditoAssessmentId",d."createdAt"
    FROM "CreditoBorrador" d WHERE d."creditoId" IS NULL AND ${phoneSql("d")}=$1 ORDER BY d.id DESC LIMIT 101`, row.phone);
}
async function customerDetail(tx: AttentionDb, actor: AttentionActor, row: ConversationRow): Promise<AttentionCustomer> {
  if (!row.phone || (!actor.central && !row.linkedCreditId)) return { match: row.phone ? "restricted" : "none", name: null, documentMasked: null, candidates: [], credits: [], studies: [], financialAllowed: actor.central };
  const candidates = await candidateCredits(tx, actor, row);
  const drafts = await candidateDrafts(tx, actor, row);
  const keys = new Set([...candidates.map(c => attentionDocumentKey(c) || `credit:${c.id}`), ...drafts.map(d => attentionDocumentKey(d) || `draft:${d.id}`)]);
  const linked = row.linkedCreditId ? candidates.find(c => c.id === row.linkedCreditId) : null;
  const ambiguous = candidates.length > 100 || drafts.length > 100 || (!linked && keys.size > 1);
  const customer: AttentionCustomer = { match: row.linkedCreditId && !linked ? "restricted" : ambiguous ? "ambiguous" : candidates.length || drafts.length ? "linked" : "none",
    name: null, documentMasked: null, candidates: actor.central ? candidates.slice(0, 100).map(c => ({ id: c.id, folio: c.folio, name: c.clienteNombre, documentMasked: maskDocument(c.clienteDocumento) })) : [],
    credits: [], studies: [], financialAllowed: actor.central };
  if (customer.match !== "linked") return customer;
  const identity = linked || candidates.at(0) || drafts[0];
  const credits = candidates.filter(c => attentionDocumentKey(identity) ? attentionDocumentKey(c) === attentionDocumentKey(identity) : c === identity);
  const selectedDrafts = drafts.filter(d => attentionDocumentKey(identity) ? attentionDocumentKey(d) === attentionDocumentKey(identity) : d === identity);
  customer.name = identity.clienteNombre; customer.documentMasked = maskDocument(identity.clienteDocumento);
  const payments = actor.central ? await tx.$queryRawUnsafe<{creditoId: number; valor: number; metodoPago: string; fechaAbono: Date | string}[]>(`
    SELECT "creditoId",valor,"metodoPago","fechaAbono" FROM "CreditoAbono"
    WHERE "creditoId"=ANY($1::integer[]) AND estado='ACTIVO' AND "anuladoAt" IS NULL ORDER BY "fechaAbono" DESC,id DESC`, credits.map(c => c.id)) : [];
  customer.credits = credits.map(c => {
    const abonos = payments.filter(p => p.creditoId === c.id);
    const complete = Boolean(c.fechaPrimerPago && Number(c.plazoMeses) > 0 && Number.isFinite(Number(c.montoCredito)) && Number(c.montoCredito) >= 0);
    const plan = actor.central && complete ? buildCreditPaymentPlan({ ...c, abonos, settled: Boolean(c.pazYSalvoEmitidoAt) }) : null;
    return { id: c.id, folio: c.folio, state: c.estado, equipment: c.referenciaEquipo || [c.equipoMarca, c.equipoModelo].filter(Boolean).join(" ") || "Sin equipo registrado",
      balance: plan?.saldoPendiente ?? null, nextDueAt: plan && plan.saldoPendiente > 0 ? plan.nextInstallment?.fechaVencimiento ?? null : null,
      nextAmount: plan && plan.saldoPendiente > 0 ? plan.nextInstallment?.saldoPendiente ?? null : null,
      payments: abonos.slice(0, 10).map(p => ({ date: iso(p.fechaAbono), amount: Number(p.valor), method: p.metodoPago })) };
  });
  const studiesPresent = await tx.$queryRawUnsafe<{present: boolean}[]>(`SELECT to_regclass('public."DataCreditoAssessment"') IS NOT NULL AS present`);
  if (studiesPresent[0]?.present) {
    const studies = await tx.$queryRawUnsafe<{id: string; state: string; createdAt: Date | string}[]>(`SELECT id,status AS state,"createdAt"
      FROM "DataCreditoAssessment" WHERE ("creditId"=ANY($1::integer[]) OR id=ANY($2::uuid[]))
      ORDER BY "createdAt" DESC LIMIT 20`, credits.map(c => c.id),
      selectedDrafts.flatMap(d => d.dataCreditoAssessmentId ? [d.dataCreditoAssessmentId] : []));
    customer.studies = studies.map(s => ({ ...s, createdAt: iso(s.createdAt) }));
  }
  // Existing applications remain visible even before an assessment exists; no new client/draft is created.
  customer.studies.push(...selectedDrafts.filter(d => !d.dataCreditoAssessmentId || !customer.studies.some(s => s.id === d.dataCreditoAssessmentId))
    .map(d => ({ id: `D-${d.id}`, state: `Solicitud: ${d.estado}`, createdAt: iso(d.createdAt) })));
  return customer;
}

export function createAttentionStore(database: AttentionDatabase, settings: { now?: () => Date } = {}) {
  const now = settings.now ?? (() => new Date());
  const transaction = <T>(actor: AttentionActor, fn: (tx: AttentionDb) => Promise<T>, settings = options) => database.$transaction(async tx => {
    await assertCurrentActor(tx, actor);
    return fn(tx);
  }, settings);
  return {
    async getAttentionHistoryCursors(actor: AttentionActor): Promise<Record<string, string | null>> {
      assertAttentionActor(actor); if (!actor.central) throw new AttentionError("Solo administración central puede leer los puntos de sincronización.", 403);
      return transaction(actor, async tx => {
        await requireSchema(tx);
        const rows = await tx.$queryRawUnsafe<{externalId: string; daptaMessagesCursor: string | null}[]>(`SELECT "externalId","daptaMessagesCursor"
          FROM "AttentionConversation" WHERE channel='whatsapp' AND "externalId" IS NOT NULL`);
        await audit(tx, actor, "DAPTA_CHECKPOINTS_READ", null, { count: rows.length });
        return Object.fromEntries(rows.map(row => [row.externalId, row.daptaMessagesCursor]));
      }, options);
    },
    async getAttentionInbox(actor: AttentionActor, filters: AttentionFilters): Promise<Omit<AttentionInbox, "integration">> {
      assertAttentionActor(actor);
      return transaction(actor, async tx => {
        const empty = { schemaReady: false, conversations: [], total: 0, page: filters.page, pageSize,
          metrics: { pending: 0, open: 0, closed: 0, mine: 0 }, operational: { unassigned: 0, unread: 0, unanswered: 0 },
          agendaCounts: { today: 0, overdue: 0, upcoming: 0, undated: 0, total: 0 }, availableTags: [], team: [], branches: [], quickReplies: [], actor };
        if (!await schemaReady(tx)) return empty;
        const access = scope(actor);
        const tagRows = await tx.$queryRawUnsafe<Pick<ConversationRow,"id"|"phone"|"linkedCreditId"|"tags">[]>(`SELECT c.id,c.phone,c."linkedCreditId",c.tags FROM "AttentionConversation" c WHERE ${access.sql} ORDER BY c.id`,...access.values);
        const identities = await conversationIdentities(tx,actor,tagRows);
        const availableTags = [...new Map(tagRows.flatMap(row => [...row.tags.filter(tag => !isAttentionSystemTag(tag)), ...identities.get(row.id)!.autoTags])
          .map(tag => [tag.toLocaleLowerCase("es-CO"),tag])).values()].sort((a,b)=>a.localeCompare(b,"es-CO"));
        const tag = filters.tag?.normalize("NFKC").trim().toLocaleLowerCase("es-CO");
        const tagIds = tag ? tagRows.filter(row => [...row.tags.filter(value=>!isAttentionSystemTag(value)), ...identities.get(row.id)!.autoTags].some(value=>value.toLocaleLowerCase("es-CO")===tag)).map(row=>row.id) : null;
        const searchQuery=await attentionConversationSearch(tx,actor,filters.search);
        const filtered = `${searchQuery.sql}
          AND ($6::text='all' OR ($6='mine' AND c."assigneeKey"=$3) OR ($6='pending' AND c.status='pending') OR ($6='closed' AND c.status='closed')
            OR ($6='unassigned' AND ${unassignedSql}) OR ($6='unread' AND op."unreadCount">0) OR ($6='unanswered' AND op."waitingSince" IS NOT NULL))
          AND ($7::uuid[] IS NULL OR c.id=ANY($7::uuid[]))`;
        const values = [...searchQuery.values, filters.filter, tagIds];
        const rows = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT c.*,${operationSelect},
          (SELECT ${messagePreviewSql} FROM "AttentionMessage" m WHERE m."conversationId"=c.id ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS preview
          FROM "AttentionConversation" c ${operationJoin} WHERE ${filtered}
          ORDER BY c."lastContactAt" DESC NULLS LAST,c.id LIMIT $8 OFFSET $9 FOR SHARE OF c`, ...values, pageSize, (filters.page - 1) * pageSize);
        const totals = await tx.$queryRawUnsafe<{total: number}[]>(`SELECT count(*)::integer AS total FROM "AttentionConversation" c ${operationJoin} WHERE ${filtered}`, ...values);
        const [operational] = await tx.$queryRawUnsafe<AttentionInbox["operational"][]>(`SELECT count(*) FILTER(WHERE ${unassignedSql})::integer AS unassigned,
          count(*) FILTER(WHERE op."unreadCount">0)::integer AS unread,count(*) FILTER(WHERE op."waitingSince" IS NOT NULL)::integer AS unanswered
          FROM "AttentionConversation" c ${operationJoin} WHERE ${access.sql}`,...access.values);
        const metricRows = await tx.$queryRawUnsafe<{pending: number; open: number; closed: number; mine: number}[]>(`SELECT
          count(*) FILTER (WHERE c.status='pending')::integer AS pending, count(*) FILTER (WHERE c.status='open')::integer AS open,
          count(*) FILTER (WHERE c.status='closed')::integer AS closed, count(*) FILTER (WHERE c."assigneeKey"=$3)::integer AS mine
          FROM "AttentionConversation" c WHERE ${access.sql}`, ...access.values);
        const replies = await tx.$queryRawUnsafe<AttentionQuickReply[]>(`SELECT id,title,text,"approvedBy","approvedAt" FROM "AttentionQuickReply" ORDER BY title,id LIMIT 200`);
        const team = await teamList(tx, actor);
        const daily = await tx.$queryRawUnsafe<{date: string; count: number}[]>(`WITH days AS (
          SELECT ((now() AT TIME ZONE 'America/Bogota')::date-i)::text AS date FROM generate_series(0,6) i
        ), received AS (SELECT (m."sentAt" AT TIME ZONE 'America/Bogota')::date::text AS date,count(DISTINCT c.id)::integer AS count
          FROM "AttentionMessage" m JOIN "AttentionConversation" c ON c.id=m."conversationId"
          WHERE m.direction='inbound' AND ${access.sql}
          AND m."sentAt">=((now() AT TIME ZONE 'America/Bogota')::date-6)::timestamp AT TIME ZONE 'America/Bogota'
          GROUP BY (m."sentAt" AT TIME ZONE 'America/Bogota')::date)
          SELECT days.date,COALESCE(received.count,0)::integer AS count FROM days LEFT JOIN received USING(date) ORDER BY days.date`, ...access.values);
        const activeRows = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT c.*,${operationSelect},
          (SELECT ${messagePreviewSql} FROM "AttentionMessage" m WHERE m."conversationId"=c.id ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS preview
          FROM "AttentionConversation" c ${operationJoin} WHERE ${access.sql} AND c.status<>'closed' ORDER BY c."lastContactAt" DESC NULLS LAST,c."updatedAt" DESC,c.id LIMIT 5 FOR SHARE OF c`, ...access.values);
        const loads = await tx.$queryRawUnsafe<{key: string; assigned: number; pending: number}[]>(`SELECT c."assigneeKey" AS key,
          count(*) FILTER(WHERE c.status<>'closed')::integer AS assigned,count(*) FILTER(WHERE c.status='pending')::integer AS pending
          FROM "AttentionConversation" c WHERE ${access.sql} AND c."assigneeSellerId" IS NULL AND c."assigneeKey"='analyst:'||c."assigneeUserId"::text GROUP BY c."assigneeKey"`, ...access.values);
        const activityRows = await tx.$queryRawUnsafe<{id: string; action: string; at: Date | string; conversationId: string; author: string}[]>(`SELECT a.id::text,a.action,a."createdAt" AS at,a."conversationId",u.nombre AS author
          FROM "AttentionAudit" a JOIN "AttentionConversation" c ON c.id=a."conversationId" JOIN "Usuario" u ON u.id=a."userId"
          WHERE ${access.sql} AND a.action=ANY($4::text[]) ORDER BY a."createdAt" DESC,a.id DESC LIMIT 12`, ...access.values,
          ["CONVERSATION_TRANSFER", "CONVERSATION_CLAIM", "CONVERSATION_CLOSE", "CONVERSATION_REOPEN", "CONVERSATION_NOTE", "CONVERSATION_TASK", "CONVERSATION_COMPLETE_TASK", "CONVERSATION_LINK", "CONVERSATION_HUMAN_REQUEST", "DAPTA_SNAPSHOT_IMPORTED"]);
        const titles: Record<string,string> = { CONVERSATION_TRANSFER: "Conversación asignada", CONVERSATION_CLAIM: "Atención iniciada", CONVERSATION_CLOSE: "Conversación finalizada", CONVERSATION_REOPEN: "Conversación reabierta", CONVERSATION_NOTE: "Nota añadida", CONVERSATION_TASK: "Recordatorio creado", CONVERSATION_COMPLETE_TASK: "Recordatorio completado", CONVERSATION_LINK: "Ficha vinculada", CONVERSATION_HUMAN_REQUEST: "Atención humana solicitada", DAPTA_SNAPSHOT_IMPORTED: "Conversación sincronizada" };
        // Tag discovery precedes these locked rows. Never serialize an identity
        // cached before a concurrent unlink, reassignment or contact correction.
        const freshIdentities = await conversationIdentities(tx,actor,[...rows,...activeRows]);
        for (const [id,identity] of freshIdentities) identities.set(id,identity);
        const result = { schemaReady: true, conversations: rows.map(row => conversation(row, identities.get(row.id)!)), total: totals[0]?.total || 0, page: filters.page, pageSize,
          metrics: metricRows[0], operational, availableTags, agendaCounts: await agendaCounts(tx,actor,colombiaDateKey(now())), team, branches: [], dashboard: {
            daily: daily.map(day => ({ ...day, label: new Date(`${day.date}T12:00:00Z`).toLocaleDateString("es-CO", { weekday: "short", timeZone: "America/Bogota" }) })),
            team: team.map(person => ({ key: person.key, name: person.name, assigned: loads.find(l => l.key === person.key)?.assigned || 0, pending: loads.find(l => l.key === person.key)?.pending || 0 })),
            activeConversations: activeRows.map(row => conversation(row, identities.get(row.id)!)),
            activity: activityRows.map(item => ({ id: item.id, title: titles[item.action], description: item.author, at: iso(item.at), conversationId: item.conversationId })),
          },
          quickReplies: replies.map(reply => ({ ...reply, approvedAt: iso(reply.approvedAt) })), actor };
        await audit(tx, actor, "INBOX_VIEWED", null, { filter: filters.filter, page: filters.page, conversationIds: rows.map(r => r.id) });
        return result;
      }, options);
    },
    async getAttentionDetail(actor: AttentionActor, id: string): Promise<AttentionDetail> {
      assertAttentionActor(actor);
      return transaction(actor, async tx => {
        await requireSchema(tx); const row = await loadConversation(tx, actor, id);
        const access = scope(actor);
        const [operation] = await tx.$queryRawUnsafe<Pick<ConversationRow,"unreadCount"|"lastInboundAt"|"waitingSince">[]>(`SELECT ${operationSelect} FROM "AttentionConversation" c ${operationJoin} WHERE ${access.sql} AND c.id=$4::uuid`,...access.values,id);
        const metaReady = await attentionMetaSchemaReady(tx);
        const messages = await tx.$queryRawUnsafe<Parameters<typeof attentionMetaMessage>[0][]>(`
          SELECT id,"conversationId",direction,text,"sentAt",author${metaReady ? ',attachment,"deliveryStatus"' : ''} FROM "AttentionMessage" WHERE "conversationId"=$1::uuid ORDER BY "sentAt" DESC,id DESC LIMIT 501`, id);
        const pending = metaReady ? await attentionMetaPendingMessages(tx,id) : [];
        const displayMessages = [...messages.map(attentionMetaMessage),...pending].sort((a,b) => Date.parse(a.sentAt)-Date.parse(b.sentAt)||a.id.localeCompare(b.id));
        const notes = await tx.$queryRawUnsafe<{id: string; text: string; author: string; createdAt: Date | string}[]>(`SELECT id,text,author,"createdAt" FROM "AttentionNote" WHERE "conversationId"=$1::uuid ORDER BY "createdAt" DESC,id DESC LIMIT 301`, id);
        const tasks = await tx.$queryRawUnsafe<{id: string; title: string; author: string; dueAt: Date | string | null; completedAt: Date | string | null}[]>(`SELECT id,title,author,"dueAt","completedAt" FROM "AttentionTask" WHERE "conversationId"=$1::uuid ORDER BY ("completedAt" IS NOT NULL),"dueAt" ASC NULLS LAST,"createdAt" DESC,id LIMIT 301`, id);
        const customer = await customerDetail(tx, actor, row);
        const identity = (await conversationIdentities(tx, actor, [row])).get(row.id)!;
        await audit(tx, actor, "CONVERSATION_VIEWED", row.id, { financial: customer.financialAllowed, creditIds: customer.credits.map(c => c.id), studyIds: customer.studies.map(s => s.id) });
        return { conversation: conversation({ ...row, ...operation, name: row.name === row.phone && customer.name ? customer.name : row.name }, identity), messages: displayMessages.slice(-500),
          notes: notes.slice(0,300).reverse().map(n => ({ ...n, createdAt: iso(n.createdAt) })), tasks: tasks.slice(0,300).map(t => ({ ...t, dueAt: t.dueAt ? iso(t.dueAt) : null, completedAt: t.completedAt ? iso(t.completedAt) : null })),
          customer, permissions: { manage: actor.central || row.assigneeKey === actor.key,
            claim: actor.analyst && row.assigneeKey === actor.key, assign: actor.central, canSend: false }, historyTruncated: row.historyTruncated || displayMessages.length > 500,
          notesTruncated: notes.length > 300, tasksTruncated: tasks.length > 300 };
      }, options);
    },
    async markAttentionRead(actor: AttentionActor, id: string, raw: { messageIds: string[] }): Promise<{ unreadCount: number; changed: boolean }> {
      assertAttentionActor(actor); attentionUuid(id);
      const { messageIds } = parseAttentionRead(raw);
      return transaction(actor,async tx=>{
        await requireSchema(tx); await loadConversation(tx,actor,id,true);
        const observed = await tx.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionMessage" WHERE "conversationId"=$1::uuid AND direction='inbound' AND id=ANY($2::uuid[])`,id,messageIds);
        if (observed.length !== messageIds.length) throw new AttentionError("Los mensajes observados no corresponden a este chat.",400);
        const changed = await tx.$queryRawUnsafe<{messageId:string}[]>(`INSERT INTO "AttentionReadState"("userId","messageId","conversationId")
          SELECT $1,m.id,m."conversationId" FROM "AttentionMessage" m WHERE m."conversationId"=$2::uuid AND m.id=ANY($3::uuid[]) AND m.direction='inbound'
          ON CONFLICT("userId","messageId") DO NOTHING RETURNING "messageId"`,actor.userId,id,messageIds);
        if (changed.length) {
          await audit(tx,actor,"MESSAGES_READ",id,{count:changed.length});
          await tx.$queryRawUnsafe(`SELECT 1 AS notified FROM pg_notify('finserpay_attention_changes',$1)`,JSON.stringify({conversationId:id,previousUserId:null,previousKey:null,previousSellerId:null,
            currentUserId:actor.userId,currentKey:actor.key,currentSellerId:null,readActorUserId:actor.userId}));
        }
        const [row] = await tx.$queryRawUnsafe<{unreadCount:number}[]>(`SELECT count(*)::integer AS "unreadCount" FROM "AttentionMessage" m WHERE m."conversationId"=$1::uuid AND m.direction='inbound'
          AND NOT EXISTS(SELECT 1 FROM "AttentionReadState" rs WHERE rs."userId"=$2 AND rs."messageId"=m.id)`,id,actor.userId);
        return {unreadCount:row.unreadCount,changed:changed.length>0};
      });
    },
    async getAttentionAgenda(actor: AttentionActor, filters: AttentionAgendaFilters): Promise<AttentionAgenda> {
      assertAttentionActor(actor);
      return transaction(actor,async tx=>{
        await requireSchema(tx); const access=scope(actor),today=colombiaDateKey(now()),counts=await agendaCounts(tx,actor,today);
        const rows=await tx.$queryRawUnsafe<{id:string;title:string;author:string;dueAt:Date|string|null;completedAt:Date|string|null;conversationId:string;name:string;phone:string|null;version:number}[]>(`SELECT t.id,t.title,t.author,t."dueAt",t."completedAt",c.id AS "conversationId",c.name,c.phone,c.version
          FROM "AttentionTask" t JOIN "AttentionConversation" c ON c.id=t."conversationId" WHERE ${access.sql} AND t."completedAt" IS NULL
          AND ($4::text='all' OR ($4='today' AND (t."dueAt" AT TIME ZONE 'America/Bogota')::date=$5::date)
            OR ($4='overdue' AND (t."dueAt" AT TIME ZONE 'America/Bogota')::date<$5::date) OR ($4='upcoming' AND (t."dueAt" AT TIME ZONE 'America/Bogota')::date>$5::date))
          ORDER BY t."dueAt" ASC NULLS LAST,t.id LIMIT $6 OFFSET $7`,...access.values,filters.filter,today,pageSize,(filters.page-1)*pageSize);
        return {items:rows.map(row=>({id:row.id,title:row.title,author:row.author,dueAt:row.dueAt?iso(row.dueAt):null,completedAt:row.completedAt?iso(row.completedAt):null,
          conversation:{id:row.conversationId,name:row.name,phone:row.phone,version:row.version}})),counts,today,
          total:filters.filter==='all'?counts.total:counts[filters.filter],page:filters.page,pageSize};
      });
    },
    async mutateAttentionConversation(actor: AttentionActor, id: string, input: AttentionMutation): Promise<void> {
      assertAttentionActor(actor); attentionUuid(id);
      const mutation = parseAttentionMutation(input as unknown as Record<string, unknown>);
      await transaction(actor, async tx => {
        await requireSchema(tx); const row = await loadConversation(tx, actor, id, true);
        const request = await idempotent(tx, actor, mutation.requestId, { id, mutation });
        if (request.replay) return;
        if (row.version !== mutation.version) throw new AttentionError("La conversación cambió. Actualiza antes de continuar.", 409);
        if (["transfer", "link", "unlink"].includes(mutation.action) && !actor.central) throw new AttentionError("La asignación y vinculación requieren administración central.", 403);
        const assignments: string[] = []; const values: unknown[] = [id];
        const set = (field: string, value: unknown, cast = "") => { values.push(value); assignments.push(`"${field}"=$${values.length}${cast}`); };
        if (mutation.action === "claim") {
          if (!actor.analyst || row.assigneeKey !== actor.key || row.assigneeUserId !== actor.userId) throw new AttentionError("Solo el analista asignado puede iniciar la atención.", 403);
          set("assigneeKey", actor.key); set("assigneeName", actor.name); set("assigneeUserId", actor.userId); set("assigneeSellerId", actor.sellerId); set("status", "open"); set("closedAt", null);
        } else if (mutation.action === "transfer") {
          const targets = await tx.$queryRawUnsafe<{key: string; name: string}[]>(`SELECT 'analyst:'||u.id::text AS key,u.nombre AS name
            FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
            WHERE u.id=$1 AND u.activo=true AND s.activa=true AND a.activo=true AND upper(trim(a.codigo))='FINSERPAY'
            AND upper(trim(r.nombre))='ANALISTA_APROBACION' FOR SHARE OF u,r,s,a`, Number(mutation.assigneeKey!.split(":")[1]));
          const target = targets[0];
          if (!target) throw new AttentionError("El analista nominal no está activo o no está autorizado.", 403);
          set("assigneeKey", target.key); set("assigneeName", target.name);
          set("assigneeUserId", Number(target.key.split(":")[1]));
          set("assigneeSellerId", null); set("status", "open"); set("closedAt", null);
        } else if (mutation.action === "close" || mutation.action === "reopen") {
          set("status", mutation.action === "close" ? "closed" : row.assigneeKey ? "open" : "pending");
          if (mutation.action === "close") assignments.push('"closedAt"=COALESCE("closedAt",now())');
          else set("closedAt", null);
        }
        else if (mutation.action === "human_request") set("mode", "human_requested");
        else if (mutation.action === "tags") set("tags", JSON.stringify(mutation.tags), "::jsonb");
        else if (mutation.action === "note") await tx.$queryRawUnsafe(`INSERT INTO "AttentionNote"(id,"conversationId",text,author,"userId","sellerId") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) RETURNING id`, randomUUID(), id, mutation.text, actor.name, actor.userId, actor.sellerId);
        else if (mutation.action === "task") await tx.$queryRawUnsafe(`INSERT INTO "AttentionTask"(id,"conversationId",title,"dueAt",author,"userId","sellerId") VALUES($1::uuid,$2::uuid,$3,$4::timestamptz,$5,$6,$7) RETURNING id`, randomUUID(), id, mutation.text, mutation.dueAt, actor.name, actor.userId, actor.sellerId);
        else if (mutation.action === "complete_task") {
          const updated = await tx.$queryRawUnsafe<{id: string}[]>(`UPDATE "AttentionTask" SET "completedAt"=COALESCE("completedAt",now()) WHERE id=$1::uuid AND "conversationId"=$2::uuid RETURNING id`, mutation.taskId, id);
          if (!updated.length) throw new AttentionError("Tarea no encontrada.", 404);
        } else if (mutation.action === "link") {
          const credits = await candidateCredits(tx, actor, row);
          if (!credits.some(c => c.id === mutation.creditId)) throw new AttentionError("El crédito no coincide con el teléfono o no pertenece al alcance autorizado.", 403);
          set("linkedCreditId", mutation.creditId);
        } else if (mutation.action === "unlink") set("linkedCreditId", null);
        await tx.$queryRawUnsafe(`UPDATE "AttentionConversation" SET ${assignments.length ? `${assignments.join(",")},` : ""} version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, ...values);
        await audit(tx, actor, `CONVERSATION_${mutation.action.toUpperCase()}`, id, { requestId: mutation.requestId, version: row.version + 1,
          ...(mutation.action === "transfer" ? { assigneeKey: mutation.assigneeKey } : {}), ...(mutation.action === "link" ? { creditId: mutation.creditId } : {}) });
      }, options);
    },
    async createAttentionCase(actor: AttentionActor, input: {phone: string; name: string; requestId: string}): Promise<{id: string}> {
      assertAttentionActor(actor); const phone = normalizeAttentionPhone(input.phone); const name = attentionText(input.name, 160);
      if (!actor.central) throw new AttentionError("Solo administración central puede crear una gestión interna.", 403);
      return transaction(actor, async tx => {
        await requireSchema(tx);
        const request = await idempotent(tx, actor, input.requestId, { action: "create", phone, name });
        if (request.replay && request.resultId) { await loadConversation(tx, actor, request.resultId); return { id: request.resultId }; }
        const id = randomUUID();
        await tx.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,channel,phone,name,status)
          VALUES($1::uuid,'internal',$2,$3,'pending') RETURNING id`, id, phone, name);
        await tx.$queryRawUnsafe(`UPDATE "AttentionRequest" SET "resultId"=$3::uuid WHERE "actorKey"=$1 AND "requestId"=$2::uuid RETURNING "requestId"`, actor.key, input.requestId, id);
        await audit(tx, actor, "INTERNAL_CASE_CREATED", id, { requestId: input.requestId }); return { id };
      }, options);
    },
    async saveAttentionQuickReply(actor: AttentionActor, input: {title: string; text: string; requestId: string}): Promise<void> {
      assertAttentionActor(actor); if (!actor.central) throw new AttentionError("La aprobación de respuestas requiere administración central.", 403);
      const title = attentionText(input.title, 100); const text = attentionText(input.text, 4000);
      await transaction(actor, async tx => {
        await requireSchema(tx); if ((await idempotent(tx, actor, input.requestId, { action: "approve_reply", title, text })).replay) return;
        const id = randomUUID();
        await tx.$queryRawUnsafe(`INSERT INTO "AttentionQuickReply"(id,title,text,"approvedBy","approvedByUserId") VALUES($1::uuid,$2,$3,$4,$5) RETURNING id`, id, title, text, actor.name, actor.userId);
        await audit(tx, actor, "QUICK_REPLY_APPROVED", null, { replyId: id, requestId: input.requestId });
      }, options);
    },
    async importAttentionSnapshots(actor: AttentionActor, snapshots: DaptaConversationSnapshot[]): Promise<{imported: number; messagesImported: number}> {
      assertAttentionActor(actor); if (!actor.central) throw new AttentionError("Solo administración central puede sincronizar Dapta.", 403);
      if (!Array.isArray(snapshots) || snapshots.length > 100) throw new AttentionError("Sincroniza un máximo de cien conversaciones por solicitud.");
      return transaction(actor, async tx => {
        await requireSchema(tx);
        const metaReady = await attentionMetaSchemaReady(tx);
        if(metaReady) await tx.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:provider-import',0))`);
        let imported = 0; let messagesImported = 0;
        // Stable lock ordering avoids two concurrent imports locking chats in opposite order.
        for (const snapshot of [...snapshots].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
          const externalId = attentionText(snapshot.externalId, 240); const phone = snapshot.phone === null ? null : normalizeAttentionPhone(snapshot.phone);
          const name = snapshot.name ? attentionText(snapshot.name, 160) : phone || "Contacto de WhatsApp";
          if (!["unknown", "ai", "human"].includes(snapshot.mode) || !Array.isArray(snapshot.messages) || snapshot.messages.length > 1000) throw new AttentionError("Conversación de Dapta inválida.");
          const historyCursor = snapshot.historyCursor;
          if (historyCursor !== null && (typeof historyCursor !== "string" || !historyCursor || historyCursor.length > 4096 || [...historyCursor].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))) throw new AttentionError("Punto de sincronización de Dapta inválido.");
          let contact = snapshot.lastContactAt ? new Date(snapshot.lastContactAt) : null;
          if (contact && !Number.isFinite(contact.getTime())) throw new AttentionError("Fecha de Dapta inválida.");
          let normalizedMessages = snapshot.messages.map(message => {
            const externalId = attentionText(message.id, 240); const text = attentionText(message.text, 16000, false);
            if (!["inbound", "outbound"].includes(message.direction) || !Number.isFinite(Date.parse(message.sentAt))) throw new AttentionError("Mensaje de Dapta inválido.");
            const sentAt = new Date(message.sentAt);
            if (!contact || sentAt.getTime() > contact.getTime()) contact = sentAt;
            return { id: randomUUID(), externalId, direction: message.direction, text, sentAt: sentAt.toISOString(), author: message.author ? attentionText(message.author, 160) : null };
          });
          await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1::text,0::bigint))`, `attention:dapta:${externalId}`);
          let existing = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT * FROM "AttentionConversation" WHERE "externalId"=$1 FOR UPDATE`, externalId);
          if(metaReady && !existing.length && phone) {
            const native = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT * FROM "AttentionConversation" WHERE channel='whatsapp' AND phone=$1 ORDER BY id LIMIT 2 FOR UPDATE`,phone);
            if(native.length===1 && native[0].metaManaged && !native[0].externalId) {
              existing=native;
              await tx.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "externalId"=$2 WHERE id=$1::uuid RETURNING id`,native[0].id,externalId);
            }
          }
          if (existing[0]?.phone && phone && existing[0].phone !== phone) throw new AttentionError("El teléfono de la conversación cambió. Requiere revisión.", 409);
          const id = existing[0]?.id || randomUUID();
          if(metaReady && existing[0]?.metaManaged) {
            // Native inbound owns the timeline after capture begins. Keep Dapta
            // outbound for AI context: its UUIDs cannot be guessed into wamids.
            const [boundary] = await tx.$queryRawUnsafe<{at:Date|string|null}[]>(`SELECT min("sentAt") AS at FROM "AttentionMessage" WHERE "conversationId"=$1::uuid AND "metaWamid" IS NOT NULL`,id);
            normalizedMessages = normalizedMessages.filter(m=>m.direction==='outbound'||(boundary?.at && Date.parse(m.sentAt)<new Date(boundary.at).getTime()));
            contact = existing[0].lastContactAt ? new Date(existing[0].lastContactAt) : null;
            for(const message of normalizedMessages)if(!contact||Date.parse(message.sentAt)>contact.getTime())contact=new Date(message.sentAt);
          }
          if (!existing.length) await tx.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name,mode,"lastContactAt","historyTruncated","daptaMessagesCursor")
            VALUES($1::uuid,$2,'whatsapp',$3,$4,$5,$6::timestamptz,$7,$8) RETURNING id`, id, externalId, phone, name, snapshot.mode, contact, snapshot.historyTruncated, historyCursor);
          const inserted = normalizedMessages.length ? await tx.$queryRawUnsafe<{direction: string; sentAt: Date | string}[]>(`
            INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author)
            SELECT m.id,$1::uuid,m."externalId",m.direction,m.text,m."sentAt",m.author FROM jsonb_to_recordset($2::jsonb)
              AS m(id uuid,"externalId" text,direction text,text text,"sentAt" timestamptz,author text)
            ON CONFLICT("conversationId","externalId") DO NOTHING RETURNING direction,"sentAt"`, id, JSON.stringify(normalizedMessages)) : [];
          const newMessages = inserted.length;
          messagesImported += newMessages;
          const reopen = Boolean(!existing[0]?.metaManaged && existing[0]?.status === "closed" && inserted.some(m => m.direction === "inbound" && new Date(m.sentAt).getTime() > new Date(existing[0].closedAt || existing[0].updatedAt).getTime()));
          const mode = existing[0]?.metaManaged || existing[0]?.mode === "human_requested" ? existing[0].mode : snapshot.mode;
          const newer = contact && (!existing[0]?.lastContactAt || contact.getTime() > new Date(existing[0].lastContactAt).getTime());
          const resolvedPhone = phone || existing[0]?.phone || null;
          if (existing.length && (newMessages || newer || existing[0].phone !== resolvedPhone || existing[0].historyTruncated !== snapshot.historyTruncated || mode !== existing[0].mode || existing[0].daptaMessagesCursor !== historyCursor)) {
            await tx.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "lastContactAt"=GREATEST("lastContactAt",$2::timestamptz),
              "historyTruncated"=$3,mode=$4,status=CASE WHEN $5::boolean THEN 'pending' ELSE status END,"closedAt"=CASE WHEN $5::boolean THEN NULL ELSE "closedAt" END,
              "daptaMessagesCursor"=$6,phone=$7,version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, id, contact, snapshot.historyTruncated, mode, reopen, historyCursor, resolvedPhone);
          }
          if (!existing.length || newMessages || newer) imported++;
          await audit(tx, actor, "DAPTA_SNAPSHOT_IMPORTED", id, { newMessages });
        }
        return { imported, messagesImported };
      }, options);
    },
  };
}

async function store() { const { default: prisma } = await import("./prisma"); return createAttentionStore(prisma as unknown as AttentionDatabase); }
export async function getAttentionInbox(actor: AttentionActor, filters: AttentionFilters) { return (await store()).getAttentionInbox(actor, filters); }
export async function getAttentionDetail(actor: AttentionActor, id: string) { return (await store()).getAttentionDetail(actor, id); }
export async function mutateAttentionConversation(actor: AttentionActor, id: string, mutation: AttentionMutation) { return (await store()).mutateAttentionConversation(actor, id, mutation); }
export async function createAttentionCase(actor: AttentionActor, input: {phone: string; name: string; requestId: string}) { return (await store()).createAttentionCase(actor, input); }
export async function saveAttentionQuickReply(actor: AttentionActor, input: {title: string; text: string; requestId: string}) { return (await store()).saveAttentionQuickReply(actor, input); }
export async function importAttentionSnapshots(actor: AttentionActor, snapshots: DaptaConversationSnapshot[]) { return (await store()).importAttentionSnapshots(actor, snapshots); }
export async function getAttentionHistoryCursors(actor: AttentionActor) { return (await store()).getAttentionHistoryCursors(actor); }
export async function markAttentionRead(actor: AttentionActor, id: string, input: {messageIds:string[]}) { return (await store()).markAttentionRead(actor,id,input); }
export async function getAttentionAgenda(actor: AttentionActor, filters: AttentionAgendaFilters) { return (await store()).getAttentionAgenda(actor,filters); }
