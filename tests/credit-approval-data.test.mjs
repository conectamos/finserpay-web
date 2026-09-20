import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { creditApprovalDataSchemaStatements } from "../scripts/credit-approval-data-schema.mjs";
import { creditApprovalSchemaStatements } from "../scripts/credit-approval-schema.mjs";
import {
  approvalErrors,
  loadApprovalModule,
  plain,
} from "./credit-approval-test-loader.mjs";
import {
  createReissueFixture,
  seals,
} from "./credit-approval-reissue-fixture.mjs";

const core = loadApprovalModule("lib/credit-approval-data-core.ts", {
  "@/lib/credit-approval-errors": approvalErrors,
});
const locations = loadApprovalModule("lib/colombia-locations.ts");
let approvalDetail = null;
const service = loadApprovalModule("lib/credit-approval-data.ts", {
  "@/lib/credit-approval-data-core": core,
  "@/lib/credit-approval": {
    CreditApprovalError: approvalErrors.CreditApprovalError,
    getCreditApprovalDetail: async () => approvalDetail,
  },
  "@/lib/credit-approval-actor": {
    approvalActorAudit: () => ({
      actorKind: "USER", actorUserId: 7, actorName: "Analista",
      actorGrantId: null, actorSessionId: null,
    }),
    assertApprovalActorActive: async () => undefined,
    assertApprovalActorCreditAccess: async () => undefined,
  },
  "@/lib/ally-payments-core": {
    resolveAllyPaymentPlatform: () => "IPHONE",
  },
  "@/lib/credit-factory": {
    isIphoneEquipmentCatalogBrand: (brand) => /^(APPLE|IPHONE)$/i.test(String(brand).trim()),
  },
  "@/lib/colombia-locations": locations,
  "@/lib/credit-approval-reissue-state": {
    getCreditApprovalReissueState: async () => ({ available: true, blocked: false, operation: null }),
  },
});

const validRequest = {
  changes: {
    clienteCorreo: "  CLIENTE@EXAMPLE.COM ",
    clienteTelefono: "+57 (300) 123-4567",
    clienteDepartamento: "valle_del_cauca",
    clienteCiudad: "  Cali ",
    clienteDireccion: " Calle 10   # 20-30 ",
    catalogItemId: 17,
  },
  reason: "  Datos confirmados   con el cliente ",
  revision: 3,
  reviewHash: "a".repeat(64),
  idempotencyKey: "10000000-0000-4000-8000-000000000001",
};

test("el PATCH acepta solo el contrato estricto y normaliza datos canónicos", () => {
  assert.deepEqual(plain(core.parseApprovalDataCorrection(validRequest)), {
    changes: {
      clienteCorreo: "cliente@example.com",
      clienteTelefono: "3001234567",
      clienteDepartamento: "VALLE_DEL_CAUCA",
      clienteCiudad: "Cali",
      clienteDireccion: "Calle 10 # 20-30",
      catalogItemId: 17,
    },
    reason: "Datos confirmados con el cliente",
    revision: 3,
    reviewHash: "a".repeat(64),
    idempotencyKey: "10000000-0000-4000-8000-000000000001",
  });

  for (const invalid of [
    { ...validRequest, extra: true },
    { ...validRequest, changes: {} },
    { ...validRequest, changes: { referenciaEquipo: "IPHONE 13" } },
    { ...validRequest, changes: { clienteNombre: "Otro nombre" } },
    { ...validRequest, changes: { catalogItemId: 0 } },
    { ...validRequest, revision: 0 },
    { ...validRequest, reviewHash: "A".repeat(64) },
    { ...validRequest, idempotencyKey: "no-es-uuid" },
    { ...validRequest, reason: "no" },
  ]) {
    assert.throws(() => core.parseApprovalDataCorrection(invalid), {
      code: "INVALID_DATA_CORRECTION",
    });
  }
});

test("la referencia canónica no repite la marca ya incluida en el modelo", () => {
  assert.equal(core.formatApprovalEquipmentReference("IPHONE", "IPHONE 13 128GB"), "IPHONE 13 128GB");
  assert.equal(core.formatApprovalEquipmentReference("Samsung", "Samsung Galaxy A55"), "Samsung Galaxy A55");
  assert.equal(core.formatApprovalEquipmentReference("Apple", "iPhone 15"), "Apple iPhone 15");
});

