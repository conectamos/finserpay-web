import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

function load(file, dependencies) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Date, URLSearchParams,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return loaded.exports;
}

const contract = load("lib/credit-amortization-contract.ts", {
  "node:crypto": { createHash },
  "@/lib/credit-amortization": { ARES_COMMERCIAL_AMORTIZATION_VERSION: "ARES_COMMERCIAL" },
});
const model = load("lib/approval-request-detail-model.ts", {
  "@/lib/credit-amortization-contract": contract,
});
const plain = value => JSON.parse(JSON.stringify(value));

test("el identificador del expediente exige D/C, entero positivo y sin rutas ambiguas", () => {
  assert.deepEqual(plain(model.parseAnalystRequestId("D-7")), { id: "D-7", source: "DRAFT", entityId: 7 });
  assert.deepEqual(plain(model.parseAnalystRequestId("C-81")), { id: "C-81", source: "CREDIT", entityId: 81 });
  for (const id of [null, 7, "", "7", "D-0", "D-01", "D--1", "D-1.5", "D-1e2", "D-9007199254740992", "d-7", "D-7 ", "D-7/../C-81", "C-81?credit=82"]) {
    assert.equal(model.parseAnalystRequestId(id), null, String(id));
  }
});

test("la proyección de contacto excluye cédula, proveedor, credenciales y evidencias crudas", () => {
  const input = {
    clienteTelefono: " 3001112233 ", clienteCorreo: " ana@example.test ",
    clienteDireccion: " Calle 4 ", clienteDepartamento: " TOLIMA ", clienteCiudad: " Ibagué ",
    clienteFechaNacimiento: "2000-01-05", clienteTipoDocumento: "CC",
    clienteDocumento: "PRIVATE-DOCUMENT", providerPayload: { token: "PRIVATE-PROVIDER" },
    otp: "PRIVATE-OTP", contratoCedulaFrenteDataUrl: "PRIVATE-PHOTO",
    financialTermsSeal: { token: "PRIVATE-SEAL" },
  };
  const projected = plain(model.projectRequestContact(input));
  assert.deepEqual(projected, {
    phone: "3001112233", email: "ana@example.test", address: "Calle 4", department: "TOLIMA",
    city: "Ibagué", birthDate: "2000-01-05", documentType: "CC",
  });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE-/);
  assert.equal(input.clienteTelefono, " 3001112233 ", "consultar no modifica el payload persistido");
  for (const invalid of [null, [], "texto", { clienteTelefono: { raw: "token" }, clienteCorreo: ["correo"] }]) {
    assert.equal(model.projectRequestContact(invalid).phone, null);
    assert.equal(model.projectRequestContact(invalid).email, null);
  }
});

