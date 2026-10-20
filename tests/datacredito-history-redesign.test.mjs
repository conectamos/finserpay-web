import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { buildDataCreditoAdminRiskSummary, sanitizeDataCreditoProviderPayload } = await jiti.import("../lib/datacredito/admin-report.ts");
const source = readFileSync(new URL("../app/dashboard/datacredito/datacredito-admin-console.tsx", import.meta.url), "utf8");
const listUrl = "/api/creditos/datacredito/admin/evaluaciones";
const controls = new Proxy({}, { get: (_, name) => String(name) });
const jsx = (type, props) => ({ type, props });
const descendants = node => Array.isArray(node) ? node.flatMap(descendants) : node && typeof node === "object"
  ? [node, ...descendants(node.props?.children), ...descendants(node.props?.action)] : [];
const text = node => Array.isArray(node) ? node.map(text).join(" ") : typeof node === "string" || typeof node === "number"
  ? String(node) : [node?.props?.children, node?.props?.label, node?.props?.title, node?.props?.value, node?.props?.description, node?.props?.detail].filter(x => x !== undefined).map(text).join(" ");
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function providerFixture() {
  return { status: "ACCEPTED", content: {
    infoTransaccion: { fechaConsulta: "2026-10-20", horaConsulta: "11:24:00", tipoIdDigitado: "CC", numeroIdDigitado: "00123456789", apellidoDigitado: "PRUEBA", codigosRespuesta: [{ clave: "CC", valor: "00" }, { clave: "TX", valor: "05" }] },
    respuesta: {
      validacion: { conInformacion: true, datosBasicos: { conInformacion: true, nombreCompleto: "CLIENTE DE PRUEBA", primerNombre: "CLIENTE", segundoNombre: "DE", primerApellido: "PRUEBA", segundoApellido: "FINSER", tipoDocumento: "CC", numeroDocumento: "00123456789", estadoDocumento: "Vigente", rangoEdad: "26-35" } },
      comportamientoCrediticio: { conInformacion: true,
        evolucionSaldoCuotaPN: { conInformacion: true, trimestres: [{ trimestre: "2026-09", saldoTotal: "1200", cuotaTotal: "85" }] },
        evolucionRoPN: { conInformacion: true, trimestres: [{ trimestre: "2026-09", saldoTotal: "600", cupoTotal: "1000", porcentajeDeuda: "60" }] },
        comportamientoPago: { conInformacion: true, vectorComportamiento: [{ anioMes: "2026-08", comportamiento: "N" }, { anioMes: "2026-09", comportamiento: "1" }] },
        indicadoresValores: { conInformacion: true, creditosVigentes: "7", creditosCerrados: "11", totalPrincipal: "17", totalCodeudorOtros: "1", valorInicial: "2500", saldoActual: "1200", valorCuota: "85", saldoMora: "359", porcentajeDeuda: "48", sectores: [
          { sector: "Sector Financiero", creditosVigentes: "5", creditosCerrados: "8", totalPrincipal: "13", totalCodeudorOtros: "0", valorInicial: "2000", saldoActual: "1100", valorCuota: "70", saldoMora: "40", porcentajeDeuda: "55" },
          { sector: "Sector Telcos", creditosVigentes: "2", creditosCerrados: "3", totalPrincipal: "4", totalCodeudorOtros: "1", valorInicial: "500", saldoActual: "100", valorCuota: "15", saldoMora: "319", porcentajeDeuda: "20" },
        ] },
      },
      informacionRiesgo: { conInformacion: true, score: "885", txtProbabilidad: "Probabilidad de prueba", viabilidad: "ALTA", ratingRecaudos: "A", txtRecaudos: "Resultado ilustrativo", montoSugerido: "2500000", alertas: [{ alerta: "Alerta sintética", colocacion: "2026-10-20", modificacion: "2026-10-20" }] },
      endeudamiento: { conInformacion: true, ingreso: "5000000", porcentajeCuotaVsIngreso: "31.5" },
      sugerencias: { conInformacion: true, vectorSugerencias: [{ titulo: "Sugerencia sintética", sugerencia: [{ descripcion: "Verificar información de prueba" }] }] },
    },
  } };
}