test("el catálogo expone solo identidad operativa, referencia derivada y plataforma", async () => {
  let query = "";
  const items = await service.listApprovalEquipmentCatalog({
    $queryRawUnsafe: async (sql) => {
      query = sql;
      return [
        { id: 1, marca: "IPHONE", modelo: "IPHONE 13 128GB", precioBaseVenta: 100, activo: true },
        { id: 2, marca: "Samsung", modelo: "Galaxy A55", precioBaseVenta: 200, activo: true },
      ];
    },
  });
  assert.match(query, /WHERE "activo"=TRUE/);
  assert.deepEqual(plain(items), [
    { id: 1, marca: "IPHONE", modelo: "IPHONE 13 128GB", referenciaEquipo: "IPHONE 13 128GB", plataforma: "IPHONE" },
    { id: 2, marca: "Samsung", modelo: "Galaxy A55", referenciaEquipo: "Samsung Galaxy A55", plataforma: "ANDROID" },
  ]);
  assert.ok(items.every((item) => !("precioBaseVenta" in item) && !("activo" in item)));
});

test("el DTO editable usa departamento raw y devuelve history al nivel superior", async () => {
  approvalDetail = {
    id: 81,
    clienteDepartamento: "VALLE DEL CAUCA",
    clienteDepartamentoCodigo: "VALLE_DEL_CAUCA",
    capabilities: {
      canEditData: true,
      correctionBlockedReason: null,
      dataCorrectionBlockedReason: null,
    },
  };
  const before = {
    clienteCorreo: "antes@example.test", clienteTelefono: "3001234567",
    clienteDepartamento: "VALLE_DEL_CAUCA", clienteCiudad: "Cali",
    clienteDireccion: "Calle 1", referenciaEquipo: "IPHONE 13",
  };
  const after = { ...before, clienteCorreo: "despues@example.test" };
  const result = await service.getCreditApprovalDataDetail({
    $queryRawUnsafe: async () => [{
      id: "10000000-0000-4000-8000-000000000001",
      before, after, reason: "Correo confirmado", actorName: "Analista",
      actorKind: "USER", createdAt: new Date("2026-09-20T12:00:00Z"),
    }],
  }, 81, { id: 7, nombre: "Analista" });

  assert.equal(result.item.clienteDepartamento, "VALLE_DEL_CAUCA");
  assert.equal(result.item.clienteDepartamentoLabel, "VALLE DEL CAUCA");
  assert.equal(result.item.capabilities.correctionBlockedReason, null);
  assert.equal("history" in result.item, false);
  assert.deepEqual(plain(result.history), [{
    id: "10000000-0000-4000-8000-000000000001",
    changes: [{
      field: "clienteCorreo",
      before: "antes@example.test",
      after: "despues@example.test",
    }],
    reason: "Correo confirmado",
    actorName: "Analista",
    actorKind: "USER",
    createdAt: "2026-09-20T12:00:00.000Z",
  }]);
});

