import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SolicitudCanonicalMutationError,
  resolveSolicitudDraftCanonicalIdentity,
} from "../lib/solicitudes.ts";

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

test("el autosave preserva documento y assessment canonicos de solicitudes materializadas", () => {
  const legacyAssessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const result = resolveSolicitudDraftCanonicalIdentity({
    materialized: true,
    storedDocument: "1.083.028.847",
    storedAssessmentId: null,
    storedPayloadAssessmentId: legacyAssessmentId,
    incomingDocument: "1083028847",
    incomingAssessmentId: legacyAssessmentId.toUpperCase(),
    payload: { clienteNombre: "Cliente" },
  });

  assert.equal(result.clienteDocumento, "1.083.028.847");
  assert.equal(result.dataCreditoAssessmentId, legacyAssessmentId);
  assert.equal(result.payload.clienteDocumento, "1.083.028.847");
  assert.equal(result.payload.dataCreditoAssessmentId, legacyAssessmentId);
  assert.equal(result.payload.clienteNombre, "Cliente");
});

test("el autosave rechaza cambios de cedula o assessment en solicitudes materializadas", () => {
  const canonicalAssessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const base = {
    materialized: true,
    storedDocument: "1083028847",
    storedAssessmentId: canonicalAssessmentId,
    payload: {},
  };

  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        ...base,
        incomingDocument: "1083028848",
        incomingAssessmentId: canonicalAssessmentId,
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_DOCUMENTO_INMUTABLE" &&
      error.status === 409
  );
  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        ...base,
        incomingDocument: "1083028847",
        incomingAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_DATACREDITO_INMUTABLE" &&
      error.status === 409
  );
});

test("una solicitud materializada sin assessment canonico no acepta uno del payload", () => {
  assert.throws(
    () =>
      resolveSolicitudDraftCanonicalIdentity({
        materialized: true,
        storedDocument: "1083028847",
        storedAssessmentId: null,
        storedPayloadAssessmentId: null,
        incomingDocument: "1083028847",
        incomingAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        payload: {},
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_DATACREDITO_INMUTABLE"
  );
});

test("la reserva generica bloquea y el autosave usa la identidad canonica", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );
  const exactResume = sourceBetween(
    reservation,
    "if (input.solicitudId)",
    "const active = await findActiveByIdentity"
  );
  const activeReuse = sourceBetween(
    reservation,
    "const active = await findActiveByIdentity",
    "const rows = await transaction.$queryRawUnsafe"
  );
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export async function attachDataCreditoToSolicitud"
  );

  assert.match(exactResume, /return \{ id: selected\[0\]\.id, reused: true \}/);
  assert.match(activeReuse, /if \(active\) \{\s*throw new ActiveSolicitudConflictError\(\)/);
  assert.doesNotMatch(activeReuse, /sameOwner|UPDATE|reused/);
  assert.match(autosave, /resolveSolicitudDraftCanonicalIdentity/);
  assert.match(autosave, /targetRow\.payload\?\.dataCreditoAssessmentId/);
  assert.match(autosave, /canonical\.clienteDocumento/);
  assert.match(autosave, /canonical\.dataCreditoAssessmentId/);
});

test("la API devuelve 409 y codigo ante una mutacion de identidad canonica", async () => {
  const route = await readProjectFile("app/api/creditos/borradores/route.ts");
  const post = sourceBetween(route, "export async function POST", "export async function PATCH");
  const errorHandling = sourceBetween(post, "} catch (error) {", "const forbidden");

  assert.match(route, /import \{ SolicitudCanonicalMutationError \} from "@\/lib\/solicitudes"/);
  assert.match(errorHandling, /error instanceof SolicitudCanonicalMutationError/);
  assert.match(errorHandling, /\{ error: error\.message, code: error\.code \}/);
  assert.match(errorHandling, /\{ status: error\.status \}/);
  assert.ok(
    post.indexOf("SolicitudCanonicalMutationError") <
      post.indexOf("const forbidden")
  );
});