const assessment = (id = "assessment-a", changes = {}) => ({
  id, documentLabel: "00123456789", platform: "IPHONE", providerEnvironment: "production", status: "APROBADO", score: 885, decision: "APROBADO",
  offer: { initialPaymentPercentage: 20, suretyPercentage: 10, maxFinancedAmount: 3_500_000, decisionRule: "SCORE_BAND" }, policyVersion: 4,
  reusedFromAssessmentId: null, consentAt: "2026-10-20T16:20:00.000Z",
  actor: { userId: 1, userName: "Administrador de prueba", sellerId: 2, sellerName: "Asesor de prueba", sedeId: 3, sedeName: "Sede de prueba", aliadoId: 4, aliadoName: "Aliado de prueba" },
  correlationId: "correlation-test", transactionCode: "05", providerStatus: "ACCEPTED", errorCode: null, durationMs: 987,
  expiresAt: "2026-11-04T16:24:00.000Z", consumedAt: null, creditId: null, retainedUntil: "2026-11-19T16:24:00.000Z",
  createdAt: "2026-10-20T16:24:00.000Z", updatedAt: "2026-10-20T16:24:00.000Z", ...changes,
});
const provider = { enabled: true, environment: "production", isProduction: true };
const list = (items = [assessment()], changes = {}) => ({ ok: true, items, provider, nextCursor: null, ...changes });
const detail = (item = assessment(), changes = {}) => ({ ok: true, assessment: item, identity: { documentNumber: item.documentLabel, firstSurname: "PRUEBA" },
  summary: buildDataCreditoAdminRiskSummary(providerFixture()), providerData: sanitizeDataCreditoProviderPayload(providerFixture()), historicWithoutDossier: false, ...changes });

function mount(fetchImplementation) {
  const scopes = new Map(); let slots, index = 0, tree, dirty = true, effects = [];
  const hooks = {
    useState(initial) { const position = index++; slots[position] ??= { value: typeof initial === "function" ? initial() : initial }; const slot = slots[position]; return [slot.value, value => { slot.value = typeof value === "function" ? value(slot.value) : value; dirty = true; }]; },
    useRef(initial) { const position = index++; return slots[position] ??= { current: initial }; },
    useMemo(factory, deps) { const position = index++; if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { deps, value: factory() }; return slots[position].value; },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(effect, deps) { const position = index++; if (!slots[position] || !sameDeps(slots[position].deps, deps)) { const old = slots[position]; const slot = slots[position] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slot.cleanup = effect(); }); } },
    useId() { return hooks.useMemo(() => `test-id-${index}`, []); },
  };
  const requests = [];
  const fetch = async (url, options) => {
    assert.ok(url === listUrl || url.startsWith(listUrl + "/"), "History must never dispatch provider/evaluation requests");
    const body = options?.body ? JSON.parse(options.body) : null;
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.method || "GET", url === listUrl ? "POST" : "GET");
    requests.push({ url, options, body });
    return fetchImplementation(url, options, body);
  };
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module: loaded, exports: loaded.exports, fetch, console, Intl, Date, Error, Number, String,
    AbortController, DOMException, URLSearchParams, setTimeout, clearTimeout,
    document: { getElementById: () => ({ focus() {}, scrollIntoView() {} }), querySelector: () => ({ focus() {} }) },
    window: { requestAnimationFrame(callback) { callback(); }, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: callback => callback(),
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name === "@/app/_components/finser-ui") return controls;
      if (name.endsWith(".module.css")) return { default: controls };
      if (name === "next/link") return { default: "a" };
      throw new Error(name);
    },
  });
  function expand(node, path = "root") {
    if (Array.isArray(node)) return node.map((child, i) => expand(child, path + i));
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const priorSlots = slots, priorIndex = index;
      scopes.set(path, scopes.get(path) || []); slots = scopes.get(path); index = 0;
      const result = node.type(node.props || {}); slots = priorSlots; index = priorIndex;
      return expand(result, path + ":component");
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, path + ":children"), action: expand(node.props?.action, path + ":action") } };
  }
  return {
    requests,
    async flush() { for (let i = 0; i < 30; i++) { if (dirty) { dirty = false; effects = []; tree = expand(jsx(loaded.exports.default, {})); for (const effect of effects) effect(); } await setImmediate(); if (!dirty) return; } throw new Error("History UI did not settle"); },
    all(predicate) { return descendants(tree).filter(predicate); },
    find(predicate) { const found = descendants(tree).find(predicate); assert.ok(found, "Expected rendered history control"); return found; },
    text() { return text(tree); },
  };
}
const button = (h, label) => h.find(node => (node.type === "Button" || node.type === "button") && (node.props?.["aria-label"] === label || text(node.props?.children).trim() === label));
const inputByLabel = (h, label) => {
  const labelled = h.all(node => ["Input", "Select", "input", "select"].includes(node.type) && node.props?.["aria-label"] === label)[0];
  if (labelled) return labelled;
  const labelNode = h.find(node => node.type === "label" && text(node).includes(label));
  return descendants(labelNode).find(node => ["Input", "Select", "input", "select"].includes(node.type));
};
const change = (h, label, value) => { const control = inputByLabel(h, label); assert.ok(control, label); control.props.onChange({ target: { value } }); };
const submit = h => h.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
const open = (h, document = "00123456789") => button(h, "Ver expediente de " + document).props.onClick();

