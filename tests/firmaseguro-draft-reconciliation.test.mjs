import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { isFirmaSeguroFailedStatus, isFirmaSeguroSuccessfulStatus } from "../lib/firmaseguro-status.ts";

const source = await readFile(new URL("../lib/firmaseguro-draft-reconciliation.ts", import.meta.url), "utf8");
const executable = stripTypeScriptTypes(source
  .replace(/^import "server-only";\s*/m, "")
  .replace(/^import[\s\S]*?from "[^"\n]+";\s*/gm, "")
  .replace(/^export /gm, ""));
const dispatchId = "ac299dfe-2280-44a8-9f55-f704285dc941";
const processUuid = "b186323b-0a08-4d40-9c78-6ec32a7e219b";
const otherUuid = "c76a9ce1-d0d3-428e-abce-af45d8f8c153";
const originalPdf = Buffer.from("%PDF-1.7\nReserved immutable contract\n%%EOF");
const documentHash = createHash("sha256").update(originalPdf).digest("hex");
const input = { dispatchId, processUuid, actor: { id: 7, nombre: "Analista" } };
const compactProcessUuid = processUuid.replaceAll("-", "");

class DraftDispatchError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fixture(overrides = {}) {
  const calls = [];
  const row = {
    id: dispatchId,
    status: "UNCERTAIN",
    processUuid: null,
    draftFolio: "FP-RESERVED",
    frozenCredit: { clienteDocumento: "1234567890" },
    documentHash,
    ...overrides.row,
  };
  const status = overrides.status ?? { uuid: processUuid, status: "CREATED" };
  const signatures = overrides.signatures ?? {};
  const documents = overrides.documents ?? {};
  const providerGet = (category, payload) => async (...args) => {
    calls.push({ category, args });
    if (payload instanceof Error) throw payload;
    return payload;
  };
  const loaded = runInNewContext(executable + "\n({ verifyDraftDispatchReconciliation, reconcileDraftDispatchFromProvider });", {
    Buffer, createHash, setTimeout, clearTimeout, DraftDispatchError,
    isFirmaSeguroFailedStatus, isFirmaSeguroSuccessfulStatus,
    getDraftDispatch: async (id) => {
      calls.push({ category: "ledger_read", id });
      return overrides.missingRow ? null : row;
    },
    firmaSeguroSignIn: async () => {
      calls.push({ category: "auth" });
      return { token: "private-auth-token" };
    },
    firmaSeguroGetProcessStatus: providerGet("process_status", status),
    firmaSeguroGetSignaturesStatus: providerGet("signatures", signatures),
    firmaSeguroGetDocumentsByUuid: providerGet("documents", documents),
    recordVerifiedDraftDispatchReceipt: async (receipt) => {
      calls.push({ category: "receipt_write", receipt });
      return receipt;
    },
    finalizeDraftDispatch: async (id) => {
      calls.push({ category: "finalize", id });
      return { ...row, processUuid, status: "AWAITING_SIGNATURE" };
    },
  });
  return { ...loaded, calls };
}

function hasCode(code) {
  return (error) => error instanceof DraftDispatchError
    && error.code === `DRAFT_DISPATCH_RECONCILIATION_${code}`;
}