test("la información financiera consulta importes guardados y calcula solo el saldo base explícito", () => {
  const result = plain(model.projectRequestFinancial({
    valorEquipoTotal: "2600000", cuotaInicial: "780000", saldoBaseFinanciado: "1820000",
    plazoMeses: "40", cuotaComercial: "90850", valorCuota: "99999",
    frecuenciaPago: " QUINCENAL ", fechaPrimerPago: "2026-10-17", providerPayload: "PRIVATE-PROVIDER",
  }));
  assert.deepEqual(result, {
    saleValue: 2600000, downPayment: 780000, authorizedAmount: 1820000,
    installments: 40, installment: 90850, frequency: "QUINCENAL", firstPayment: "2026-10-17",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|providerPayload|payload/);
  assert.equal(model.projectRequestFinancial({ valorEquipoTotal: 1000, cuotaInicial: 300 }).authorizedAmount, 700);
  assert.equal(model.projectRequestFinancial({ valorEquipoTotal: 300, cuotaInicial: 1000 }).authorizedAmount, null);
});

test("el sello firmado prevalece sobre el borrador desactualizado sin recalcular sus condiciones", () => {
  const snapshot = {
    valorVenta: "2600000.000000", cuotaInicial: "780000.000000", valorFinanciado: "1820000.000000",
    numeroCuotas: 40, cuotaPactada: "91000.000000", cuotaComercial: "90850.000000",
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17",
  };
  const seal = {
    version: contract.FINANCING_TERMS_SEAL_VERSION,
    checksum: createHash("sha256").update(JSON.stringify(snapshot, Object.keys(snapshot).sort())).digest("hex"),
    snapshot,
  };
  const stalePayload = { valorEquipoTotal: 1, cuotaInicial: 1, plazoMeses: 1, fechaPrimerPago: "2026-10-02" };
  const expected = {
    saleValue: 2600000, downPayment: 780000, authorizedAmount: 1820000,
    installments: 40, installment: 91000, frequency: "QUINCENAL", firstPayment: "2026-10-17",
  };
  assert.deepEqual(plain(model.projectRequestFinancial(stalePayload, seal)), expected);
  assert.deepEqual(plain(model.projectRequestFinancial({ ...stalePayload, financialTermsSeal: seal })), expected);
  assert.equal(model.projectRequestFinancial(stalePayload, { ...seal, checksum: "a".repeat(64) }).saleValue, 1);
});

test("importes inválidos o ausentes no se presentan como valores financieros válidos", () => {
  for (const value of [null, [], "texto", { valorEquipoTotal: -1 }, { valorEquipoTotal: true }, { valorEquipoTotal: "NaN" }, { valorEquipoTotal: Infinity }, { valorEquipoTotal: [] }, { valorEquipoTotal: [1] }, { valorEquipoTotal: " " }]) {
    assert.equal(model.projectRequestFinancial(value).saleValue, null);
  }
  assert.equal(model.projectRequestFinancial({ valorEquipoTotal: 0, cuotaInicial: 0 }).authorizedAmount, 0);
});

function detailFixture({ item: overrides = {}, found = true, rowFound = true, capabilities = {} } = {}) {
  const calls = [];
  const item = {
    id: "D-7", entityId: 7, source: "DRAFT", numero: "SOL-000007", numeroCreditoVisible: "SOL-000007",
    clienteNombre: "Ana Prueba", documento: "1111222333", estado: "PROCESO", estadoLabel: "En proceso",
    currentStep: 1, rawState: "ABIERTO", createdAt: "2026-10-06T14:00:00.000Z",
    updatedAt: "2026-10-07T14:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", closedAt: null,
    plataforma: "IPHONE", imei: "351168083278358", technicalErrorCode: null,
    aliado: { nombre: "Aliado" }, sede: { nombre: "Sede" }, asesor: { nombre: "Asesor" },
    usuario: { nombre: "Creador" }, timeline: [{ key: "DATACREDITO", label: "Consulta", status: "APROBADO", at: "2026-10-06T14:00:00.000Z" }],
    ...overrides,
  };
  const row = {
    data: {
      clienteTelefono: "3001112233", clienteCorreo: "ana@example.test", clienteCiudad: "Ibagué",
      valorEquipoTotal: 2600000, cuotaInicial: 780000, plazoMeses: 40, cuotaComercial: 91000,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17", referenciaEquipo: "IPHONE 13",
      providerPayload: "PRIVATE-PROVIDER", accessToken: "PRIVATE-TOKEN", fotoRemisionDataUrl: "PRIVATE-PHOTO",
    },
    media: { fotoRemisionDataUrl: true }, seal: null, signatureStatus: null,
    signatureError: "PRIVATE-PROVIDER-ERROR", signedAt: null, hasSignedDocument: false,
    payload: "PRIVATE-RAW-PAYLOAD", equalityPayload: "PRIVATE-EQUALITY",
  };
  class OperationalCaseReadError extends Error {}
  const detail = load("lib/approval-request-detail.ts", {
    "server-only": {},
    "@/lib/prisma": { default: {
      $queryRawUnsafe: async (sql, ...parameters) => {
        calls.push({ name: "sql", sql, parameters });
        assert.match(sql, /^\s*SELECT/i);
        assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|CREATE\s+TABLE|ALTER\s+TABLE/i);
        return rowFound ? [row] : [];
      },
    } },
    "@/lib/solicitudes-storage": { getSolicitudDetail: async input => {
      calls.push({ name: "scope", input });
      return found ? item : null;
    } },
    "@/lib/solicitudes": { normalizeSolicitudFilters: input => input },
    "@/lib/approval-operations-read": {
      OperationalCaseReadError,
      getOperationalCase: async (source, id) => {
        calls.push({ name: "operational", source, id });
        return { capabilities, timeline: [], payload: "PRIVATE-OPERATION" };
      },
    },
    "@/lib/firmaseguro-status": { isFirmaSeguroFailedStatus: status => status === "FAILED" },
    "@/lib/approval-request-detail-model": model,
  });
  return { detail, calls };
}

test("abrir el expediente valida identidad y usuario antes de leer cualquier registro", async () => {
  for (const [id, userId] of [["D-0", 17], ["D-01", 17], ["D-9007199254740992", 17], ["C-7", 0], ["D-7", -1], ["D-7", NaN]]) {
    const f = detailFixture();
    assert.equal(await f.detail.getAnalystRequestDetail(id, userId), null);
    assert.equal(f.calls.length, 0);
  }
  const missing = detailFixture({ found: false });
  assert.equal(await missing.detail.getAnalystRequestDetail("D-7", 17), null);
  assert.equal(missing.calls.length, 1);
  assert.equal(missing.calls[0].name, "scope");
});