test("consulta administrativa preserva ceros de cédula, filtros exactos y cuerpo privado sin consultas pagas", async () => {
  const h = mount(async () => Response.json(list())); await h.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.limit, 25);
  change(h, "Cédula exacta", "00.123 456789"); change(h, "Resultado", "RECHAZADO"); change(h, "Plataforma", "ANDROID");
  change(h, "Desde", "2026-10-01"); change(h, "Hasta", "2026-10-20"); await h.flush(); submit(h); await h.flush();
  assert.deepEqual(h.requests.at(-1).body, { documentNumber: "00123456789", status: "RECHAZADO", platform: "ANDROID", dateFrom: "2026-10-01", dateTo: "2026-10-20", cursor: null, limit: 25 });
  assert.equal(inputByLabel(h, "Cédula exacta").props.type === "number", false);
  assert.ok(h.requests.every(request => !request.url.includes("00123456789")));
});

test("cargar más conserva filtros aplicados y añade resultados sin usar cambios no enviados", async () => {
  const h = mount(async (_url, _options, body) => Response.json(body.cursor ? list([assessment("b", { documentLabel: "00999999999" })]) : list(undefined, { nextCursor: "cursor-secret" }))); await h.flush();
  change(h, "Resultado", "APROBADO"); await h.flush(); submit(h); await h.flush();
  change(h, "Resultado", "RECHAZADO"); await h.flush(); button(h, "Cargar más").props.onClick(); await h.flush();
  assert.equal(h.requests.at(-1).body.status, "APROBADO"); assert.equal(h.requests.at(-1).body.cursor, "cursor-secret");
  assert.match(h.text(), /00123456789/); assert.match(h.text(), /00999999999/);
});

test("errores de listado conservan filtros y pueden reintentarse sin una evaluación nueva", async () => {
  let fail = false; const h = mount(async () => fail ? Response.json({ error: "Historial temporalmente no disponible" }, { status: 503 }) : Response.json(list())); await h.flush();
  change(h, "Cédula exacta", "00076543210"); await h.flush(); fail = true; submit(h); await h.flush();
  assert.match(h.text(), /Historial temporalmente no disponible/); assert.equal(inputByLabel(h, "Cédula exacta").props.value, "00076543210");
  fail = false; button(h, "Actualizar historial").props.onClick(); await h.flush();
  assert.equal(h.requests.at(-1).body.documentNumber, "00076543210"); assert.doesNotMatch(h.text(), /Historial temporalmente no disponible/);
});

