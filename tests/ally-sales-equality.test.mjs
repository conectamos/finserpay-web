import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, {
    module: loaded, exports: loaded.exports, console,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return loaded.exports;
}

const access = load("lib/solicitud-operation-access.ts");
const imei = "001234567890123";
const allyAdmin = { id: 21, rolNombre: "ADMIN", sedeId: 31, aliadoId: 41,
  aliadoAccesoId: 41, aliadoAccesoCodigo: "ALLY-41", sedeAccesoId: 31,
  activo: true, sedeAccesoActiva: true, aliadoAccesoActivo: true };
const ownDraft = { id: 51, usuarioId: 21, vendedorId: null, sedeId: 31,
  aliadoId: 41, plataforma: "ANDROID", imei };

function harness(options = {}) {
  const calls = [];
  const reads = [];
  let sellerReads = 0;
  let lockCount = 0;
  let releases = 0;
  const state = { user: { ...allyAdmin }, draft: { ...ownDraft }, seller: null, ...options };
  const effect = name => async value => { calls.push({ name, value }); return { status: name }; };
  const route = load("app/api/equality/route.ts", {
    "next/server": { NextResponse: { json: (data, init = {}) => ({ data, status: init.status || 200, headers: init.headers }) } },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/auth": { getSessionUser: async () => state.user },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/seller-auth": { async getSellerSessionUser() { sellerReads++; return state.seller; } },
    "@/lib/solicitud-operation-access": access,
    "@/lib/solicitudes-storage": { async getActiveSolicitudCreditContext(id) { reads.push(id); return state.draft; } },
    "@/lib/firmaseguro-storage": { async tryAcquireSolicitudOperationLock(id) {
      assert.equal(id, 51); lockCount++;
      if (state.lockBusy) return null;
      state.afterLock?.(state);
      return { async release() { releases++; } };
    } },
    "@/lib/equality-device-meta": { getEqualityDeviceMeta: () => ({}), getPayloadSummary: () => ({}) },
    "@/lib/equality-zero-touch": {
      isEqualityConfigured: () => true,
      normalizeEqualityDeviceUid: value => String(value ?? "").trim().replace(/\s+/g, ""),
      isEqualityApiError: () => false,
      getEqualityProbeDeviceUid: () => "866000000000000",
      queryEqualityDevices: effect("query"),
      uploadEqualityInventoryDevice: effect("upload"),
      activateEqualityFinancingService: effect("activate"),
      lockEqualityDevice: effect("lock"),
      unlockEqualityDevice: effect("unlock"),
      releaseEqualityDevice: effect("release"),
      notifyEqualityDevice: effect("notify"),
      sendEqualityLockMessage: effect("lock-message"),
    },
  });
  return {
    state, calls, reads,
    counts: () => ({ sellerReads, lockCount, releases }),
    send: (body = {}) => route.POST({ json: async () => ({ action: "query", draftId: 51, deviceUid: imei, ...body }) }),
    get: () => route.GET(new Request(`https://test.invalid/api/equality?deviceUid=${imei}`)),
  };
}

test("ally administrator consults and enrolls only their own Android draft without a seller session", async () => {
  for (const action of ["query", "enroll"]) {
    const app = harness();
    const response = await app.send({ action });
    assert.equal(response.status, 200);
    assert.equal(response.data.ok, true);
    assert.equal(response.data.deviceUid, imei, "leading zeroes remain text");
    assert.equal(app.counts().sellerReads, 0, "an administrator never borrows a stale seller cookie");
    assert.deepEqual(app.calls.map(call => call.name), action === "query" ? ["query"] : ["upload", "activate", "query"]);
    assert.ok(app.calls.every(call => call.value === imei));
    assert.equal(app.counts().lockCount, action === "enroll" ? 1 : 0);
    assert.equal(app.counts().releases, action === "enroll" ? 1 : 0);
  }
});

