import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import pg from "pg";
import { parseVerificationOptions, runProductionVerification, verifyHttpResponse, verifyReport, verifyWorkbook } from "../scripts/verify-cut-collection-production.mjs";

const jiti = createJiti(import.meta.url);
const { buildCutCollectionWorkbook } = await jiti.import("../lib/cut-collection-excel.ts");
function fixture(filters = { day: 2, month: 11, year: 2026, status: "todos", aliadoId: null, sedeId: null }) {
  const cutDate = `${filters.year}-${String(filters.month).padStart(2, "0")}-${String(filters.day).padStart(2, "0")}`;
  const rows = ["1.234", "1234"].map((document, index) => ({
    key: `${index + 1}:2`, creditId: index + 1, installment: 2, clientName: "Cliente de prueba", document, folio: `CR-${index}`,
    aliadoId: 2, aliado: "Aliado", sedeId: 2, sede: "Sede", dueDate: cutDate, installmentAmount: 100,
    priorPayments: 20, expected: 100, received: 30, reconciledReceived: 10, pending: 70, priorReversals: 0, lastPaymentAt: null,
    status: "parcial", warning: null, payments: [{ id: 11 + index, received: 20, amount: 20, method: "EFECTIVO", state: "ACTIVO",
      paidAt: "2026-10-01T12:00:00Z", createdAt: "2026-10-01T12:00:00Z", appliedBefore: 20, appliedNow: 20, previous: true }],
    previousRecovery: 0, futureAdvances: 0,
  })).filter(row => filters.status === "todos" || row.status === filters.status);
  return { ok: true, mode: "consulta", cutDate, asOf: "2026-11-02T16:00:00.000Z", projection: null,
    filters, rows,
    summary: { expected: rows.length * 100, received: rows.length * 30, pending: rows.length * 70,
      completion: rows.length ? 30 : null, pendingClients: rows.length ? 1 : 0, creditsCount: rows.length,
      priorPayments: rows.length * 20, priorReversals: 0, previousRecovery: 0, futureAdvances: 0 },
    history: [], historyPage: 0, historyHasMore: false, options: { aliados: [], sedes: [] }, warnings: [] };
}

test("verificador valida tarjetas, detalle, normalización de cliente y archivo Excel real", async () => {
  const report = fixture();
  assert.equal(verifyReport(report), report);
  const bytes = await buildCutCollectionWorkbook(report).xlsx.writeBuffer();
  await verifyWorkbook(bytes, report);
  const wrong = structuredClone(report);
  wrong.summary.expected++;
  assert.throws(() => verifyReport(wrong), /card_detail_total_mismatch/);
  await assert.rejects(verifyWorkbook(bytes, wrong), /excel_summary_mismatch/);
});

test("verificador detecta filtros ignorados y movimientos duplicados sin revelar valores", () => {
  const report = fixture();
  assert.throws(() => verifyReport(report, { status: "pagado" }), /status_filter_ignored/);
  assert.throws(() => verifyReport(report, { status: "todos", sedeId: 1 }), /foreign_site_in_rows/);
  report.rows[1].key = report.rows[0].key;
  assert.throws(() => verifyReport(report), /wrong_or_duplicate_installment/);
});

test("consulta directa exige cuota total, anticipos no aditivos y conciliación explícita del recibido", () => {
  for (const [change, code] of [
    [report => { report.rows[0].reconciledReceived = 0; }, /payment_detail_received_mismatch/],
    [report => { report.rows[0].priorPayments = 31; }, /advances_not_subset_of_received/],
    [report => { report.rows[0].expected = 80; }, /expected_not_full_installment/],
    [report => { report.rows[0].pending = 80; }, /pending_equation_mismatch/],
    [report => { report.summary.creditsCount = 1; }, /credits_count_mismatch/],
    [report => { report.projection = { id: "old" }; }, /direct_report_contains_projection/],
    [report => { report.history = [{ id: "old" }]; }, /direct_report_contains_projection/],
    [report => { report.rows[0].payments.push(report.rows[0].payments[0]); }, /invalid_or_duplicate_payment_detail/],
  ]) {
    const report = fixture();
    change(report);
    assert.throws(() => verifyReport(report), code);
  }
  const withoutSeed = fixture();
  for (const row of withoutSeed.rows) { delete row.reconciledReceived; row.payments[0].received = 30; }
  assert.equal(verifyReport(withoutSeed), withoutSeed);
});

test("opciones aceptan sólo cortes 02/17 y origen autorizado, sin ninguna opción de escritura", () => {
  assert.equal(parseVerificationOptions().cut, "2026-11-02");
  assert.deepEqual(parseVerificationOptions(["--cut", "2026-10-17", "--origin", "https://example.up.railway.app"]), {
    cut: "2026-10-17", origin: "https://example.up.railway.app", filters: { day: 17, month: 10, year: 2026, status: "todos" },
  });
  for (const args of [["--save"], ["--cut"], ["--cut", "2026-11-03"], ["--cut", "2026-13-02"], ["--cut", "1999-11-02"],
    ["--cut", "2026-11-02", "--cut", "2026-11-17"], ["--origin", "https://outside.example"], ["--origin", "http://finserpay.com"]]) {
    assert.throws(() => parseVerificationOptions(args));
  }
});

test("rechazos tempranos genéricos del proxy se admiten; reportes y errores autenticados exigen encabezados privados", async () => {
  for (const [status, error] of [[401, "No autenticado"], [403, "Acceso no autorizado"]]) {
    await verifyHttpResponse(Response.json({ error }, { status }), status, true);
    await assert.rejects(verifyHttpResponse(Response.json({ error }, { status }), status), /missing_private_no_store/);
    await assert.rejects(verifyHttpResponse(Response.json({ error, items: ["private"] }, { status }), status, true), /proxy_denial_not_generic/);
  }
  await assert.rejects(verifyHttpResponse(Response.json({ ok: true }), 200, true), /missing_private_no_store/);
});

