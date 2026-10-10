import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../lib/firmaseguro.ts", import.meta.url), "utf8");

function fixture(reply = () => Response.json({ ok: true })) {
  const requests = [];
  const exports = runInNewContext(stripTypeScriptTypes(source.replace(/^export /gm, "")) +
    "\n({ firmaSeguroEditSignature, firmaSeguroResendSignature, firmaSeguroGetSignaturesStatus, firmaSeguroGetProcessStatus, extractFirmaSeguroStatus, isFirmaSeguroCompletedStatus });", {
    Buffer, URL, AbortSignal,
    console: { error() {} },
    process: { env: { FIRMASEGURO_BASE_URL: "https://firmaseguro.example.test" } },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return reply(url, options);
    },
  });
  return { ...exports, requests };
}

const contactEdit = {
  uuid: "b4b038ce-4a89-4c43-9cf8-30f573e530b1",
  signature_id: 123,
  authentication_method_id: 4,
  contact_information: {
    email: "cliente@example.test", first_name: "Cliente", second_name: null,
    first_last_name: "Prueba", second_last_name: null, identification_type_id: 1,
    identification: "123456789", indicative: "57", mobile_number: "3001234567",
  },
  signatory_type: "Cliente", template_rol: null,
};

test("edita el firmante del mismo proceso mediante PUT del contrato oficial v2", async () => {
  const api = fixture();
  await api.firmaSeguroEditSignature("fixture-token", contactEdit);
  assert.equal(api.requests.length, 1);
  const request = api.requests[0];
  assert.equal(request.url, "https://firmaseguro.example.test/api/v2/Signature/edit-signature");
  assert.equal(request.method, "PUT");
  assert.equal(request.headers.Authorization, "Bearer fixture-token");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), contactEdit);
  assert.equal(request.cache, "no-store");
  assert.ok(request.signal instanceof AbortSignal);
  assert.doesNotMatch(request.body, /base64String|documents|create-full/);
});

test("reenvía el mismo signature_id con el GET mutante documentado sin crear procesos", async () => {
  const api = fixture();
  await api.firmaSeguroResendSignature("fixture-token", 123);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url,
    "https://firmaseguro.example.test/api/v2/Signature/resend-signature/123");
  assert.equal(api.requests[0].method, "GET");
  assert.equal(api.requests[0].body, undefined);
  assert.equal(api.requests[0].cache, "no-store");
  assert.ok(api.requests[0].signal instanceof AbortSignal);
});

for (const method of ["firmaSeguroEditSignature", "firmaSeguroResendSignature"]) {
  for (const status of [401, 403]) {
    test(`${method} no repite la mutación ante HTTP ${status}`, async () => {
      const api = fixture(() => Response.json({ error: "Forbidden" }, { status }));
      await assert.rejects(api[method]("fixture-token",
        method === "firmaSeguroEditSignature" ? contactEdit : 123),
      (error) => error.name === "FirmaSeguroApiError" && error.status === status);
      assert.equal(api.requests.length, 1);
    });
  }
}

test("un timeout o respuesta perdida no reintenta editar ni notificar", async () => {
  for (const method of ["firmaSeguroEditSignature", "firmaSeguroResendSignature"]) {
    const api = fixture(() => { throw new DOMException("fixture timeout", "TimeoutError"); });
    await assert.rejects(api[method]("fixture-token",
      method === "firmaSeguroEditSignature" ? contactEdit : 123),
    (error) => error.name === "TimeoutError");
    assert.equal(api.requests.length, 1);
  }
});

test("rechaza identificadores ajenos al int32 positivo antes de contactar al proveedor", async () => {
  const api = fixture();
  for (const signatureId of [0, -1, 1.5, 2_147_483_648, "123", null, undefined]) {
    await assert.rejects(api.firmaSeguroResendSignature("fixture-token", signatureId),
      (error) => error.status === 400);
    await assert.rejects(api.firmaSeguroEditSignature("fixture-token",
      { ...contactEdit, signature_id: signatureId }), (error) => error.status === 400);
  }
  await assert.rejects(api.firmaSeguroEditSignature("fixture-token",
    { ...contactEdit, uuid: " " }), (error) => error.status === 400);
  assert.equal(api.requests.length, 0);
});

