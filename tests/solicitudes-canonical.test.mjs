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
  assert.match(factory, /deliveryMode \|\|[\s\S]{0,240}!draftId \|\|/);
  assert.match(factory, /setDraftId\(result\.solicitudId\)/);
  assert.match(factory, /replaceDraftInUrl\(result\.solicitudId\)/);
});

test("el autosave preserva documento, apellido y assessment canonicos de solicitudes materializadas", () => {
  const legacyAssessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const result = resolveSolicitudDraftCanonicalIdentity({
    materialized: true,
    storedDocument: "1.083.028.847",
    storedPayloadFirstSurname: "De La Cruz",
    storedAssessmentId: null,
    storedPayloadAssessmentId: legacyAssessmentId,
    incomingDocument: "1083028847",
    incomingFirstSurname: "  de   la cruz ",
    incomingAssessmentId: legacyAssessmentId.toUpperCase(),
    payload: {
      clienteNombre: "Cliente",
      clientePrimerApellido: "  de   la cruz ",
    },
  });

  assert.equal(result.clienteDocumento, "1.083.028.847");
  assert.equal(result.clientePrimerApellido, "De La Cruz");
  assert.equal(result.dataCreditoAssessmentId, legacyAssessmentId);
  assert.equal(result.payload.clienteDocumento, "1.083.028.847");
  assert.equal(result.payload.clientePrimerApellido, "De La Cruz");
  assert.equal(result.payload.dataCreditoAssessmentId, legacyAssessmentId);
  assert.equal(result.payload.clienteNombre, "Cliente");
});

