import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as validation from "../lib/credit-client-validation.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function load(source, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, Error, Date,
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; }, ...globals });
  return module.exports;
}
const step = load(read("lib/credit-client-step.ts"), { "./credit-client-validation": validation });
const route = read("app/api/creditos/borradores/route.ts");
const post = route.slice(route.indexOf("export async function POST("), route.indexOf("export async function PATCH("));
const complete = {
  clientePrimerNombre: "María José", clientePrimerApellido: "De la Peña", clienteSegundoApellido: "Muñoz",
  clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", clienteDocumento: "123456789",
  clienteFechaNacimiento: "1995-05-02", clienteFechaExpedicion: "2014-06-03",
  clienteTelefono: "3001234567", clienteCorreo: "cliente@example.invalid",
  clienteDepartamento: "TOLIMA", clienteCiudad: "IBAGUE", clienteGenero: "FEMENINO",
  clienteEstadoCivil: "SOLTERO", clienteEstrato: "3", clienteDireccion: "Calle 5 # 6-10",
  referenciaFamiliar1Nombre: "Ana Muñoz", referenciaFamiliar1Parentesco: "Madre", referenciaFamiliar1Telefono: "3011234567",
  referenciaFamiliar2Nombre: "Luis Peña", referenciaFamiliar2Parentesco: "Padre", referenciaFamiliar2Telefono: "3021234567",
  dataCreditoAssessmentId: "approved-assessment", wizardStep: 2,
};
function fixture({ storedStep = 1, signed = false, verifiedFullName, identityAvailable = true } = {}) {
  const saves = []; const recoveries = [];
  const globals = { ...step, Buffer, console,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    getAccess: async () => ({ central: true, user: { id: 7, sedeId: 3, aliadoId: 9 }, seller: null }),
    expireStaleSolicitudes: async () => {}, ensureVeriffSchema: async () => {}, ensureFirmaSeguroSchema: async () => {},
    normalizePayload: (payload) => structuredClone(payload || {}),
    sanitizeText: (value) => String(value || "").trim(), parsePositiveId: (value) => Number(value) || null,
    clampStep: (value) => Math.max(1, Math.min(5, Number(value) || 1)),
    extractDraftFields: (payload) => payload,
    getActiveSolicitudCreditContext: async () => ({ id: 11, currentStep: storedStep, usuarioId: 7, vendedorId: null, sedeId: 3, aliadoId: 9, clienteDocumento: complete.clienteDocumento, dataCreditoAssessmentId: complete.dataCreditoAssessmentId }),
    canOperateSolicitud: () => true, assertDocumentNotBlacklisted: async () => {},
    prisma: { $queryRawUnsafe: async () => [{ signed }] },
    enforceDataCreditoCustomerIdentity: async (payload, scope, save, actor) => {
      recoveries.push({ payload, scope, save, actor });
      if (!identityAvailable) return null;
      if (verifiedFullName) {
        payload.clienteNombre = verifiedFullName; payload.clientePrimerNombre = ""; payload.clientePrimerApellido = "";
        return { effective: { firstSurname: "", fullName: verifiedFullName, nameMode: "FULL_NAME_ONLY" } };
      }
      return { effective: { firstSurname: complete.clientePrimerApellido } };
    },
    saveSolicitudDraft: async (input) => { saves.push(input); return { id: 11 }; },
    readDrafts: async () => [{ id: 11, payload: saves.at(-1).payload }], serializeDraft: (row) => row,
    documentBlacklistErrorResponse: () => null,
    ActiveSolicitudConflictError: class extends Error {}, SolicitudCanonicalMutationError: class extends Error {},
    DRAFT_REQUIRES_DATACREDITO_CODE: "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO",
  };
  const { POST } = load(post, {}, globals);
  return { saves, recoveries, async request(payload, body = {}) {
    const response = await POST(new Request("http://localhost/api/creditos/borradores", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 11, currentStep: 2, action: "ADVANCE_CLIENT", payload, ...body }),
    }));
    return { status: response.status, data: await response.json() };
  } };
}