test("expediente mantiene los datos de riesgo y todas las secciones dentro de desplegables cerrados", async () => {
  const h = mount(async url => Response.json(url === listUrl ? list() : detail(assessment("assessment-a", { score: 368 })))); await h.flush(); open(h); await h.flush();
  assert.match(h.text(), /CLIENTE DE PRUEBA/); assert.match(h.text(), /1\.200\.000/); assert.match(h.text(), /359\.000/);
  for (const heading of ["Identidad y validación", "Riesgo, recaudos y alertas", "Resumen Telcos", "Evolución de saldos y cuotas", "Historial global de comportamiento de pago", "Endeudamiento", "Sugerencias de MiDecisor", "Información de la transacción"]) {
    const section = h.all(node => node.type === "details" && text(node).includes(heading))[0]; assert.ok(section, heading); assert.notEqual(section.props.open, true, heading);
  }
  assert.match(h.text(), /885/); assert.match(h.text(), /368/);
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].url, listUrl + "/assessment-a");
});

test("fallo del expediente conserva el listado y muestra un error claro", async () => {
  const h = mount(async url => url === listUrl ? Response.json(list()) : Response.json({ error: "No fue posible descifrar este expediente" }, { status: 503 })); await h.flush(); open(h); await h.flush();
  assert.match(h.text(), /No fue posible descifrar este expediente/); assert.match(h.text(), /00123456789/);
  assert.ok(button(h, "Ver expediente de 00123456789"));
});

test("respuesta tardía de otro cliente no sustituye el expediente seleccionado", async () => {
  const first = defer(), second = defer();
  const h = mount(async url => url === listUrl ? Response.json(list([assessment(), assessment("assessment-b", { documentLabel: "00999999999" })])) : url.endsWith("assessment-a") ? first.promise : second.promise);
  await h.flush(); open(h); await h.flush(); open(h, "00999999999"); await h.flush();
  second.resolve(Response.json(detail(assessment("assessment-b", { documentLabel: "00999999999" }), { identity: { documentNumber: "00999999999", firstSurname: "SEGUNDO" }, summary: null, providerData: null }))); await h.flush();
  assert.match(h.text(), /CC\s+00999999999/);
  first.resolve(Response.json(detail())); await h.flush(); assert.match(h.text(), /CC\s+00999999999/); assert.doesNotMatch(h.text(), /CLIENTE DE PRUEBA/);
});

test("cerrar el expediente invalida una respuesta pendiente y conserva los filtros y resultados", async () => {
  const pending = defer(); const h = mount(async url => url === listUrl ? Response.json(list()) : pending.promise); await h.flush();
  open(h); await h.flush(); button(h, "Cerrar expediente").props.onClick(); await h.flush();
  pending.resolve(Response.json(detail())); await h.flush();
  assert.doesNotMatch(h.text(), /CLIENTE DE PRUEBA/); assert.ok(button(h, "Ver expediente de 00123456789"));
});

test("una página o expediente antiguos no reaparecen después de aplicar otros filtros", async () => {
  const pendingList = defer(), pendingDetail = defer();
  const h = mount(async (url, _options, body) => url !== listUrl ? pendingDetail.promise : body.cursor ? pendingList.promise : Response.json(list([assessment()], { nextCursor: "next-page" }))); await h.flush();
  open(h); await h.flush(); button(h, "Cargar más").props.onClick(); await h.flush();
  change(h, "Cédula exacta", "00999999999"); await h.flush(); submit(h); await h.flush();
  pendingList.resolve(Response.json(list([assessment("late", { documentLabel: "00888888888" })]))); pendingDetail.resolve(Response.json(detail())); await h.flush();
  assert.doesNotMatch(h.text(), /00888888888|CLIENTE DE PRUEBA/); assert.equal(inputByLabel(h, "Cédula exacta").props.value, "00999999999");
});

