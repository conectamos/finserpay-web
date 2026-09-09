import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";

export function loadApprovalModule(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    exports: loadedModule.exports,
    module: loadedModule,
    require: (name) => {
      if (name === "node:crypto") return crypto;
      if (name === "server-only") return {};
      assert.ok(name in dependencies, `Unexpected dependency in ${path}: ${name}`);
      return dependencies[name];
    },
    Buffer, Uint8Array, console, URL, URLSearchParams, Date, Request, Response, TextDecoder,
  }, { filename: path });
  return loadedModule.exports;
}

const importFlags = loadApprovalModule("lib/credit-import-flags.ts");
const policy = loadApprovalModule("lib/credit-approval-policy.ts", { "./credit-import-flags": importFlags });
const documentCore = loadApprovalModule("lib/document-blacklist-core.ts");
const paymentsCore = loadApprovalModule("lib/ally-payments-core.ts");
export const service = loadApprovalModule("lib/credit-approval.ts", {
  "@/lib/credit-approval-policy": policy,
  "@/lib/document-blacklist-core": documentCore,
  "@/lib/ally-payments-core": paymentsCore,
  "@/lib/firmaseguro": { isFirmaSeguroCompletedStatus: (status) => status === "COMPLETED" },
});
export const roles = loadApprovalModule("lib/roles.ts");
export const plain = (value) => JSON.parse(JSON.stringify(value));
export const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yFusAAAAASUVORK5CYII=";
export const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF").toString("base64");

export function approvalFixture() {
  const credit = {
    id: 81, folio: "FNS-TEST-81", clienteNombre: "Cliente de prueba", clienteDocumento: "100000001",
    fechaCredito: new Date("2026-09-10T15:00:00Z"), createdAt: new Date("2026-09-10T15:00:00Z"),
    estado: "ACTIVO", aliadoId: 5, aliadoNombre: "Aliado de prueba", aliadoCodigo: "ALIADO_TEST",
    valorEquipoTotal: 1000000, cuotaInicial: 200000, saldoBaseFinanciado: 800000,
    contratoSnapshot: { equipo: { plataforma: "IPHONE" }, financiero: { dataCredito: { assessmentId: "assessment-81", resolvedMaxFinancedAmount: 900000 } } },
    imei: "000000000000001", equipoMarca: "Apple", equipoModelo: "Equipo de prueba", required: true, paid: false,
    ...Object.fromEntries(service.APPROVAL_EVIDENCE.map(({ field }) => [field, png])),
  };
  const assessment = {
    id: "assessment-81", creditId: 81, consumedAt: new Date("2026-09-10T15:00:00Z"), retainedUntil: new Date("2099-01-01T00:00:00Z"),
    score: 750, offer: { initialPaymentPercentage: 15, maxFinancedAmount: 950000 }, status: "APROBADO",
  };
  const document = {
    id: 91, processUuid: "process-81", status: "COMPLETED", signedDocumentBase64: pdf,
    signedDocumentFileName: "credito-81.pdf", completedAt: new Date("2026-09-10T15:30:00Z"),
  };
  return { credit, review: null, assessment, document };
}

export function approvalDatabase(overrides = {}) {
  const state = { ...approvalFixture(), policy: true, events: [], queries: [], writes: [], ...overrides };
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      state.queries.push({ sql, params });
      if (/^SELECT "id" FROM "CreditApprovalPolicy"/.test(sql)) return state.policy ? [{ id: 1 }] : [];
      if (sql.includes('FROM "Credito" credit')) return state.credit ? [state.credit] : [];
      if (sql.includes('FROM "CreditApprovalReview"')) return state.review ? [state.review] : [];
      if (sql.includes('FROM "DataCreditoAssessment"')) {
        // These predicates are security requirements, not conveniences of the mock.
        assert.match(sql, /"creditId" = \$1/);
        assert.match(sql, /"consumedAt" IS NOT NULL/);
        assert.match(sql, /"retainedUntil" > CURRENT_TIMESTAMP/);
        const item = state.assessment;
        return item && item.creditId === params[0] && (!params[1] || item.id === params[1]) && item.consumedAt && item.retainedUntil > new Date() ? [item] : [];
      }
      if (sql.includes('FROM "FirmaSeguroProcess"')) return state.document ? [state.document] : [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...params) {
      state.writes.push({ sql, params });
      if (sql.includes('INSERT INTO "CreditApprovalReview"')) {
        state.review ??= { status: "PENDING", revision: 1, approvedRevision: null, approvedAt: null, approvedByName: null, reviewHash: null };
      } else if (sql.includes('UPDATE "CreditApprovalReview"')) {
        assert.equal(params[0], state.credit.id);
        assert.equal(params[4], state.review.revision);
        Object.assign(state.review, { status: "APPROVED", approvedRevision: state.review.revision, approvedAt: new Date(), approvedByName: params[2], reviewHash: params[3] });
      } else if (sql.includes('INSERT INTO "CreditApprovalEvent"')) {
        state.events.push(params);
      } else throw new Error(`Unexpected write: ${sql}`);
      return 1;
    },
  };
  return { db, state };
}