test("la transición rechaza cada campo obligatorio vacío antes de guardar", async () => {
  for (const field of validation.CREDIT_CLIENT_FIELD_ORDER) {
    const f = fixture(); const result = await f.request({ ...complete, [field]: "" });
    assert.equal(result.status, 422, field); assert.equal(result.data.code, "CREDIT_CLIENT_INCOMPLETE", field);
    assert.ok(result.data.errors[field], field); assert.equal(f.saves.length, 0, field);
  }
});

test("la transición acepta datos completos y el nombre íntegro sólo si lo recupera el servidor", async () => {
  const f = fixture(); assert.equal((await f.request(complete)).status, 200); assert.equal(f.saves.length, 1);
  const whole = "María del Mar  De la Peña Muñoz";
  const client = { ...complete, clienteNombre: whole, clientePrimerNombre: "", clientePrimerApellido: "" };
  assert.equal((await fixture().request(client)).status, 422);
  const recovered = fixture({ verifiedFullName: whole }); assert.equal((await recovered.request(client)).status, 200);
  assert.equal(recovered.saves[0].payload.clienteNombre, whole);
  assert.equal(recovered.saves[0].payload.clientePrimerNombre, ""); assert.equal(recovered.saves[0].payload.clientePrimerApellido, "");
});

test("el API aplica formato y unicidad de teléfonos, fechas y correo", async () => {
  for (const invalid of [
    { referenciaFamiliar1Telefono: "123" },
    { referenciaFamiliar1Telefono: complete.clienteTelefono },
    { referenciaFamiliar2Telefono: complete.referenciaFamiliar1Telefono },
    { clienteCorreo: "sin-correo" }, { clienteFechaExpedicion: "1990-01-01" },
    { clienteFechaNacimiento: "2030-01-01" },
  ]) {
    const f = fixture(); assert.equal((await f.request({ ...complete, ...invalid })).status, 422);
    assert.equal(f.saves.length, 0);
  }
});

test("no permite omitir action ni falsear el scope para alcanzar un paso nuevo incompleto", async () => {
  const payload = { ...complete, referenciaFamiliar2Telefono: "" };
  for (const body of [ { action: undefined }, { action: undefined, currentStep: 1 }, { action: undefined, payloadScope: "DELIVERY_EVIDENCE" } ]) {
    const f = fixture(); assert.equal((await f.request(payload, body)).status, 422); assert.equal(f.saves.length, 0);
    assert.equal(f.recoveries.length, 1);
  }
});

test("autosave conserva datos incompletos y referencias al corregir sin autorizar una transición", async () => {
  const payload = { ...complete, clienteDireccion: "", wizardStep: 1 };
  for (const storedStep of [1, 2]) {
    const f = fixture({ storedStep });
    assert.equal((await f.request(payload, { action: undefined, currentStep: 1 })).status, 200);
    assert.equal(f.saves[0].payload.referenciaFamiliar2Telefono, complete.referenciaFamiliar2Telefono);
    assert.equal(f.saves[0].payload.clienteDireccion, "");
  }
  const f = fixture({ storedStep: 2 });
  assert.equal((await f.request(payload)).status, 422); assert.equal(f.saves.length, 0);
});

test("recupera la consulta vinculada y conserva la exención de entrega ya firmada", async () => {
  const f = fixture(); const payload = { ...complete }; delete payload.dataCreditoAssessmentId;
  assert.equal((await f.request(payload)).status, 200);
  assert.equal(f.recoveries[0].payload.dataCreditoAssessmentId, complete.dataCreditoAssessmentId);
  const delivery = fixture({ storedStep: 4, signed: true });
  assert.equal((await delivery.request({ fotoEntregaDataUrl: "existing" }, { currentStep: 5, action: undefined, payloadScope: "DELIVERY_EVIDENCE" })).status, 200);
  assert.equal(delivery.recoveries.length, 0);
});

test("los datos completos no autorizan avanzar sin identidad de una consulta aprobada", async () => {
  const f = fixture({ identityAvailable: false });
  const result = await f.request(complete);
  assert.equal(result.status, 409); assert.equal(result.data.code, "DATACREDITO_IDENTITY_UNAUTHORIZED");
  assert.equal(f.saves.length, 0);
});
