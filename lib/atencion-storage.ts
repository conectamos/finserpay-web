import { createHash, randomUUID } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionText, attentionUuid, normalizeAttentionPhone, parseAttentionMutation } from "./atencion-core";
import { buildCreditPaymentPlan } from "./credit-payment-plan";
import type { AttentionActor, AttentionAssignee, AttentionBranch, AttentionConversation, AttentionCustomer, AttentionDetail, AttentionFilters, AttentionInbox, AttentionMutation, AttentionQuickReply, DaptaConversationSnapshot } from "./atencion-types";

export interface AttentionDb { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>; }
export interface AttentionDatabase extends AttentionDb {
  $transaction<T>(fn: (tx: AttentionDb) => Promise<T>, options: { isolationLevel: "ReadCommitted"; timeout: number; maxWait: number }): Promise<T>;
}
type ConversationRow = Omit<AttentionConversation, "lastContactAt" | "updatedAt" | "preview"> & {
  lastContactAt: Date | string | null; updatedAt: Date | string; closedAt: Date | string | null;
  daptaMessagesCursor: string | null; preview?: string | null; historyTruncated: boolean;
};
type CreditRow = { id: number; folio: string; clienteNombre: string; clienteDocumento: string | null; estado: string;
  referenciaEquipo: string | null; equipoMarca: string | null; equipoModelo: string | null;
  montoCredito: number; valorCuota: number; plazoMeses: number | null; frecuenciaPago: string;
  fechaPrimerPago: Date | string | null; fechaProximoPago: Date | string | null; pazYSalvoEmitidoAt: Date | string | null; planCapitalVigente: unknown;
};
type DraftRow = { id: number; clienteNombre: string | null; clienteDocumento: string | null; estado: string;
  dataCreditoAssessmentId: string | null; createdAt: Date | string };
