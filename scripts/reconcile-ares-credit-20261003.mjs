/**
 * One-credit ARES reconciliation. Read-only unless --apply is explicit.
 *
 * DATABASE_URL=... node scripts/reconcile-ares-credit-20261003.mjs
 *   --folio=...
 *
 * For an approved write, also pass --apply --actor-id=... --method=EFECTIVO
 * --cash-policy=create-income (confirmed cash receipt with no FINSER cash entry)
 * or --cash-policy=link-existing --cash-movement-id=... .
 * The create-income policy writes exactly one cash income and one credit payment.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  ARES_20261003_EXPECTED as EXPECTED,
  ARES_20261003_RECEIPTS as RECEIPTS,
  buildAres20261003Snapshot,
} from "./lib/ares-20261003-reconciliation.mjs";

const SOURCE_RECEIPT = "R0100001108";
const EXPECTED_CREDIT_ID = 386;
const EXPECTED_CREDIT_SEDE_ID = 67;
const EXPECTED_COLLECTION_SEDE_ID = 17;
const EXPECTED_ACTOR_ID = 1;
const EXPECTED_EXISTING_PAYMENT_ID = 1241;
const EXPECTED_EXISTING_CASH_ID = 1247;
const EFFECTIVE_RECEIPT_DATE = "2026-09-18";
const EXPECTED_LOAN_NUMBER_SHA256 =
  "2f75019f2d6ff90083b55a3059a2c7352b705959edc4e5e10ba6954168f7cf36";
const ORIGINAL_TOTAL = 2694500;
const MARKER = "ABONO_CREDITO_ID:";
const SOURCE_PDFS = {
  historialSha256: "e5e642ffcb93529d03107f9b956da1ff5d4666db2b854e2e85acf5e7f1dd7e1d",
  planSha256: "1528289115bc378bb6c63933edeafa7547624dae777e583caae530243bbd7291",
};
const SOURCE_HASH = createHash("sha256").update(JSON.stringify({
  pdfs: SOURCE_PDFS, receipts: RECEIPTS, expected: EXPECTED,
})).digest("hex");
const PENDING_WOMPI = [
  "APPROVED", "APPROVED_REVIEW_REQUIRED", "APPROVED_DUPLICATE_REVIEW_REQUIRED",
  "AMOUNT_MISMATCH", "CHECKOUT_FALLBACK", "CREATING_NEQUI", "PENDING",
  "PROCESSING_APPROVED",
];
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const json = (value) => JSON.stringify(value);
function canonical(value) {
  if (value === null || typeof value !== "object") return json(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    json(key) + ":" + canonical(value[key])).join(",") + "}";
}
function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  check(Number.isFinite(date.getTime()), "Fecha almacenada invalida.");
  return date.toISOString().slice(0, 10);
}
function colombiaDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (name) => parts.find((item) => item.type === name)?.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}
function colombiaTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  check(Number.isFinite(date.getTime()), "Fecha de registro invalida.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (name) => parts.find((item) => item.type === name)?.value;
  return part("year") + "-" + part("month") + "-" + part("day") + " " +
    part("hour") + ":" + part("minute") + ":" + part("second") +
    " America/Bogota";
}
function validId(value, label) {
  const id = Number(value);
  check(Number.isSafeInteger(id) && id > 0, label + " invalido.");
  return id;
}
function optionsFromArgs(args) {
  const opts = new Map();
  for (const arg of args) {
    if (arg === "--apply") {
      check(!opts.has("apply"), "--apply duplicado.");
      opts.set("apply", true);
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    check(Boolean(match), "Opcion invalida.");
    check(["folio", "actor-id", "method", "cash-policy", "cash-movement-id"].includes(match[1]),
      "Opcion no reconocida.");
    check(!opts.has(match[1]), "Opcion duplicada.");
    opts.set(match[1], match[2]);
  }
  const folio = String(opts.get("folio") || "").trim();
  check(/^[A-Za-z0-9-]{8,100}$/.test(folio), "Indica --folio exacto.");
  const actorId = opts.has("actor-id")
    ? validId(opts.get("actor-id"), "--actor-id") : null;
  const apply = Boolean(opts.get("apply"));
  const method = opts.get("method") || null;
  const policy = opts.get("cash-policy") || null;
  const cashId = opts.has("cash-movement-id")
    ? validId(opts.get("cash-movement-id"), "--cash-movement-id") : null;
  check(method === null || ["EFECTIVO", "TRANSFERENCIA", "NEQUI", "DAVIPLATA", "OTRO"].includes(method),
    "--method invalido.");
  check(policy === null || ["link-existing", "create-income"].includes(policy),
    "--cash-policy invalida.");
  if (apply) {
    check(actorId === EXPECTED_ACTOR_ID, "--apply requiere el administrador central documentado.");
    check(Boolean(method && policy), "--apply requiere --method y --cash-policy.");
    check(method === "EFECTIVO", "El recibo ARES fue confirmado en efectivo.");
    check(policy !== "link-existing" || Boolean(cashId),
      "--cash-policy=link-existing requiere --cash-movement-id.");
    check(policy !== "create-income" || cashId === null,
      "--cash-policy=create-income no admite --cash-movement-id.");
  }
  return { folio, actorId, apply, method, policy, cashId };
}
async function auditExists(db) {
  const result = await db.query("SELECT to_regclass($1) AS name", ['"CreditAresReconciliation"']);
  return Boolean(result.rows[0]?.name);
}
async function auditForCredit(db, creditId) {
  if (!await auditExists(db)) return null;
  const result = await db.query(
    'SELECT "abonoId","cashMovementId","snapshotAfter","sourceHash","cashPolicy" ' +
    'FROM "CreditAresReconciliation" WHERE "creditoId"=$1 AND "sourceReceipt"=$2',
    [creditId, SOURCE_RECEIPT],
  );
  check(result.rows.length <= 1, "Auditoria ARES duplicada.");
  return result.rows[0] || null;
}
async function creditForFolio(db, folio, lock) {
  const result = await db.query(
    'SELECT "id","folio","saldoBaseFinanciado","montoCredito","valorCuota","plazoMeses",' +
    '"frecuenciaPago","fechaCredito","fechaPrimerPago","fechaProximoPago",' +
    '"planCapitalVigente","estado","pazYSalvoEmitidoAt","sedeId" ' +
    'FROM "Credito" WHERE "folio"=$1 ' + (lock ? "FOR UPDATE" : ""),
    [folio],
  );
  check(result.rows.length === 1, "El folio no identifica exactamente un credito.");
  return result.rows[0];
}
async function verifyActor(db, actorId) {
  const result = await db.query(
    'SELECT u."activo",u."sedeId",r."nombre" AS role,a."codigo" AS ally FROM "Usuario" u ' +
    'JOIN "Rol" r ON r."id"=u."rolId" JOIN "Sede" s ON s."id"=u."sedeId" ' +
    'LEFT JOIN "Aliado" a ON a."id"=s."aliadoId" WHERE u."id"=$1',
    [actorId],
  );
  const row = result.rows[0];
  check(result.rows.length === 1 && row.activo === true &&
    String(row.role).trim().toUpperCase() === "ADMIN" &&
    String(row.ally).trim().toUpperCase() === "FINSERPAY" &&
    Number(row.sedeId) === EXPECTED_COLLECTION_SEDE_ID,
  "El actor debe ser administrador central activo de FINSER PAY.");
}
async function paymentsForCredit(db, creditId, lock) {
  const result = await db.query(
    'SELECT "id","valor","fechaAbono","estado","sedeId","usuarioId","metodoPago" ' +
    'FROM "CreditoAbono" ' +
    'WHERE "creditoId"=$1 ORDER BY "id" ' + (lock ? "FOR UPDATE" : ""),
    [creditId],
  );
  return result.rows;
}
async function verifyBaseline(db, credit, payments) {
  check(Number(credit.id) === EXPECTED_CREDIT_ID, "ID de credito distinto al documentado.");
  check(Number(credit.sedeId) === EXPECTED_CREDIT_SEDE_ID,
    "La sede del credito difiere de la evidencia.");
  const registration = await db.query(
    'SELECT "numeroCredito","numeroCreditoConfirmado" FROM "CreditSadminRegistration" WHERE "creditoId"=$1',
    [credit.id],
  );
  const loanNumber = String(registration.rows[0]?.numeroCredito || "").trim();
  check(registration.rows.length === 1 &&
    registration.rows[0].numeroCreditoConfirmado === true &&
    createHash("sha256").update(loanNumber).digest("hex") === EXPECTED_LOAN_NUMBER_SHA256,
  "El numero de credito confirmado no coincide con la evidencia.");
  check(Number(credit.saldoBaseFinanciado) === 1452000 &&
    Number(credit.valorCuota) === 158500 && Number(credit.plazoMeses) === 17 &&
    credit.frecuenciaPago === "QUINCENAL", "Condiciones originales distintas a ARES.");
  check(dateKey(credit.fechaCredito) === "2026-08-24" &&
    dateKey(credit.fechaPrimerPago) === "2026-09-17", "Fechas originales distintas a ARES.");
  check(Number(credit.montoCredito) === ORIGINAL_TOTAL && credit.planCapitalVigente === null,
    "La obligacion original o plan vigente cambio.");
  check(credit.estado !== "ANULADO" && credit.pazYSalvoEmitidoAt === null,
    "Credito anulado o finalizado.");
  check(payments.length === 1 && payments[0].estado !== "ANULADO" &&
    Number(payments[0].id) === EXPECTED_EXISTING_PAYMENT_ID &&
    Number(payments[0].valor) === 160000 &&
    Number(payments[0].usuarioId) === EXPECTED_ACTOR_ID &&
    Number(payments[0].sedeId) === EXPECTED_COLLECTION_SEDE_ID &&
    payments[0].metodoPago === "EFECTIVO",
  "El recaudo existente de $160.000 difiere de la evidencia.");
  check(dateKey(payments[0].fechaAbono) === "2026-10-03" ||
    colombiaDateKey(payments[0].fechaAbono) === "2026-10-03",
  "El recaudo de $160.000 no tiene fecha efectiva 03/10/2026.");
  const revisions = await db.query(
    'SELECT COUNT(*)::int AS count FROM "CreditPrincipalPaymentRevision" WHERE "creditoId"=$1',
    [credit.id],
  );
  check(revisions.rows[0].count === 0, "Ya existe una revision de capital.");
  const pending = await db.query(
    'SELECT "id" FROM "WompiPaymentIntent" WHERE "creditoId"=$1 ' +
    'AND "processedAbonoId" IS NULL AND "status"=ANY($2::text[]) LIMIT 1',
    [credit.id, PENDING_WOMPI],
  );
  check(pending.rows.length === 0, "Existe un pago Wompi pendiente.");
}
async function cashCandidates(db, sedeId) {
  const result = await db.query(
    'SELECT "id","tipo","valor","sedeId","concepto","descripcion","createdAt" ' +
    'FROM "CajaMovimiento" WHERE "tipo"=$1 AND "valor"=$2 AND "sedeId"=$3 ' +
    'ORDER BY "createdAt" DESC,"id" DESC LIMIT 101',
    ["INGRESO", 400000, sedeId],
  );
  check(result.rows.length <= 100, "Demasiados ingresos de $400.000 para conciliar.");
  return result.rows;
}
async function verifyExistingPaymentCash(db, credit, payment, lock) {
  const result = await db.query(
    'SELECT "id","tipo","valor","sedeId","concepto","descripcion","createdAt" ' +
    'FROM "CajaMovimiento" WHERE "id"=$1 ' + (lock ? "FOR UPDATE" : ""),
    [EXPECTED_EXISTING_CASH_ID],
  );
  const cash = result.rows[0];
  const description = String(cash?.descripcion || "");
  const linkedPaymentId = /(?:^|\|)\s*ABONO_CREDITO_ID:\s*(\d+)\s*(?:\||$)/i
    .exec(description)?.[1];
  const linkedFolio = /(?:^|\|)\s*Folio:\s*([^|]+)/i
    .exec(description)?.[1]?.trim();
  const method = /(?:^|\|)\s*Metodo:\s*([^|]+)/i
    .exec(description)?.[1]?.trim().toUpperCase();
  check(Boolean(cash) && Number(cash.id) === EXPECTED_EXISTING_CASH_ID &&
    cash.tipo === "INGRESO" && Number(cash.valor) === 160000 &&
    Number(cash.sedeId) === EXPECTED_COLLECTION_SEDE_ID &&
    String(cash.concepto).toUpperCase() === "ABONO CREDITO EFECTIVO" &&
    Number(linkedPaymentId) === Number(payment.id) &&
    linkedFolio === credit.folio && method === "EFECTIVO" &&
    (dateKey(cash.createdAt) === "2026-10-03" ||
      colombiaDateKey(cash.createdAt) === "2026-10-03"),
  "El ingreso de caja del abono existente de $160.000 difiere de la evidencia.");
  return cash;
}
async function verifyNoUndocumentedReceipt(db, credit, policy, cashId) {
  const otherPayments = await db.query(
    'SELECT "id" FROM "CreditoAbono" WHERE "observacion" ILIKE $1 LIMIT 2',
    ["%" + SOURCE_RECEIPT + "%"],
  );
  check(otherPayments.rows.length === 0,
    "El recibo ARES ya aparece en otro abono de credito.");
  const sourceCash = await db.query(
    'SELECT "id","valor","descripcion" FROM "CajaMovimiento" ' +
    'WHERE "descripcion" ILIKE $1 OR "descripcion" ILIKE $2 LIMIT 101',
    ["%" + credit.folio + "%", "%" + SOURCE_RECEIPT + "%"],
  );
  check(sourceCash.rows.length <= 100,
    "Demasiados movimientos de caja con el folio o recibo ARES.");
  const unaccounted = sourceCash.rows.filter((row) =>
    Number(row.id) !== EXPECTED_EXISTING_CASH_ID);
  check(policy !== "create-income" || unaccounted.length === 0,
    "Ya existe caja asociada a este folio o recibo; no se creara otro ingreso.");
  check(policy !== "link-existing" ||
    (unaccounted.length === 1 && Number(unaccounted[0].id) === cashId),
  "El ingreso existente seleccionado no es la unica caja asociada al recibo.");
}
function verifyCash(row, credit, sedeId, method) {
  check(Boolean(row) && row.tipo === "INGRESO" && Number(row.valor) === 400000 &&
    Number(row.sedeId) === sedeId, "El ingreso de caja seleccionado no coincide.");
  const description = String(row.descripcion || "");
  check(!description.includes(MARKER), "El ingreso de caja ya esta vinculado a otro abono.");
  const matched = /(?:^|\|)\s*Folio:\s*([^|]+)/i.exec(description);
  check(!matched || matched[1].trim() === credit.folio,
    "El ingreso de caja identifica otro credito.");
  check(Boolean(matched) || description.includes(SOURCE_RECEIPT),
    "El ingreso de caja no contiene el folio exacto ni el recibo ARES.");
  const recordedMethod = /(?:^|\|)\s*Metodo:\s*([^|]+)/i.exec(description)?.[1]?.trim().toUpperCase();
  check(!method || !recordedMethod || recordedMethod === method,
    "El metodo del ingreso de caja difiere del recaudo declarado.");
  const concept = String(row.concepto || "").toUpperCase();
  check(/CREDITO|RECAUDO|ABONO/.test(concept),
    "El concepto de caja no identifica un recaudo de credito.");
  if (method && concept.includes("EFECTIVO")) check(method === "EFECTIVO",
    "El concepto de caja indica efectivo, pero el metodo declarado es otro.");
  if (method && concept.includes("TRANSFERENCIA")) check(method === "TRANSFERENCIA",
    "El concepto de caja indica transferencia, pero el metodo declarado es otro.");
  if (method && concept.includes("NEQUI")) check(method === "NEQUI",
    "El concepto de caja indica Nequi, pero el metodo declarado es otro.");
  if (method && concept.includes("DAVIPLATA")) check(method === "DAVIPLATA",
    "El concepto de caja indica Daviplata, pero el metodo declarado es otro.");
  const utc = dateKey(row.createdAt);
  const local = colombiaDateKey(row.createdAt);
  check((utc >= "2026-09-18" && utc <= "2026-10-03") ||
    (local >= "2026-09-18" && local <= "2026-10-03"),
  "El ingreso de caja queda fuera del periodo documentado.");
}
function planFor(payments, newPaymentId) {
  const snapshot = buildAres20261003Snapshot([
    { id: Number(payments[0].id), valor: 160000 },
    { id: newPaymentId, valor: 400000 },
  ]);
  const pending = snapshot.cuotas.reduce(
    (sum, row) => sum + row.valorProgramado - row.valorAbonadoAlCorte, 0);
  const updatedTotal = snapshot.totalAbonadoAlCorte + pending;
  check(pending === EXPECTED.futureInstallmentsTotal &&
    updatedTotal === EXPECTED.revisedCreditTotal &&
    snapshot.cuotas[2].fechaVencimiento === EXPECTED.nextDueDate &&
    snapshot.cuotas[2].valorAbonadoAlCorte === 0,
  "El plan resultante no reproduce ARES.");
  return { snapshot, updatedTotal };
}

async function createAuditTable(db) {
  await db.query('CREATE TABLE IF NOT EXISTS "CreditAresReconciliation" (' +
    '"id" uuid PRIMARY KEY,' +
    '"creditoId" integer NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,' +
    '"abonoId" integer NOT NULL UNIQUE REFERENCES "CreditoAbono"("id") ON DELETE RESTRICT,' +
    '"cashMovementId" integer NOT NULL UNIQUE REFERENCES "CajaMovimiento"("id") ON DELETE RESTRICT,' +
    '"sourceReceipt" text NOT NULL,"sourceHash" char(64) NOT NULL,' +
    '"sourceEvidence" jsonb NOT NULL,"snapshotBefore" jsonb,' +
    '"snapshotAfter" jsonb NOT NULL,"creditBefore" jsonb NOT NULL,' +
    '"creditAfter" jsonb NOT NULL,"allocations" jsonb NOT NULL,' +
    '"cashPolicy" text NOT NULL CHECK ("cashPolicy" IN (\'link-existing\',\'create-income\')),' +
    '"actorId" integer NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,' +
    '"createdAt" timestamptz NOT NULL DEFAULT now(),' +
    'UNIQUE ("creditoId","sourceReceipt"),UNIQUE ("sourceReceipt"))');
  await db.query(
    'CREATE OR REPLACE FUNCTION "blockCreditAresReconciliationMutation"() ' +
    'RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    "RAISE EXCEPTION 'CreditAresReconciliation is immutable'; RETURN NULL; END; $$",
  );
  await db.query(
    'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger ' +
    "WHERE tgrelid='\"CreditAresReconciliation\"'::regclass " +
    "AND tgname='CreditAresReconciliation_immutable') THEN " +
    'CREATE TRIGGER "CreditAresReconciliation_immutable" ' +
    'BEFORE UPDATE OR DELETE ON "CreditAresReconciliation" ' +
    'FOR EACH ROW EXECUTE FUNCTION "blockCreditAresReconciliationMutation"(); ' +
    'END IF; IF NOT EXISTS (SELECT 1 FROM pg_trigger ' +
    "WHERE tgrelid='\"CreditAresReconciliation\"'::regclass " +
    "AND tgname='CreditAresReconciliation_no_truncate') THEN " +
    'CREATE TRIGGER "CreditAresReconciliation_no_truncate" ' +
    'BEFORE TRUNCATE ON "CreditAresReconciliation" ' +
    'FOR EACH STATEMENT EXECUTE FUNCTION "blockCreditAresReconciliationMutation"(); ' +
    'END IF; END; $$',
  );
  await db.query(
    'CREATE OR REPLACE FUNCTION "blockReconciledAresCashMutation"() ' +
    'RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    'IF EXISTS (SELECT 1 FROM "CreditAresReconciliation" ' +
    'WHERE "cashMovementId"=OLD."id") THEN ' +
    "RAISE EXCEPTION 'Reconciled ARES cash income is immutable'; " +
    'END IF; IF TG_OP = \'DELETE\' THEN RETURN OLD; END IF; ' +
    'RETURN NEW; END; $$',
  );
  await db.query(
    'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger ' +
    "WHERE tgrelid='\"CajaMovimiento\"'::regclass " +
    "AND tgname='CajaMovimiento_ares_reconciled_immutable') THEN " +
    'CREATE TRIGGER "CajaMovimiento_ares_reconciled_immutable" ' +
    'BEFORE UPDATE OR DELETE ON "CajaMovimiento" ' +
    'FOR EACH ROW EXECUTE FUNCTION "blockReconciledAresCashMutation"(); ' +
    'END IF; END; $$',
  );
}
async function verifyReplay(db, credit, audit) {
  check(audit.sourceHash === SOURCE_HASH &&
    canonical(credit.planCapitalVigente) === canonical(audit.snapshotAfter),
  "Hay conciliacion previa, pero evidencia o plan vigente difieren.");
  const payment = await db.query(
    'SELECT "valor","estado","metodoPago","sedeId","fechaAbono" ' +
    'FROM "CreditoAbono" WHERE "id"=$1 AND "creditoId"=$2',
    [audit.abonoId, credit.id],
  );
  const cash = await db.query(
    'SELECT "valor","tipo","sedeId","concepto","descripcion","createdAt" ' +
    'FROM "CajaMovimiento" WHERE "id"=$1',
    [audit.cashMovementId],
  );
  check(payment.rows.length === 1 && Number(payment.rows[0].valor) === 400000 &&
    payment.rows[0].estado !== "ANULADO" &&
    payment.rows[0].metodoPago === "EFECTIVO" &&
    Number(payment.rows[0].sedeId) === EXPECTED_COLLECTION_SEDE_ID &&
    (dateKey(payment.rows[0].fechaAbono) === EFFECTIVE_RECEIPT_DATE ||
      colombiaDateKey(payment.rows[0].fechaAbono) === EFFECTIVE_RECEIPT_DATE) &&
    cash.rows.length === 1 && Number(cash.rows[0].valor) === 400000 &&
    cash.rows[0].tipo === "INGRESO" &&
    Number(cash.rows[0].sedeId) === EXPECTED_COLLECTION_SEDE_ID &&
    cash.rows[0].concepto === "ABONO CREDITO EFECTIVO" &&
    String(cash.rows[0].descripcion || "").includes(MARKER + audit.abonoId) &&
    String(cash.rows[0].descripcion || "").includes("ARES: " + SOURCE_RECEIPT) &&
    String(cash.rows[0].descripcion || "").includes("Fecha efectiva ARES: " + EFFECTIVE_RECEIPT_DATE),
  "El abono o su ingreso de caja no concilian con la auditoria previa.");
  return { mode: "already-applied", creditId: Number(credit.id),
    paymentId: Number(audit.abonoId), cashMovementId: Number(audit.cashMovementId),
    cashPolicy: audit.cashPolicy,
    cashRegisteredAt: cash.rows[0].createdAt.toISOString() };
}
async function run(db, opts) {
  await db.query(opts.apply
    ? "BEGIN ISOLATION LEVEL SERIALIZABLE"
    : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL lock_timeout = '10s'");
    await db.query("SET LOCAL statement_timeout = '30s'");
    if (opts.apply) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0::bigint))",
        ["ares-20261003:" + opts.folio]);
    }
    const credit = await creditForFolio(db, opts.folio, opts.apply);
    check(Number(credit.id) === EXPECTED_CREDIT_ID,
      "El folio no corresponde al credito historico identificado.");
    if (opts.actorId !== null) await verifyActor(db, opts.actorId);
    const prior = await auditForCredit(db, credit.id);
    if (prior) {
      const replay = await verifyReplay(db, credit, prior);
      await db.query(opts.apply ? "COMMIT" : "ROLLBACK");
      return replay;
    }
    const payments = await paymentsForCredit(db, credit.id, opts.apply);
    await verifyBaseline(db, credit, payments);
    const existingCash = await verifyExistingPaymentCash(db, credit, payments[0], opts.apply);
    await verifyNoUndocumentedReceipt(db, credit, opts.policy, opts.cashId);
    const sedeId = EXPECTED_COLLECTION_SEDE_ID;
    const candidates = await cashCandidates(db, sedeId);
    let linkedCash = null;
    if (opts.cashId !== null) {
      linkedCash = candidates.find((item) => Number(item.id) === opts.cashId) || null;
      verifyCash(linkedCash, credit, sedeId, opts.method);
    }
    planFor(payments, Number(payments[0].id) + 1000000000);
    if (!opts.apply) {
      await db.query("ROLLBACK");
      return {
        mode: "dry-run", creditId: Number(credit.id),
        existingPayment: { id: Number(payments[0].id), amount: 160000,
          effectiveDate: dateKey(payments[0].fechaAbono) },
        existingPaymentCash: { id: Number(existingCash.id), amount: 160000,
          sedeId, registeredDate: colombiaDateKey(existingCash.createdAt) },
        plannedPayment: { amount: 400000, effectiveDate: "2026-09-18",
          ordinaryInstallment: 158500, extraordinaryPrincipal: 241449, lateFee: 51 },
        existingPaymentAllocation: { ordinaryInstallment: 158500,
          additionalInterest: 1442, lateFee: 58 },
        resultingCapital: 1058115, nextDueDate: "2026-10-17",
        nextInstallment: 158500, revisedCreditTotal: 2461700,
        cashPolicy: opts.policy,
        cashAction: opts.policy === "create-income" ? {
          action: "create-one-income", amount: 400000, method: "EFECTIVO",
          sedeId, cashRegistrationDate: "when-applied",
          paymentEffectiveDate: EFFECTIVE_RECEIPT_DATE,
        } : opts.policy === "link-existing" ? {
          action: "link-existing-income", cashMovementId: opts.cashId,
        } : null,
        cashCandidates: candidates.map((item) => ({
          id: Number(item.id), sedeId: Number(item.sedeId),
          date: dateKey(item.createdAt),
          linked: String(item.descripcion || "").includes(MARKER),
          sourceMatch: String(item.descripcion || "").includes(credit.folio) ||
            String(item.descripcion || "").includes(SOURCE_RECEIPT),
        })),
      };
    }
    check(opts.policy === "create-income" || Boolean(linkedCash),
      "Selecciona un ingreso de caja existente verificable.");
    await createAuditTable(db);
    check(!await auditForCredit(db, credit.id), "La conciliacion se registro concurrentemente.");
    if (linkedCash) {
      const locked = await db.query(
        'SELECT "id","tipo","valor","sedeId","concepto","descripcion","createdAt" ' +
        'FROM "CajaMovimiento" WHERE "id"=$1 FOR UPDATE',
        [linkedCash.id],
      );
      verifyCash(locked.rows[0], credit, sedeId, opts.method);
      linkedCash = locked.rows[0];
      const used = await db.query(
        'SELECT 1 FROM "CreditAresReconciliation" WHERE "cashMovementId"=$1 LIMIT 1',
        [linkedCash.id],
      );
      check(used.rows.length === 0, "El ingreso de caja ya fue conciliado.");
    }
    const registration = await db.query("SELECT NOW() AS at");
    const registeredAt = registration.rows[0].at;
    const registrationLabel = colombiaTimestamp(registeredAt);
    const observation = "Conciliacion historica ARES " + SOURCE_RECEIPT +
      ": efectivo recibido 18/09/2026; cuota 158500, capital extraordinario 241449," +
      " mora 51. Registro FINSER: " + registrationLabel + ".";
    const created = await db.query(
      'INSERT INTO "CreditoAbono" ' +
      '("creditoId","usuarioId","sedeId","valor","metodoPago","observacion",' +
      '"fechaAbono","createdAt","updatedAt") ' +
      "VALUES ($1,$2,$3,400000,$4,$5,TIMESTAMP '2026-09-18 12:00:00',NOW(),NOW()) " +
      'RETURNING "id"',
      [credit.id, opts.actorId, sedeId, opts.method, observation],
    );
    const paymentId = Number(created.rows[0].id);
    const { snapshot, updatedTotal } = planFor(payments, paymentId);
    const updated = await db.query(
      'UPDATE "Credito" SET "planCapitalVigente"=$1::jsonb,"montoCredito"=$2,' +
      "\"fechaProximoPago\"=TIMESTAMP '2026-10-17 12:00:00' " +
      'WHERE "id"=$3 AND "planCapitalVigente" IS NULL AND "montoCredito"=$4',
      [json(snapshot), updatedTotal, credit.id, ORIGINAL_TOTAL],
    );
    check(updated.rowCount === 1, "El credito cambio durante la conciliacion.");
    const marker = MARKER + paymentId + " | Folio: " + credit.folio +
      " | Metodo: EFECTIVO | ARES: " + SOURCE_RECEIPT +
      " | Fecha efectiva ARES: " + EFFECTIVE_RECEIPT_DATE +
      " | Registro FINSER: " + registrationLabel;
    let cashMovementId;
    if (opts.policy === "create-income") {
      const insertedCash = await db.query(
        'INSERT INTO "CajaMovimiento" ' +
        '("tipo","concepto","valor","descripcion","sedeId","createdAt","updatedAt") ' +
        "VALUES ('INGRESO','ABONO CREDITO EFECTIVO',400000,$1,$2,NOW(),NOW()) " +
        'RETURNING "id","createdAt"',
        [marker, sedeId],
      );
      cashMovementId = Number(insertedCash.rows[0].id);
      check(insertedCash.rows[0].createdAt.getTime() === registeredAt.getTime(),
        "La fecha de registro de caja no coincide con la auditoria.");
    } else {
      cashMovementId = Number(linkedCash.id);
      const description = [String(linkedCash.descripcion || "").trim(), marker]
        .filter(Boolean).join(" | ");
      const cashUpdate = await db.query(
        'UPDATE "CajaMovimiento" SET "descripcion"=$1,"updatedAt"=NOW() WHERE "id"=$2',
        [description, cashMovementId],
      );
      check(cashUpdate.rowCount === 1, "No se pudo vincular el ingreso de caja.");
    }
    const before = {
      montoCredito: Number(credit.montoCredito),
      fechaProximoPago: credit.fechaProximoPago?.toISOString?.() || null,
      planCapitalVigente: credit.planCapitalVigente,
      existingPaymentId: Number(payments[0].id),
      existingPaymentAmount: Number(payments[0].valor),
      existingPaymentCashId: Number(existingCash.id),
    };
    const after = {
      montoCredito: updatedTotal, fechaProximoPago: "2026-10-17",
      capitalPendiente: 1058115, totalReceived: 560000,
      paymentId, cashMovementId, cashPolicy: opts.policy,
      paymentEffectiveDate: EFFECTIVE_RECEIPT_DATE,
      cashRegisteredAt: registeredAt.toISOString(),
    };
    await db.query(
      'INSERT INTO "CreditAresReconciliation" ' +
      '("id","creditoId","abonoId","cashMovementId","sourceReceipt","sourceHash",' +
      '"sourceEvidence","snapshotBefore","snapshotAfter","creditBefore","creditAfter",' +
      '"allocations","cashPolicy","actorId") ' +
      'VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,' +
      '$11::jsonb,$12::jsonb,$13,$14)',
      [randomUUID(), credit.id, paymentId, cashMovementId, SOURCE_RECEIPT, SOURCE_HASH,
        json({ pdfs: SOURCE_PDFS, receipts: RECEIPTS.map(({ document, date, received }) =>
          ({ document, date, received })),
          userConfirmed: { cashReceivedDate: EFFECTIVE_RECEIPT_DATE,
            method: "EFECTIVO", noFinserReceipt: true },
          finserCashRecordedAt: registeredAt.toISOString() }),
        json(credit.planCapitalVigente), json(snapshot), json(before), json(after),
        json({ receipts: RECEIPTS,
          existing160000: { ordinaryInstallment: 158500,
            additionalInterest: 1442, lateFee: 58 },
          historical400000: { ordinaryInstallment: 158500,
            extraordinaryPrincipal: 241449, lateFee: 51 } }),
        opts.policy, opts.actorId],
    );
    const storedCredit = await creditForFolio(db, opts.folio, false);
    const storedPayments = await paymentsForCredit(db, credit.id, false);
    const storedAudit = await auditForCredit(db, credit.id);
    const storedCash = await db.query(
      'SELECT "tipo","concepto","valor","sedeId","descripcion","createdAt" ' +
      'FROM "CajaMovimiento" WHERE "id"=$1', [cashMovementId],
    );
    check(storedPayments.length === 2 &&
      storedPayments.reduce((sum, item) => sum + Number(item.valor), 0) === 560000 &&
      Number(storedCredit.montoCredito) === updatedTotal &&
      canonical(storedCredit.planCapitalVigente) === canonical(snapshot) &&
      Number(storedAudit?.abonoId) === paymentId &&
      Number(storedAudit?.cashMovementId) === cashMovementId &&
      storedAudit?.cashPolicy === opts.policy &&
      storedCash.rows.length === 1 && storedCash.rows[0].tipo === "INGRESO" &&
      storedCash.rows[0].concepto === "ABONO CREDITO EFECTIVO" &&
      Number(storedCash.rows[0].valor) === 400000 &&
      Number(storedCash.rows[0].sedeId) === sedeId &&
      String(storedCash.rows[0].descripcion || "").includes(MARKER + paymentId) &&
      (opts.policy !== "create-income" ||
        storedCash.rows[0].createdAt.getTime() === registeredAt.getTime()),
    "La verificacion posterior no concilia.");
    await db.query("COMMIT");
    return { mode: "applied", creditId: Number(credit.id), paymentId,
      cashMovementId, cashPolicy: opts.policy, totalReceived: 560000,
      resultingCapital: 1058115, nextDueDate: "2026-10-17",
      paymentEffectiveDate: EFFECTIVE_RECEIPT_DATE,
      cashRegisteredAt: storedCash.rows[0].createdAt.toISOString(),
      revisedCreditTotal: updatedTotal };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

let db;
try {
  const opts = optionsFromArgs(process.argv.slice(2));
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  check(Boolean(connectionString), "DATABASE_URL no esta configurada; ningun dato cambio.");
  db = new pg.Client({
    connectionString, connectionTimeoutMillis: 10000,
    application_name: "finserpay-ares-20261003-reconciliation",
  });
  await db.connect();
  console.log(json(await run(db, opts)));
} catch (error) {
  const code = typeof error?.code === "string"
    ? error.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 24) : "";
  const message = error instanceof Error && !code
    ? error.message : "Error de base de datos durante la conciliacion.";
  console.error(message + (code ? " (" + code + ")" : ""));
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => undefined);
}
