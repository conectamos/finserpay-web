import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { hasAuditedCreditIdentityCorrection } from "../lib/credit-client-name.ts";
import {
  readAnalystDraftDataSnapshot,
  resolveAnalystDraftDataUpdate,
  readAnalystDraftFinancialSnapshot,
  readAnalystDraftEvidenceSnapshot,
  resolveAnalystDraftFinancialUpdate,
  resolveAnalystDraftEvidenceUpdate,
  hasPendingAnalystDraftEvidence,
  startVisibleDraftDataPolling,
} from "../lib/analyst-draft-data-sync.ts";

function payload(revision, values, fieldRevisions = {}) {
  return {
    analystDataRevision: revision,
    analystDataCorrection: { revision, fields: Object.keys(values), values, fieldRevisions },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("solo lee datos de cliente autorizados y revisiones enteras", () => {
  const result = readAnalystDraftDataSnapshot(12, payload(2, {
    clienteTelefono: "3000000001", valorEquipoTotal: "100", imei: "123456789012345",
    clienteDocumento: "11111111", clienteCorreo: 4,
  }, { clienteTelefono: 2, imei: 2 }));
  assert.deepEqual(result.values, { clienteTelefono: "3000000001" });
  assert.deepEqual(result.fieldRevisions, { clienteTelefono: 2 });
  assert.equal(readAnalystDraftDataSnapshot(12, payload(-1, {})).revision, 0);
  assert.deepEqual(readAnalystDraftDataSnapshot(12, {
    analystDataRevision: 2,
    analystDataCorrection: { revision: 1, fields: ["clienteTelefono"], values: { clienteTelefono: "viejo" } },
  }).values, {});
});

test("la actualización conserva el equipo, plan, evidencia y campos locales no corregidos", () => {
  const previous = readAnalystDraftDataSnapshot(12, {});
  const update = resolveAnalystDraftDataUpdate(previous, 12,
    payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 }));
  const local = { clienteTelefono: "3000000000", clienteCorreo: "asesor@example.test",
    valorEquipoTotal: "4200000", cuotaInicial: "1500000", plazoMeses: "40",
    imei: "123456789012345", fotoRemisionDataUrl: "evidencia-local" };
  assert.deepEqual({ ...local, ...update.values }, { ...local, clienteTelefono: "3000000001" });
  assert.equal(update.snapshot.revision, 1);
});

test("la misma revisión no vuelve a sobrescribir un dato que el asesor editó después", () => {
  const saved = payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 });
  const previous = readAnalystDraftDataSnapshot(12, saved);
  assert.equal(resolveAnalystDraftDataUpdate(previous, 12, saved), null);
});

test("descarta respuestas fuera de orden y de otra solicitud", () => {
  const previous = readAnalystDraftDataSnapshot(12, payload(3, { clienteTelefono: "3000000003" }));
  assert.equal(resolveAnalystDraftDataUpdate(previous, 12, payload(2, { clienteTelefono: "3000000002" })), null);
  assert.equal(resolveAnalystDraftDataUpdate(previous, 13, payload(4, { clienteTelefono: "3000000004" })), null);
});

test("una segunda corrección no repone campos ya reconocidos de la primera", () => {
  const previous = readAnalystDraftDataSnapshot(12,
    payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 }));
  const next = payload(2, { clienteTelefono: "3000000002", clienteCorreo: "corregido@example.test" },
    { clienteTelefono: 1, clienteCorreo: 2 });
  assert.deepEqual(resolveAnalystDraftDataUpdate(previous, 12, next).values,
    { clienteCorreo: "corregido@example.test" });
});

test("la revisión por campo reconoce un valor histórico restablecido por el analista", () => {
  const previous = readAnalystDraftDataSnapshot(12,
    payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 }));
  const update = resolveAnalystDraftDataUpdate(previous, 12,
    payload(2, { clienteTelefono: "3000000001" }, { clienteTelefono: 2 }));
  assert.deepEqual(update.values, { clienteTelefono: "3000000001" });
});

test("para marcadores previos sin revisión por campo aplica solamente valores modificados", () => {
  const previous = readAnalystDraftDataSnapshot(12, payload(1, { clienteTelefono: "3000000001" }));
  const next = payload(2, { clienteTelefono: "3000000001", clienteCorreo: "nuevo@example.test" });
  assert.deepEqual(resolveAnalystDraftDataUpdate(previous, 12, next).values,
    { clienteCorreo: "nuevo@example.test" });
});

