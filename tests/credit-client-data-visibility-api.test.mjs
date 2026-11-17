import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { CREDIT_CLIENT_REDACTED_FIELDS } from "../lib/credit-client-data-visibility.ts";
import * as operationAccess from "../lib/solicitud-operation-access.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const snapshots = await jiti.import("../lib/credit-factory-snapshot.ts");
const roles = await jiti.import("../lib/roles.ts");
const allies = await jiti.import("../lib/aliados.ts");
const lookup = await jiti.import("../lib/credit-route-lookup.ts");
const display = await jiti.import("../lib/credit-display-number.ts");
const listPath = "app/api/creditos/route.ts";
const commandPath = "app/api/creditos/[id]/command/route.ts";
const json = value => JSON.parse(JSON.stringify(value));
const NextResponse = { json: (body, options) => Response.json(body, options) };

// Run the real handlers, field mappings and redactors. Only database/provider I/O
// and unrelated financial calculations are controlled by this fixture.
function functionsFrom(file, names, globals) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = names.map(name => {
    const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `Missing function ${name}`);
    return node.getText(source).replace(/^export\s+/, "");
  });
  const code = ts.transpileModule(`${declarations.join("\n")}\nexports.result = { ${names.join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports, console, URL, Map, Set, Date, Request, Response, ...globals }, { filename: file });
  return exports.result;
}

function credit({ empty = false, fullNameOnly = false } = {}) {
  return {
    id: 81, folio: "FC-TEST-81", clienteDocumento: "900000081", clienteTipoDocumento: "CC",
    clienteNombre: "CLIENTE DE PRUEBA", clientePrimerNombre: fullNameOnly ? null : "CLIENTE",
    clientePrimerApellido: fullNameOnly ? null : "PRUEBA", clienteTelefono: "3000000081",
    clienteDireccion: empty ? null : "Dirección privada de prueba",
    clienteFechaNacimiento: empty ? null : new Date("1990-01-02T00:00:00Z"),
    clienteFechaExpedicion: empty ? null : new Date("2008-02-03T00:00:00Z"),
    clienteCorreo: empty ? null : "privado@example.test", clienteGenero: empty ? null : "MASCULINO",
    contratoSnapshot: {
      cliente: {
        estadoCivil: empty ? null : "SOLTERO", estrato: empty ? null : "2",
        referenciasFamiliares: empty ? [] : [
          { nombre: "Referencia uno", parentesco: "HERMANO", telefono: "3000000001" },
          { nombre: "Referencia dos", parentesco: "MADRE", telefono: "3000000002" },
        ],
      },
      ...(fullNameOnly ? { dataCreditoIdentity: { effective: { nameMode: "FULL_NAME_ONLY" } } } : {}),
    },
    fechaCredito: new Date("2026-11-01T12:00:00Z"), createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"), montoCredito: 1000000, valorCuota: 100000,
    cuotaInicial: 0, plazoMeses: 10, estado: "GENERADO", referenciaPago: "REF-81",
    usuario: { id: 7, nombre: "Usuario prueba", usuario: "test-login" },
    vendedor: { id: 23, nombre: "Vendedor prueba", documento: "900000023" },
    sede: { id: 14, nombre: "Sede prueba", aliadoId: 4 },
  };
}

function actor(role, central = false) {
  return {
    id: 7, rolNombre: role === "SUPERVISOR" ? "VENDEDOR" : role,
    aliadoAccesoCodigo: central ? "FINSERPAY" : "ALLY", aliadoId: 4, aliadoAccesoId: 4,
    sedeId: 14, sedeAccesoId: 14, activo: true, sedeAccesoActiva: true, aliadoAccesoActivo: true,
  };
}

const core = {
  NextResponse, CREDIT_CLIENT_REDACTED_FIELDS, ...snapshots, ...roles, ...allies, ...lookup,
  ...operationAccess, canOperateSolicitudContext: operationAccess.canOperateSolicitud,
  sanitizeText: value => String(value ?? "").trim(), sanitizeSearch: value => String(value ?? "").trim(),
  toNullableDate: value => value ? new Date(value) : null,
  documentValuesMatch: (left, right) => String(left).replace(/\D/g, "") === String(right).replace(/\D/g, ""),
  resolveCreditPaymentSummary: () => ({ totalAbonado: 0, saldoPendiente: 1000000, abonosCount: 0 }),
  buildCreditPaymentPlan: () => ({ estadoPago: "AL_DIA", paidCount: 0, pendingCount: 10, overdueCount: 0 }),
  calculateCreditEarlyPayoff: () => ({ eligible: false }), readMassCreditComponents: () => null,
  resolveCreditSellerDisplay: item => item.usuario,
  withCreditDisplayNumber: item => ({ ...item, numeroCreditoVisible: display.creditDisplayNumber(item) }),
  creditListInclude: {}, creditListOmit: {},
};
const listNames = ["extractFamilyReferences", "readCommercialInstallmentFromSnapshot", "resolveCommercialInstallment",
  "safeIsoDate", "serializeCredit", "redactCreditForNonAdmin", "parseTake", "parseId"];

function listFixture({ role = "ADMIN", central = false, record = credit(), authenticated = true } = {}) {
  const calls = { reads: [], writes: 0 };
  const user = authenticated ? actor(role, central) : null;
  const seller = { id: 23, sedeId: 14, tipoPerfil: role };
  const api = functionsFrom(listPath, [...listNames, "GET", "POST", "dataCreditoRecoveredCreditResponse", "finalizedSolicitudRecoveredCreditResponse"], {
    ...core, getSessionUser: async () => user, getSellerSessionUser: async () => seller,
    buildPaymentSummaryMap: async () => new Map(), getCreditDisplayNumbers: async () => new Map(),
    getActiveSolicitudCreditContext: async () => null,
    getFinalizedSolicitudCreditContext: async () => ({ id: 12, creditoId: record.id, clienteDocumento: record.clienteDocumento,
      usuarioId: user?.id, vendedorId: role === "ADMIN" ? null : seller.id, aliadoId: 4 }),
    prisma: { credito: {
      findMany: async query => { calls.reads.push(json(query.where)); return [record]; },
      findUnique: async () => record,
      create: async () => { calls.writes++; throw new Error("Recovery must not create credit"); },
    } },
  });
  return { ...api, calls, record };
}

function assertVisibility(item, record, restricted) {
  assert.deepEqual(item.redactedClientFields, restricted ? [...CREDIT_CLIENT_REDACTED_FIELDS] : []);
  const expected = {
    clienteDireccion: record.clienteDireccion,
    clienteFechaNacimiento: record.clienteFechaNacimiento?.toISOString() ?? null,
    clienteFechaExpedicion: record.clienteFechaExpedicion?.toISOString() ?? null,
    clienteCorreo: record.clienteCorreo, clienteGenero: record.clienteGenero,
    clienteEstadoCivil: record.contratoSnapshot.cliente.estadoCivil,
    clienteEstrato: record.contratoSnapshot.cliente.estrato,
    referenciasFamiliares: record.contratoSnapshot.cliente.referenciasFamiliares,
  };
  for (const field of CREDIT_CLIENT_REDACTED_FIELDS) {
    assert.deepEqual(item[field], restricted ? (field === "referenciasFamiliares" ? [] : null) : expected[field], field);
  }
  assert.equal(item.clienteDocumento, record.clienteDocumento);
  assert.equal(item.clienteNombre, record.clienteNombre);
}

for (const [role, central] of [["ADMIN", true], ["ADMIN", false], ["VENDEDOR", false], ["SUPERVISOR", false]]) {
  test(`GET ${role} central=${central}: visibility matches its existing access scope`, async () => {
    const fixture = listFixture({ role, central });
    const response = await fixture.GET(new Request("https://fixture.test/api/creditos?id=81"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assertVisibility(body.items[0], fixture.record, role !== "ADMIN");
    assert.equal(body.scope, central ? "global" : role === "VENDEDOR" ? "vendedor" : "aliado");
    assert.equal(fixture.calls.reads.length, 1);
    if (role === "VENDEDOR") assert.deepEqual(fixture.calls.reads[0].AND[0], { sedeId: 14, vendedorId: 23 });
    else if (!central) assert.deepEqual(fixture.calls.reads[0].AND[0], { sede: { aliadoId: 4 } });
  });

  test(`POST finalized recovery ${role} central=${central}: keeps central-only sensitive data access`, async () => {
    const fixture = listFixture({ role, central });
    const response = await fixture.POST(new Request("https://fixture.test/api/creditos", {
      method: "POST", body: JSON.stringify({ solicitudId: 12, clienteDocumento: fixture.record.clienteDocumento }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.recovered, true);
    assert.deepEqual(body.solicitud, { id: 12, estado: "CERRADO", creditoId: 81 });
    assertVisibility(body.item, fixture.record, !central);
    assert.equal(fixture.calls.writes, 0);
  });
}

test("recovery from an existing assessment declares restricted fields without exposing their values", async () => {
  const fixture = listFixture();
  for (const permitted of [true, false]) {
    const body = await fixture.dataCreditoRecoveredCreditResponse(fixture.record, permitted).json();
    assert.equal(body.recovered, true);
    assertVisibility(body.item, fixture.record, !permitted);
  }
});

test("a truly missing administrator field remains missing, without being labeled redacted", async () => {
  const fixture = listFixture({ record: credit({ empty: true }) });
  const response = await fixture.GET(new Request("https://fixture.test/api/creditos?id=81"));
  assertVisibility((await response.json()).items[0], fixture.record, false);
});

test("unauthenticated GET still returns 401 without querying credits", async () => {
  const fixture = listFixture({ authenticated: false });
  assert.equal((await fixture.GET(new Request("https://fixture.test/api/creditos?id=81"))).status, 401);
  assert.deepEqual(fixture.calls.reads, []);
});

function commandFixture({ role = "ADMIN", central = false, record = credit({ fullNameOnly: true }), otherAlly = false } = {}) {
  const user = actor(role, central);
  if (otherAlly) user.aliadoAccesoId = 99;
  const calls = { updates: [] };
  const api = functionsFrom(commandPath, ["POST", "parseId", "extractFamilyReferences", "serializeCredit"], {
    ...core, SUPERVISOR_COMMANDS: ["payment-reference"], DEVICE_CONTROL_COMMANDS: new Set(), CREDIT_DELIVERY_PHOTO_OMIT: {},
    getSessionUser: async () => user,
    getSellerSessionUser: async () => ({ id: 23, sedeId: 14, tipoPerfil: role }),
    loadCredit: async () => record, loadPaymentSummary: async () => ({ totalAbonado: 0, abonosCount: 0 }),
    isMassImportedCredit: () => false, getEqualityDeviceMeta: () => ({}), getPayloadSummary: () => ({}),
    resolveCreditState: () => record.estado,
    prisma: { credito: { update: async ({ data }) => { calls.updates.push(json(data)); return { ...record, ...data }; } } },
  });
  return { calls, record, post: () => api.POST(new Request("https://fixture.test/api/creditos/81/command", {
    method: "POST", body: JSON.stringify({ command: "payment-reference" }),
  }), { params: Promise.resolve({ id: "81" }) }) };
}

for (const [role, central] of [["ADMIN", true], ["ADMIN", false], ["SUPERVISOR", false]]) {
  test(`command ${role} central=${central}: respects privacy and retains authoritative full-name mode`, async () => {
    const fixture = commandFixture({ role, central });
    const response = await fixture.post();
    assert.equal(response.status, 200);
    const body = await response.json();
    assertVisibility(body.item, fixture.record, role !== "ADMIN");
    assert.equal(body.item.dataCreditoIdentityNameMode, "FULL_NAME_ONLY");
    assert.equal(body.item.clientePrimerNombre, null);
    assert.equal(body.item.clientePrimerApellido, null);
    assert.equal(fixture.calls.updates.length, 2);
    assert.ok(fixture.record.clienteCorreo, "serialization must not erase stored data");
  });
}

test("command keeps seller prohibition and cross-ally isolation before any updates", async () => {
  for (const [options, expected] of [[{ role: "VENDEDOR" }, 403], [{ role: "SUPERVISOR", otherAlly: true }, 404]]) {
    const fixture = commandFixture(options);
    assert.equal((await fixture.post()).status, expected);
    assert.deepEqual(fixture.calls.updates, []);
  }
});

test("command with genuinely absent administrator data does not claim redaction or full-name-only authority", async () => {
  const fixture = commandFixture({ record: credit({ empty: true }) });
  const response = await fixture.post();
  assert.equal(response.status, 200);
  const { item } = await response.json();
  assertVisibility(item, fixture.record, false);
  assert.equal(item.dataCreditoIdentityNameMode, null);
});
