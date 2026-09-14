import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { loadApprovalModule, plain } from "./credit-approval-test-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const policy = await jiti.import("../lib/datacredito/policy.ts");
const legacy = {
  calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66, fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};
const bands = [
  ...["ANDROID", "IPHONE"].flatMap((platform) => [
    { id: `${platform}-no-info`, platform, scoreMin: -1, scoreMax: -1, decision: "APROBADO", initialPaymentPercentage: 30, suretyPercentage: 75, maxFinancedAmount: 1000000, installmentCount: 16, maxInstallmentAmount: platform === "IPHONE" ? 160000 : null },
    { id: `${platform}-all`, platform, scoreMin: 0, scoreMax: 950, decision: "APROBADO", initialPaymentPercentage: 20, suretyPercentage: 75, maxFinancedAmount: 3500000, installmentCount: 40, maxInstallmentAmount: platform === "IPHONE" ? 160000 : null },
  ]),
];
const priorityRules = {
  telcoDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2000000, IPHONE: 2000000 } },
  totalDelinquency: { enabled: true, rejectAboveCopByPlatform: { ANDROID: 2000000, IPHONE: 2000000 } },
};
class StorageError extends Error {}
class ConflictError extends Error {}

test("catálogo entrega defaults V2/29.24 pero conserva revisión explícita V1/29.66", async () => {
  const queries = [];
  const original = { bands, priorityRules, financialSettings: legacy };
  const service = loadApprovalModule("lib/datacredito/admin-storage.ts", {
    "@/lib/prisma": { default: {
      async $queryRawUnsafe(sql) {
        queries.push(sql);
        return sql.includes('FROM "DataCreditoPolicyProfile" profile') ? [{
          id: "profile", name: "Historical", description: null, active: true, version: 7,
          revisionId: "revision", policy: original, createdAt: new Date("2026-08-01"),
          updatedAt: new Date("2026-08-01"), revisionCreatedAt: new Date("2026-08-01"), assignedAlliesCount: 1n,
        }] : [];
      },
    } },
    "@/lib/credit-settings": { getCreditSettings: async () => legacy },
    "@/lib/datacredito/storage": { ensureDataCreditoSchema: async () => {}, DEFAULT_DATACREDITO_POLICY_PROFILE_ID: "general" },
    "@/lib/datacredito/database-errors": {},
    "@/lib/datacredito/policy": policy,
    "@/lib/datacredito/secure-record": {},
  });
  const catalog = await service.listDataCreditoPolicyCatalog();
  assert.equal(catalog.financialDefaults.calculoVersion, "ARES_FRANCES_V2");
  assert.equal(catalog.financialDefaults.tasaInteresEa, 29.24);
  assert.deepEqual(plain(catalog.profiles[0].financialSettings), legacy);
  assert.deepEqual(original.financialSettings, legacy);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => !/\b(?:UPDATE|INSERT|DELETE)\b/.test(query)));
});

test("PATCH usa V2 solo cuando falta configuración explícita; no reinterpreta V1 histórica", async () => {
  let assignedFinancialSettings = null;
  const written = [];
  const route = loadApprovalModule("app/api/creditos/datacredito/politica/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => ({ id: 7, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSER", aliadoId: 1 }) },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true, configured: true }) },
    "@/lib/datacredito/policy-access": {},
    "@/lib/datacredito/policy": policy,
    "@/lib/credit-settings": { getCreditSettings: async () => legacy },
    "@/lib/datacredito/storage": {
      getAssignedDataCreditoPolicy: async () => ({ kind: "READY", policy: { profileId: "profile", revisionId: "revision", version: 7, financialSettings: assignedFinancialSettings, priorityRules } }),
      createDataCreditoPolicyVersion: async (input) => { written.push(plain(input)); return { ...input, version: 8 }; },
      isDataCreditoAuditConfigured: () => true,
      DataCreditoStorageConfigurationError: StorageError, DataCreditoPolicyConflictError: ConflictError,
    },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/seller-auth": {},
    "@/lib/solicitud-operation-access": {},
  });
  const request = () => new Request("https://finserpay.test/api/creditos/datacredito/politica", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 7, bands, priorityRules }),
  });
  assert.equal((await route.PATCH(request())).status, 200);
  assert.equal(written[0].financialSettings.calculoVersion, "ARES_FRANCES_V2");
  assert.equal(written[0].financialSettings.tasaInteresEa, 29.24);
  assignedFinancialSettings = legacy;
  assert.equal((await route.PATCH(request())).status, 200);
  assert.deepEqual(written[1].financialSettings, legacy);
});