test("el rechazo de modificación del proveedor se propaga sin crear un proceso alternativo", async () => {
  const api = fixture(() => Response.json("Signer already signed", { status: 400 }));
  await assert.rejects(api.firmaSeguroEditSignature("fixture-token", contactEdit),
    (error) => error.status === 400 && error.message.includes("already signed"));
  assert.equal(api.requests.length, 1);
  assert.doesNotMatch(api.requests[0].url, /Process/);
});

test("HTTP 200 con fallo explícito no confirma una edición ni un reenvío", async () => {
  for (const payload of [false, { success: false }, { Ok: false }, { error: "Rejected" },
    { errors: ["Rejected"] }, { data: { success: false } }, { result: { error: "Rejected" } }]) {
    for (const method of ["firmaSeguroEditSignature", "firmaSeguroResendSignature"]) {
      const api = fixture(() => Response.json(payload));
      await assert.rejects(api[method]("fixture-token",
        method === "firmaSeguroEditSignature" ? contactEdit : 123),
      (error) => error.name === "FirmaSeguroApiError" && error.status === 502);
      assert.equal(api.requests.length, 1);
    }
  }
});

test("consulta firmantes solo en el UUID del proceso vigente", async () => {
  const api = fixture();
  await api.firmaSeguroGetSignaturesStatus("fixture-token", contactEdit.uuid);
  assert.equal(api.requests[0].url,
    `https://firmaseguro.example.test/api/v2/Signature/get-signatures-status/${contactEdit.uuid}`);
  assert.equal(api.requests[0].method, "GET");
});

test("lee status_process real y refresca la firma vigente sin enviar otro contrato", async () => {
  const refreshSource = await readFile(new URL("../lib/firmaseguro-credit.ts", import.meta.url), "utf8");
  const refreshCode = refreshSource.slice(refreshSource.indexOf("export async function refreshFirmaSeguroProcess("),
    refreshSource.indexOf("export async function getLatestFirmaSeguroProcessForCredit("))
    .replace(/^export /gm, "");
  const signedPdf = Buffer.from("%PDF-1.7\nSigned test contract\n%%EOF").toString("base64");
  for (const terminalSource of ["process", "signatures"]) {
    const api = fixture(url => Response.json(url.includes("get-process-status")
      ? { uuid: contactEdit.uuid, status_process: terminalSource === "process" ? "Firmado" : "En proceso", name: "Contrato" }
      : { uuid: contactEdit.uuid, signatures: [{ id: 123, status: "Enviado" }],
        status_process: terminalSource === "signatures" ? "Firmado" : "Enviado" }));
    const updates = [];
    const refresh = runInNewContext(stripTypeScriptTypes(refreshCode) + "\nrefreshFirmaSeguroProcess;", {
      ...api, Buffer, Date,
      runWithFirmaSeguroAuth: async callback => ({ result: await callback("fixture-token") }),
      collectFirmaSeguroUuidCandidates: () => [],
      firmaSeguroGetDocumentsByUuid: async uuid => { assert.equal(uuid, contactEdit.uuid); return { base64: signedPdf }; },
      extractFirmaSeguroSignedDocument: payload => ({ base64: payload.base64, fileName: "signed.pdf", url: "" }),
      summarizeFirmaSeguroDocumentPayload: () => ({}),
      redactBase64Payload: payload => payload,
      updateFirmaSeguroProcess: async (uuid, input) => { updates.push({ uuid, input }); return { ...process, ...input }; },
    });
    const process = { processUuid: contactEdit.uuid, draftId: 25, creditoId: null,
      status: "Enviado", completedAt: null, signedDocumentBase64: null };
    assert.equal(api.extractFirmaSeguroStatus({ status_process: "Firmado", status: "Enviado", name: "Contrato" }), "Firmado");
    const result = await refresh(process);
    assert.ok(result.completedAt);
    assert.equal(result.signedDocumentBase64, signedPdf);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].uuid, contactEdit.uuid);
    assert.equal(api.requests.length, 2);
    assert.ok(api.requests.every(request => request.method === "GET" && request.url.endsWith(contactEdit.uuid)));
    assert.equal(result.lastError, null);
  }
});