const financialPayload = (revision, values, fieldRevisions = Object.fromEntries(Object.keys(values).map((key) => [key, revision]))) => ({
  analystFinancialRevision: revision,
  analystFinancialCorrection: { revision, fields: Object.keys(values), values, fieldRevisions },
});
const evidencePayload = (revision, values, fieldRevisions = Object.fromEntries(Object.keys(values).map((key) => [key, revision]))) => ({
  ...values, analystEvidenceRevision: revision,
  analystEvidenceCorrection: { revision, fields: Object.keys(values), fieldRevisions },
});

test("las condiciones corregidas conservan tipos y excluyen datos del cliente, equipo y fotos", () => {
  const previous = readAnalystDraftFinancialSnapshot(12, {});
  const update = resolveAnalystDraftFinancialUpdate(previous, 12, financialPayload(1, {
    valorEquipoTotal: "4000000", cuotaInicial: "1200000", plazoMeses: "40", cuotaComercial: 139800,
    clienteTelefono: "3000000000", imei: "350000000000001", fotoEntregaDataUrl: "foto",
  }));
  assert.deepEqual(update.values, { valorEquipoTotal: "4000000", cuotaInicial: "1200000",
    plazoMeses: "40", cuotaComercial: 139800 });
  const local = { clienteTelefono: "asesor", imei: "equipo", fotoEntregaDataUrl: "foto-local" };
  assert.deepEqual({ ...local, ...update.values }, { ...local, valorEquipoTotal: "4000000",
    cuotaInicial: "1200000", plazoMeses: "40", cuotaComercial: 139800 });
});

test("las revisiones financieras no reponen valores ya reconocidos y descartan respuestas antiguas o ajenas", () => {
  const previous = readAnalystDraftFinancialSnapshot(12, financialPayload(1,
    { valorEquipoTotal: "4000000", cuotaInicial: "1200000" }));
  const next = financialPayload(2, { valorEquipoTotal: "4000000", cuotaInicial: "1500000" },
    { valorEquipoTotal: 1, cuotaInicial: 2 });
  assert.deepEqual(resolveAnalystDraftFinancialUpdate(previous, 12, next).values, { cuotaInicial: "1500000" });
  assert.equal(resolveAnalystDraftFinancialUpdate(previous, 12, financialPayload(1, {})), null);
  assert.equal(resolveAnalystDraftFinancialUpdate(previous, 13, next), null);
});

test("una revisión ligera detecta cambios de evidencia pero nunca se reconoce sin cargar las fotos", () => {
  const previous = readAnalystDraftEvidenceSnapshot(12, {});
  const full = evidencePayload(1, { fotoRemisionDataUrl: "foto-corregida", fotoRemisionCapturedAt: "2030-01-01T10:00:00.000Z",
    fotoRemisionSource: "CORRECCION_ANALISTA_SOLICITUD" });
  const light = { analystEvidenceRevision: full.analystEvidenceRevision,
    analystEvidenceCorrection: full.analystEvidenceCorrection };
  assert.equal(hasPendingAnalystDraftEvidence(previous, 12, light), true);
  assert.equal(resolveAnalystDraftEvidenceUpdate(previous, 12, light), null);
  const applied = resolveAnalystDraftEvidenceUpdate(previous, 12, full);
  assert.deepEqual(applied.values, { fotoRemisionDataUrl: "foto-corregida",
    fotoRemisionCapturedAt: "2030-01-01T10:00:00.000Z", fotoRemisionSource: "CORRECCION_ANALISTA_SOLICITUD" });
  assert.equal(hasPendingAnalystDraftEvidence(applied.snapshot, 12, light), false);
  assert.equal(resolveAnalystDraftEvidenceUpdate(applied.snapshot, 12, full), null);
});