test("el detalle usa alcance nominal en solo lectura sin filtrar payloads crudos al cliente", async () => {
  const f = detailFixture();
  const result = plain(await f.detail.getAnalystRequestDetail("D-7", 17));
  const scope = f.calls.find(call => call.name === "scope").input;
  assert.equal(scope.readOnly, true);
  assert.deepEqual(plain(scope.viewer), { kind: "APPROVAL_ANALYST", userId: 17, aliadoId: null, sedeId: null, vendedorId: null });
  assert.equal(f.calls.find(call => call.name === "sql").parameters[0], 7);
  assert.equal(result.client.phone, "3001112233");
  assert.equal(result.financial.authorizedAmount, 1820000);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|providerPayload|accessToken|equalityPayload|fotoRemisionDataUrl/);
  assert.equal("payload" in result, false);
  assert.equal(result.documents.find(doc => doc.key === "foto-remision").href, "/api/aprobaciones/solicitudes/D-7/archivo/foto-remision");
  assert.deepEqual(result.actions, []);
  assert.equal(f.calls.some(call => call.name === "operational"), false, "paso 1 no inicia operaciones ni validaciones");
});

test("las solicitudes tempranas, vencidas, rechazadas y cerradas conservan lectura sin acciones", async () => {
  for (const item of [
    { currentStep: 2 }, { currentStep: 4, expiresAt: "2020-01-01T00:00:00.000Z" },
    { currentStep: 4, estado: "RECHAZADA", rawState: "CERRADO" },
    { currentStep: 4, estado: "CANCELADA", rawState: "CERRADO" },
  ]) {
    const f = detailFixture({ item });
    const result = await f.detail.getAnalystRequestDetail("D-7", 17);
    assert.equal(result.id, "D-7");
    assert.deepEqual(plain(result.actions), []);
    assert.equal(f.calls.some(call => call.name === "operational"), false);
  }
});