const providerSource = await readFile(new URL("../lib/firmaseguro-recipient-provider.ts", import.meta.url), "utf8");
const operationsSource = await readFile(new URL("../lib/approval-operations-core.ts", import.meta.url), "utf8");
const pendingStart = operationsSource.indexOf("export function isVerifiedPendingSignatureStatus");
const pendingEnd = operationsSource.indexOf("export function ", pendingStart + 1);
const pendingCheckSource = operationsSource.slice(pendingStart, pendingEnd).replace(/^export /gm, "");
function inspector(api = fixture()) {
  const executable = providerSource.replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  return runInNewContext(stripTypeScriptTypes(pendingCheckSource + executable) +
    "\n({ parsePendingFirmaSeguroRecipient, inspectPendingFirmaSeguroRecipient });", { ...api });
}
function pendingProcess() {
  return {
    processUuid: contactEdit.uuid, status: "SENT", completedAt: null, supersededAt: null,
    signedDocumentBase64: null,
    requestPayload: { endpoint: "create-full", payload: { signatures: [{
      authenticationMethodId: 4, rol: "Cliente", signatory_type: "Cliente",
      contactInformation: { phone: { indicative: "57", number: "3001111111" },
        email: "anterior@example.test", person: {
          firstName: "Cliente", firstLastName: "Prueba", identification: "123456789",
          identificationTypeId: 1,
        } },
    }] } },
  };
}
function pendingSigner() {
  return { signature_id: 123, processUuid: contactEdit.uuid, status: "PENDING",
    authentication_method_id: 4, contact_information: { ...contactEdit.contact_information } };
}

test("inspecciona un único firmante con identidad verificable y conserva el proceso y el contrato", () => {
  const { parsePendingFirmaSeguroRecipient: parse } = inspector();
  const process = pendingProcess();
  const snapshot = JSON.stringify(process);
  for (const payload of [[pendingSigner()], { signatures: [pendingSigner()] }, { data: [pendingSigner()] }]) {
    const result = parse(process, { status: "IN_PROGRESS" }, payload);
    assert.equal(result.signatureId, 123);
    assert.equal(result.phone, "3001234567");
    assert.equal(result.email, "cliente@example.test");
    assert.deepEqual(JSON.parse(JSON.stringify(result.editPayload)), { ...contactEdit, template_rol: "Cliente" });
    assert.equal(JSON.stringify(process), snapshot);
  }
});

test("acepta el request original de create-full-by-company generado por el builder real", async () => {
  const creditSource = await readFile(new URL("../lib/firmaseguro-credit.ts", import.meta.url), "utf8");
  const start = creditSource.indexOf("function buildCreateFullByCompanyPayload(");
  const end = creditSource.indexOf("function buildCreateFullPayload(", start);
  assert.ok(start >= 0 && end > start);
  const build = runInNewContext(stripTypeScriptTypes(creditSource.slice(start, end)) +
    "\nbuildCreateFullByCompanyPayload;", {
    getFirmaSeguroConfig: () => ({ processTypeId: 3, signatureMethodId: 2,
      identificationTypeId: 1, typePersonId: 1 }),
    buildFirmaSeguroFolioFileName: () => "original.pdf", getCreditPackageBalanceTypeId: () => 2,
    getFirmaSeguroTags: () => [], optionalText: value => value || null,
  });
  const payload = build({ folio: "TEST" }, { firstName: "Cliente", firstLastName: "Prueba",
    document: "123456789", phone: "3001111111" }, "pdf-redacted", "callback", {
    authMethodId: 4, signerEmail: "anterior@example.test", notifyByEmail: false,
    sendByEmail: false, sendByWhatsApp: true,
  });
  const process = { ...pendingProcess(), requestPayload: { endpoint: "create-full-by-company", payload } };
  const result = inspector().parsePendingFirmaSeguroRecipient(process, { status: "SENT" }, [pendingSigner()]);
  assert.equal(result.signatureId, 123);
  assert.equal(result.editPayload.contact_information.identification, "123456789");
  assert.equal(result.editPayload.contact_information.first_name, "Cliente");
  assert.equal(result.editPayload.authentication_method_id, 4);
  assert.equal(result.editPayload.signatory_type, "Firmante");
});

