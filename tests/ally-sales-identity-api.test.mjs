import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const access = loadReissueModule("lib/solicitud-operation-access.ts");
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const user = { id: 12, nombre: "Admin aliado", activo: true, rolNombre: "ADMIN",
  aliadoId: 56, aliadoAccesoId: 56, aliadoAccesoCodigo: "ALLY-56", aliadoAccesoActivo: true,
  sedeId: 7, sedeAccesoId: 7, sedeAccesoActiva: true };

function declarations(path, names, dependencies) {
  const source = read(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(ast).replace(/^export /, "")).join("\n");
  assert.equal(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).length, names.length);
  return runInNewContext(ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText + `\n({${names.join(",")}})`, {
    NextResponse: Response, console, URL, Date, ...access,
    isAdminRole: role => role === "ADMIN",
    isFinserPayCentralAlly: code => code === "FINSERPAY",
    ...dependencies,
  });
}

function signatureFixture(options = {}) {
  const calls = { queries: [], blacklist: 0, provider: 0, seller: 0 };
  const actor = options.user === null ? null : { ...user, ...options.user };
  const row = { id: 90, usuarioId: user.id, vendedorId: null, sedeId: 7, sedeAliadoId: 56,
    clienteDocumento: "100000001", payload: {}, ...options.row };
  const functions = declarations("app/api/creditos/borradores/[id]/firma-seguro/route.ts",
    ["readAuthorizedDraft", "PATCH"], {
      getSessionUser: async () => actor,
      getSellerSessionUser: async () => { calls.seller++; return null; },
      ensureDraftTable: async () => {},
      prisma: { $queryRawUnsafe: async (sql, ...values) => { calls.queries.push({ sql, values }); return [row]; } },
      payloadObject: payload => payload || {},
      assertDocumentNotBlacklisted: async () => { calls.blacklist++; },
      parseDraftId: value => Number(value) || null,
      correctFirmaSeguroDraftImei: async () => { calls.provider++; throw new Error("No external correction"); },
      logFirmaSeguroDraftError: () => {},
      firmaSeguroErrorResponse: error => { throw error; },
    });
  return { calls, row, functions };
}

test("FirmaSeguro permite la venta propia del admin aliado con restricciones de propietario en SQL", async () => {
  const fixture = signatureFixture();
  const authorized = await fixture.functions.readAuthorizedDraft(90, { operate: true });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.centralAdmin, false, "No adquiere permisos centrales al firmar su venta");
  assert.equal(authorized.row.usuarioId, user.id);
  assert.equal(authorized.row.vendedorId, null);
  assert.equal(fixture.calls.seller, 0);
  assert.match(fixture.calls.queries[0].sql, /s\."aliadoId" = \$2/);
  assert.match(fixture.calls.queries[0].sql, /d\."usuarioId" = \$3/);
  assert.match(fixture.calls.queries[0].sql, /d\."vendedorId" IS NULL/);
  assert.deepEqual(fixture.calls.queries[0].values, [90, 56, 12]);
});

test("FirmaSeguro niega operar ventas de otro admin, vendedores y aliados antes de enviar", async () => {
  for (const row of [{ usuarioId: 13 }, { vendedorId: 71 }, { sedeAliadoId: 57 }]) {
    const fixture = signatureFixture({ row });
    const authorized = await fixture.functions.readAuthorizedDraft(90, { operate: true });
    assert.equal(authorized.ok, false);
    assert.equal(authorized.status, 403);
    assert.equal(fixture.calls.blacklist, 0);
    assert.equal(fixture.calls.provider, 0);
  }
  for (const override of [{ activo: false }, { aliadoAccesoActivo: false }, { sedeAccesoActiva: false },
    { aliadoAccesoId: 57 }, { sedeAccesoId: 8 }]) {
    const fixture = signatureFixture({ user: override });
    assert.equal((await fixture.functions.readAuthorizedDraft(90, { operate: true })).status, 403);
    assert.equal(fixture.calls.provider, 0);
  }
});