test("el expediente enlaza acciones existentes solo cuando el backend autoriza cada capacidad", async () => {
  const f = detailFixture({ item: { currentStep: 4 }, capabilities: { canRedirectPendingSignature: true, canChangeImei: true } });
  const result = plain(await f.detail.getAnalystRequestDetail("D-7", 17));
  assert.deepEqual(result.actions.map(action => action.kind), ["imei", "signature"]);
  for (const action of result.actions) {
    assert.match(action.href, /^\/dashboard\/aprobaciones\//);
    assert.match(action.href, /caso=D-7/);
  }
  assert.doesNotMatch(JSON.stringify(result.actions), /creditos\?|financ|plan|cuota|desist/i);
  const noPermission = detailFixture({ item: { currentStep: 4 }, capabilities: {} });
  assert.deepEqual(plain((await noPermission.detail.getAnalystRequestDetail("D-7", 17)).actions), []);
});

test("el crédito creado conserva su folio visible y enlaces dentro de aprobaciones", async () => {
  const f = detailFixture({ item: { source: "CREDIT", id: "C-81", entityId: 81, estado: "APROBADA", numeroCreditoVisible: "0100000081" } });
  const result = plain(await f.detail.getAnalystRequestDetail("C-81", 17));
  assert.equal(result.source, "CREDIT");
  assert.equal(result.number, "0100000081");
  assert.equal(f.calls.find(call => call.name === "sql").parameters[0], 81);
  assert.equal(result.documents.find(doc => doc.key === "foto-remision").href, "/api/aprobaciones/81/evidencias?tipo=foto-remision");
  assert.deepEqual(result.actions, [{ kind: "approval", label: "Ver expediente de aprobación", href: "/dashboard/aprobaciones?credito=81" }]);
});

test("las consultas PostgreSQL reales leen borrador/crédito, respetan el sello vigente y no escriben", async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "CreditoBorrador" ("id" INTEGER PRIMARY KEY, "payload" JSONB, "clienteTelefono" TEXT,
      "closedReason" TEXT, "closedAt" TIMESTAMPTZ, "desistedByUserId" INTEGER);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY, "nombre" TEXT);
    CREATE TABLE "FirmaSeguroProcess" ("id" INTEGER PRIMARY KEY, "draftId" INTEGER, "creditoId" INTEGER,
      "draftPayload" JSONB, "status" TEXT, "lastError" TEXT, "completedAt" TIMESTAMPTZ,
      "signedDocumentBase64" TEXT, "supersededAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ);
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "clienteTelefono" TEXT, "clienteCorreo" TEXT,
      "clienteDireccion" TEXT, "clienteDepartamento" TEXT, "clienteCiudad" TEXT,
      "clienteFechaNacimiento" TIMESTAMP, "clienteTipoDocumento" TEXT, "referenciaEquipo" TEXT,
      "equipoMarca" TEXT, "equipoModelo" TEXT, "valorEquipoTotal" NUMERIC, "cuotaInicial" NUMERIC,
      "saldoBaseFinanciado" NUMERIC, "plazoMeses" INTEGER, "valorCuota" NUMERIC,
      "frecuenciaPago" TEXT, "fechaPrimerPago" TIMESTAMP,
      "contratoCedulaFrenteDataUrl" TEXT, "contratoCedulaRespaldoDataUrl" TEXT,
      "iphoneSelfieCedulaDataUrl" TEXT, "fotoEntregaDataUrl" TEXT, "fotoRemisionDataUrl" TEXT,
      "contratoSnapshot" JSONB);
    CREATE TABLE "CreditoAmortizacion" ("creditoId" INTEGER PRIMARY KEY, "cuotaComercial" NUMERIC);
  `);
  const snapshot = { valorVenta: "2600000", cuotaInicial: "780000", valorFinanciado: "1820000",
    numeroCuotas: 40, cuotaPactada: "91000", frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17" };
  const seal = { version: contract.FINANCING_TERMS_SEAL_VERSION, snapshot,
    checksum: createHash("sha256").update(JSON.stringify(snapshot, Object.keys(snapshot).sort())).digest("hex") };
  const draftPayload = { clienteTelefono: "3005556677", clienteCorreo: "ana@example.test", valorEquipoTotal: 99,
    cuotaInicial: 1, plazoMeses: 1, cuotaComercial: 10, frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-10-02",
    fotoRemisionDataUrl: "PRIVATE-PHOTO", providerPayload: "PRIVATE-PROVIDER", password: "PRIVATE-CREDENTIAL" };
  await pg.query('INSERT INTO "CreditoBorrador" ("id","payload","clienteTelefono") VALUES ($1,$2::jsonb,$3)', [7, JSON.stringify(draftPayload), "3001112233"]);
  await pg.query(`INSERT INTO "FirmaSeguroProcess" ("id","draftId","draftPayload","status","completedAt","signedDocumentBase64","createdAt")
    VALUES (1,7,$1::jsonb,'SIGNED','2026-10-07T12:00:00Z','JVBERi0=',CURRENT_TIMESTAMP)`, [JSON.stringify({ financialTermsSeal: seal })]);
  await pg.query(`INSERT INTO "FirmaSeguroProcess" ("id","draftId","draftPayload","status","supersededAt","createdAt")
    VALUES (2,7,$1::jsonb,'FAILED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [JSON.stringify({ financialTermsSeal: { ...seal, snapshot: { ...snapshot, valorVenta: "1" } } })]);
  await pg.exec(`INSERT INTO "Credito" VALUES (81,'3008887766','credito@example.test','Calle 4','TOLIMA','Ibagué',
    '2000-01-05T00:00:00Z','CC','IPHONE 13','IPHONE','13',2600000,780000,1820000,40,91000,'QUINCENAL','2026-10-17T00:00:00Z');
    INSERT INTO "CreditoAmortizacion" VALUES (81,90850);`);
  const before = await pg.query('SELECT "payload" FROM "CreditoBorrador" WHERE "id"=7');
  const calls = [];
  class OperationalCaseReadError extends Error {}
  const detail = load("lib/approval-request-detail.ts", {
    "server-only": {}, "@/lib/prisma": { default: { $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ sql, params });
      assert.match(sql, /^\s*SELECT/);
      return (await pg.query(sql, params)).rows;
    } } },
    "@/lib/solicitudes": { normalizeSolicitudFilters: input => input },
    "@/lib/solicitudes-storage": { getSolicitudDetail: async input => {
      assert.equal(input.readOnly, true);
      return { numero: "SOL-000007", numeroCreditoVisible: "0100000081", clienteNombre: "Ana", documento: "1111222333",
        estado: "PROCESO", estadoLabel: "En proceso", currentStep: 2, rawState: "ABIERTO", createdAt: null,
        updatedAt: null, expiresAt: null, closedAt: null, plataforma: "IPHONE", imei: "351168083278358",
        usuario: { nombre: "Asesor" }, timeline: [] };
    } },
    "@/lib/approval-operations-read": { OperationalCaseReadError, getOperationalCase: async () => ({ capabilities: {}, timeline: [] }) },
    "@/lib/firmaseguro-status": { isFirmaSeguroFailedStatus: status => status === "FAILED" },
    "@/lib/approval-request-detail-model": model,
  });
  const draft = plain(await detail.getAnalystRequestDetail("D-7", 17));
  assert.equal(draft.client.phone, "3001112233");
  assert.deepEqual(draft.financial, { saleValue: 2600000, downPayment: 780000, authorizedAmount: 1820000,
    installments: 40, installment: 91000, frequency: "QUINCENAL", firstPayment: "2026-10-17" });
  assert.equal(draft.documents.find(doc => doc.key === "foto-remision").available, true);
  assert.equal(draft.documents.find(doc => doc.key === "documento-firmado").available, true);
  assert.doesNotMatch(JSON.stringify(draft), /PRIVATE-|providerPayload|password|fotoRemisionDataUrl|financialTermsSeal/);
  const credit = plain(await detail.getAnalystRequestDetail("C-81", 17));
  assert.equal(credit.client.phone, "3008887766");
  assert.equal(credit.client.birthDate, "2000-01-05");
  assert.equal(credit.financial.saleValue, 2600000);
  assert.equal(credit.financial.installment, 90850);
  assert.match(credit.financial.firstPayment, /^2026-10-17/);
  assert.equal(credit.equipment.reference, "IPHONE 13");
  assert.equal(calls.length, 2);
  const after = await pg.query('SELECT "payload" FROM "CreditoBorrador" WHERE "id"=7');
  assert.deepEqual(after.rows, before.rows, "abrir no modifica evidencias ni términos del borrador");

  await pg.query('UPDATE "CreditoBorrador" SET "payload"="payload" - $1::text - $2::text WHERE "id"=7', ["clienteTelefono", "clienteCorreo"]);
  const noPayloadContact = await detail.getAnalystRequestDetail("D-7", 17);
  assert.equal(noPayloadContact.client.phone, "3001112233", "el teléfono materializado sigue disponible aunque falte en el JSON");
  assert.equal(noPayloadContact.client.email, null);
  await pg.query('UPDATE "CreditoBorrador" SET "clienteTelefono"=$1,"payload"="payload" || $2::jsonb WHERE "id"=7',
    ["", JSON.stringify({ clienteTelefono: "3002223344" })]);
  assert.equal((await detail.getAnalystRequestDetail("D-7", 17)).client.phone, "3002223344", "un campo canónico vacío conserva el contacto del JSON");
  await pg.query('UPDATE "Credito" SET "contratoSnapshot"=$1::jsonb WHERE "id"=81', [JSON.stringify({ financiero: { cuotaComercial: "90750" } })]);
  await pg.exec('DELETE FROM "CreditoAmortizacion" WHERE "creditoId"=81');
  assert.equal((await detail.getAnalystRequestDetail("C-81", 17)).financial.installment, 90750,
    "el crédito histórico sin tabla de amortización conserva su cuota comercial guardada");
  await pg.exec(`INSERT INTO "Usuario" VALUES (17,'Analista de prueba');
    UPDATE "CreditoBorrador" SET "closedReason"='DESISTIDA',"closedAt"='2026-10-08T20:00:00Z',"desistedByUserId"=17 WHERE "id"=7`);
  const closed = plain(await detail.getAnalystRequestDetail("D-7", 17));
  assert.deepEqual(closed.timeline.find(event => event.id === "DESISTIDA"), {
    id: "DESISTIDA", label: "Solicitud desistida", status: "DESISTIDA", at: "2026-10-08T20:00:00.000Z",
    detail: "Solicitud cerrada; su historial se conserva.", actor: "Analista de prueba",
  });
  await pg.exec(`UPDATE "CreditoBorrador" SET "closedReason"='RECHAZADA' WHERE "id"=7`);
  assert.ok(!(await detail.getAnalystRequestDetail("D-7", 17)).timeline.some(event => event.id === "DESISTIDA"));
});

test("las fechas calendario mantienen su día UTC aunque el almacenamiento incluya el offset de Bogotá", () => {
  assert.equal(model.projectRequestContact({ clienteFechaNacimiento: "2000-01-04T19:00:00-05:00" }).birthDate, "2000-01-05");
  assert.equal(model.projectRequestFinancial({ fechaPrimerPago: "2026-10-16T19:00:00-05:00" }).firstPayment, "2026-10-17");
  assert.equal(model.projectRequestContact({ clienteFechaNacimiento: "2000-01-05" }).birthDate, "2000-01-05");
  assert.equal(model.projectRequestFinancial({ fechaPrimerPago: "2026-10-17" }).firstPayment, "2026-10-17");
});