test("carga, vacío e históricos sin expediente muestran estados reales y advertencia de certificación", async () => {
  const pending = defer(); const h = mount(async () => pending.promise); await h.flush(); assert.ok(h.all(node => node.type === "LoadingState").length);
  pending.resolve(Response.json(list([], { provider: { enabled: true, environment: "demo", isProduction: false } }))); await h.flush();
  assert.ok(h.all(node => node.type === "EmptyState").length); assert.match(h.text(), /certificación/); assert.equal(h.requests.length, 1);
  const historical = mount(async url => Response.json(url === listUrl ? list() : detail(assessment(), { historicWithoutDossier: true, summary: null, providerData: null }))); await historical.flush(); open(historical); await historical.flush();
  assert.match(historical.text(), /antes de habilitar el expediente cifrado/); assert.equal(historical.requests.length, 2);
});

test("limpiar restablece los filtros y cierra el expediente sin tocar registros", async () => {
  const h = mount(async url => Response.json(url === listUrl ? list() : detail())); await h.flush();
  change(h, "Cédula exacta", "00076543210"); change(h, "Resultado", "APROBADO"); change(h, "Desde", "2026-10-01"); await h.flush(); submit(h); await h.flush();
  open(h); await h.flush(); assert.match(h.text(), /CLIENTE DE PRUEBA/);
  button(h, "Limpiar filtros").props.onClick(); await h.flush();
  assert.deepEqual(h.requests.at(-1).body, { documentNumber: "", status: "", platform: "", dateFrom: "", dateTo: "", cursor: null, limit: 25 });
  assert.equal(inputByLabel(h, "Cédula exacta").props.value, ""); assert.doesNotMatch(h.text(), /CLIENTE DE PRUEBA/);
});

test("la ruta exige acceso central antes de renderizar historial y conserva la navegación administrativa", async () => {
  const pageSource = readFileSync(new URL("../app/dashboard/datacredito/page.tsx", import.meta.url), "utf8");
  let guardCalls = 0, allowed = true, rendered = 0;
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(pageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx: (type, props) => { rendered++; return jsx(type, props); }, jsxs: (type, props) => { rendered++; return jsx(type, props); } };
      if (name === "@/lib/dashboard-access") return { requireCentralAdminDashboardAccess: async () => { guardCalls++; if (!allowed) throw new Error("CENTRAL_ACCESS_DENIED"); return { session: { nombre: "Administradora de prueba", rolNombre: "ADMIN" } }; } };
      if (name === "@/app/dashboard/_components/finser-navigation") return { default: "FinserNavigation" };
      if (name === "@/app/_components/finser-support-link") return { default: "FinserSupportLink" };
      if (name === "lucide-react") return controls;
      if (name === "./datacredito-admin-console") return { default: "DataCreditoAdminConsole" };
      throw new Error(name);
    },
  });
  const page = await loaded.exports.default();
  assert.equal(guardCalls, 1);
  const navigation = descendants(page).find(node => node.type === "FinserNavigation");
  assert.ok(navigation); assert.equal(navigation.props.admin, true); assert.equal(navigation.props.adminCentral, true);
  assert.equal(navigation.props.nombreUsuario, "Administradora de prueba"); assert.equal(navigation.props.activeSection, "integrations");
  assert.equal(navigation.props.variant, "administration"); assert.ok(descendants(page).some(node => node.type === "DataCreditoAdminConsole"));
  const before = rendered; allowed = false;
  await assert.rejects(loaded.exports.default(), /CENTRAL_ACCESS_DENIED/); assert.equal(guardCalls, 2); assert.equal(rendered, before);
});
