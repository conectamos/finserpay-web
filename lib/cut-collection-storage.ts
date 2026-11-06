import { randomUUID } from "node:crypto";
import { assertCutUuid, CutCollectionError, cutDateFromFilters, type CutAccess } from "./cut-collection-access";
import { captureCutSnapshot, buildCutRows, buildDirectCutRows, summarizeCutRows, measureEarlyRisk } from "./cut-collection";
import type { CutCredit, CutFilters, CutHistory, CutReport, CutRiskComparisonItem, CutSnapshot } from "./cut-collection-types";

export interface CutDb {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export interface CutDatabase extends CutDb {
  $transaction<T>(fn: (tx: CutDb) => Promise<T>, options: { isolationLevel: "RepeatableRead"; timeout: number; maxWait: number }): Promise<T>;
}
type Branch = { id: number; nombre: string; aliadoId: number | null; aliado: string | null };
type Projection = { id: string; cutDate: Date | string; createdAt: Date | string; createdBy: number; scopeSedeIds: number[]; snapshot: CutSnapshot };
type RawCredit = {
  id: number; folio: string; clienteNombre: string; clienteDocumento: string | null; sedeId: number;
  aliadoId: number | null; sede: string; aliado: string | null; estado: string;
  montoCredito: number; valorCuota: number; plazoMeses: number | null; frecuenciaPago: string;
  fechaPrimerPago: Date | string | null; fechaProximoPago: Date | string | null;
  originatedAt?: Date | string | null;
  pazYSalvoEmitidoAt: Date | string | null; planCapitalVigente: unknown;
};
type RawPayment = { id: number; creditoId: number; valor: number; estado: string; metodoPago: string; fechaAbono: Date | string; createdAt: Date | string; anuladoAt: Date | string | null };
const iso = (value: string | Date) => new Date(value).toISOString();
const calendar = (value: string | Date) => iso(value).slice(0, 10);
const transactionOptions = { isolationLevel: "RepeatableRead" as const, timeout: 60000, maxWait: 10000 };
const HISTORY_PAGE_SIZE = 10;

async function branches(tx: CutDb, access: CutAccess, filters: CutFilters) {
  const authorized = await tx.$queryRawUnsafe<Branch[]>(`SELECT s.id,s.nombre,s."aliadoId",a.nombre AS aliado
    FROM "Sede" s LEFT JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE ($1::boolean OR ($2::integer IS NOT NULL AND s.id=$2) OR ($2::integer IS NULL AND s."aliadoId"=$3))
    ORDER BY s.nombre,s.id`, access.central, access.sedeId, access.aliadoId);
  if (filters.aliadoId && !authorized.some(row => row.aliadoId === filters.aliadoId)) throw new CutCollectionError("Aliado no autorizado.", 403);
  if (filters.sedeId && !authorized.some(row => row.id === filters.sedeId && (!filters.aliadoId || row.aliadoId === filters.aliadoId))) throw new CutCollectionError("Sede no autorizada para el aliado seleccionado.", 403);
  const selected = authorized.filter(row => (!filters.sedeId || row.id === filters.sedeId) && (!filters.aliadoId || row.aliadoId === filters.aliadoId));
  return { authorized, selected };
}

/** Read exclusively from credit-owned branches. A digital payment's collection branch grants no access. */
async function readCredits(tx: CutDb, sedeIds: number[], firstCutDates?: readonly string[]): Promise<CutCredit[]> {
  if (!sedeIds.length) return [];
  // Risk comparisons need only these initial-payment cohorts, not every loan
  // with a later installment in a selected cut. Dates remain SQL parameters.
  const cohortClause = firstCutDates ? ' AND c."fechaPrimerPago"::date=ANY($2::date[])' : "";
  const parameters = firstCutDates ? [sedeIds, firstCutDates] : [sedeIds];
  const credits = await tx.$queryRawUnsafe<RawCredit[]>(`SELECT c.id,c.folio,c."clienteNombre",c."clienteDocumento",c."sedeId",
    s.nombre AS sede,s."aliadoId",a.nombre AS aliado,c.estado,c."montoCredito",c."valorCuota",c."plazoMeses",c."frecuenciaPago",
    c."fechaPrimerPago",c."fechaProximoPago",c."pazYSalvoEmitidoAt",(to_jsonb(c)->>'fechaCredito')::timestamp AS "originatedAt",to_jsonb(c)->'planCapitalVigente' AS "planCapitalVigente"
    FROM "Credito" c JOIN "Sede" s ON s.id=c."sedeId" LEFT JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE c."sedeId"=ANY($1::integer[])${cohortClause} ORDER BY c.id`, ...parameters);
  const payments = await tx.$queryRawUnsafe<RawPayment[]>(`SELECT p.id,p."creditoId",p.valor,p.estado,p."metodoPago",p."fechaAbono",p."createdAt",p."anuladoAt"
    FROM "CreditoAbono" p JOIN "Credito" c ON c.id=p."creditoId"
    WHERE c."sedeId"=ANY($1::integer[])${cohortClause} ORDER BY p."fechaAbono",p.id`, ...parameters);
  const grouped = new Map<number, RawPayment[]>();
  for (const payment of payments) { const list = grouped.get(payment.creditoId) || []; list.push(payment); grouped.set(payment.creditoId, list); }
  // Keep the current Sadmin presentation rules, inside this same authorized
  // transaction. The store's raw adapter does not expose Prisma model delegates.
  // Aggregate-only risk reports never expose credit numbers and need no Sadmin lookup.
  let displayNumbers = new Map<number, string>();
  if (!firstCutDates) {
    const { getCreditDisplayNumbers } = await import("./credit-display-number-server");
    displayNumbers = await getCreditDisplayNumbers(credits.map(row => row.id), {
      creditSadminRegistration: {
        findMany: ({ where }) => tx.$queryRawUnsafe<Array<{
          creditoId: number; numeroCredito: string | null; numeroCreditoConfirmado: boolean;
        }>>(`SELECT "creditoId","numeroCredito","numeroCreditoConfirmado"
          FROM "CreditSadminRegistration"
          WHERE "creditoId"=ANY($1::integer[]) AND "numeroCreditoConfirmado"=TRUE AND "numeroCredito" IS NOT NULL`,
        where.creditoId.in),
      },
    });
  }
  return credits.map(row => ({
    id: row.id, folio: displayNumbers.get(row.id) || row.folio, clientName: row.clienteNombre,
    document: row.clienteDocumento || "", aliadoId: row.aliadoId, aliado: row.aliado || "Sin aliado",
    sedeId: row.sedeId, sede: row.sede, state: row.estado,
    settledAt: row.pazYSalvoEmitidoAt ? iso(row.pazYSalvoEmitidoAt) : null,
    originatedAt: row.originatedAt ? iso(row.originatedAt) : undefined,
    plan: { montoCredito: Number(row.montoCredito), valorCuota: Number(row.valorCuota), plazoMeses: row.plazoMeses,
      frecuenciaPago: row.frecuenciaPago, fechaPrimerPago: row.fechaPrimerPago ? calendar(row.fechaPrimerPago) : null,
      fechaProximoPago: row.fechaProximoPago ? calendar(row.fechaProximoPago) : null,
      settled: Boolean(row.pazYSalvoEmitidoAt), planCapitalVigente: row.planCapitalVigente },
    payments: (grouped.get(row.id) || []).map(payment => ({ id: payment.id, value: Number(payment.valor), state: payment.estado,
      method: payment.metodoPago, paidAt: iso(payment.fechaAbono), createdAt: iso(payment.createdAt), annulledAt: payment.anuladoAt ? iso(payment.anuladoAt) : null })),
  }));
}

async function schemaAvailable(tx: CutDb) {
  const rows = await tx.$queryRawUnsafe<{ present: boolean }[]>(`SELECT to_regclass('public."CutCollectionProjection"') IS NOT NULL AS present`);
  return rows[0]?.present === true;
}
function requireSchema(available: boolean) {
  if (!available) throw new CutCollectionError("Falta instalar el esquema de recaudo por corte. Ejecuta la preparación de base de datos del despliegue.", 503);
}
function evaluate(snapshot: CutSnapshot, credits: CutCredit[], filters: CutFilters) {
  try {
    const result = buildCutRows(snapshot, credits);
    const rows = result.rows.filter(row => filters.status === "todos" || row.status === filters.status);
    return { rows, summary: summarizeCutRows(rows), warnings: result.warnings };
  } catch (error) {
    throw new CutCollectionError(error instanceof Error ? error.message : "Se requiere conciliar el cronograma de la proyección.", 409);
  }
}

function comparisonDates(cutDates: string[]): string[] {
  if (!Array.isArray(cutDates) || cutDates.length < 1 || cutDates.length > 6) {
    throw new CutCollectionError("Selecciona entre uno y seis cortes para comparar.");
  }
  const unique = new Set<string>();
  for (const cutDate of cutDates) {
    if (typeof cutDate !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(02|17)$/.test(cutDate) ||
        Number(cutDate.slice(0, 4)) < 2000 || Number(cutDate.slice(0, 4)) > 2200) {
      throw new CutCollectionError("Fecha de comparación inválida. Usa un corte 02 o 17 en formato AAAA-MM-DD.");
    }
    if (unique.has(cutDate)) throw new CutCollectionError("Hay cortes repetidos en la comparación.");
    unique.add(cutDate);
  }
  return [...unique];
}

export function createCutCollectionStore(database: CutDatabase) {
  async function assemble(tx: CutDb, access: CutAccess, filters: CutFilters, projectionId: string | null, saveKey?: string, historyPage = 0): Promise<CutReport> {
    const scope = await branches(tx, access, filters);
    const selectedIds = scope.selected.map(row => row.id);
    const [{ now }] = await tx.$queryRawUnsafe<{ now: Date | string }[]>(`SELECT CURRENT_TIMESTAMP AS now`);
    const asOf = iso(now);
    const available = await schemaAvailable(tx);
    if (projectionId || saveKey) requireSchema(available);
    const current = await readCredits(tx, selectedIds);
    const cutDate = cutDateFromFilters(filters);
    let selected: Projection | undefined;
    if (saveKey) {
      selected = (await tx.$queryRawUnsafe<Projection[]>(`SELECT * FROM "CutCollectionProjection" WHERE "createdBy"=$1 AND "requestKey"=$2::uuid`, access.userId, saveKey))[0];
      if (selected && (calendar(selected.cutDate) !== cutDate || [...selected.scopeSedeIds].sort().join() !== [...selectedIds].sort().join())) {
        throw new CutCollectionError("La solicitud ya corresponde a otra proyección. Crea una nueva versión.", 409);
      }
      if (!selected) {
        let snapshot: CutSnapshot;
        try { snapshot = captureCutSnapshot(current, cutDate, asOf); }
        catch (error) { throw new CutCollectionError(error instanceof Error ? error.message : "No se pudo construir el cronograma.", 409); }
        if (!snapshot.credits.length) throw new CutCollectionError("No hay cuotas para guardar en este corte.", 409);
        const id = randomUUID();
        const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "CutCollectionProjection"
          (id,"requestKey","createdBy","createdAt","cutDate","scopeSedeIds",snapshot)
          VALUES ($1::uuid,$2::uuid,$3,$4::timestamptz,$5::date,$6::integer[],$7::jsonb)
          ON CONFLICT ("createdBy","requestKey") DO NOTHING RETURNING id`, id, saveKey, access.userId, asOf, cutDate, selectedIds, JSON.stringify(snapshot));
        if (!inserted.length) throw new CutCollectionError("Se está guardando esta misma proyección. Reintenta con la misma solicitud.", 409);
        selected = { id, createdAt: asOf, createdBy: access.userId, cutDate, scopeSedeIds: selectedIds, snapshot };
      }
      projectionId = selected.id;
    }
    // Filter historical and current scope before pagination, so empty mixed-branch
    // projections neither consume a page nor reveal unauthorized version counts.
    const historyCandidates = available && selectedIds.length ? await tx.$queryRawUnsafe<Projection[]>(`SELECT p.* FROM "CutCollectionProjection" p
      WHERE p."scopeSedeIds" && $1::integer[] AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.snapshot->'credits') AS saved
        WHERE (saved->>'sedeId')::integer=ANY($1::integer[]) AND NOT EXISTS (
          SELECT 1 FROM "Credito" c WHERE c.id=(saved->>'id')::integer AND NOT (c."sedeId"=ANY($1::integer[]))
        )
      ) ORDER BY p."createdAt" DESC,p.id DESC LIMIT 11 OFFSET $2`, selectedIds, historyPage * HISTORY_PAGE_SIZE) : [];
    const historyHasMore = historyCandidates.length > HISTORY_PAGE_SIZE;
    const historyRows = historyCandidates.slice(0, HISTORY_PAGE_SIZE);
    if (projectionId) {
      selected = selected || historyRows.find(row => row.id === projectionId);
      if (!selected && selectedIds.length) selected = (await tx.$queryRawUnsafe<Projection[]>(`SELECT * FROM "CutCollectionProjection"
        WHERE id=$1::uuid AND "scopeSedeIds" && $2::integer[] LIMIT 1`, projectionId, selectedIds))[0];
      if (!selected) throw new CutCollectionError("Proyección no encontrada en el alcance autorizado.", 404);
      if (calendar(selected.cutDate) !== cutDate) throw new CutCollectionError("La proyección corresponde a otro corte. Selecciona su fecha de vencimiento.");
    }
    // A moved credit must satisfy BOTH the historical branch and its current branch.
    const inspectedProjections = selected ? [...historyRows, selected] : historyRows;
    const snapshotIds = [...new Set(inspectedProjections.flatMap(row => row.snapshot.credits.map(credit => credit.id)))];
    const inaccessible = snapshotIds.length ? await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM "Credito"
      WHERE id=ANY($1::integer[]) AND NOT ("sedeId"=ANY($2::integer[]))`, snapshotIds, selectedIds) : [];
    const excluded = new Set(inaccessible.map(row => row.id));
    const allowed = new Set(selectedIds);
    const scopedSnapshot = (snapshot: CutSnapshot): CutSnapshot => {
      const credits = snapshot.credits.filter(credit => allowed.has(credit.sedeId) && !excluded.has(credit.id));
      const ids = new Set(credits.map(credit => credit.id));
      return { ...snapshot, credits, schedule: snapshot.schedule.filter(row => ids.has(row.creditId)) };
    };
    let snapshot: CutSnapshot;
    try { snapshot = selected ? scopedSnapshot(selected.snapshot) : captureCutSnapshot(current, cutDate, asOf); }
    catch (error) { throw new CutCollectionError(error instanceof Error ? error.message : "No se pudo construir el cronograma.", 409); }
    if (selected && !snapshot.credits.length) throw new CutCollectionError("Proyección no encontrada en el alcance autorizado.", 404);
    const result = evaluate(snapshot, current, filters);
    const warnings = new Set(result.warnings);
    if (!available) warnings.add("La vista previa está disponible. Para guardar versiones se debe instalar el esquema de recaudo por corte.");
    if (excluded.size) warnings.add("El historial se limita a créditos que siguen dentro de las sedes autorizadas seleccionadas.");
    const history: CutHistory[] = [];
    for (const row of historyRows) {
      const scoped = scopedSnapshot(row.snapshot);
      if (!scoped.credits.length) continue;
      try {
        const report = row.id === selected?.id ? result : evaluate(scoped, current, filters);
        history.push({ id: row.id, cutDate: calendar(row.cutDate), createdAt: iso(row.createdAt),
          expected: report.summary.expected, received: report.summary.received, pending: report.summary.pending,
          completion: report.summary.completion, rowCount: report.rows.length });
      } catch {
        // Keep the version discoverable even if a later capital revision needs reconciliation.
        history.push({ id: row.id, cutDate: calendar(row.cutDate), createdAt: iso(row.createdAt),
          expected: null, received: null, pending: null, completion: null,
          rowCount: null, warning: "Requiere conciliación del cronograma; selecciona para ver el motivo." });
        warnings.add("Hay proyecciones históricas que requieren conciliación del cronograma.");
      }
    }
    const allies = new Map<number, string>();
    for (const branch of scope.authorized) if (branch.aliadoId) allies.set(branch.aliadoId, branch.aliado || "Sin aliado");
    return { ok: true, filters, cutDate, asOf, projection: selected ? { id: selected.id, createdAt: iso(selected.createdAt) } : null,
      ...result, warnings: [...warnings], history, historyPage, historyHasMore,
      options: { aliados: [...allies].map(([id, nombre]) => ({ id, nombre })).sort((a,b) => a.nombre.localeCompare(b.nombre)),
        sedes: scope.authorized.map(({ id, nombre, aliadoId }) => ({ id, nombre, aliadoId })) } };
  }
  return {
    async directRiskComparison(access: CutAccess, filters: CutFilters, cutDates: string[]): Promise<CutRiskComparisonItem[]> {
      const dates = comparisonDates(cutDates);
      return database.$transaction(async tx => {
        const scope = await branches(tx, access, filters);
        const [{ now }] = await tx.$queryRawUnsafe<{ now: Date | string }[]>(`SELECT CURRENT_TIMESTAMP AS now`);
        const queriedAt = iso(now);
        const credits = await readCredits(tx, scope.selected.map(branch => branch.id), dates);
        const cohorts = new Map(dates.map(cutDate => [cutDate, [] as CutCredit[]]));
        for (const credit of credits) cohorts.get(String(credit.plan.fechaPrimerPago))?.push(credit);
        try {
          // Match the main report: risk uses ally/site scope, independently of
          // the current installment status. All cuts share this database snapshot.
          return dates.map(cutDate => ({ cutDate, queriedAt,
            earlyRisk: measureEarlyRisk(cohorts.get(cutDate)!, cutDate, queriedAt) }));
        } catch (error) {
          throw new CutCollectionError(error instanceof Error ? error.message : "No se pudo conciliar el riesgo temprano de los cortes.", 409);
        }
      }, transactionOptions);
    },
    async directReport(access: CutAccess, filters: CutFilters): Promise<CutReport> {
      return database.$transaction(async tx => {
        const scope = await branches(tx, access, filters);
        const [{ now }] = await tx.$queryRawUnsafe<{ now: Date | string }[]>(`SELECT CURRENT_TIMESTAMP AS now`);
        const asOf = iso(now);
        const cutDate = cutDateFromFilters(filters);
        const credits = await readCredits(tx, scope.selected.map(branch => branch.id));
        let calculated: ReturnType<typeof buildDirectCutRows>;
        try { calculated = buildDirectCutRows(credits, cutDate, asOf); }
        catch (error) { throw new CutCollectionError(error instanceof Error ? error.message : "No se pudo conciliar el cronograma y sus recaudos.", 409); }
        const rows = calculated.rows.filter(row => filters.status === "todos" || row.status === filters.status);
        const allies = new Map<number, string>();
        for (const branch of scope.authorized) if (branch.aliadoId) allies.set(branch.aliadoId, branch.aliado || "Sin aliado");
        return { ok: true, mode: "consulta", filters, cutDate, asOf, projection: null,
          rows, summary: summarizeCutRows(rows), earlyRisk: measureEarlyRisk(credits, cutDate, asOf), warnings: [...new Set(rows.flatMap(row => row.warning ? [`${row.folio}: ${row.warning}`] : []))],
          history: [], historyPage: 0, historyHasMore: false,
          options: { aliados: [...allies].map(([id, nombre]) => ({ id, nombre })).sort((a,b) => a.nombre.localeCompare(b.nombre)),
            sedes: scope.authorized.map(({ id, nombre, aliadoId }) => ({ id, nombre, aliadoId })) } };
      }, transactionOptions);
    },
    async report(access: CutAccess, filters: CutFilters, projectionId?: string | null, historyPage = 0) {
      if (projectionId) assertCutUuid(projectionId);
      if (!Number.isSafeInteger(historyPage) || historyPage < 0 || !Number.isSafeInteger(historyPage * HISTORY_PAGE_SIZE)) {
        throw new CutCollectionError("Página de historial inválida.");
      }
      return database.$transaction(tx => assemble(tx, access, filters, projectionId || null, undefined, historyPage), transactionOptions);
    },
    async save(access: CutAccess, filters: CutFilters, requestKey: string) {
      assertCutUuid(requestKey);
      for (let attempt = 0; ; attempt++) {
        try { return await database.$transaction(tx => assemble(tx, access, filters, null, requestKey), transactionOptions); }
        catch (error) {
          const code = (error as { code?: string; meta?: { code?: string } }).code;
          const dbCode = (error as { meta?: { code?: string } }).meta?.code;
          if (attempt < 2 && [code, dbCode].some(value => value === "40001" || value === "P2034")) continue;
          throw error;
        }
      }
    },
  };
}

async function defaultStore() {
  const { default: prisma } = await import("./prisma");
  return createCutCollectionStore(prisma as unknown as CutDatabase);
}
export async function getCutCollectionReport(access: CutAccess, filters: CutFilters, projectionId?: string | null, historyPage = 0) {
  return (await defaultStore()).report(access, filters, projectionId, historyPage);
}
export async function getDirectCutCollectionReport(access: CutAccess, filters: CutFilters) {
  return (await defaultStore()).directReport(access, filters);
}
export async function getDirectCutRiskComparison(access: CutAccess, filters: CutFilters, cutDates: string[]): Promise<CutRiskComparisonItem[]> {
  return (await defaultStore()).directRiskComparison(access, filters, cutDates);
}
export async function saveCutCollectionProjection(access: CutAccess, filters: CutFilters, requestKey: string) {
  return (await defaultStore()).save(access, filters, requestKey);
}