test("PATCH permite corregir un aprobado, lo devuelve a pendiente y audita solo los seis datos operativos", async () => {
  const trace = [];
  const firstHash = "a".repeat(64);
  const nextHash = "b".repeat(64);
  const actor = { id: 7, nombre: "Analista" };
  const credit = {
    id: 81,
    clienteCorreo: "antes@example.test",
    clienteTelefono: "3001234567",
    clienteDepartamento: "VALLE_DEL_CAUCA",
    clienteCiudad: "Cali",
    clienteDireccion: "Calle 1",
    referenciaEquipo: "IPHONE 12",
    equipoMarca: "Apple",
    contratoSnapshot: { equipo: { plataforma: "IPHONE" } },
    estado: "ACTIVO",
    required: true,
    paid: false,
  };
  const review = {
    status: "APPROVED", revision: 1, reviewHash: firstHash, reviewHashVersion: 2,
  };
  const auditRows = [];
  const detail = () => ({
    id: 81,
    clienteDepartamento: "VALLE DEL CAUCA",
    clienteDepartamentoCodigo: credit.clienteDepartamento,
    review: { status: review.status, revision: review.revision, reviewHash: review.revision === 1 ? firstHash : nextHash },
    capabilities: {
      canEditData: true, correctionBlockedReason: null, dataCorrectionBlockedReason: null,
    },
  });
  const writeService = loadApprovalModule("lib/credit-approval-data.ts", {
    "@/lib/credit-approval-data-core": core,
    "@/lib/credit-approval": {
      CreditApprovalError: approvalErrors.CreditApprovalError,
      getCreditApprovalDetail: async () => {
        trace.push("detail");
        return detail();
      },
    },
    "@/lib/credit-approval-actor": {
      approvalActorAudit: () => ({
        actorKind: "USER", actorUserId: 7, actorName: "Analista",
        actorGrantId: null, actorSessionId: null,
      }),
      assertApprovalActorActive: async () => { trace.push("actor"); },
      assertApprovalActorCreditAccess: async () => { trace.push("access"); },
    },
    "@/lib/ally-payments-core": {
      resolveAllyPaymentPlatform: () => "IPHONE",
    },
    "@/lib/credit-factory": {
      isIphoneEquipmentCatalogBrand: (brand) => /^(APPLE|IPHONE)$/i.test(String(brand).trim()),
    },
    "@/lib/colombia-locations": locations,
    "@/lib/credit-approval-reissue-state": {
      getCreditApprovalReissueState: async () => {
        trace.push("reissue");
        return { available: true, blocked: false, operation: null };
      },
    },
  });
  const db = {
    async $queryRawUnsafe(sql) {
      if (sql.includes('FROM "Credito" credit') && sql.includes("FOR UPDATE OF credit")) {
        trace.push("credit");
        return [credit];
      }
      if (sql.includes('FROM "CreditApprovalReview"') && sql.includes("FOR UPDATE")) {
        trace.push("review");
        return [review];
      }
      if (sql.includes('WHERE "idempotencyKey"')) {
        trace.push("idempotency");
        return [];
      }
      if (sql.includes('FROM "CatalogoEquipoModelo"')) {
        trace.push("catalog");
        assert.match(sql, /FOR SHARE/);
        return [{ id: 17, marca: "IPHONE", modelo: "IPHONE 13 128GB", precioBaseVenta: 1500000, activo: true }];
      }
      if (sql.includes('FROM "CreditApprovalDataCorrection"')) return auditRows;
      throw new Error("Unexpected query: " + sql);
    },
    async $executeRawUnsafe(sql, ...params) {
      if (sql.includes('INSERT INTO "CreditApprovalReview"')) {
        trace.push("ensure-review");
        return 0;
      }
      if (sql.includes('UPDATE "Credito" SET')) {
        trace.push("update-credit");
        assert.match(sql, /"clienteCorreo"=CASE/);
        assert.match(sql, /"referenciaEquipo"=CASE/);
        assert.doesNotMatch(sql, /"equipoMarca"=|"equipoModelo"=|"valorEquipoTotal"=|"contratoSnapshot"=/);
        credit.clienteCorreo = params[2];
        credit.clienteDepartamento = params[6];
        credit.clienteCiudad = params[8];
        credit.referenciaEquipo = params[12];
        review.status = "PENDING";
        review.revision = 2;
        review.reviewHash = null;
        review.reviewHashVersion = 2;
        return 1;
      }
      if (sql.includes('INSERT INTO "CreditApprovalDataCorrection"')) {
        trace.push("audit");
        auditRows.push({
          id: params[0],
          creditoId: params[1],
          idempotencyKey: params[2],
          requestHash: params[3],
          requestedRevision: params[4],
          requestedReviewHash: params[5],
          requestedHashVersion: params[6],
          resultingRevision: params[7],
          resultingReviewHash: params[8],
          resultingHashVersion: params[9],
          before: JSON.parse(params[10]),
          after: JSON.parse(params[11]),
          reason: params[12],
          actorKind: params[13],
          actorUserId: params[14],
          actorName: params[15],
          actorGrantId: params[16],
          actorSessionId: params[17],
          catalogSnapshot: JSON.parse(params[18]),
          createdAt: new Date("2026-09-20T12:00:00Z"),
        });
        return 1;
      }
      throw new Error("Unexpected write: " + sql);
    },
  };
  const input = core.parseApprovalDataCorrection({
    changes: { clienteCorreo: "despues@example.test", clienteDepartamento: "TOLIMA", clienteCiudad: "Chaparral", catalogItemId: 17 },
    reason: "Datos confirmados con el cliente",
    revision: 1,
    reviewHash: firstHash,
    idempotencyKey: "10000000-0000-4000-8000-000000000001",
  });
  const result = await writeService.correctCreditApprovalData(db, 81, input, actor);

  assert.deepEqual(trace.slice(0, 6), ["actor", "credit", "access", "ensure-review", "review", "idempotency"]);
  assert.ok(trace.indexOf("catalog") > trace.indexOf("review"));
  assert.ok(trace.indexOf("audit") > trace.indexOf("update-credit"));
  assert.equal(credit.clienteCorreo, "despues@example.test");
  assert.equal(credit.clienteDepartamento, "TOLIMA");
  assert.equal(credit.clienteCiudad, "Chaparral");
  assert.equal(credit.referenciaEquipo, "IPHONE 13 128GB");
  assert.equal(result.item.review.revision, 2);
  assert.equal(result.item.review.status, "PENDING");
  assert.equal(result.unchanged, false);
  assert.equal(result.replayed, false);
  assert.equal(result.history.length, 1);
  assert.equal(auditRows[0].requestedHashVersion, 2);
  assert.equal(auditRows[0].resultingHashVersion, 2);
  assert.deepEqual(auditRows[0].catalogSnapshot, {
    id: 17,
    marca: "IPHONE",
    modelo: "IPHONE 13 128GB",
    precioBaseVenta: 1500000,
    activo: true,
    plataforma: "IPHONE",
    referenciaEquipo: "IPHONE 13 128GB",
  });

  const departmentOnly = core.parseApprovalDataCorrection({
    changes: { clienteDepartamento: "ANTIOQUIA" },
    reason: "Cambio de departamento sin municipio",
    revision: 2,
    reviewHash: nextHash,
    idempotencyKey: "20000000-0000-4000-8000-000000000002",
  });
  await assert.rejects(writeService.correctCreditApprovalData(db, 81, departmentOnly, actor), {
    code: "INVALID_CITY",
  });
});

