import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  firmaSeguroCorrectionReviewKey, hasFirmaSeguroCorrectionViewChanges,
  pendingDraftSignatureMessage, readPendingDraftSignatureDispatch,
  resolveFirmaSeguroDraftForSubmission,
} from "../lib/firmaseguro-draft-submit.ts";

const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name) {
  let result;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(result, name); return result;
}
const handlerCode = initializer("handleFirmaSeguroStepReady");
const submitCode = initializer("submitFirmaSeguroDraft");
const readCode = initializer("readFirmaSeguroDispatchState");
const evaluate = (code, context) => runInNewContext(ts.transpileModule(`(${code})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const id = "00000000-0000-4000-8000-000000003433";
const pending = (changes = {}) => ({ id, status: "PREPARING", pending: true, createdAt: "2026-10-20T16:39:50Z",
  updatedAt: "2026-10-20T16:39:50Z", hasReceipt: false, hasProviderLocator: false, failureStage: null, canResume: true, ...changes });
const draft = () => ({ id: 3433, estado: "ABIERTO", payload: { clienteNombre: "CLIENTE SINTÉTICO", clienteDocumento: "1000000000",
  imei: "350000000003433", valorEquipoTotal: 2000000, cuotaInicial: 600000, plazoMeses: 24, fechaPrimerPago: "2026-11-02" } });

function fixture(options = {}) {
  const currentDraft = draft(); const reads = [], saves = [], sends = [], notices = [], applied = [];
  let signatureState = options.state === undefined ? pending() : options.state;
  const context = {
    Error, Object, String, Boolean, URLSearchParams,
    draftId: 3433, firmaSeguroRequestInFlightRef: { current: false }, firmaSeguroProcessSent: false,
    firmaSeguroSigningIdentityReady: true, firmaSeguroIdentityReadiness: { retry() {} },
    iphoneInstallmentLimitExceeded: false, veriffRequired: true, veriffApproved: true,
    contratoListo: true, firmaSeguroDocumentsReady: true, createClientMode: true, iphoneFactory: true,
    factoryDraftPayload: { ...currentDraft.payload, ...options.visible }, firmaSeguroCorrectionReviewKeyRef: { current: null },
    cancelPendingDraftAutosave() {},
    setNotice: value => notices.push(value),
    resolveFirmaSeguroDraftForSubmission, firmaSeguroCorrectionReviewKey, hasFirmaSeguroCorrectionViewChanges,
    pendingDraftSignatureMessage, readPendingDraftSignatureDispatch,
    sanitizeFirmaSeguroVisibleText: value => value,
    resolveFirmaSeguroProcessUiState: process => process?.completedAt ? "signed" : "waiting",
    formatFirmaSeguroProcessIssue: () => "Revisión requerida",
    readFirmaSeguroDispatchState: async selectedId => {
      reads.push(["status", selectedId, signatureState?.id || null]);
      if (options.statusFailure) return { ok: false, error: "Sin conexión al consultar el envío" };
      return { ok: true, draftId: options.statusDraftId || selectedId, signatureDispatch: signatureState };
    },
    requestJson: async url => {
      reads.push(["draft", url]);
      if (options.draftFailure) return { ok: false, data: { error: "Solicitud no disponible" } };
      return { ok: true, data: { ok: true, item: currentDraft } };
    },
    saveCurrentDraft: async step => {
      saves.push(step);
      if (options.saveRace) { signatureState = pending({ status: "UNCERTAIN", canResume: false }); throw Object.assign(new Error("Envío pendiente"), { code: "SOLICITUD_ENVIO_FIRMA_PENDIENTE" }); }
      return currentDraft.id;
    },
    submitFirmaSeguroDraft: async (selectedId, originalId) => {
      sends.push({ selectedId, originalId });
      if (options.submitFailure) {
        signatureState = pending({ status: "UNCERTAIN", canResume: false, ...options.failedSubmissionState });
        throw Object.assign(new Error("No se pudo confirmar el resultado del envío"), { code: options.submitFailure });
      }
      return { process: { processUuid: "same-provider-process", status: "PENDING" } };
    },
    applyDraftPayload: item => { applied.push(item); context.factoryDraftPayload = { ...item.payload }; },
  };
  for (const setter of new Set(handlerCode.match(/\bset[A-Z]\w+/g))) {
    if (!(setter in context)) context[setter] = () => {};
  }
  return { context, reads, saves, sends, notices, applied, run: evaluate(handlerCode, context), currentDraft,
    state: value => { signatureState = value; } };
}

test("sin editar datos, una preparación se retoma con el mismo UUID sin autosave ni nueva firma", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.reads.map(item => item[0]), ["status", "draft"], "el estado se consulta antes de leer el contrato que se revisará");
  assert.equal(f.saves.length, 0);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].selectedId, 3433); assert.equal(f.sends[0].originalId, id);
  assert.equal(f.context.firmaSeguroRequestInFlightRef.current, false);
});

test("envíos inciertos, en curso o preparados por otro usuario sólo muestran consulta, sin POST", async () => {
  for (const changes of [
    { status: "DISPATCHING", canResume: false }, { status: "UNCERTAIN", canResume: false },
    { canResume: false }, { hasReceipt: true, canResume: true }, { hasProviderLocator: true, canResume: true },
    { status: "UNCERTAIN", canResume: true },
  ]) {
    const f = fixture({ state: pending(changes) }); await f.run();
    assert.equal(f.saves.length, 0); assert.equal(f.sends.length, 0);
    assert.equal(f.notices.at(-1).tone, "amber");
    assert.doesNotMatch(f.notices.at(-1).text, /cambiados|modificad|Código:/i);
  }
});

test("datos visibles distintos exigen revisar el contrato preparado antes del envío original", async () => {
  const f = fixture({ visible: { valorEquipoTotal: 2100000 } });
  await f.run();
  assert.equal(f.sends.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.applied.length, 1);
  assert.match(f.notices.at(-1).text, /datos guardados.*Revísalos/);
  assert.equal(f.context.factoryDraftPayload.valorEquipoTotal, 2000000);
  await f.run();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].originalId, id); assert.equal(f.saves.length, 0);
});

test("un estado ilegible, otra solicitud o fallo de lectura nunca cae al guardado ni al envío", async () => {
  for (const options of [{ statusFailure: true }, { statusDraftId: 9999 }, { draftFailure: true },
    { state: {} }, { state: pending({ status: "UNKNOWN" }) }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.saves.length, 0); assert.equal(f.sends.length, 0);
    assert.equal(f.notices.at(-1).tone, "red");
  }
});

test("una reserva creada entre preflight y guardado muestra el pendiente y no crea otro contrato", async () => {
  const f = fixture({ state: null, saveRace: true }); await f.run();
  assert.equal(f.saves.length, 1); assert.equal(f.sends.length, 0);
  assert.equal(f.notices.at(-1).tone, "amber"); assert.match(f.notices.at(-1).text, /envío anterior.*confirmado/i);
});

test("un envío inicial incierto o sin persistir consulta el mismo intento y evita otro POST o guardado", async () => {
  for (const code of ["DRAFT_DISPATCH_UNCERTAIN", "DRAFT_DISPATCH_ACK_PERSISTENCE_FAILED", "DRAFT_DISPATCH_PERSISTENCE_FAILED"]) {
    const f = fixture({ state: null, submitFailure: code,
      failedSubmissionState: { hasReceipt: code === "DRAFT_DISPATCH_PERSISTENCE_FAILED", hasProviderLocator: true } });
    await f.run();
    assert.deepEqual(f.reads.map(item => item[0]), ["status", "draft", "status"], `${code}: consulta inmediata tras el fallo`);
    assert.deepEqual(f.reads.filter(item => item[0] === "status").map(item => item[2]), [null, id], "recupera el UUID reservado por el primer envío");
    assert.deepEqual(f.saves, [4]);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].originalId, undefined, "sólo se intentó el envío inicial");
    assert.equal(f.notices.at(-1).tone, "amber", code);
    assert.match(f.notices.at(-1).text, /envío anterior.*confirmado|confirmación pendiente de conciliar/i);
    assert.equal(f.context.firmaSeguroRequestInFlightRef.current, false);

    await f.run();
    assert.equal(f.sends.length, 1, "un nuevo clic no vuelve a contactar al proveedor");
    assert.deepEqual(f.saves, [4], "el intento pendiente tampoco vuelve a guardar el contrato");
    assert.equal(f.notices.at(-1).tone, "amber");
  }
});

test("sin reserva pendiente, los cambios reales se guardan y el envío normal conserva su flujo", async () => {
  const f = fixture({ state: null, visible: { clienteTelefono: "3001234567" } }); await f.run();
  assert.deepEqual(f.saves, [4]); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].originalId, undefined);
});

test("la llamada HTTP de reanudación sólo transporta la clave original, sin valores ni destinatario", async () => {
  const requests = [];
  const context = { Error, Object, JSON, resolvePersistedDraftStep: () => 4,
    requestJson: async (url, request) => { requests.push({ url, request }); return { ok: true, data: { ok: true, process: { processUuid: "same" } } }; },
    setFirmaSeguroIdentityReviewDraftId() {}, setFirmaSeguroDraftProcess() {}, setFirmaSeguroDispatchSnapshot() {}, setFirmaSeguroPendingDraftId() {},
  };
  await evaluate(submitCode, context)(3433, id);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, "/api/creditos/borradores/3433/firma-seguro");
  assert.equal(requests[0].request.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].request.body), { idempotencyKey: id });
});

test("la consulta de la reserva sólo lee el estado local y descarta respuestas de otro caso", async () => {
  const requests = [], snapshots = [];
  const context = { Error, Object, readPendingDraftSignatureDispatch,
    currentEquipmentDraftIdRef: { current: 3433 }, setFirmaSeguroDispatchSnapshot: item => snapshots.push(item),
    requestJson: async (url, request) => { requests.push({ url, request }); return { ok: true, data: { ok: true, draftId: 3433, signatureDispatch: pending() } }; },
  };
  const read = evaluate(readCode, context); await read(3433);
  assert.equal(requests[0].url, "/api/creditos/borradores/3433/estado-proceso");
  assert.equal(requests[0].request.method, "GET"); assert.equal(requests[0].request.body, undefined);
  assert.equal(snapshots[0].dispatch.id, id);
  context.currentEquipmentDraftIdRef.current = 4444;
  await assert.rejects(read(3433), /solicitud cambió/); assert.equal(snapshots.length, 1);
});

test("la pantalla sustituye Por enviar por el pendiente y ofrece consulta sin enviar automáticamente", () => {
  assert.match(source, /veriffApproved && !pendingFirmaSeguroDispatch \? <IdentitySignatureOverview/);
  assert.match(source, /aria-label="Estado del envío de firma"/);
  assert.match(source, /Continuar el mismo envío/);
  assert.match(source, /pendingFirmaSeguroDispatch && !pendingFirmaSeguroDispatch\.canResume \? refreshFirmaSeguroDraftProcess\(\) : handleFirmaSeguroStepReady\(\)/);
  assert.match(source, /setFirmaSeguroDispatchSnapshot\(\{ draftId: snapshot\.draftId, dispatch: snapshot\.signatureDispatch \|\| null \}\)/);
});
