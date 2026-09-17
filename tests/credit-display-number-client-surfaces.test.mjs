import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Evaluate the real handler and its pure display helpers with controlled I/O.
// The production access query, redaction and DTO composition run unchanged.
function functionsFrom(path, names, globals = {}) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declarations = names.map(name => {
    const found = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(found, `Missing function ${name}`);
    return found.getText(source).replace(/^export\s+/, "");
  });
  const { outputText } = ts.transpileModule(`${declarations.join("\n")}\nexports.result = { ${names.join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  runInNewContext(outputText, { exports, console, URL, Map, Number, String, Date, ...globals }, { filename: path });
  return exports.result;
}
const display = functionsFrom("lib/credit-display-number-server.ts", ["withCreditDisplayNumber", "creditNumberSearchWhere"]);
const NextResponse = { json: (body, options = {}) => ({ body, status: options.status || 200 }) };
const normalize = value => JSON.parse(JSON.stringify(value));

function creditRoute({ user = { rolNombre: "ADMIN", aliadoAccesoId: 4, aliadoAccesoCodigo: "ALLY", sedeId: 14 }, records = [] } = {}) {
  const calls = { queries: [], numberIds: [], access: [] };
  const globals = {
    NextResponse,
    getSessionUser: async () => user,
    getSellerSessionUser: async () => ({ id: 23, sedeId: 14, tipoPerfil: "VENDEDOR" }),
    isAdminRole: role => role === "ADMIN",
    isFinserPayCentralAlly: () => false,
    sanitizeSearch: value => String(value || "").trim(),
    parseTake: value => Number(value) || 15,
    parseId: value => value ? Number(value) : null,
    buildCreditAccessWhere: input => { calls.access.push(input); return { sede: { aliadoId: input.aliadoId } }; },
    creditListInclude: {}, creditListOmit: {},
    prisma: { credito: { findMany: async query => { calls.queries.push(query); return records; } } },
    buildPaymentSummaryMap: async () => new Map(),
    getCreditDisplayNumbers: async ids => { calls.numberIds.push([...ids]); return new Map([[81, "00081-A"]]); },
    serializeCredit: item => ({ ...item }),
    ...display,
  };
  const { GET } = functionsFrom("app/api/creditos/route.ts", ["GET", "redactCreditForNonAdmin"], globals);
  return { GET, calls };
}

test("buscar el número SADMIN conserva el alcance del aliado y el folio original del DTO", async () => {
  const record = { id: 81, folio: "FC-ORIGINAL-81", clienteNombre: "Cliente prueba" };
  const { GET, calls } = creditRoute({ records: [record] });
  const result = await GET(new Request("https://example.test/api/creditos?search=00081-A"));
  assert.equal(result.status, 200);
  const query = normalize(calls.queries[0]);
  assert.deepEqual(query.where.AND[0], { sede: { aliadoId: 4 } });
  const numberSearch = query.where.AND[1].OR.find(item => item.OR?.some(term => term.registroSadmin));
  assert.deepEqual(numberSearch, { OR: [
    { folio: { contains: "00081-A", mode: "insensitive" } },
    { registroSadmin: { is: { numeroCreditoConfirmado: true, numeroCredito: { contains: "00081-A", mode: "insensitive" } } } },
  ] });
  assert.deepEqual(calls.numberIds, [[81]]);
  assert.equal(result.body.items[0].numeroCreditoVisible, "00081-A");
  assert.equal(result.body.items[0].folio, "FC-ORIGINAL-81");
  assert.deepEqual(record, { id: 81, folio: "FC-ORIGINAL-81", clienteNombre: "Cliente prueba" });
});

test("el vendedor recibe número visible sin perder alcance ni redacción de datos sensibles", async () => {
  const record = { id: 81, folio: "FC-ORIGINAL-81", clienteDireccion: "Privado", clienteCorreo: "privado@example.test", usuario: { usuario: "Privado" }, vendedor: { documento: "Privado" } };
  const { GET, calls } = creditRoute({ user: { rolNombre: "VENDEDOR", aliadoAccesoId: 4, sedeId: 14 }, records: [record] });
  const result = await GET(new Request("https://example.test/api/creditos?id=81"));
  assert.deepEqual(normalize(calls.queries[0].where), { AND: [{ sedeId: 14, vendedorId: 23 }, { id: 81 }] });
  assert.deepEqual(calls.numberIds, [[81]]);
  assert.equal(result.body.items[0].numeroCreditoVisible, "00081-A");
  assert.equal(result.body.items[0].folio, "FC-ORIGINAL-81");
  assert.equal(result.body.items[0].clienteDireccion, null);
  assert.equal(result.body.items[0].clienteCorreo, null);
  assert.equal(result.body.items[0].usuario.usuario, "");
  assert.equal(result.body.items[0].vendedor.documento, "");
});

test("un usuario sin sesión no consulta créditos ni números SADMIN", async () => {
  const { GET, calls } = creditRoute({ user: null });
  const result = await GET(new Request("https://example.test/api/creditos?search=00081-A"));
  assert.equal(result.status, 401);
  assert.deepEqual(calls.queries, []);
  assert.deepEqual(calls.numberIds, []);
});

test("el portal cliente adjunta números solo a los créditos del documento consultado y mantiene el fallback", async () => {
  const calls = { queries: [], numberIds: [] };
  const records = [81, 82].map(id => ({ id, folio: `FC-ORIGINAL-${id}`, clienteNombre: "Cliente prueba", clienteDocumento: "1234567890", fechaCredito: new Date("2026-09-17T12:00:00Z"), sede: { nombre: "Sede prueba" }, abonos: [], montoCredito: 1000000, valorCuota: 100000, plazoMeses: 10 }));
  const { GET } = functionsFrom("app/api/clientes/creditos/route.ts", ["GET"], {
    NextResponse,
    sanitizeSearch: value => String(value || "").trim(),
    ensureCreditAbonoAuditColumns: async () => {},
    prisma: { credito: { findMany: async query => { calls.queries.push(query); return records; } } },
    getCreditDisplayNumbers: async ids => { calls.numberIds.push([...ids]); return new Map([[81, "00081-A"]]); },
    withCreditDisplayNumber: display.withCreditDisplayNumber,
    buildCreditPaymentPlan: () => ({ estadoPago: "AL_DIA", saldoPendiente: 1000000, totalPaid: 0, installments: [] }),
    calculateCreditEarlyPayoff: () => ({ eligible: false, reason: "No disponible", capitalPendiente: 1000000, interesFianzaCondonado: 0, saldoObligacion: 1000000 }),
  });
  const result = await GET(new Request("https://example.test/api/clientes/creditos?documento=1234567890"));
  assert.equal(result.status, 200);
  assert.deepEqual(normalize(calls.queries[0].where), { clienteDocumento: "1234567890", estado: { not: "ANULADO" } });
  assert.deepEqual(calls.numberIds, [[81, 82]]);
  assert.deepEqual(result.body.items.map(item => [item.id, item.folio, item.numeroCreditoVisible]), [
    [81, "FC-ORIGINAL-81", "00081-A"], [82, "FC-ORIGINAL-82", "FC-ORIGINAL-82"],
  ]);
});

test("las solicitudes SOL conservan su número y solo los créditos asociados usan SADMIN", () => {
  const { creditDisplayNumber } = functionsFrom("lib/credit-display-number.ts", ["creditDisplayNumber"]);
  const { solicitudDisplayNumber } = functionsFrom("app/dashboard/solicitudes/solicitudes-wall-client.tsx", ["solicitudDisplayNumber"], { creditDisplayNumber });
  assert.equal(solicitudDisplayNumber({ source: "DRAFT", numero: "SOL-001376", numeroCreditoVisible: "00081-A" }), "SOL-001376");
  assert.equal(solicitudDisplayNumber({ source: "CREDIT", numero: "FC-ORIGINAL-81", numeroCreditoVisible: "00081-A" }), "00081-A");
  assert.equal(solicitudDisplayNumber({ source: "CREDIT", numero: "FC-ORIGINAL-82" }), "FC-ORIGINAL-82");
});
