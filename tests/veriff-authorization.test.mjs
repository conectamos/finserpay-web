import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { canAccessVeriffValidation, canOperateVeriffDraft } =
  await jiti.import("../lib/veriff-access.ts");
const { redactVeriffValidationForOperator } = await jiti.import(
  "../lib/veriff-response.ts"
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const central = {
  aliadoAccesoCodigo: "FINSERPAY",
  aliadoAccesoId: 1,
  id: 1,
  rolNombre: "ADMIN",
  sedeId: 1,
};
const allyAdmin = {
  aliadoAccesoCodigo: "ALIADO-10",
  aliadoAccesoId: 10,
  id: 2,
  rolNombre: "ADMIN",
  sedeId: 100,
};
const sellerUser = {
  aliadoId: 10,
  aliadoAccesoCodigo: "ALIADO-10",
  aliadoAccesoId: 10,
  id: 3,
  rolNombre: "ASESOR",
  sedeId: 100,
};
const owner = { id: 50, sedeId: 100, tipoPerfil: "VENDEDOR" };
const otherSellerSameSede = {
  id: 51,
  sedeId: 100,
  tipoPerfil: "VENDEDOR",
};
const supervisor = { id: 50, sedeId: 100, tipoPerfil: "SUPERVISOR" };
const ownerRow = {
  aliadoId: 10,
  estado: "ABIERTO",
  sedeId: 100,
  usuarioId: sellerUser.id,
  vendedorId: owner.id,
};

test("Veriff respeta alcance central, aliado y asesor titular", () => {
  assert.equal(canAccessVeriffValidation(central, ownerRow, null), true);
  assert.equal(canAccessVeriffValidation(allyAdmin, ownerRow, null), true);
  assert.equal(
    canAccessVeriffValidation(
      { ...allyAdmin, aliadoAccesoId: 11 },
      ownerRow,
      null
    ),
    false
  );
  assert.equal(canAccessVeriffValidation(sellerUser, ownerRow, owner), true);
  assert.equal(
    canAccessVeriffValidation(sellerUser, ownerRow, otherSellerSameSede),
    false
  );
  assert.equal(
    canAccessVeriffValidation(
      sellerUser,
      { ...ownerRow, usuarioId: sellerUser.id },
      otherSellerSameSede
    ),
    false,
    "compartir usuario o sede no concede acceso"
  );
  assert.equal(
    canAccessVeriffValidation(
      sellerUser,
      ownerRow,
      { ...owner, sedeId: 101 }
    ),
    true,
    "el titular conserva acceso al cambiar de sede dentro del mismo aliado"
  );
  assert.equal(
    canAccessVeriffValidation(
      { ...sellerUser, aliadoId: 11 },
      ownerRow,
      owner
    ),
    false,
    "el mismo id de asesor no cruza aliados"
  );
  assert.equal(canAccessVeriffValidation(sellerUser, ownerRow, supervisor), false);
  assert.equal(canAccessVeriffValidation(sellerUser, ownerRow, null), false);
});

test("solo un borrador abierto y dentro del alcance puede iniciar Veriff", () => {
  assert.equal(canOperateVeriffDraft(central, ownerRow, null), true);
  assert.equal(canOperateVeriffDraft(allyAdmin, ownerRow, null), false);
  assert.equal(canOperateVeriffDraft(sellerUser, ownerRow, owner), true);
  assert.equal(
    canOperateVeriffDraft(
      sellerUser,
      { ...ownerRow, estado: "CERRADO" },
      owner
    ),
    false
  );
  assert.equal(
    canOperateVeriffDraft(sellerUser, ownerRow, otherSellerSameSede),
    false
  );
  assert.equal(canOperateVeriffDraft(sellerUser, ownerRow, supervisor), false);
});

test("POST autoriza el borrador y la cedula antes de reusar o llamar al proveedor", async () => {
  const route = await readProjectFile("app/api/creditos/veriff/route.ts");
  const access = route.indexOf(
    "if (!draft || !canOperateVeriffDraft(user, draft, sellerSession))"
  );
  const operationLock = route.indexOf(
    "operationLock = await tryAcquireSolicitudOperationLock(draftId)"
  );
  const lockedAccess = route.indexOf(
    "if (!draft || !canOperateVeriffDraft(user, draft, sellerSession))",
    access + 1
  );
  const reuse = route.indexOf("getReusableVeriffValidationForDraft({");
  const provider = route.indexOf("await veriffCreateSession({");

  assert.match(route, /FROM "CreditoBorrador" d/);
  assert.match(route, /NULLIF\(d\."plataforma", ''\)/);
  assert.match(route, /d\."payload"->>'plataformaDispositivo'/);
  assert.doesNotMatch(route, /'''|->>''plataformaDispositivo''/);
  assert.match(route, /draft\.clienteDocumento/);
  assert.match(route, /requestedDocument !== clienteDocumento/);
  assert.ok(access >= 0);
  assert.ok(operationLock > access);
  assert.ok(lockedAccess > operationLock);
  assert.ok(reuse > lockedAccess);
  assert.ok(provider > reuse);
  assert.match(route, /SOLICITUD_OPERACION_EN_PROCESO/);
  assert.match(route, /finally \{[\s\S]{0,100}operationLock\?\.release\(\)/);
  assert.match(route, /aliadoId: draft\.aliadoId/);
  assert.match(route, /sedeId: draft\.sedeId/);
  assert.match(route, /vendedorId: draft\.vendedorId/);
});

test("el estado Veriff exige solicitud activa al titular y la biometria queda solo para central", async () => {
  const [statusRoute, webhookRoute, mediaRoute, mediaDownloadRoute] = await Promise.all([
    readProjectFile("app/api/creditos/veriff/[id]/route.ts"),
    readProjectFile("app/api/veriff/webhook/route.ts"),
    readProjectFile("app/api/creditos/veriff/[id]/media/route.ts"),
    readProjectFile("app/api/creditos/veriff/[id]/media/[mediaId]/route.ts"),
  ]);

  assert.match(statusRoute, /getActiveSolicitudCreditContext\(input\.current\.draftId\)/);
  assert.match(statusRoute, /canOperateSolicitud\(\{/);
  assert.match(statusRoute, /input\.current\.creditoId/);
  assert.match(statusRoute, /!centralAdmin/);
  assert.match(statusRoute, /redactVeriffValidationForOperator\(serialized\)/);
  const providerRead = statusRoute.indexOf(
    "decisionPayload = await veriffGetDecision(current.veriffSessionId)"
  );
  const mutationLock = statusRoute.indexOf(
    "operationLock = await tryAcquireSolicitudOperationLock(current.draftId)"
  );
  const decisionMutation = statusRoute.indexOf(
    "await updateVeriffValidationFromDecision("
  );
  const retryMutation = statusRoute.indexOf(
    "await enforceVeriffRetryPolicy(row)"
  );
  assert.ok(providerRead >= 0);
  assert.ok(mutationLock > providerRead, "la lectura de red no mantiene el lease");
  assert.ok(decisionMutation > mutationLock);
  assert.ok(retryMutation > decisionMutation);
  assert.match(statusRoute, /refreshDeferred: true/);
  assert.match(
    statusRoute,
    /finally \{[\s\S]{0,100}operationLock\?\.release\(\)/
  );
  const webhookLock = webhookRoute.indexOf(
    "await tryAcquireSolicitudOperationLock(current.draftId)"
  );
  const webhookMutation = webhookRoute.indexOf(
    "await updateVeriffValidationFromDecision("
  );
  const webhookRetryPolicy = webhookRoute.indexOf(
    "await enforceVeriffRetryPolicy(updated)"
  );
  assert.ok(webhookLock >= 0);
  assert.ok(webhookMutation > webhookLock);
  assert.ok(webhookRetryPolicy > webhookMutation);
  assert.match(webhookRoute, /SOLICITUD_OPERACION_EN_PROCESO/);
  assert.match(webhookRoute, /"Retry-After": "2"/);
  assert.match(
    webhookRoute,
    /finally \{[\s\S]{0,100}operationLock\?\.release\(\)/
  );
  for (const route of [mediaRoute, mediaDownloadRoute]) {
    assert.match(route, /isAdminRole\(user\.rolNombre\)/);
    assert.match(route, /isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/);
    assert.doesNotMatch(route, /getSellerSessionUser|canAccessVeriffValidation/);
  }

  const access = await readProjectFile("lib/veriff-access.ts");
  assert.doesNotMatch(access, /row\.sedeId === user\.sedeId \|\|/);
  assert.doesNotMatch(access, /row\.usuarioId === user\.id/);
  assert.match(access, /canSellerOperateSolicitud\(seller, user\.aliadoId, row\)/);
  assert.doesNotMatch(access, /row\.sedeId === seller\.sedeId/);
});

test("la respuesta operativa Veriff no expone identidad ni sesion del proveedor", () => {
  const redacted = redactVeriffValidationForOperator({
    id: 81,
    draftId: 417,
    creditoId: null,
    captureToken: "capture-secret",
    veriffSessionId: "provider-session",
    sessionUrl: "https://provider.example/session",
    identityData: {
      fullName: "Cliente Sensible",
      documentNumber: "1083028847",
      dateOfBirth: "1990-01-01",
    },
    identityDocumentNumber: "1083028847",
    identityDocumentStatus: "match",
    vendorData: "draft:417",
    clienteDocumento: "1083028847",
    clienteNombre: "Cliente Sensible",
    status: "APPROVED",
    decision: "APPROVED",
    approved: true,
    technicalApproved: true,
    trusted: true,
    riskBlocked: false,
    reviewRequired: false,
    pending: false,
    code: "9001",
    reason: "raw provider reason",
    lastError: null,
    decidedAt: "2026-08-28T10:00:00.000Z",
  });

  assert.deepEqual(
    {
      approved: redacted.approved,
      draftId: redacted.draftId,
      identityDataAvailable: redacted.identityDataAvailable,
      identityDocumentStatus: redacted.identityDocumentStatus,
      status: redacted.status,
    },
    {
      approved: true,
      draftId: 417,
      identityDataAvailable: true,
      identityDocumentStatus: "match",
      status: "APPROVED",
    }
  );
  for (const sensitiveKey of [
    "captureToken",
    "clienteDocumento",
    "clienteNombre",
    "creditoId",
    "identityData",
    "identityDocumentNumber",
    "reviewRequired",
    "reason",
    "riskBlocked",
    "sessionUrl",
    "vendorData",
    "veriffSessionId",
  ]) {
    assert.equal(
      Object.hasOwn(redacted, sensitiveKey),
      false,
      `${sensitiveKey} no debe salir en la respuesta del asesor`
    );
  }
});
