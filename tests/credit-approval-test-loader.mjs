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
const colombiaDate = loadApprovalModule("lib/colombia-date.ts");
const creditFactory = loadApprovalModule("lib/credit-factory.ts", { "@/lib/colombia-date": colombiaDate });
export const callState = loadApprovalModule("lib/credit-approval-call-state.ts");
const reissueState = loadApprovalModule("lib/credit-approval-reissue-state.ts");
export const approvalErrors = loadApprovalModule("lib/credit-approval-errors.ts");
export const approvalActors = loadApprovalModule("lib/credit-approval-actor.ts");
const noveltyCore = loadApprovalModule("lib/credit-approval-novelty-core.ts", {
  "@/lib/credit-approval-errors": approvalErrors, "@/lib/credit-approval-actor": approvalActors,
});
export const noveltyState = loadApprovalModule("lib/credit-approval-novelty-state.ts", {
  "@/lib/credit-approval-errors": approvalErrors, "@/lib/credit-approval-novelty-core": noveltyCore,
});
export const service = loadApprovalModule("lib/credit-approval.ts", {
  "@/lib/credit-factory": creditFactory,
  "@/lib/credit-approval-call-state": callState,
  "@/lib/credit-approval-errors": approvalErrors,
  "@/lib/credit-approval-actor": approvalActors,
  "@/lib/credit-approval-novelty-state": noveltyState,
  "@/lib/credit-approval-policy": policy,
  "@/lib/credit-approval-reissue-state": reissueState,
  "@/lib/document-blacklist-core": documentCore,
  "@/lib/ally-payments-core": paymentsCore,
  "@/lib/firmaseguro": { isFirmaSeguroCompletedStatus: (status) => status === "COMPLETED" },
});
export const roles = loadApprovalModule("lib/roles.ts");
export const plain = (value) => JSON.parse(JSON.stringify(value));
export const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yFusAAAAASUVORK5CYII=";
export const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF").toString("base64");

export const CALL_RECORDING_ID = "00000000-0000-4000-8000-000000000081";
export function readyCallRecording(detail) {
  return { id: CALL_RECORDING_ID, revision: detail.review.revision, reviewHash: detail.review.reviewHash,
    fileName: "llamada-sintetica.wav", mimeType: "audio/wav", sizeBytes: 100, sha256: "b".repeat(64),
    createdAt: "2026-09-11T15:00:00.000Z", actorName: "Analista de prueba", href: `/api/aprobaciones/${detail.id}/grabaciones/${CALL_RECORDING_ID}` };
}
export function completeApprovalDetail(fixture, reissue, novelties) {
  const { credit, review, assessment, document } = fixture;
  const before = service.buildCreditApprovalDetail(credit, review, assessment, document, reissue, novelties);
  return service.buildCreditApprovalDetail(credit, review, assessment, document, reissue, novelties,
    { available: true, recording: before.review.status === "APPROVED" && !review?.callRecordingId ? null : readyCallRecording(before) });
}