test("el autosave rechaza cambios de cedula, apellido o assessment en solicitudes materializadas", () => {
  const canonicalAssessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const base = {
    materialized: true,
    storedDocument: "1083028847",
    storedPayloadFirstSurname: "Mendoza",
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
        incomingFirstSurname: "Mendoza Rojas",
        incomingAssessmentId: canonicalAssessmentId,
      }),
    (error) =>
      error instanceof SolicitudCanonicalMutationError &&
      error.code === "SOLICITUD_APELLIDO_INMUTABLE" &&
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

test("la restauracion de DataCredito compara cedula y primer apellido antes de mostrar aprobacion", async () => {
  const route = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/[id]/route.ts"
  );
  const gate = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
  );

  assert.match(route, /buildDataCreditoIdentityHashes/);
  assert.match(route, /identity\.documentHash !== row\.documentHash/);
  assert.match(route, /identity\.surnameHash !== row\.surnameHash/);
  assert.match(route, /ASSESSMENT_IDENTITY_MISMATCH/);
  assert.match(route, /requestedDraft\?\.clientePrimerApellido/);
  assert.match(gate, /assessmentParams\.set\("documentNumber"/);
  assert.match(gate, /assessmentParams\.set\("firstSurname"/);
});

test("la reserva inicial persiste el primer apellido consultado como identidad canonica", async () => {
  const storage = await readProjectFile("lib/solicitudes-storage.ts");
  const evaluationRoute = await readProjectFile(
    "app/api/creditos/datacredito/evaluaciones/route.ts"
  );

  assert.match(storage, /clientePrimerApellido: string;/);
  assert.match(
    storage,
    /clientePrimerApellido: String\(input\.clientePrimerApellido \|\| ""\)/
  );
  assert.match(evaluationRoute, /clientePrimerApellido: firstSurname/);
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
  const autosave = sourceBetween(
    source,
    "export async function saveSolicitudDraft",
    "export async function attachDataCreditoToSolicitud"
  );

  assert.match(
    reservation,
    /if \(input\.solicitudId\)[\s\S]*findBlockingSolicitudByDocument\([\s\S]*selected\[0\]\.id[\s\S]*return \{ id: selected\[0\]\.id, reused: true \}/
  );
  assert.match(reservation, /if \(blocker\)[\s\S]*solicitudConflictFromBlocker/);
  assert.doesNotMatch(reservation, /isSolicitudIdentityReleased/);
  assert.match(autosave, /resolveSolicitudDraftCanonicalIdentity/);
  assert.match(autosave, /targetRow\.payload\?\.dataCreditoAssessmentId/);
  assert.match(autosave, /canonical\.clienteDocumento/);
  assert.match(autosave, /canonical\.dataCreditoAssessmentId/);
});

test("cualquier credito o borrador no liberado bloquea globalmente la cedula", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const blocker = sourceBetween(
    source,
    "async function findBlockingSolicitudByDocument",
    "async function findActiveByIdentity"
  );
  const reservation = sourceBetween(
    source,
    "export async function reserveSolicitudForIdentity",
    "export async function saveSolicitudDraft"
  );

  assert.match(blocker, /FROM "CreditoBorrador" draft/);
  assert.match(blocker, /UNION ALL[\s\S]*FROM "Credito" credit/);
  assert.match(
    blocker,
    /NOT \([\s\S]*draft\."estado" = 'CERRADO'[\s\S]*'DESISTIDA'[\s\S]*'EXPIRADA_15_DIAS'[\s\S]*\)/
  );
  assert.match(
    blocker,
    /ORDER BY[\s\S]*candidate\."source" = 'CREDIT'[\s\S]*candidate\."createdAt" DESC/
  );
  assert.doesNotMatch(
    blocker,
    /FROM "Credito" credit[\s\S]*credit\."estado"\s*(?:=|IN)/
  );
  assert.match(reservation, /const blocker = await findBlockingSolicitudByDocument/);
  assert.match(reservation, /if \(blocker\)[\s\S]*solicitudConflictFromBlocker/);
  assert.match(blocker, /new ActiveSolicitudConflictError/);
  assert.match(blocker, /excludedDraftId\?: number \| null/);
  assert.match(blocker, /draft\."id" <> \$2/);
  assert.doesNotMatch(reservation, /isSolicitudIdentityReleased/);
  assert.match(blocker, /debe quedar desistida antes de iniciar otra/);
  assert.doesNotMatch(reservation, /closedReason[^\n]*RECHAZADA[^\n]*INSERT/);
});

test("solo las solicitudes abiertas vencen automaticamente a los 15 dias", async () => {
  const source = await readProjectFile("lib/solicitudes-storage.ts");
  const expiration = sourceBetween(
    source,
    "async function expireStaleWith",
    "export async function expireStaleSolicitudes"
  );

  assert.match(
    expiration,
    /"closedReason" = (?:COALESCE\("closedReason", )?'EXPIRADA_15_DIAS'\)?/
  );
  assert.match(expiration, /WHERE "estado" = 'ABIERTO'/);
  assert.match(expiration, /COALESCE\("expiresAt", "createdAt" \+ INTERVAL '15 days'\)/);
  assert.doesNotMatch(expiration, /"closedReason"[^\n]*RECHAZADA/);
  assert.doesNotMatch(expiration, /NOT \([\s\S]*'FINALIZADA'/);
});

test("desistir libera de una vez los duplicados no finalizados de la misma cedula", async () => {
  const [source, draftRoute] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/api/creditos/borradores/route.ts"),
  ]);
  const sellerDesist = sourceBetween(
    source,
    "export async function desistSolicitud",
    "export async function desistSolicitudAsCentralAdmin"
  );
  const centralDesist = sourceBetween(
    source,
    "export async function desistSolicitudAsCentralAdmin",
    "export async function completeSolicitudForCredit"
  );

  for (const desist of [sellerDesist, centralDesist]) {
    assert.match(desist, /prisma\.\$transaction/);
    assert.match(desist, /SELECT "id", "clienteDocumento"[\s\S]*WHERE "id" = \$1/);
    assert.match(desist, /const document = normalizeDigits\(target\[0\]\.clienteDocumento\)/);
    assert.match(desist, /lockIdentity\(transaction, "document", document\)/);
    assert.match(desist, /UPDATE "CreditoBorrador"/);
    assert.match(
      desist,
      /regexp_replace\(COALESCE\("clienteDocumento", ''\), '\[\^0-9\]', '', 'g'\) = \$\d/
    );
    assert.match(desist, /"creditoId" IS NULL/);
    assert.match(desist, /"closedReason" = 'DESISTIDA'/);
    assert.match(desist, /'EXPIRADA_15_DIAS'/);
    assert.match(desist, /findBlockingSolicitudByDocument\(transaction, document\)/);
    assert.match(desist, /identityReleased: changed && !blocker/);
  }

  assert.match(sellerDesist, /"vendedorId" = \$3 AND "sedeId" = \$4/);
  const centralUpdate = centralDesist.slice(centralDesist.indexOf('UPDATE "CreditoBorrador"'));
  assert.doesNotMatch(centralUpdate, /"vendedorId"\s*=|"sedeId"\s*=/);
  assert.match(draftRoute, /ok: result\.changed/);
  assert.match(draftRoute, /identityReleased: result\.identityReleased/);
  assert.match(draftRoute, /status: result\.changed \? 200 : 409/);
  assert.doesNotMatch(draftRoute, /status: changed \? 200 : 409/);
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