test("una nueva foto conserva adjuntos locales de otros grupos y no reescribe evidencia anterior", () => {
  const previous = readAnalystDraftEvidenceSnapshot(12, evidencePayload(1, {
    fotoRemisionDataUrl: "remision-1", fotoRemisionSource: "upload", fotoRemisionCapturedAt: "2030-01-01T10:00:00Z",
  }));
  const next = evidencePayload(2, { fotoRemisionDataUrl: "remision-1", fotoRemisionSource: "upload",
    fotoRemisionCapturedAt: "2030-01-01T10:00:00Z", fotoEntregaDataUrl: "entrega-2",
    fotoEntregaSource: "CORRECCION_ANALISTA_SOLICITUD", fotoEntregaCapturedAt: "2030-01-02T10:00:00Z" }, {
    fotoRemisionDataUrl: 1, fotoRemisionSource: 1, fotoRemisionCapturedAt: 1,
    fotoEntregaDataUrl: 2, fotoEntregaSource: 2, fotoEntregaCapturedAt: 2,
  });
  const changed = resolveAnalystDraftEvidenceUpdate(previous, 12, next).values;
  const local = { fotoRemisionDataUrl: "asesor-remision-nueva", contratoCedulaFrenteDataUrl: "asesor-cedula",
    valorEquipoTotal: "asesor-precio" };
  assert.deepEqual({ ...local, ...changed }, { ...local, fotoEntregaDataUrl: "entrega-2",
    fotoEntregaSource: "CORRECCION_ANALISTA_SOLICITUD", fotoEntregaCapturedAt: "2030-01-02T10:00:00Z" });
});

test("una foto invalidada después de corregirla se reconoce como ausente solo desde una lectura completa", () => {
  const previous = readAnalystDraftEvidenceSnapshot(12, {});
  const invalidated = evidencePayload(1, { fotoRemisionDataUrl: "antes", fotoRemisionCapturedAt: "antes", fotoRemisionSource: "upload" });
  delete invalidated.fotoRemisionDataUrl;
  delete invalidated.fotoRemisionCapturedAt;
  delete invalidated.fotoRemisionSource;
  assert.equal(resolveAnalystDraftEvidenceUpdate(previous, 12, invalidated), null);
  const loaded = resolveAnalystDraftEvidenceUpdate(previous, 12, invalidated, true);
  assert.deepEqual(loaded.values, { fotoRemisionDataUrl: null, fotoRemisionCapturedAt: null, fotoRemisionSource: null });
  assert.equal(hasPendingAnalystDraftEvidence(loaded.snapshot, 12, invalidated), false);
});

test("la evidencia descarta firmas, fotos del proveedor, condiciones y revisiones de otra solicitud", () => {
  const previous = readAnalystDraftEvidenceSnapshot(12, evidencePayload(1, { fotoEntregaDataUrl: "actual" }));
  const next = evidencePayload(2, { fotoEntregaDataUrl: "nueva", contratoSelfieDataUrl: "foto-proveedor",
    firmaSeguroSignedUrl: "firma", valorEquipoTotal: "4000000" });
  assert.deepEqual(resolveAnalystDraftEvidenceUpdate(previous, 12, next).values, { fotoEntregaDataUrl: "nueva" });
  assert.equal(resolveAnalystDraftEvidenceUpdate(previous, 13, next), null);
  assert.equal(hasPendingAnalystDraftEvidence(previous, 13, next), false);
  assert.equal(resolveAnalystDraftEvidenceUpdate(previous, 12, evidencePayload(1, { fotoEntregaDataUrl: "vieja" })), null);
});