export function approvalFixture() {
  const credit = {
    id: 81, folio: "FNS-TEST-81", clienteNombre: "Cliente de prueba", clienteDocumento: "100000001",
    clienteCorreo: "cliente@example.test", clienteTelefono: "3001234567",
    plazoMeses: 12, frecuenciaPago: "QUINCENAL", valorCuota: 98765.43,
    cuotaComercialGuardada: null, fechaPrimerPago: new Date("2026-10-01T00:00:00.000Z"),
    fechaCredito: new Date("2026-09-10T15:00:00Z"), createdAt: new Date("2026-09-10T15:00:00Z"),
    estado: "ACTIVO", aliadoId: 5, aliadoNombre: "Aliado de prueba", aliadoCodigo: "ALIADO_TEST",
    valorEquipoTotal: 1000000, cuotaInicial: 200000, saldoBaseFinanciado: 800000,
    contratoSnapshot: { equipo: { plataforma: "IPHONE" }, financiero: { dataCredito: { assessmentId: "assessment-81", resolvedMaxFinancedAmount: 900000 } } },
    imei: "000000000000001", referenciaEquipo: "APPLE EQUIPO DE PRUEBA 256GB", equipoMarca: "Apple", equipoModelo: "Equipo de prueba", required: true, paid: false,
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
  const state = { ...approvalFixture(), policy: true, activatedAt: new Date("2026-09-09T00:00:00Z"), events: [], noveltyEvents: [], sharedAccess: true, queries: [], writes: [], ...overrides };
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      state.queries.push({ sql, params });
      if (/^SELECT "id" FROM "CreditApprovalPolicy"/.test(sql)) return state.policy ? [{ id: 1 }] : [];
      if (sql.startsWith('SELECT credit."id" FROM "Credito" credit')) {
        assert.match(sql, /credit\."createdAt">=policy\."activatedAt"/);
        assert.match(sql, /IMPORTACION_MASIVA/);
        assert.match(sql, /LiquidacionAliadoCredito/);
        const credit = state.credit;
        const inScope = credit && state.policy && new Date(credit.createdAt) >= state.activatedAt &&
          credit.aliadoCodigo !== "FINSERPAY" && !credit.paid &&
          !["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(credit.estado.trim().toUpperCase()) &&
          !(credit.equalityService === "IMPORTACION_MASIVA" && credit.contratoSnapshot?.origen?.tipo === "IMPORTACION_MASIVA");
        return inScope ? [{ id: credit.id }] : [];
      }
      if (sql.includes('FROM "CreditApprovalCallRecording"')) {
        if (state.callRecordingError) throw new Error("Audio schema unavailable");
        if (state.callRecording === null) return [];
        const recording = state.callRecording ?? { id: CALL_RECORDING_ID, revision: params[1], reviewHash: params[2],
          fileName: "llamada-sintetica.wav", mimeType: "audio/wav", sizeBytes: 100, sha256: "b".repeat(64),
          createdAt: new Date("2026-09-11T15:00:00Z"), actorName: "Analista de prueba" };
        return (params[3] ? recording.id === params[3] : recording.revision === params[1] && recording.reviewHash === params[2]) ? [recording] : [];
      }
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
      if (sql.includes('FROM "CreditApprovalReissue"')) return state.reissue ? [state.reissue] : [];
      if (sql.includes('FROM "CreditApprovalSharedGrant"')) return state.sharedAccess ? [{ id: params[1] }] : [];
      if (sql.includes('FROM "CreditApprovalNoveltyItem"')) return state.noveltyItems || [];
      if (sql.includes('FROM "CreditApprovalNovelty"')) {
        if (sql.includes('FOR UPDATE') && state.novelty?.status === "RESOLVED") return [];
        return state.novelty ? [state.novelty] : [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...params) {
      state.writes.push({ sql, params });
      if (sql.includes('INSERT INTO "CreditApprovalReview"')) {
        state.review ??= { status: "PENDING", revision: 1, approvedRevision: null, approvedAt: null, approvedByName: null, reviewHash: null };
      } else if (sql.includes('UPDATE "CreditApprovalReview"')) {
        assert.equal(params[0], state.credit.id);
        assert.equal(params[4], state.review.revision);
        Object.assign(state.review, { status: "APPROVED", approvedRevision: state.review.revision, approvedAt: new Date(), approvedByUserId: params[1], approvedByName: params[2], reviewHash: params[3], approvedByKind: params[5], approvedByGrantId: params[6], approvedBySessionId: params[7], callRecordingId: params[8] });
      } else if (sql.includes('INSERT INTO "CreditApprovalEvent"')) {
        state.events.push(params);
      } else if (sql.includes('UPDATE "CreditApprovalNovelty"')) {
        state.novelty.status = "RESOLVED"; state.novelty.version += 1;
      } else if (sql.includes('INSERT INTO "CreditApprovalNoveltyEvent"')) {
        state.noveltyEvents.push(params);
      } else throw new Error(`Unexpected write: ${sql}`);
      return 1;
    },
  };
  return { db, state };
}