test("la lectura administrativa por aliado permanece y sólo central puede corregir el IMEI firmado", async () => {
  const fixture = signatureFixture({ row: { usuarioId: 13, vendedorId: 71 } });
  assert.equal((await fixture.functions.readAuthorizedDraft(90)).ok, true, "Conserva la lectura existente del aliado");
  const response = await fixture.functions.PATCH({ json: async () => { throw new Error("No debe leer acciones no autorizadas"); } },
    { params: Promise.resolve({ id: "90" }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "CORRECCION_IMEI_NO_AUTORIZADA");
  assert.equal(fixture.calls.provider, 0);
  const central = signatureFixture({ user: { aliadoAccesoCodigo: "FINSERPAY" }, row: { usuarioId: 13, vendedorId: 71, sedeAliadoId: 57 } });
  assert.equal((await central.functions.readAuthorizedDraft(90, { operate: true })).ok, true);
});

function veriffFixture(options = {}) {
  const calls = { provider: 0, updates: 0, released: 0, reads: 0 };
  const draft = { usuarioId: user.id, vendedorId: null, aliadoId: user.aliadoId, ...options.draft };
  const current = { id: 44, draftId: 90, creditoId: null, clienteDocumento: "100000001", veriffSessionId: "isolated-test-session" };
  const { GET } = declarations("app/api/creditos/veriff/[id]/route.ts",
    ["parseId", "canReadActiveValidation", "GET"], {
      getSessionUser: async () => ({ ...user, ...options.user }),
      getSellerSessionUser: async () => { throw new Error("Admin no usa perfil vendedor"); },
      getVeriffValidationById: async () => current,
      getActiveSolicitudCreditContext: async () => { calls.reads++; return calls.reads > 1 && options.afterLock ? { ...draft, ...options.afterLock } : draft; },
      assertDocumentNotBlacklisted: async () => {},
      veriffGetDecision: async () => { calls.provider++; return null; },
      veriffGetPerson: async () => { calls.provider++; return null; },
      tryAcquireSolicitudOperationLock: async () => ({ release: async () => { calls.released++; } }),
      updateVeriffValidation: async () => { calls.updates++; throw new Error("Unexpected mutation"); },
      updateVeriffValidationFromDecision: async () => { calls.updates++; throw new Error("Unexpected mutation"); },
      enforceVeriffRetryPolicy: async () => ({}),
      getVeriffRetryPolicy: async () => ({}),
      serializeVeriffValidation: row => row,
      redactVeriffValidationForOperator: row => ({ id: row.id, status: "PENDING" }),
      getVeriffPublicSummary: () => ({}),
      documentBlacklistErrorResponse: () => null,
      VeriffApiError: class extends Error {},
    });
  return { calls, request: () => GET(new Request("https://fixture.invalid/veriff/44"), { params: Promise.resolve({ id: "44" }) }) };
}

test("admin aliado puede consultar el estado de su Veriff y recibe la respuesta operativa protegida", async () => {
  const fixture = veriffFixture();
  const response = await fixture.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).validation, { id: 44, status: "PENDING" });
  assert.equal(fixture.calls.provider, 2, "Son dobles en memoria, nunca peticiones reales");
  assert.equal(fixture.calls.updates, 0);
  assert.equal(fixture.calls.released, 1);
});

test("Veriff niega consultas ajenas antes de contactar al proveedor y revalida bajo bloqueo", async () => {
  for (const draft of [{ usuarioId: 13 }, { vendedorId: 71 }, { aliadoId: 57 }]) {
    const fixture = veriffFixture({ draft });
    assert.equal((await fixture.request()).status, 403);
    assert.equal(fixture.calls.provider, 0);
    assert.equal(fixture.calls.updates, 0);
  }
  const moved = veriffFixture({ afterLock: { usuarioId: 13 } });
  assert.equal((await moved.request()).status, 403);
  assert.equal(moved.calls.updates, 0, "Una respuesta antigua no cambia una solicitud que perdió el alcance");
  assert.equal(moved.calls.released, 1);
});