test("ally administrator cannot operate another administrator, a seller, another ally, or a closed draft", async () => {
  for (const draft of [
    { ...ownDraft, usuarioId: 22 },
    { ...ownDraft, vendedorId: 61 },
    { ...ownDraft, aliadoId: 42 },
    { ...ownDraft, usuarioId: undefined },
    null,
  ]) {
    const app = harness({ draft });
    assert.equal((await app.send({ action: "enroll", usuarioId: 21, aliadoId: 41, sedeId: 31 })).status, 403);
    assert.equal(app.calls.length, 0);
  }
});

test("Android platform, current 15-digit IMEI, and active draft are required for noncentral operations", async () => {
  for (const draft of [
    { ...ownDraft, plataforma: "IPHONE" },
    { ...ownDraft, plataforma: null },
    { ...ownDraft, imei: "00123456789012" },
    { ...ownDraft, imei: "0012345678901234" },
    { ...ownDraft, imei: "991234567890123" },
  ]) {
    const app = harness({ draft });
    assert.equal((await app.send({ action: "enroll" })).status, 409);
    assert.equal(app.calls.length, 0);
  }
  const missing = harness();
  assert.equal((await missing.send({ draftId: null })).status, 403);
  assert.equal(missing.calls.length, 0);
});

test("an ally sale never grants central device commands or unrestricted GET queries", async () => {
  for (const action of ["activate", "upload", "lock", "unlock", "release", "notify", "lock-message"]) {
    const app = harness();
    assert.equal((await app.send({ action, title: "Test", message: "Test" })).status, 403);
    assert.equal(app.calls.length, 0);
    assert.equal(app.counts().lockCount, 0);
  }
  const app = harness();
  assert.equal((await app.get()).status, 403);
  assert.equal(app.calls.length, 0);
});

test("enrollment revalidates ownership, platform, IMEI and expiration after acquiring the operation lock", async () => {
  for (const mutate of [
    state => { state.draft.usuarioId = 22; },
    state => { state.draft.aliadoId = 42; },
    state => { state.draft.vendedorId = 61; },
    state => { state.draft.plataforma = "IPHONE"; },
    state => { state.draft.imei = "991234567890123"; },
    state => { state.draft = null; },
  ]) {
    const app = harness({ afterLock: mutate });
    assert.ok([403, 409].includes((await app.send({ action: "enroll" })).status));
    assert.equal(app.reads.length, 2);
    assert.equal(app.calls.length, 0, "no provider mutation follows stale authorization");
    assert.equal(app.counts().releases, 1);
  }
});

test("busy operations block duplicate dispatch, while existing seller and central access are preserved", async () => {
  const busy = harness({ lockBusy: true });
  const blocked = await busy.send({ action: "enroll" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "SOLICITUD_OPERACION_EN_PROCESO");
  assert.equal(busy.calls.length, 0);
  const seller = harness({ user: { ...allyAdmin, rolNombre: "ASESOR" },
    seller: { id: 61, tipoPerfil: "VENDEDOR" }, draft: { ...ownDraft, vendedorId: 61 } });
  assert.equal((await seller.send({ action: "enroll" })).status, 200);
  assert.equal(seller.counts().sellerReads, 1);
  const central = harness({ user: { ...allyAdmin, aliadoAccesoCodigo: "FINSERPAY" } });
  assert.equal((await central.send({ action: "query", draftId: null })).status, 200);
  assert.deepEqual(central.calls.map(call => call.name), ["query"]);
});

test("no authentication or an unrelated profile cannot use ally administrative ownership", async () => {
  for (const user of [null, { ...allyAdmin, rolNombre: "ANALISTA_APROBACION" }, { ...allyAdmin, rolNombre: "ASESOR" },
    { ...allyAdmin, activo: false }, { ...allyAdmin, sedeAccesoActiva: false }, { ...allyAdmin, aliadoAccesoActivo: false },
    { ...allyAdmin, aliadoAccesoId: 42 }, { ...allyAdmin, sedeAccesoId: 32 }, { ...allyAdmin, activo: undefined }]) {
    const app = harness({ user });
    assert.ok([401, 403].includes((await app.send({ action: "enroll" })).status));
    assert.equal(app.calls.length, 0);
  }
});