test("GET y PATCH publican {ok,item,history} sin anidar el historial", () => {
  const route = readFileSync(new URL("../app/api/aprobaciones/[id]/datos/route.ts", import.meta.url), "utf8");
  assert.equal((route.match(/NextResponse\.json\(\{ ok: true, \.\.\.result \}/g) || []).length, 2);
  assert.doesNotMatch(route, /item:\s*result/);
});

test("la migración conserva aprobaciones V1 y exige metadato explícito para aprobar nuevas V2", () => {
  const dataSchema = creditApprovalDataSchemaStatements.join("\n");
  const baseSchema = creditApprovalSchemaStatements.join("\n");
  const addAt = dataSchema.indexOf('ADD COLUMN IF NOT EXISTS "reviewHashVersion" SMALLINT');
  const legacyAt = dataSchema.indexOf('SET "reviewHashVersion"=1');
  const approvedVersionAt = dataSchema.indexOf('SET "approvedHashVersion"=1');
  const defaultAt = dataSchema.indexOf('ALTER COLUMN "reviewHashVersion" SET DEFAULT 2');
  assert.ok(addAt >= 0 && addAt < legacyAt && legacyAt < approvedVersionAt && approvedVersionAt < defaultAt);
  assert.match(dataSchema, /CHECK \("reviewHashVersion" IN \(1,2\)\)/);
  assert.match(dataSchema, /status"='APPROVED' AND "reviewHashVersion"=1 AND "approvedHashVersion" IS NULL/);
  assert.doesNotMatch(dataSchema, /SET "approvedHashVersion"=CASE/);
  assert.match(dataSchema, /status"='APPROVED' AND "approvedHashVersion" IS NOT NULL[\s\S]*approvedHashVersion"="reviewHashVersion/);
  assert.match(dataSchema, /approvedHashVersion" IS NULL[\s\S]*reviewHashVersion"=1[\s\S]*approvedHashVersion":=1/);
  assert.match(baseSchema, /"reviewHashVersion" SMALLINT NOT NULL DEFAULT 2/);
  assert.match(baseSchema, /CreditApprovalEvent[\s\S]*"reviewHashVersion" SMALLINT NOT NULL DEFAULT 1/);
  assert.match(baseSchema, /previous_hash_version[\s\S]*"reviewHashVersion"/);
  assert.match(baseSchema, /CREDIT_APPROVAL_DATA_CHANGED[\s\S]*THEN 2/);
  assert.match(dataSchema, /"requestedHashVersion" SMALLINT NOT NULL DEFAULT 1/);
  assert.match(dataSchema, /"resultingHashVersion" SMALLINT NOT NULL DEFAULT 2/);
  const serviceSource = readFileSync(new URL("../lib/credit-approval.ts", import.meta.url), "utf8");
  assert.match(serviceSource, /"approvedHashVersion" = "reviewHashVersion"/);
  assert.match(serviceSource, /"callRecordingId", "reviewHashVersion"\)[\s\S]*approvalReason, reviewHashVersion/);
});

test("la bitácora exige snapshots exactos, catálogo cuando cambia referencia e inmutabilidad total", () => {
  const schema = creditApprovalDataSchemaStatements.join("\n");
  assert.match(schema, /COUNT\(\*\)=6 FROM jsonb_object_keys\(value\)/);
  assert.match(schema, /referenciaEquipo[\s\S]*"catalogSnapshot" IS NOT NULL/);
  assert.match(schema, /referenciaEquipo[\s\S]*"catalogSnapshot" IS NULL/);
  assert.match(schema, /BEFORE UPDATE OR DELETE/);
  assert.match(schema, /BEFORE TRUNCATE/);
});

test("documentos posteriores resuelven contacto, ubicación y referencia desde el contrato congelado", () => {
  const contractual = loadApprovalModule("lib/credit-contract-data.ts", {
    "@/lib/credit-amortization-contract": seals,
    "@/lib/credit-approval-data-core": core,
  });
  const fixture = createReissueFixture();
  fixture.credit.contratoSnapshot.cliente = {
    correo: "snapshot@example.invalid",
    telefono: "3000000001",
    departamento: "TOLIMA",
    ciudad: "Ibagué",
    direccion: "CALLE DE PRUEBA 1",
  };
  Object.assign(fixture.credit, {
    clienteCorreo: "operativo@example.invalid",
    clienteTelefono: "3009999999",
    clienteDepartamento: "ANTIOQUIA",
    clienteCiudad: "Medellín",
    clienteDireccion: "DIRECCIÓN OPERATIVA",
    referenciaEquipo: "REFERENCIA OPERATIVA",
  });
  const resolved = contractual.withContractualCreditData(fixture.credit);
  assert.equal(resolved.clienteCorreo, fixture.seal.snapshot.clienteCorreo);
  assert.equal(resolved.clienteTelefono, fixture.seal.snapshot.clienteTelefono);
  assert.equal(resolved.clienteDepartamento, "TOLIMA");
  assert.equal(resolved.clienteCiudad, "Ibagué");
  assert.equal(resolved.clienteDireccion, fixture.seal.snapshot.clienteDireccion);
  assert.equal(resolved.referenciaEquipo, fixture.seal.snapshot.referenciaEquipo);
  assert.equal(fixture.credit.clienteCorreo, "operativo@example.invalid");

  const legacy = contractual.withContractualCreditData({
    contratoSnapshot: { cliente: {}, equipo: { marca: "IPHONE", modelo: "IPHONE 13 128GB" }, financiero: {} },
    equipoMarca: "IPHONE",
    equipoModelo: "IPHONE 13 128GB",
    referenciaEquipo: "REFERENCIA OPERATIVA",
  });
  assert.equal(legacy.referenciaEquipo, "IPHONE 13 128GB");

  const documents = readFileSync(new URL("../app/api/creditos/[id]/documentos/route.ts", import.meta.url), "utf8");
  assert.match(documents, /const credito = withContractualCreditData\(storedCredit\)/);
});