test("dry run verifica la referencia remota y conserva solo descriptores de evidencia", async () => {
  const f = fixture({
    status: { data: { process: {
      uuid: processUuid, id: 42, status: "CREATED",
      tags: [{ reissue: dispatchId }, { credito: "FP-RESERVED" }, { cedula: "1234567890" }],
      signer: { uuid: otherUuid, email: "private-customer@example.test" },
    } } },
    documents: { document: { uuid: otherUuid, base64_string: originalPdf.toString("base64") } },
  });
  const verified = await f.verifyDraftDispatchReconciliation(input);
  assert.equal(verified.evidence.kind, "provider_tag");
  assert.equal(verified.evidence.folioVerified, true);
  assert.equal(verified.evidence.documentVerified, true);
  assert.equal(verified.evidence.responseHashes.length, 3);
  assert.equal(verified.processUuid, processUuid);
  assert.equal(verified.dispatchId, dispatchId);
  assert.deepEqual(f.calls.map((call) => call.category), ["ledger_read", "auth", "process_status", "signatures", "documents"]);
  const serialized = JSON.stringify(verified);
  for (const privateValue of ["private-auth-token", "private-customer@example.test", "1234567890", originalPdf.toString("base64")]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("aplica únicamente receipt y finalize después de verificar un tag auténtico", async () => {
  const f = fixture({ signatures: { processUuid, tags: [{ key: "reissue", value: dispatchId }] } });
  const result = await f.reconcileDraftDispatchFromProvider(input);
  assert.equal(result.status, "AWAITING_SIGNATURE");
  assert.deepEqual(f.calls.map((call) => call.category), ["ledger_read", "auth", "process_status", "signatures", "documents", "receipt_write", "finalize"]);
  assert.equal(f.calls[5].receipt.actor.id, 7);
  assert.equal(f.calls[6].id, dispatchId);
});

test("sin tags exige hash byte por byte del PDF original, no un PDF firmado distinto", async () => {
  const good = fixture({ documents: { data: { base64String: originalPdf.toString("base64") } } });
  assert.equal((await good.verifyDraftDispatchReconciliation(input)).evidence.kind, "original_pdf_sha256");
  const signedPdf = Buffer.concat([originalPdf, Buffer.from("\nSigned revision")]);
  const different = fixture({ documents: { pdfBase64: signedPdf.toString("base64") } });
  await assert.rejects(different.verifyDraftDispatchReconciliation(input), hasCode("EVIDENCE_INSUFFICIENT"));
});

test("rechaza tag de otra operación aunque devuelva el PDF original exacto", async () => {
  const f = fixture({
    status: { uuid: processUuid, tags: [{ reissue: otherUuid }] },
    documents: { pdfBase64: originalPdf.toString("base64") },
  });
  await assert.rejects(f.reconcileDraftDispatchFromProvider(input), hasCode("CONFLICT"));
  assert.equal(f.calls.some((call) => ["receipt_write", "finalize"].includes(call.category)), false);
});

test("rechaza correlaciones múltiples o folio y cédula distintos", async () => {
  for (const tags of [
    [{ reissue: dispatchId }, { reissue: otherUuid }],
    [{ reissue: dispatchId }, { credito: "FP-OTHER" }],
    [{ reissue: dispatchId }, { cedula: "9999999999" }],
  ]) {
    const f = fixture({ status: { uuid: processUuid, tags } });
    await assert.rejects(f.verifyDraftDispatchReconciliation(input), hasCode("CONFLICT"));
  }
});

test("rechaza UUID del proceso distinto o múltiples procesos remotos", async () => {
  for (const status of [
    { uuid: otherUuid, tags: [{ reissue: dispatchId }] },
    { process: { uuid: processUuid }, data: { processUuid: otherUuid }, tags: [{ reissue: dispatchId }] },
  ]) {
    const f = fixture({ status });
    await assert.rejects(f.verifyDraftDispatchReconciliation(input), hasCode("UUID_MISMATCH"));
  }
});

test("acepta el identificador hexadecimal de 32 caracteres del proveedor sin añadir guiones", async () => {
  for (const identityKey of ["uuid", "id", "processId", "processUuid"]) {
    const f = fixture({ status: { data: { process: {
      [identityKey]: compactProcessUuid, status: "CREATED", tags: [{ reissue: dispatchId }],
    } } } });
    const verified = await f.verifyDraftDispatchReconciliation({ ...input, processUuid: compactProcessUuid });
    assert.equal(verified.processUuid, compactProcessUuid);
    assert.equal(verified.evidence.kind, "provider_tag");
    const providerCalls = f.calls.filter((call) => ["process_status", "signatures", "documents"].includes(call.category));
    assert.equal(providerCalls.length, 3);
    assert.ok(providerCalls.every((call) => call.args.includes(compactProcessUuid)));
  }
});

test("identificadores remotos compactos contradictorios impiden recuperar otro proceso", async () => {
  for (const identityKey of ["id", "processId"]) {
    const f = fixture({ status: { data: { process: {
      uuid: compactProcessUuid, [identityKey]: otherUuid.replaceAll("-", ""),
      status: "CREATED", tags: [{ reissue: dispatchId }],
    } } } });
    await assert.rejects(f.reconcileDraftDispatchFromProvider({ ...input, processUuid: compactProcessUuid }), hasCode("UUID_MISMATCH"));
    assert.equal(f.calls.some((call) => ["receipt_write", "finalize"].includes(call.category)), false);
  }
});

test("lee el estado español del proceso con el formato auténtico del proveedor", async () => {
  for (const status of ["Creado", "En proceso", "Enviado"]) {
    const f = fixture({
      status: { processes: [{ uuid: compactProcessUuid, status, date_created: "2026-10-04T17:37:36Z" }] },
      signatures: { signatures: [{ id: 42, status: "Enviado" }], status_process: status, uuid: compactProcessUuid },
      documents: { documents: [null], status, uuid: compactProcessUuid },
    });
    // Real GET responses have no correlation tag/PDF: still fail closed.
    await assert.rejects(f.verifyDraftDispatchReconciliation({ ...input, processUuid: compactProcessUuid }), hasCode("EVIDENCE_INSUFFICIENT"));
    const withOriginal = fixture({
      status: { processes: [{ uuid: compactProcessUuid, status }] },
      documents: { originalPdfBase64: originalPdf.toString("base64") },
    });
    const verified = await withOriginal.verifyDraftDispatchReconciliation({ ...input, processUuid: compactProcessUuid });
    assert.equal(verified.providerStatus, status.toUpperCase().replaceAll(" ", "_"));
  }
  const rejected = fixture({ status: { uuid: compactProcessUuid, status_process: "Declinado", tags: [{ reissue: dispatchId }] } });
  assert.equal((await rejected.verifyDraftDispatchReconciliation({ ...input, processUuid: compactProcessUuid })).providerStatus, "DECLINADO");
});

test("solo el proceso admite formato compacto y la CLI conserva la misma restricción", async () => {
  const cli = await readFile(new URL("../scripts/reconcile-firmaseguro-draft.mjs", import.meta.url), "utf8");
  const validation = cli.slice(cli.indexOf("const draftId = Number("), cli.indexOf("const require = createRequire("));
  const validateCli = (dispatch, process) => runInNewContext(validation, { options: {
    "--draft-id": "1", "--actor-id": "7", "--dispatch-id": dispatch, "--process-uuid": process,
  } });
  assert.doesNotThrow(() => validateCli(dispatchId, processUuid));
  assert.doesNotThrow(() => validateCli(dispatchId, compactProcessUuid));
  for (const candidate of [
    { dispatchId: dispatchId.replaceAll("-", ""), processUuid: compactProcessUuid },
    { dispatchId, processUuid: compactProcessUuid.slice(1) },
    { dispatchId, processUuid: "g" + compactProcessUuid.slice(1) },
    { dispatchId, processUuid: `${compactProcessUuid}/other` },
  ]) {
    const f = fixture();
    await assert.rejects(f.verifyDraftDispatchReconciliation({ ...input, ...candidate }), hasCode("INVALID"));
    assert.equal(f.calls.length, 0);
    assert.throws(() => validateCli(candidate.dispatchId, candidate.processUuid), /identificadores válidos/);
  }
});

test("no sigue URLs ni acepta referencias suministradas en el input como evidencia", async () => {
  const f = fixture({ documents: { url: "http://169.254.169.254/private.pdf" } });
  await assert.rejects(f.verifyDraftDispatchReconciliation({
    ...input, tags: [{ reissue: dispatchId }], documentHash,
  }), hasCode("EVIDENCE_INSUFFICIENT"));
  assert.deepEqual(f.calls.filter((call) => ["process_status", "signatures", "documents"].includes(call.category)).map((call) => call.category), ["process_status", "signatures", "documents"]);
});

test("estado de proveedor inaccesible no se sustituye por un tag de otro endpoint", async () => {
  const f = fixture({ status: new Error("network unavailable"), signatures: { tags: [{ reissue: dispatchId }] } });
  await assert.rejects(f.reconcileDraftDispatchFromProvider(input), hasCode("PROVIDER_UNAVAILABLE"));
  assert.equal(f.calls.some((call) => ["receipt_write", "finalize"].includes(call.category)), false);
});

test("no concilia estados previos al envío ni actores nulos o UUID ya asociado distinto", async () => {
  const missing = fixture({ missingRow: true });
  await assert.rejects(missing.verifyDraftDispatchReconciliation(input), (error) => hasCode("NOT_FOUND")(error) && error.status === 404);
  const noActor = fixture();
  await assert.rejects(noActor.verifyDraftDispatchReconciliation({ ...input, actor: null }), (error) => hasCode("INVALID")(error) && error.status === 400);
  for (const status of ["PREPARING", "FAILED_SAFE"]) {
    const f = fixture({ row: { status } });
    await assert.rejects(f.verifyDraftDispatchReconciliation(input), hasCode("STATE"));
    assert.deepEqual(f.calls.map((call) => call.category), ["ledger_read"]);
  }
  const conflict = fixture({ row: { processUuid: otherUuid } });
  await assert.rejects(conflict.verifyDraftDispatchReconciliation(input), hasCode("UUID_MISMATCH"));
});

test("preserva PROCESS_REJECTED y DECLINADA como fallo real en la evidencia verificada", async () => {
  for (const providerStatus of ["PROCESS_REJECTED", "DECLINADA"]) {
    const f = fixture({ status: { uuid: processUuid, status: providerStatus, tags: [{ reissue: dispatchId }] } });
    const verified = await f.verifyDraftDispatchReconciliation(input);
    assert.equal(verified.providerStatus, providerStatus);
    assert.equal(isFirmaSeguroFailedStatus(verified.providerStatus), true);
  }
});

test("SUCCESS del envelope no oculta REJECTED dentro del proceso", async () => {
  const f = fixture({ status: { status: "SUCCESS", data: { process: {
    uuid: processUuid, status: "REJECTED", tags: [{ reissue: dispatchId }],
  } } } });
  assert.equal((await f.verifyDraftDispatchReconciliation(input)).providerStatus, "REJECTED");
});

test("estados reales contradictorios priorizan fallo y no convierten desconocidos en CREATED", async () => {
  const failed = fixture({ status: { process: {
    uuid: processUuid, status: "PENDING", processStatus: "PROCESS_REJECTED", tags: [{ reissue: dispatchId }],
  } } });
  assert.equal((await failed.verifyDraftDispatchReconciliation(input)).providerStatus, "PROCESS_REJECTED");
  for (const state of ["UNKNOWN_NEW_STATE", "NOT_SIGNED", 7, null, ""]) {
    const unknown = fixture({ status: { status: "SUCCESS", data: { process: {
      uuid: processUuid, status: state, tags: [{ reissue: dispatchId }],
    } } } });
    await assert.rejects(unknown.reconcileDraftDispatchFromProvider(input), hasCode("STATUS_UNSUPPORTED"));
    assert.equal(unknown.calls.some((call) => ["receipt_write", "finalize"].includes(call.category)), false);
  }
  const missing = fixture({ status: { uuid: processUuid, tags: [{ reissue: dispatchId }] } });
  await assert.rejects(missing.reconcileDraftDispatchFromProvider(input), hasCode("STATUS_MISSING"));
  const envelopeOnly = fixture({ status: { status: "SUCCESS", data: { process: {
    uuid: processUuid, tags: [{ reissue: dispatchId }],
  } } } });
  await assert.rejects(envelopeOnly.reconcileDraftDispatchFromProvider(input), hasCode("STATUS_MISSING"));
});
