import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontro ${start}`);
  assert.notEqual(endIndex, -1, `No se encontro ${end}`);
  return source.slice(startIndex, endIndex);
}

test("solo la reserva de identidad materializa una solicitud nueva", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export async function attachDataCreditoToSolicitud"
  );

  assert.match(reservation, /INSERT INTO "CreditoBorrador"/);
  assert.doesNotMatch(autosave, /INSERT INTO "CreditoBorrador"/);
  assert.match(autosave, /SOLICITUD_REQUIERE_CONSULTA_DATACREDITO/);
  assert.match(autosave, /targetId = conflicting\.id/);
});

test("la propiedad canonica exige el mismo asesor y la misma sede", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const ownership = sourceBetween(
    source,
    "function sameOwner",
    "async function lockIdentity"
  );

  assert.match(
    ownership,
    /row\.vendedorId === input\.vendedorId\s*&&\s*row\.sedeId === input\.sedeId/
  );
  assert.match(
    ownership,
    /row\.vendedorId === null\s*&&\s*row\.usuarioId === input\.usuarioId\s*&&\s*row\.sedeId === input\.sedeId/
  );
  assert.doesNotMatch(
    ownership,
    /if \(input\.vendedorId\) return row\.vendedorId === input\.vendedorId;/
  );
});

test("los fantasmas historicos sin DataCredito no bloquean una identidad", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const finder = sourceBetween(
    source,
    "async function findActiveByIdentity",
    "export async function reserveSolicitudForIdentity"
  );

  assert.match(finder, /"dataCreditoAssessmentId" IS NOT NULL/);
  assert.match(
    finder,
    /UPPER\(COALESCE\("payload"->>'solicitudOrigen', ''\)\) = 'DATACREDITO'/
  );
  assert.match(
    finder,
    /NULLIF\("payload"->>'dataCreditoStatus', ''\) IS NOT NULL/
  );
  assert.match(
    finder,
    /NULLIF\("payload"->>'dataCreditoAssessmentId', ''\) IS NOT NULL/
  );

  const materializedPredicate = finder.indexOf(
    '"dataCreditoAssessmentId" IS NOT NULL'
  );
  const identityPredicate = finder.indexOf(
    "regexp_replace(COALESCE(\"clienteDocumento\", ''), '[^0-9]', '', 'g') = $1"
  );
  assert.ok(materializedPredicate >= 0);
  assert.ok(identityPredicate > materializedPredicate);
});

test("el muro muestra solo solicitudes materializadas por DataCredito, incluso ante error tecnico", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const draftQuery = sourceBetween(
    source,
    "async function readDraftRows",
    "async function readCreditRows"
  );

  assert.match(
    draftQuery,
    /COALESCE\(dc\."status", NULLIF\(d\."payload"->>'dataCreditoStatus', ''\)\) IS NOT NULL/
  );
  assert.match(
    draftQuery,
    /COALESCE\(dc\."errorCode", NULLIF\(d\."payload"->>'dataCreditoErrorCode', ''\)\)/
  );
  assert.doesNotMatch(draftQuery, /dc\."status" IS NOT NULL/);
  assert.match(source, /solicitudOrigen: "DATACREDITO"/);
  assert.match(source, /dataCreditoStatus: "PENDING"/);
  assert.match(source, /markSolicitudDataCreditoTechnicalError/);
});

test("las salidas tecnicas posteriores a la reserva permanecen visibles y gestionables", async () => {
  const route = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/route.ts"
  );
  const reservation = route.indexOf(
    "const solicitudReservation = await reserveSolicitudForIdentity"
  );
  const trackedResponse = route.indexOf(
    "return solicitudTechnicalResponse",
    reservation
  );

  assert.ok(reservation >= 0);
  assert.ok(trackedResponse > reservation);
  assert.match(route, /markSolicitudDataCreditoTechnicalError/);
  assert.match(route, /errorCode: response\.code/);
});

test("la aprobacion enlaza el id canonico antes del autosave", async () => {
  const gate = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
  );
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );

  assert.match(gate, /solicitudId: number \| null/);
  assert.match(gate, /readNumber\(payload\.solicitudId\)/);
  assert.match(factory, /deliveryMode \|\|\s*!draftId \|\|/);
  assert.match(factory, /setDraftId\(result\.solicitudId\)/);
  assert.match(factory, /replaceDraftInUrl\(result\.solicitudId\)/);
});