const options = { isolationLevel: "ReadCommitted" as const, timeout: 30000, maxWait: 10000 };
const pageSize = 40;
const iso = (value: Date | string) => new Date(value).toISOString();
const documentKey = (value: string | null) => (value || "").replace(/\D/g, "");
const maskDocument = (value: string | null) => value ? `••••${documentKey(value).slice(-4)}` : "Sin documento";
function conversation(row: ConversationRow): AttentionConversation {
  return { id: row.id, externalId: row.externalId, channel: row.channel, phone: row.phone, name: row.name,
    status: row.status, mode: row.mode, assigneeKey: row.assigneeKey, assigneeName: row.assigneeName,
    sedeId: row.sedeId, lastContactAt: row.lastContactAt ? iso(row.lastContactAt) : null, updatedAt: iso(row.updatedAt),
    preview: row.preview ?? null, tags: row.tags, version: row.version, linkedCreditId: row.linkedCreditId };
}
/** All access predicates are evaluated on the server from the current session. */
function scope(actor: AttentionActor) {
  return { sql: `($1::boolean OR s."aliadoId"=$2::integer)
    AND ($3::boolean OR c."sedeId"=$4::integer)
    AND ($5::boolean OR c."assigneeKey" IS NULL OR c."assigneeKey"=$6::text)`,
    values: [actor.central, actor.aliadoId, actor.admin, actor.sedeId, actor.admin || actor.supervisor, actor.key] };
}
async function schemaReady(tx: AttentionDb) {
  const rows = await tx.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT
    to_regclass('public."AttentionConversation"') IS NOT NULL AND to_regclass('public."AttentionMessage"') IS NOT NULL
    AND to_regclass('public."AttentionNote"') IS NOT NULL AND to_regclass('public."AttentionTask"') IS NOT NULL
    AND to_regclass('public."AttentionQuickReply"') IS NOT NULL AND to_regclass('public."AttentionAudit"') IS NOT NULL
    AND to_regclass('public."AttentionRequest"') IS NOT NULL AS ready`);
  return rows[0]?.ready === true;
}
async function requireSchema(tx: AttentionDb) { if (!await schemaReady(tx)) throw new AttentionError("Atención requiere preparar su esquema de base de datos.", 503); }
async function audit(tx: AttentionDb, actor: AttentionActor, action: string, id: string | null, metadata: object = {}) {
  await tx.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId",action,metadata)
    VALUES ($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`, id, actor.userId, actor.sellerId, action, JSON.stringify(metadata));
}
async function branchList(tx: AttentionDb, actor: AttentionActor): Promise<AttentionBranch[]> {
  return tx.$queryRawUnsafe(`SELECT s.id,s.nombre AS name FROM "Sede" s WHERE s.activa=true
    AND ($1::boolean OR s."aliadoId"=$2::integer) AND ($3::boolean OR s.id=$4::integer) ORDER BY s.nombre,s.id`,
    actor.central, actor.aliadoId, actor.admin, actor.sedeId);
}
async function teamList(tx: AttentionDb, actor: AttentionActor): Promise<AttentionAssignee[]> {
  const allowed = await branchList(tx, actor);
  const rows = await tx.$queryRawUnsafe<{key: string; name: string; sedeId: number}[]>(`
    SELECT 'seller:'||v.id::text AS key,v.nombre AS name,sv."sedeId" FROM "Vendedor" v
    JOIN "SedeVendedor" sv ON sv."vendedorId"=v.id WHERE v.activo=true AND sv.activo=true AND sv."sedeId"=ANY($1::integer[])
    UNION ALL SELECT 'user:'||u.id::text,u.nombre,u."sedeId" FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId"
    WHERE u.activo=true AND upper(trim(r.nombre))='ADMIN' AND u."sedeId"=ANY($1::integer[])`, allowed.map(b => b.id));
  const grouped = new Map<string, AttentionAssignee>();
  for (const row of rows) { const person = grouped.get(row.key) || { key: row.key, name: row.name, sedeIds: [] }; person.sedeIds.push(row.sedeId); grouped.set(row.key, person); }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
}
async function loadConversation(tx: AttentionDb, actor: AttentionActor, id: string, lock = false) {
  const access = scope(actor);
  const rows = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT c.* FROM "AttentionConversation" c JOIN "Sede" s ON s.id=c."sedeId"
    WHERE ${access.sql} AND c.id=$7::uuid ${lock ? "FOR UPDATE OF c" : ""}`, ...access.values, attentionUuid(id));
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
function phoneSql(alias: "c" | "k" | "d") {
  const digits = `regexp_replace(regexp_replace(COALESCE(${alias}."clienteTelefono",''),'[^0-9]','','g'),'^00','')`;
  return `(CASE WHEN length(${digits})=10 AND ${digits} LIKE '3%' THEN '+57'||${digits} ELSE '+'||${digits} END)`;
}
async function candidateCredits(tx: AttentionDb, actor: AttentionActor, row: ConversationRow): Promise<CreditRow[]> {
  return tx.$queryRawUnsafe(`SELECT c.id,c.folio,c."clienteNombre",c."clienteDocumento",c.estado,c."referenciaEquipo",c."equipoMarca",c."equipoModelo",
    c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",c."fechaPrimerPago",c."fechaProximoPago",c."pazYSalvoEmitidoAt",
    to_jsonb(c)->'planCapitalVigente' AS "planCapitalVigente" FROM "Credito" c JOIN "Sede" s ON s.id=c."sedeId"
    WHERE ${phoneSql("c")}=$1 AND c."sedeId"=$2 AND ($3::boolean OR s."aliadoId"=$4::integer)
    AND ($5::boolean OR c."vendedorId"=$6::integer) ORDER BY c.id DESC LIMIT 101`,
    row.phone, row.sedeId, actor.central, actor.aliadoId, actor.admin || actor.supervisor, actor.sellerId);
}
async function candidateDrafts(tx: AttentionDb, actor: AttentionActor, row: ConversationRow): Promise<DraftRow[]> {
  const presence = await tx.$queryRawUnsafe<{present: boolean}[]>(`SELECT to_regclass('public."CreditoBorrador"') IS NOT NULL AS present`);
  if (!presence[0]?.present) return [];
  return tx.$queryRawUnsafe(`SELECT d.id,d."clienteNombre",d."clienteDocumento",d.estado,d."dataCreditoAssessmentId",d."createdAt"
    FROM "CreditoBorrador" d JOIN "Sede" s ON s.id=d."sedeId" WHERE d."creditoId" IS NULL
    AND ${phoneSql("d")}=$1 AND d."sedeId"=$2 AND ($3::boolean OR s."aliadoId"=$4::integer)
    AND ($5::boolean OR d."vendedorId"=$6::integer) ORDER BY d.id DESC LIMIT 101`,
    row.phone, row.sedeId, actor.central, actor.aliadoId, actor.admin || actor.supervisor, actor.sellerId);
}
async function customerDetail(tx: AttentionDb, actor: AttentionActor, row: ConversationRow): Promise<AttentionCustomer> {
  const candidates = await candidateCredits(tx, actor, row);
  const drafts = await candidateDrafts(tx, actor, row);
  const keys = new Set([...candidates.map(c => documentKey(c.clienteDocumento) || `credit:${c.id}`), ...drafts.map(d => documentKey(d.clienteDocumento) || `draft:${d.id}`)]);
  const linked = row.linkedCreditId ? candidates.find(c => c.id === row.linkedCreditId) : null;
  const ambiguous = candidates.length > 100 || drafts.length > 100 || (!linked && keys.size > 1);
  const customer: AttentionCustomer = { match: row.linkedCreditId && !linked ? "restricted" : ambiguous ? "ambiguous" : candidates.length || drafts.length ? "linked" : "none",
    name: null, documentMasked: null, candidates: candidates.slice(0, 100).map(c => ({ id: c.id, folio: c.folio, name: c.clienteNombre, documentMasked: maskDocument(c.clienteDocumento) })),
    credits: [], studies: [], financialAllowed: actor.admin };
  if (customer.match !== "linked") return customer;
  const identity = linked || candidates.at(0) || drafts[0];
  const credits = candidates.filter(c => identity.clienteDocumento ? documentKey(c.clienteDocumento) === documentKey(identity.clienteDocumento) : c === identity);
  const selectedDrafts = drafts.filter(d => identity.clienteDocumento ? documentKey(d.clienteDocumento) === documentKey(identity.clienteDocumento) : d === identity);
  customer.name = identity.clienteNombre; customer.documentMasked = maskDocument(identity.clienteDocumento);
  const payments = actor.admin ? await tx.$queryRawUnsafe<{creditoId: number; valor: number; metodoPago: string; fechaAbono: Date | string}[]>(`
    SELECT "creditoId",valor,"metodoPago","fechaAbono" FROM "CreditoAbono"
    WHERE "creditoId"=ANY($1::integer[]) AND estado='ACTIVO' AND "anuladoAt" IS NULL ORDER BY "fechaAbono" DESC,id DESC`, credits.map(c => c.id)) : [];
  customer.credits = credits.map(c => {
    const abonos = payments.filter(p => p.creditoId === c.id);
    const complete = Boolean(c.fechaPrimerPago && Number(c.plazoMeses) > 0 && Number.isFinite(Number(c.montoCredito)) && Number(c.montoCredito) >= 0);
    const plan = actor.admin && complete ? buildCreditPaymentPlan({ ...c, abonos, settled: Boolean(c.pazYSalvoEmitidoAt) }) : null;
    return { id: c.id, folio: c.folio, state: c.estado, equipment: c.referenciaEquipo || [c.equipoMarca, c.equipoModelo].filter(Boolean).join(" ") || "Sin equipo registrado",
      balance: plan?.saldoPendiente ?? null, nextDueAt: plan && plan.saldoPendiente > 0 ? plan.nextInstallment?.fechaVencimiento ?? null : null,
      nextAmount: plan && plan.saldoPendiente > 0 ? plan.nextInstallment?.saldoPendiente ?? null : null,
      payments: abonos.slice(0, 10).map(p => ({ date: iso(p.fechaAbono), amount: Number(p.valor), method: p.metodoPago })) };
  });
  const studiesPresent = await tx.$queryRawUnsafe<{present: boolean}[]>(`SELECT to_regclass('public."DataCreditoAssessment"') IS NOT NULL AS present`);
  if (studiesPresent[0]?.present) {
    const studies = await tx.$queryRawUnsafe<{id: string; state: string; createdAt: Date | string}[]>(`SELECT id,status AS state,"createdAt"
      FROM "DataCreditoAssessment" WHERE ("creditId"=ANY($1::integer[]) OR id=ANY($7::uuid[])) AND "sedeId"=$2
      AND ($3::boolean OR "aliadoId"=$4::integer) AND ($5::boolean OR "sellerId"=$6::integer)
      ORDER BY "createdAt" DESC LIMIT 20`, credits.map(c => c.id), row.sedeId, actor.central, actor.aliadoId, actor.admin || actor.supervisor, actor.sellerId,
      selectedDrafts.flatMap(d => d.dataCreditoAssessmentId ? [d.dataCreditoAssessmentId] : []));
    customer.studies = studies.map(s => ({ ...s, createdAt: iso(s.createdAt) }));
  }
  // Existing applications remain visible even before an assessment exists; no new client/draft is created.
  customer.studies.push(...selectedDrafts.filter(d => !d.dataCreditoAssessmentId || !customer.studies.some(s => s.id === d.dataCreditoAssessmentId))
    .map(d => ({ id: `D-${d.id}`, state: `Solicitud: ${d.estado}`, createdAt: iso(d.createdAt) })));
  return customer;
}

export function createAttentionStore(database: AttentionDatabase) {
  return {
    async getAttentionHistoryCursors(actor: AttentionActor, sedeId: number): Promise<Record<string, string | null>> {
      assertAttentionActor(actor); if (!actor.central) throw new AttentionError("Solo administración central puede leer los puntos de sincronización.", 403);
      return database.$transaction(async tx => {
        await requireSchema(tx);
        if (!(await branchList(tx, actor)).some(b => b.id === sedeId)) throw new AttentionError("Sede no autorizada.", 403);
        const rows = await tx.$queryRawUnsafe<{externalId: string; daptaMessagesCursor: string | null}[]>(`SELECT "externalId","daptaMessagesCursor"
          FROM "AttentionConversation" WHERE "sedeId"=$1 AND channel='whatsapp' AND "externalId" IS NOT NULL`, sedeId);
        await audit(tx, actor, "DAPTA_CHECKPOINTS_READ", null, { sedeId, count: rows.length });
        return Object.fromEntries(rows.map(row => [row.externalId, row.daptaMessagesCursor]));
      }, options);
    },
    async getAttentionInbox(actor: AttentionActor, filters: AttentionFilters): Promise<Omit<AttentionInbox, "integration">> {
      assertAttentionActor(actor);
      return database.$transaction(async tx => {
        const empty = { schemaReady: false, conversations: [], total: 0, page: filters.page, pageSize,
          metrics: { pending: 0, open: 0, closed: 0, mine: 0 }, team: [], branches: [], quickReplies: [], actor };
        if (!await schemaReady(tx)) return empty;
        const access = scope(actor);
        const draftsPresent = await tx.$queryRawUnsafe<{present: boolean}[]>(`SELECT to_regclass('public."CreditoBorrador"') IS NOT NULL AS present`);
        const draftSearch = draftsPresent[0]?.present ? `OR EXISTS(SELECT 1 FROM "CreditoBorrador" d WHERE d."sedeId"=c."sedeId" AND ${phoneSql("d")}=c.phone
          AND ($5::boolean OR 'seller:'||d."vendedorId"::text=$6) AND d."clienteNombre" ILIKE $8)` : "";
        const filtered = `${access.sql} AND ($7::text='' OR c.name ILIKE $8 OR c.phone LIKE $8
          OR EXISTS(SELECT 1 FROM "Credito" k WHERE k."sedeId"=c."sedeId" AND ${phoneSql("k")}=c.phone
            AND ($5::boolean OR 'seller:'||k."vendedorId"::text=$6) AND k."clienteNombre" ILIKE $8) ${draftSearch})
          AND ($9::text='all' OR ($9='mine' AND c."assigneeKey"=$6) OR ($9='pending' AND c.status='pending') OR ($9='closed' AND c.status='closed'))`;
        const values = [...access.values, filters.search, `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`, filters.filter];
        const rows = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT c.*,
          (SELECT left(m.text,160) FROM "AttentionMessage" m WHERE m."conversationId"=c.id ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS preview
          FROM "AttentionConversation" c JOIN "Sede" s ON s.id=c."sedeId" WHERE ${filtered}
          ORDER BY c."updatedAt" DESC,c.id LIMIT $10 OFFSET $11`, ...values, pageSize, (filters.page - 1) * pageSize);
        const totals = await tx.$queryRawUnsafe<{total: number}[]>(`SELECT count(*)::integer AS total FROM "AttentionConversation" c JOIN "Sede" s ON s.id=c."sedeId" WHERE ${filtered}`, ...values);
        const metricRows = await tx.$queryRawUnsafe<{pending: number; open: number; closed: number; mine: number}[]>(`SELECT
          count(*) FILTER (WHERE c.status='pending')::integer AS pending, count(*) FILTER (WHERE c.status='open')::integer AS open,
          count(*) FILTER (WHERE c.status='closed')::integer AS closed, count(*) FILTER (WHERE c."assigneeKey"=$6)::integer AS mine
          FROM "AttentionConversation" c JOIN "Sede" s ON s.id=c."sedeId" WHERE ${access.sql}`, ...access.values);
        const replies = await tx.$queryRawUnsafe<AttentionQuickReply[]>(`SELECT id,title,text,"approvedBy","approvedAt" FROM "AttentionQuickReply" ORDER BY title,id LIMIT 200`);
        const result = { schemaReady: true, conversations: rows.map(conversation), total: totals[0]?.total || 0, page: filters.page, pageSize,
          metrics: metricRows[0], team: await teamList(tx, actor), branches: await branchList(tx, actor),
          quickReplies: replies.map(reply => ({ ...reply, approvedAt: iso(reply.approvedAt) })), actor };
        await audit(tx, actor, "INBOX_VIEWED", null, { filter: filters.filter, page: filters.page, conversationIds: rows.map(r => r.id) });
        return result;
      }, options);
    },
    async getAttentionDetail(actor: AttentionActor, id: string): Promise<AttentionDetail> {
      assertAttentionActor(actor);
      return database.$transaction(async tx => {
        await requireSchema(tx); const row = await loadConversation(tx, actor, id);
        const messages = await tx.$queryRawUnsafe<{id: string; direction: "inbound" | "outbound"; text: string; sentAt: Date | string; author: string | null}[]>(`
          SELECT id,direction,text,"sentAt",author FROM "AttentionMessage" WHERE "conversationId"=$1::uuid ORDER BY "sentAt" DESC,id DESC LIMIT 501`, id);
        const notes = await tx.$queryRawUnsafe<{id: string; text: string; author: string; createdAt: Date | string}[]>(`SELECT id,text,author,"createdAt" FROM "AttentionNote" WHERE "conversationId"=$1::uuid ORDER BY "createdAt" DESC,id DESC LIMIT 301`, id);
        const tasks = await tx.$queryRawUnsafe<{id: string; title: string; author: string; dueAt: Date | string | null; completedAt: Date | string | null}[]>(`SELECT id,title,author,"dueAt","completedAt" FROM "AttentionTask" WHERE "conversationId"=$1::uuid ORDER BY ("completedAt" IS NOT NULL),"dueAt" ASC NULLS LAST,"createdAt" DESC,id LIMIT 301`, id);
        const customer = await customerDetail(tx, actor, row);
        await audit(tx, actor, "CONVERSATION_VIEWED", row.id, { financial: customer.financialAllowed, creditIds: customer.credits.map(c => c.id), studyIds: customer.studies.map(s => s.id) });
        return { conversation: conversation({ ...row, name: row.name === row.phone && customer.name ? customer.name : row.name }), messages: messages.slice(0,500).reverse().map(m => ({ ...m, sentAt: iso(m.sentAt) })),
          notes: notes.slice(0,300).reverse().map(n => ({ ...n, createdAt: iso(n.createdAt) })), tasks: tasks.slice(0,300).map(t => ({ ...t, dueAt: t.dueAt ? iso(t.dueAt) : null, completedAt: t.completedAt ? iso(t.completedAt) : null })),
          customer, permissions: { manage: actor.admin || actor.supervisor || row.assigneeKey === actor.key,
            claim: row.assigneeKey === null || row.assigneeKey === actor.key, canSend: false }, historyTruncated: row.historyTruncated || messages.length > 500,
          notesTruncated: notes.length > 300, tasksTruncated: tasks.length > 300 };
      }, options);
    },
    async mutateAttentionConversation(actor: AttentionActor, id: string, input: AttentionMutation): Promise<void> {
      assertAttentionActor(actor); attentionUuid(id);
      const mutation = parseAttentionMutation(input as unknown as Record<string, unknown>);
      await database.$transaction(async tx => {
        await requireSchema(tx); const row = await loadConversation(tx, actor, id, true);
        const request = await idempotent(tx, actor, mutation.requestId, { id, mutation });
        if (request.replay) return;
        if (row.version !== mutation.version) throw new AttentionError("La conversación cambió. Actualiza antes de continuar.", 409);
        const manage = actor.admin || actor.supervisor || row.assigneeKey === actor.key;
        if (mutation.action !== "claim" && !manage) throw new AttentionError("Toma la conversación antes de modificarla.", 403);
        const assignments: string[] = []; const values: unknown[] = [id];
        const set = (field: string, value: unknown, cast = "") => { values.push(value); assignments.push(`"${field}"=$${values.length}${cast}`); };
        if (mutation.action === "claim") {
          if (row.assigneeKey && row.assigneeKey !== actor.key) throw new AttentionError("La conversación ya tiene asesor. Usa transferir.", 409);
          set("assigneeKey", actor.key); set("assigneeName", actor.name); set("assigneeUserId", actor.userId); set("assigneeSellerId", actor.sellerId); set("status", "open"); set("closedAt", null);
        } else if (mutation.action === "transfer") {
          const target = (await teamList(tx, actor)).find(person => person.key === mutation.assigneeKey && person.sedeIds.includes(row.sedeId));
          if (!target) throw new AttentionError("El asesor no está activo en la sede de esta conversación.", 403);
          set("assigneeKey", target.key); set("assigneeName", target.name);
          set("assigneeUserId", target.key.startsWith("user:") ? Number(target.key.split(":")[1]) : null);
          set("assigneeSellerId", target.key.startsWith("seller:") ? Number(target.key.split(":")[1]) : null); set("status", "open"); set("closedAt", null);
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
    async createAttentionCase(actor: AttentionActor, input: {phone: string; name: string; sedeId: number; requestId: string}): Promise<{id: string}> {
      assertAttentionActor(actor); const phone = normalizeAttentionPhone(input.phone); const name = attentionText(input.name, 160);
      if (!Number.isSafeInteger(input.sedeId) || input.sedeId < 1) throw new AttentionError("Sede inválida.");
      return database.$transaction(async tx => {
        await requireSchema(tx);
        if (!(await branchList(tx, actor)).some(b => b.id === input.sedeId)) throw new AttentionError("Sede no autorizada.", 403);
        const request = await idempotent(tx, actor, input.requestId, { action: "create", phone, name, sedeId: input.sedeId });
        if (request.replay && request.resultId) { await loadConversation(tx, actor, request.resultId); return { id: request.resultId }; }
        const id = randomUUID();
        await tx.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,channel,phone,name,"sedeId",status,"assigneeKey","assigneeName","assigneeUserId","assigneeSellerId")
          VALUES($1::uuid,'internal',$2,$3,$4,'open',$5,$6,$7,$8) RETURNING id`, id, phone, name, input.sedeId, actor.key, actor.name, actor.userId, actor.sellerId);
        await tx.$queryRawUnsafe(`UPDATE "AttentionRequest" SET "resultId"=$3::uuid WHERE "actorKey"=$1 AND "requestId"=$2::uuid RETURNING "requestId"`, actor.key, input.requestId, id);
        await audit(tx, actor, "INTERNAL_CASE_CREATED", id, { requestId: input.requestId }); return { id };
      }, options);
    },
    async saveAttentionQuickReply(actor: AttentionActor, input: {title: string; text: string; requestId: string}): Promise<void> {
      assertAttentionActor(actor); if (!actor.central) throw new AttentionError("La aprobación de respuestas requiere administración central.", 403);
      const title = attentionText(input.title, 100); const text = attentionText(input.text, 4000);
      await database.$transaction(async tx => {
        await requireSchema(tx); if ((await idempotent(tx, actor, input.requestId, { action: "approve_reply", title, text })).replay) return;
        const id = randomUUID();
        await tx.$queryRawUnsafe(`INSERT INTO "AttentionQuickReply"(id,title,text,"approvedBy","approvedByUserId") VALUES($1::uuid,$2,$3,$4,$5) RETURNING id`, id, title, text, actor.name, actor.userId);
        await audit(tx, actor, "QUICK_REPLY_APPROVED", null, { replyId: id, requestId: input.requestId });
      }, options);
    },
    async importAttentionSnapshots(actor: AttentionActor, sedeId: number, snapshots: DaptaConversationSnapshot[]): Promise<{imported: number}> {
      assertAttentionActor(actor); if (!actor.central) throw new AttentionError("Solo administración central puede sincronizar Dapta.", 403);
      if (!Array.isArray(snapshots) || snapshots.length > 100) throw new AttentionError("Sincroniza un máximo de cien conversaciones por solicitud.");
      return database.$transaction(async tx => {
        await requireSchema(tx); if (!(await branchList(tx, actor)).some(b => b.id === sedeId)) throw new AttentionError("Sede no autorizada.", 403);
        let imported = 0;
        // Stable lock ordering avoids two concurrent imports locking chats in opposite order.
        for (const snapshot of [...snapshots].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
          const externalId = attentionText(snapshot.externalId, 240); const phone = normalizeAttentionPhone(snapshot.phone);
          const name = snapshot.name ? attentionText(snapshot.name, 160) : phone;
          if (!["unknown", "ai", "human"].includes(snapshot.mode) || !Array.isArray(snapshot.messages) || snapshot.messages.length > 1000) throw new AttentionError("Conversación de Dapta inválida.");
          const historyCursor = snapshot.historyCursor;
          if (historyCursor !== null && (typeof historyCursor !== "string" || !historyCursor || historyCursor.length > 4096 || [...historyCursor].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))) throw new AttentionError("Punto de sincronización de Dapta inválido.");
          let contact = snapshot.lastContactAt ? new Date(snapshot.lastContactAt) : null;
          if (contact && !Number.isFinite(contact.getTime())) throw new AttentionError("Fecha de Dapta inválida.");
          const normalizedMessages = snapshot.messages.map(message => {
            const externalId = attentionText(message.id, 240); const text = attentionText(message.text, 16000, false);
            if (!["inbound", "outbound"].includes(message.direction) || !Number.isFinite(Date.parse(message.sentAt))) throw new AttentionError("Mensaje de Dapta inválido.");
            const sentAt = new Date(message.sentAt);
            if (!contact || sentAt.getTime() > contact.getTime()) contact = sentAt;
            return { id: randomUUID(), externalId, direction: message.direction, text, sentAt: sentAt.toISOString(), author: message.author ? attentionText(message.author, 160) : null };
          });
          await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1::text,0::bigint))`, `attention:dapta:${externalId}`);
          const existing = await tx.$queryRawUnsafe<ConversationRow[]>(`SELECT * FROM "AttentionConversation" WHERE "externalId"=$1 FOR UPDATE`, externalId);
          if (existing[0] && (existing[0].sedeId !== sedeId || existing[0].phone !== phone)) throw new AttentionError("La conversación ya está vinculada a otra sede o teléfono. Requiere revisión.", 409);
          const id = existing[0]?.id || randomUUID();
          if (!existing.length) await tx.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name,"sedeId",mode,"lastContactAt","historyTruncated","daptaMessagesCursor")
            VALUES($1::uuid,$2,'whatsapp',$3,$4,$5,$6,$7::timestamptz,$8,$9) RETURNING id`, id, externalId, phone, name, sedeId, snapshot.mode, contact, snapshot.historyTruncated, historyCursor);
          const inserted = normalizedMessages.length ? await tx.$queryRawUnsafe<{direction: string; sentAt: Date | string}[]>(`
            INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author)
            SELECT m.id,$1::uuid,m."externalId",m.direction,m.text,m."sentAt",m.author FROM jsonb_to_recordset($2::jsonb)
              AS m(id uuid,"externalId" text,direction text,text text,"sentAt" timestamptz,author text)
            ON CONFLICT("conversationId","externalId") DO NOTHING RETURNING direction,"sentAt"`, id, JSON.stringify(normalizedMessages)) : [];
          const newMessages = inserted.length;
          const reopen = Boolean(existing[0]?.status === "closed" && inserted.some(m => m.direction === "inbound" && new Date(m.sentAt).getTime() > new Date(existing[0].closedAt || existing[0].updatedAt).getTime()));
          const mode = existing[0]?.mode === "human_requested" || snapshot.mode === "unknown" ? existing[0]?.mode || snapshot.mode : snapshot.mode;
          const newer = contact && (!existing[0]?.lastContactAt || contact.getTime() > new Date(existing[0].lastContactAt).getTime());
          if (existing.length && (newMessages || newer || existing[0].historyTruncated !== snapshot.historyTruncated || mode !== existing[0].mode || existing[0].daptaMessagesCursor !== historyCursor)) {
            await tx.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "lastContactAt"=GREATEST("lastContactAt",$2::timestamptz),
              "historyTruncated"=$3,mode=$4,status=CASE WHEN $5::boolean THEN 'pending' ELSE status END,"closedAt"=CASE WHEN $5::boolean THEN NULL ELSE "closedAt" END,
              "daptaMessagesCursor"=$6,version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`, id, contact, snapshot.historyTruncated, mode, reopen, historyCursor);
          }
          if (!existing.length || newMessages || newer) imported++;
          await audit(tx, actor, "DAPTA_SNAPSHOT_IMPORTED", id, { newMessages, sedeId });
        }
        return { imported };
      }, options);
    },
  };
}

async function store() { const { default: prisma } = await import("./prisma"); return createAttentionStore(prisma as unknown as AttentionDatabase); }
export async function getAttentionInbox(actor: AttentionActor, filters: AttentionFilters) { return (await store()).getAttentionInbox(actor, filters); }
export async function getAttentionDetail(actor: AttentionActor, id: string) { return (await store()).getAttentionDetail(actor, id); }
export async function mutateAttentionConversation(actor: AttentionActor, id: string, mutation: AttentionMutation) { return (await store()).mutateAttentionConversation(actor, id, mutation); }
export async function createAttentionCase(actor: AttentionActor, input: {phone: string; name: string; sedeId: number; requestId: string}) { return (await store()).createAttentionCase(actor, input); }
export async function saveAttentionQuickReply(actor: AttentionActor, input: {title: string; text: string; requestId: string}) { return (await store()).saveAttentionQuickReply(actor, input); }
export async function importAttentionSnapshots(actor: AttentionActor, sedeId: number, snapshots: DaptaConversationSnapshot[]) { return (await store()).importAttentionSnapshots(actor, sedeId, snapshots); }
export async function getAttentionHistoryCursors(actor: AttentionActor, sedeId: number) { return (await store()).getAttentionHistoryCursors(actor, sedeId); }