test("configuración falla antes de red y nunca imprime credenciales ni errores internos", async () => {
  const messages = [];
  const original = console.log;
  console.log = value => messages.push(value);
  try {
    assert.equal(await runProductionVerification(["--help"], {}), 0);
    assert.equal(await runProductionVerification([], {}), 1);
    assert.equal(await runProductionVerification(["--write-all"], {}), 1);
    assert.equal(await runProductionVerification([], { DATABASE_URL: "postgres://secret-connection", SESSION_SECRET: "secret-signing",
      FINSERPAY_VERIFY_BASE_URL: "https://outside.example" }), 1);
    assert(messages.some(value => value.includes("unapproved_base_host")));
    assert.doesNotMatch(messages.join("\n"), /secret-connection|secret-signing|outside\.example/);
  } finally { console.log = original; }
});

test("recorrido completo usa sólo GET y SQL de lectura, mantiene roles, valida URL heredada y no revela datos", async () => {
  const originalClient = pg.Client;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const messages = [];
  const requests = [];
  const queries = [];
  let connectionOptions;
  let disconnected = false;
  pg.Client = class {
    constructor(options) { connectionOptions = options; }
    async connect() {}
    async end() { disconnected = true; }
    async query(sql, values) {
      queries.push(sql);
      assert.match(sql, /^\s*(SELECT|SHOW)\b/);
      assert.doesNotMatch(sql, /CutCollectionProjection|\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
      if (sql.startsWith("SHOW")) return { rows: [{ default_transaction_read_only: "on" }] };
      if (sql.includes("credit_hash")) return { rows: [{ credits: 2, payments: 2, credit_hash: "private-hash", payment_hash: "private-hash" }] };
      if (sql.includes("SELECT u.id") && sql.includes("NOT IN")) return { rows: [
        { userId: 3, sedeId: 2, aliadoId: 2, vendedorId: 7, profile: "SUPERVISOR" },
        { userId: 4, sedeId: 2, aliadoId: 2, vendedorId: 8, profile: "VENDEDOR" },
      ] };
      if (sql.includes("SELECT u.id")) return { rows: [
        { userId: 1, sedeId: 1, aliadoId: 1, central: true, credits: 2 },
        { userId: 2, sedeId: 2, aliadoId: 2, central: false, credits: 2 },
      ] };
      if (sql.includes('SELECT id FROM "Credito"')) return { rows: values[1].map(id => ({ id })) };
      throw new Error("Unexpected query in test");
    }
  };
  const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), method: options.method, body: options.body });
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    const encoded = options.headers.Cookie?.match(/(?:^|;\s*)session=([^.;]+)/)?.[1];
    const userId = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()).userId : null;
    if (!userId) return Response.json({ error: "No autenticado" }, { status: 401 });
    if (userId === 4) return Response.json({ error: "Acceso no autorizado" }, { status: 403 });
    const params = new URL(input).searchParams;
    const filters = { day: Number(params.get("day")), month: Number(params.get("month")), year: Number(params.get("year")),
      status: params.get("status"), aliadoId: params.has("aliadoId") ? Number(params.get("aliadoId")) : null,
      sedeId: params.has("sedeId") ? Number(params.get("sedeId")) : null };
    if (filters.day === 3 || filters.status === "invalid") return Response.json({ error: "Filtro inválido" }, { status: 400, headers: privateHeaders });
    if ((userId === 2 && (filters.aliadoId === 1 || filters.sedeId === 1)) || (userId === 3 && filters.sedeId !== 2)) {
      return Response.json({ error: "Sede no autorizada" }, { status: 403, headers: privateHeaders });
    }
    const report = fixture(filters);
    const sedes = [{ id: 1, nombre: "Central", aliadoId: 1 }, { id: 2, nombre: "Local", aliadoId: 2 }, { id: 3, nombre: "Otra", aliadoId: 2 }];
    report.options = {
      aliados: [{ id: 1, nombre: "Central" }, { id: 2, nombre: "Aliado" }].filter(ally => userId === 1 || ally.id === 2),
      sedes: sedes.filter(site => userId === 1 || (userId === 3 ? site.id === 2 : site.aliadoId === 2)),
    };
    if (params.get("format") !== "xlsx") return Response.json(report, { headers: privateHeaders });
    const bytes = await buildCutCollectionWorkbook(report).xlsx.writeBuffer();
    return new Response(bytes, { headers: { ...privateHeaders,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="FINSERPAY_Recaudo_${report.cutDate}.xlsx"`, "Content-Length": String(bytes.byteLength),
    } });
  };
  console.log = value => messages.push(value);
  try {
    assert.equal(await runProductionVerification(["--cut", "2026-10-17", "--origin", "https://finserpay.com"], {
      DATABASE_URL: "postgres://secret-connection", SESSION_SECRET: "secret-signing",
    }), 0, messages.join("\n"));
    assert.match(connectionOptions.options, /default_transaction_read_only=on/);
    assert.equal(disconnected, true);
    assert.equal(queries.filter(sql => sql.includes("credit_hash")).length, 2);
    const inherited = requests.filter(request => request.url.includes("projectionId="));
    assert.equal(inherited.length, 4);
    assert(inherited.every(request => request.url.includes("517ce382-0723-48f6-a791-31dc9eda22dd")));
    assert(messages.some(message => message.includes("production_cut_verification_complete")));
    assert.doesNotMatch(messages.join("\n"), /secret-connection|secret-signing|Cliente de prueba|1\.234|private-hash/);
  } finally {
    pg.Client = originalClient;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
