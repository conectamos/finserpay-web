import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const placeholder = (name) => Object.defineProperty(() => null, "name", { value: name });
const ui = Object.fromEntries(["Badge", "Button", "EmptyState", "LoadingState"].map((name) => [name, placeholder(name)]));
const Correction = placeholder("ApprovalEvidenceCorrection");
const icons = new Proxy({}, { get: (_, key) => placeholder(String(key)) });
let active;
const react = {
  useState(initial) {
    const instance = active, index = instance.index++;
    if (!(index in instance.slots)) instance.slots[index] = typeof initial === "function" ? initial() : initial;
    return [instance.slots[index], (value) => { instance.slots[index] = typeof value === "function" ? value(instance.slots[index]) : value; }];
  },
  useRef(initial) {
    const instance = active, index = instance.index++;
    instance.slots[index] ||= { current: initial };
    return instance.slots[index];
  },
  useCallback(fn) { return fn; },
  useEffect() {},
};
function load(file, dependencies = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, { module: loadedModule, exports: loadedModule.exports, require(name) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "lucide-react") return icons;
    if (name === "@/app/_components/finser-ui") return ui;
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return loadedModule.exports.default;
}
const SharedGallery = load("app/revision-creditos/shared-evidence-gallery.tsx", {
  "@/app/dashboard/aprobaciones/approval-evidence-correction": { default: Correction },
});
const Pdf = load("app/dashboard/aprobaciones/last-pdf-page-preview.tsx", {
  "./last-pdf-page": { loadLastPdfPage() {}, renderLastPdfPage() {}, lastPageErrorMessage() {} },
});
const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) :
  node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : [];
const text = (node) => Array.isArray(node) ? node.map(text).join("") :
  node && typeof node === "object" ? text(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);
function mount(Component, props) {
  const instance = { index: 0, slots: [] };
  let tree;
  return {
    render(nextProps = props) { props = nextProps; active = instance; instance.index = 0; tree = Component(props); active = null; return this; },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, "Expected rendered control"); return node; },
    all(predicate) { return nodes(tree).filter(predicate); },
    text() { return text(tree); },
  }.render();
}
const detail = () => ({
  id: 87, folio: "QA-87", clienteNombre: "Cliente de prueba",
  review: { revision: 4, reviewHash: "a".repeat(64) },
  capabilities: { canCorrectEvidence: true, correctionBlockedReason: null },
  evidence: ["Frente", "Respaldo", "Selfie", "Entrega", "Remisión"].map((label, index) => ({
    key: "photo-" + index, label, available: index !== 0, href: `/api/aprobaciones/87/evidencias/photo-${index}?v=4`,
  })),
});
function gallery(overrides = {}) {
  const props = { detail: detail(), readOnly: false, disabled: false, onUpdated: async () => {}, onBusyChange() {}, ...overrides };
  const root = SharedGallery(props);
  return mount(root.type, root.props);
}
const toggle = (h) => h.find((node) => node.type === ui.Button && "aria-expanded" in node.props);
const photo = (h) => h.find((node) => typeof node.type === "function" && node.props.item && !node.props.thumbnail);

test("la galería cuenta archivos reales y selecciona evidencias sin confundir disponibilidad con aprobación", () => {
  const h = gallery();
  assert.match(h.text(), /4 de 5 disponibles/);
  assert.match(h.text(), /no significa que esté aprobado/);
  assert.equal(h.all((node) => node.type === "button" && "aria-pressed" in node.props).length, 5);
  assert.equal(photo(h).props.item.key, "photo-1");
  h.find((node) => node.type === "button" && node.props["aria-label"] === "Remisión").props.onClick();
  h.render();
  assert.equal(photo(h).props.item.key, "photo-4");
  assert.equal(h.find((node) => node.type === "button" && node.props["aria-label"] === "Remisión").props["aria-pressed"], true);
  h.find((node) => node.type === "button" && node.props["aria-label"] === "Frente, no disponible").props.onClick();
  h.render();
  const selected = photo(h);
  const missing = mount(selected.type, selected.props);
  assert.match(missing.text(), /Fotografía no disponible/);
  assert.equal(missing.all((node) => node.type === "img" || node.type === "a").length, 0);
});