function advisorSyncRuntime() {
  // Run the real React callback and its following invalidation effect, with
  // state setters represented by their synchronous post-render values.
  const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const callback = source.slice(source.indexOf("  const synchronizeAnalystDraftData = useCallback("),
    source.indexOf("  const currentIphoneClosureFingerprint = useMemo("));
  const fingerprint = source.slice(source.indexOf("function identityEvidenceClientIdentity("), source.indexOf("function parseDisplayDate("));
  const effectStart = source.indexOf("  useEffect(() => {\n    const nextIdentity = identityEvidenceClientIdentity({");
  assert.ok(effectStart >= 0);
  const effect = source.slice(effectStart + "  useEffect(() => {".length, source.indexOf("\n  }, [", effectStart));
  const context = {
    useCallback: (callback) => callback,
    readAnalystDraftDataSnapshot, resolveAnalystDraftDataUpdate,
    resolveAnalystDraftFinancialUpdate, resolveAnalystDraftEvidenceUpdate,
    analystDataSnapshotRef: { current: readAnalystDraftDataSnapshot(12, {}) },
    analystFinancialSnapshotRef: { current: readAnalystDraftFinancialSnapshot(12, {}) },
    analystEvidenceSnapshotRef: { current: readAnalystDraftEvidenceSnapshot(12, {}) },
    identityEvidenceClientIdentityRef: { current: "old-identity" },
    preservedCanonicalClientNameRef: { current: null }, applyingDraftRef: { current: false },
    auditedIdentityCorrectionRef: { current: false }, firmaSeguroRefreshGenerationRef: { current: 0 },
    hasAuditedCreditIdentityCorrection,
    cancelPendingDraftAutosave() {},
    equipmentCatalogKey: (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase(),
    clienteDocumento: "100000001", clientePrimerNombre: "ANA", clientePrimerApellido: "PRUEBA",
    clienteSegundoApellido: "DEMO", clienteFechaNacimiento: "1990-01-01", clienteFechaExpedicion: "2010-01-01",
    contratoCedulaFrenteDataUrl: "cedula-anterior", fotoRemisionDataUrl: "remision-anterior",
  };
  for (const name of new Set([...callback.matchAll(/\b(set[A-Z]\w*)\(/g), ...effect.matchAll(/\b(set[A-Z]\w*)\(/g)].map((match) => match[1]))) {
    const state = name.charAt(3).toLowerCase() + name.slice(4);
    context[name] = (value) => { context[state] = value; };
  }
  const script = `${fingerprint}\n${callback}\nfunction identityEffect() {${effect}\n}\nthis.sync = synchronizeAnalystDraftData; this.effect = identityEffect;`;
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, context);
  return context;
}

test("el callback y efecto reales conservan la evidencia nueva recibida junto con una corrección de identidad", () => {
  const advisor = advisorSyncRuntime();
  advisor.sync({ id: 12, payload: { wizardStep: 2,
    ...payload(1, { clientePrimerNombre: "ANA NUEVA" }, { clientePrimerNombre: 1 }),
    ...evidencePayload(1, { contratoCedulaFrenteDataUrl: "cedula-para-identidad-nueva",
      contratoCedulaFrenteCapturedAt: "2030-01-01T10:00:00Z", contratoCedulaFrenteSource: "CORRECCION_ANALISTA_SOLICITUD" }),
  } });
  advisor.effect();
  assert.equal(advisor.clientePrimerNombre, "ANA NUEVA");
  assert.equal(advisor.contratoCedulaFrenteDataUrl, "cedula-para-identidad-nueva");
  assert.equal(advisor.contratoCedulaFrenteAudit.source, "CORRECCION_ANALISTA_SOLICITUD");
  assert.equal(advisor.analystEvidenceRevision, 1);
  assert.equal(advisor.analystDataRevision, 1);
});

test("el callback real aplica condiciones y después una remisión nueva del mismo expediente", () => {
  const advisor = advisorSyncRuntime();
  advisor.sync({ id: 12, payload: { wizardStep: 2,
    ...financialPayload(2, { valorEquipoTotal: "4000000", cuotaInicial: "1200000", plazoMeses: "40" }),
    ...evidencePayload(3, { fotoRemisionDataUrl: "remision-condiciones-nuevas",
      fotoRemisionCapturedAt: "2030-01-01T10:00:00Z", fotoRemisionSource: "CORRECCION_ANALISTA_SOLICITUD" }),
  } });
  assert.equal(advisor.valorEquipoTotal, "4000000");
  assert.equal(advisor.cuotaInicial, "1200000");
  assert.equal(advisor.plazoMeses, "40");
  assert.equal(advisor.fotoRemisionDataUrl, "remision-condiciones-nuevas");
  assert.equal(advisor.fotoRemisionAudit.source, "CORRECCION_ANALISTA_SOLICITUD");
  assert.equal(advisor.analystFinancialRevision, 2);
  assert.equal(advisor.analystEvidenceRevision, 3);
});

test("la corrección con nueva firma conserva las fotos y retira el contrato anterior de la pantalla del asesor", () => {
  const advisor = advisorSyncRuntime();
  const corrected = payload(1, { clientePrimerNombre: "ANA MARÍA", clienteFechaNacimiento: "1991-02-03" },
    { clientePrimerNombre: 1, clienteFechaNacimiento: 1 });
  corrected.analystDataCorrection.preserveIdentityEvidence = true;
  const process = { processUuid: "firma-corregida", status: "CREATED" };
  advisor.firmaSeguroDraftProcess = { processUuid: "firma-anterior", status: "SIGNED" };
  advisor.sync({ id: 12, payload: { ...corrected, firmaSeguroClientCorrectionPending: true,
    __analystFirmaSeguroProcess: process } });
  advisor.effect();
  assert.equal(advisor.clientePrimerNombre, "ANA MARÍA");
  assert.equal(advisor.clienteFechaNacimiento, "1991-02-03");
  assert.equal(advisor.contratoCedulaFrenteDataUrl, "cedula-anterior");
  assert.equal(advisor.fotoRemisionDataUrl, "remision-anterior");
  assert.equal(advisor.auditedIdentityCorrectionRef.current, true);
  assert.equal(advisor.firmaSeguroDraftProcess, process);
  assert.equal(advisor.wizardStep, 4);
  assert.equal(advisor.firmaSeguroRefreshGenerationRef.current, 1);
});

test("una actualización posterior de Veriff conserva nombres y nacimiento corregidos por el analista", () => {
  const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const applyVeriffIdentityData = ");
  assert.ok(start >= 0);
  const callback = source.slice(start, source.indexOf("  const veriffMissingIdentityMessage", start));
  const context = { auditedIdentityCorrectionRef: { current: true }, dataCreditoApproval: { documentNumber: "100000001" },
    dataCreditoAssessmentId: "assessment", veriffExpectedDraftId: 12, veriffApprovalCanUnlockClient: () => true,
    applyingVeriffIdentityRef: { current: false }, clientePrimerNombre: "ANA CORREGIDA",
    clienteFechaNacimiento: "1991-02-03", dateOnly: (value) => value,
    normalizeVeriffGender: () => "", normalizeVeriffDocumentType: (value) => value };
  for (const name of new Set([...callback.matchAll(/\b(set[A-Z]\w*)\(/g)].map((match) => match[1]))) {
    const state = name.charAt(3).toLowerCase() + name.slice(4);
    context[name] = (value) => { context[state] = value; };
  }
  runInNewContext(ts.transpileModule(`${callback}\nthis.apply = applyVeriffIdentityData;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  context.apply({ identityData: { firstName: "ANA ANTERIOR", lastName: "PRUEBA", documentNumber: "100000001",
    dateOfBirth: "1990-01-01" } });
  assert.equal(context.clientePrimerNombre, "ANA CORREGIDA");
  assert.equal(context.clienteFechaNacimiento, "1991-02-03");
});

function pollingHarness(load) {
  const requests = [];
  const applied = [];
  const timers = new Map();
  let timerId = 0;
  let visible = true;
  const polling = startVisibleDraftDataPolling({
    load: (signal) => { requests.push(signal); return load(signal); },
    apply: (value) => applied.push(value),
    isVisible: () => visible,
    schedule: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    cancel: (id) => timers.delete(id),
  });
  return { polling, requests, applied, timers, setVisible: (value) => { visible = value; } };
}

test("una consulta en vuelo no se duplica al volver el foco y programa la siguiente en cinco segundos", async () => {
  let resolve;
  const harness = pollingHarness(() => new Promise((done) => { resolve = done; }));
  harness.polling.refresh();
  harness.polling.refresh();
  assert.equal(harness.requests.length, 1);
  resolve("datos");
  await flush();
  assert.deepEqual(harness.applied, ["datos"]);
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].delay, 5_000);
  harness.polling.stop();
  assert.equal(harness.timers.size, 0);
});

test("al desmontar o cambiar la solicitud aborta y descarta una respuesta tardía", async () => {
  let resolve;
  const harness = pollingHarness(() => new Promise((done) => { resolve = done; }));
  harness.polling.stop();
  assert.equal(harness.requests[0].aborted, true);
  resolve("solicitud anterior");
  await flush();
  harness.polling.refresh();
  assert.deepEqual(harness.applied, []);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.requests.length, 1);
});

test("ocultar la pestaña detiene lecturas y volver a verla sincroniza sin esperar el intervalo", async () => {
  const harness = pollingHarness(async () => "datos");
  await flush();
  harness.setVisible(false);
  harness.polling.refresh();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.requests.length, 1);
  harness.setVisible(true);
  harness.polling.refresh();
  await flush();
  assert.equal(harness.requests.length, 2);
  harness.polling.stop();
});

test("si la pestaña se oculta durante la lectura no aplica la respuesta", async () => {
  let resolve;
  const harness = pollingHarness(() => new Promise((done) => { resolve = done; }));
  harness.setVisible(false);
  harness.polling.refresh();
  assert.equal(harness.requests[0].aborted, true);
  resolve("datos");
  await flush();
  assert.deepEqual(harness.applied, []);
  assert.equal(harness.timers.size, 0);
  harness.polling.stop();
});

test("un error temporal de lectura conserva la pantalla y permite reintentar", async () => {
  let attempts = 0;
  const harness = pollingHarness(async () => {
    if (++attempts === 1) throw new Error("sin conexión");
    return "recuperado";
  });
  await flush();
  assert.deepEqual(harness.applied, []);
  const retry = [...harness.timers.values()][0];
  retry.callback();
  await flush();
  assert.deepEqual(harness.applied, ["recuperado"]);
  harness.polling.stop();
});