test("no confunde un id anidado, un id de proceso ni un firmante ajeno con la firma vigente", () => {
  const { parsePendingFirmaSeguroRecipient: parse } = inspector();
  for (const signer of [
    { ...pendingSigner(), signature_id: undefined, processId: 123 },
    { ...pendingSigner(), signature_id: undefined, data: { id: 123 } },
    { ...pendingSigner(), signature_id: 123, id: 124 },
    { ...pendingSigner(), signature_id: "123" },
    { ...pendingSigner(), processUuid: "different-process" },
    { ...pendingSigner(), contact_information: { ...contactEdit.contact_information, identification: "999999" } },
  ]) {
    assert.throws(() => parse(pendingProcess(), { status: "SENT" }, [signer]),
      (error) => error.code === "FIRMASEGURO_RECIPIENT_UNVERIFIED");
  }
});

test("no escribe ni permite reenviar ante múltiples firmantes, respuesta desconocida o datos ausentes", () => {
  const { parsePendingFirmaSeguroRecipient: parse } = inspector();
  for (const payload of [[], [pendingSigner(), pendingSigner()], { data: pendingSigner() },
    { success: false, signatures: [pendingSigner()] }, { unrelated: [{ id: 123 }] },
    [{ ...pendingSigner(), contact_information: { ...contactEdit.contact_information, email: null } }],
    [{ ...pendingSigner(), contact_information: { ...contactEdit.contact_information, mobile_number: null } }],
    [{ ...pendingSigner(), contact_information: { ...contactEdit.contact_information, first_name: "Otra" } }]]) {
    assert.throws(() => parse(pendingProcess(), { status: "SENT" }, payload),
      (error) => error.code === "FIRMASEGURO_RECIPIENT_UNVERIFIED");
  }
});

test("bloquea un documento completado, rechazado o con indicios de firma aunque aún diga pendiente", () => {
  const { parsePendingFirmaSeguroRecipient: parse } = inspector();
  for (const status of ["SIGNED", "DECLINED", "EXPIRED", "UNKNOWN"]) {
    assert.throws(() => parse(pendingProcess(), { status }, [pendingSigner()]),
      (error) => error.code === "FIRMASEGURO_SIGNATURE_NOT_PENDING");
    assert.throws(() => parse(pendingProcess(), { status: "SENT" }, [{ ...pendingSigner(), status }]),
      (error) => error.code === "FIRMASEGURO_SIGNATURE_NOT_PENDING");
  }
  for (const signedField of [{ isSigned: true }, { isSigned: false, declined: true },
    { signedAt: "2026-10-09T12:00:00Z" }, { signDate: "2026-10-09" }]) {
    assert.throws(() => parse(pendingProcess(), { status: "SENT" }, [{ ...pendingSigner(), ...signedField }]),
      (error) => error.code === "FIRMASEGURO_SIGNATURE_NOT_PENDING");
  }
  assert.throws(() => parse({ ...pendingProcess(), completedAt: new Date() },
    { status: "SENT" }, [pendingSigner()]), (error) => error.code === "FIRMASEGURO_SIGNATURE_NOT_PENDING");
});

test("consulta de nuevo estado y firmante con límite de espera antes de editar o reenviar", async () => {
  const api = fixture(url => Response.json(url.includes("get-process-status")
    ? { status: "SENT" } : { signatures: [pendingSigner()] }));
  const inspect = inspector(api).inspectPendingFirmaSeguroRecipient;
  const result = await inspect("fixture-token", pendingProcess());
  assert.equal(result.signatureId, 123);
  assert.equal(api.requests.length, 2);
  for (const request of api.requests) {
    assert.equal(request.method, "GET");
    assert.ok(request.signal instanceof AbortSignal);
    assert.doesNotMatch(request.url, /edit-signature|resend-signature|create-full/);
  }
});