test("la foto conserva el original autenticado, informa dimensiones y se recupera de un error", () => {
  const selected = photo(gallery());
  const h = mount(selected.type, selected.props);
  const image = h.find((node) => node.type === "img");
  assert.equal(image.props.src, selected.props.item.href);
  assert.match(image.props.className, /object-contain/);
  image.props.onLoad({ currentTarget: { naturalWidth: 2400, naturalHeight: 3200 } });
  h.render();
  assert.match(h.text(), /Resolución original: 2400 × 3200 px/);
  assert.equal(h.find((node) => node.type === "a").props.href, selected.props.item.href);
  assert.equal(h.find((node) => node.type === "a").props.target, "_blank");
  h.find((node) => node.type === "img").props.onError();
  h.render();
  assert.match(h.text(), /No se pudo cargar la fotografía/);
  assert.doesNotMatch(h.text(), /2400 × 3200/);
  h.find((node) => node.type === ui.Button).props.onClick();
  h.render();
  assert.equal(h.find((node) => node.type === "img").props.src, selected.props.item.href + "&retry=1");
  assert.equal(h.find((node) => node.type === "a").props.href, selected.props.item.href);
});

test("un reemplazo pendiente permanece abierto y no se bloquea a sí mismo", () => {
  const events = [], current = detail();
  const onUpdated = async () => {};
  const h = gallery({ detail: current, onBusyChange: (busy) => events.push(busy), onUpdated });
  toggle(h).props.onClick(); h.render();
  let correction = h.find((node) => node.type === Correction);
  assert.equal(correction.props.detail, current);
  assert.equal(correction.props.onUpdated, onUpdated);
  assert.equal(correction.props.disabled, false);
  correction.props.onBusyChange(true); h.render();
  assert.equal(toggle(h).props.disabled, true, "No debe cerrar y perder la foto sin guardar");
  correction = h.find((node) => node.type === Correction);
  assert.equal(correction.props.disabled, false, "El busy del propio formulario no debe bloquear Guardar o Cancelar");
  assert.deepEqual(events, [true]);
  correction.props.onBusyChange(false); h.render();
  assert.equal(toggle(h).props.disabled, false);
  assert.deepEqual(events, [true, false]);
});

test("aprobadas permanece solo lectura y una restricción real impide abrir el corrector", () => {
  const approved = gallery({ readOnly: true });
  assert.equal(approved.all((node) => node.type === ui.Button || node.type === Correction).length, 0);
  const current = detail();
  current.capabilities = { canCorrectEvidence: false, correctionBlockedReason: "El crédito está liquidado." };
  const restricted = gallery({ detail: current });
  assert.equal(toggle(restricted).props.disabled, true);
  assert.match(restricted.text(), /El crédito está liquidado/);
  assert.equal(restricted.all((node) => node.type === Correction).length, 0);
});

test("cambiar el crédito o su revisión descarta estado de imágenes y selección anterior", () => {
  const current = detail(), props = { detail: current, readOnly: false, onUpdated: async () => {}, onBusyChange() {} };
  const original = SharedGallery(props);
  const anotherCredit = SharedGallery({ ...props, detail: { ...current, id: 88 } });
  const anotherRevision = SharedGallery({ ...props, detail: { ...current, review: { ...current.review, reviewHash: "b".repeat(64) } } });
  assert.notEqual(original.key, anotherCredit.key);
  assert.notEqual(original.key, anotherRevision.key);
  const h = gallery({ detail: { ...current, evidence: [] } });
  assert.match(h.text(), /0 de 0 disponibles/);
  assert.equal(h.find((node) => node.type === ui.EmptyState).props.title, "Sin fotografías registradas");
});

test("el PDF compacto limita solo su panel y mantiene los controles y el tamaño administrativo", () => {
  const standard = mount(Pdf, { href: "/private/doc", folio: "QA-87" });
  const compact = mount(Pdf, { href: "/private/doc", folio: "QA-87", compact: true });
  assert.equal(standard.find((node) => node.props.style?.maxHeight).props.style.maxHeight, "75vh");
  assert.equal(compact.find((node) => node.props.style?.maxHeight).props.style.maxHeight, "min(60vh, 32rem)");
  for (const h of [standard, compact]) {
    assert.equal(h.all((node) => node.type === "canvas").length, 1);
    assert.ok(h.find((node) => node.props["aria-label"] === "Ampliar última página"));
    assert.ok(h.find((node) => node.props["aria-label"] === "Reducir última página"));
    assert.match(h.text(), /Última página del documento firmado/);
  }
});