import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const sourcePath = new URL("../app/dashboard/atencion/attention-image-viewer.tsx", import.meta.url);
const privateUrl = "/api/atencion/00000000-0000-4000-8000-000000000001/messages/00000000-0000-4000-8000-000000000002/media";
const workUrl = "/api/atencion/solicitudes/00000000-0000-4000-8000-000000000003/files/00000000-0000-4000-8000-000000000004";
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" ? text(value.props?.children) : typeof value === "string" || typeof value === "number" ? String(value) : "";

// Execute the actual viewer lifecycle against inert DOM methods. The image route
// remains private; this harness never downloads client media or sends a message.
function mount({ url = privateUrl, name = "Soporte recibido.jpg" } = {}) {
  const slots = [], references = new WeakMap(), events = { shown: 0, closed: 0, requestedClose: 0, restored: 0, focused: 0 };
  let cursor = 0, pending = [], tree, dirty = false;
  const document = { body: { style: { overflow: "auto" } }, activeElement: null };
  class Element {
    isConnected = true;
    clientWidth = 320;
    clientHeight = 240;
    focus() { document.activeElement = this; events.focused++; }
  }
  const launcher = new Element();
  launcher.focus = () => { document.activeElement = launcher; events.restored++; };
  document.activeElement = launcher;
  const dialog = new Element();
  dialog.open = false;
  dialog.showModal = () => { assert.equal(dialog.open, false); dialog.open = true; events.shown++; };
  dialog.close = () => { dialog.open = false; events.closed++; };
  dialog.getBoundingClientRect = () => ({ left: 10, top: 10, right: 990, bottom: 790 });
  const jsx = (type, props, key) => {
    props ||= {};
    if (props.ref && typeof props.ref === "object") {
      if (!references.has(props.ref)) references.set(props.ref, type === "dialog" ? dialog : new Element());
      props.ref.current = references.get(props.ref);
    }
    return { type, props, key };
  };
  const react = {
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useState(initial) {
      const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true; }];
    },
    useId() { return `image-viewer-${cursor++}`; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(code, {
    module: mod, exports: mod.exports, document, HTMLElement: Element,
    fetch() { assert.fail("el visor no debe realizar solicitudes de API ni enviar mensajes"); },
    require(id) {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (id === "next/image") return { default: "Image" };
      if (id === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
      if (id.endsWith("finser-ui")) return { Button: "button" };
      if (id.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      assert.fail(`Dependencia inesperada del visor: ${id}`);
    },
  });
  function render() {
    cursor = 0; pending = []; dirty = false;
    tree = mod.exports.default({ url, name, onClose() { events.requestedClose++; } });
    pending.forEach(effect => effect());
    return tree;
  }
  render();
  return {
    document, launcher, dialog, events,
    all: () => nodes(tree), text: () => text(tree),
    find: (type, predicate = () => true) => nodes(tree).find(node => node.type === type && predicate(node.props)),
    button: label => nodes(tree).find(node => node.type === "button" && node.props["aria-label"] === label),
    flush() { for (let n = 0; dirty && n < 10; n++) render(); },
    rerender: render,
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("el visor abre un diálogo modal nativo y restaura foco y desplazamiento al desmontar", () => {
  const f = mount();
  assert.equal(f.dialog.open, true); assert.equal(f.events.shown, 1);
  assert.equal(f.document.body.style.overflow, "hidden");
  assert.ok(f.find("dialog", props => props["aria-label"] === "Visor de imagen"));
  f.rerender(); assert.equal(f.events.shown, 1, "un refresco del chat no vuelve a abrir el modal");
  f.unmount();
  assert.equal(f.dialog.open, false); assert.equal(f.events.closed, 1);
  assert.equal(f.document.body.style.overflow, "auto"); assert.equal(f.document.activeElement, f.launcher); assert.equal(f.events.restored, 1);
});

test("el visor conserva la URL privada exacta para imagen y descarga sin abrir otra pestaña", () => {
  for (const url of [privateUrl, workUrl]) {
    const f = mount({ url });
    const image = f.find("Image", props => Boolean(props.src)); assert.ok(image); assert.equal(image.props.src, url); assert.equal(image.props.unoptimized, true);
    const downloads = f.all().filter(node => node.type === "a");
    assert.equal(downloads.length, 1); assert.equal(downloads[0].props.href, url);
    assert.ok(downloads[0].props.download); assert.equal(downloads[0].props.target, undefined);
    assert.equal(f.all().some(node => typeof node.props.src === "string" && node.props.src !== url), false);
    f.unmount();
  }
});

test("Escape y el botón de cerrar solicitan el cierre y no envían mensajes", () => {
  const f = mount(); let prevented = false;
  f.find("dialog").props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.events.requestedClose, 1);
  const close = f.button("Cerrar visor de imagen"); assert.ok(close); assert.equal(close.props.type, "button");
  close.props.onClick(); assert.equal(f.events.requestedClose, 2); f.unmount();
});

test("ampliar espera la carga real, duplica el tamaño visible y vuelve a ajustar la imagen", () => {
  const f = mount();
  assert.equal(f.button("Ampliar imagen").props.disabled, true);
  assert.equal(f.button("Ampliar imagen 2 veces").props.disabled, true);
  assert.match(f.text(), /Cargando imagen/);
  f.find("Image", props => Boolean(props.src)).props.onLoad(); f.flush();
  assert.equal(f.button("Ampliar imagen").props.disabled, false);
  assert.equal(f.all().some(node => node.props.role === "status"), false);
  f.button("Ampliar imagen").props.onClick(); f.flush();
  const enlarged = f.find("Image", props => Boolean(props.src));
  assert.equal(enlarged.props.src, privateUrl); assert.equal(enlarged.props.style.width, 640); assert.equal(enlarged.props.style.height, 480);
  assert.ok(f.find("div", props => props["data-zoomed"] === true));
  assert.match(f.text(), /Desplázate para revisar la imagen ampliada/);
  assert.equal(f.events.shown, 1, "el zoom no remonta ni vuelve a abrir el diálogo");
  f.button("Ajustar imagen").props.onClick(); f.flush();
  assert.equal(f.find("Image", props => Boolean(props.src)).props.style, undefined);
  assert.ok(f.find("div", props => props["data-zoomed"] === false));
  assert.equal(f.button("Ampliar imagen").props.disabled, false);
  assert.ok(f.all().filter(node => node.type === "button").every(node => node.props.type === "button"), "ningún control del visor envía el formulario del chat");
  f.unmount();
});

test("una imagen fallida conserva su descarga y permite reintentar la misma ruta privada", () => {
  const f = mount();
  const first = f.find("Image", props => Boolean(props.src));
  first.props.onError(); f.flush();
  const error = f.all().find(node => node.props.role === "alert");
  assert.match(text(error), /No se pudo cargar la imagen/);
  assert.equal(f.all().some(node => node.props.src), false, "retira la imagen rota");
  assert.equal(f.button("Ampliar imagen").props.disabled, true);
  assert.equal(f.find("a").props.href, privateUrl);
  const retry = f.find("button", props => text(props.children).includes("Reintentar imagen"));
  assert.ok(retry); retry.props.onClick(); f.flush();
  const replacement = f.find("Image", props => Boolean(props.src));
  assert.equal(replacement.props.src, privateUrl); assert.notEqual(replacement.key, first.key);
  assert.equal(f.all().some(node => node.props.role === "alert"), false);
  assert.match(f.text(), /Cargando imagen/);
  replacement.props.onLoad(); f.flush(); assert.equal(f.button("Ampliar imagen").props.disabled, false);
  assert.equal(f.events.requestedClose, 0); assert.equal(f.events.shown, 1); f.unmount();
});

test("el fondo cierra el visor y los clics sobre la imagen permanecen dentro", () => {
  const f = mount();
  const stage = f.find("div", props => props["data-zoomed"] !== undefined);
  assert.ok(stage);
  const stageElement = {}, imageElement = {};
  stage.props.onClick({ target: imageElement, currentTarget: stageElement });
  assert.equal(f.events.requestedClose, 0);
  stage.props.onClick({ target: stageElement, currentTarget: stageElement });
  assert.equal(f.events.requestedClose, 1); f.unmount();
});

test("el espacio vacío interior cierra, mientras la imagen y el teclado alternan el zoom", () => {
  for (const origin of ["empty-button", "image", "keyboard"]) {
    const f = mount();
    f.find("Image", props => Boolean(props.src)).props.onLoad(); f.flush();
    const buttonElement = {}, imageElement = {};
    const event = { detail: origin === "keyboard" ? 0 : 1, currentTarget: buttonElement, target: origin === "image" ? imageElement : buttonElement };
    f.button("Ampliar imagen 2 veces").props.onClick(event); f.flush();
    if (origin === "empty-button") {
      assert.equal(f.events.requestedClose, 1, "el área vacía no debe ampliar la imagen");
      assert.ok(f.find("div", props => props["data-zoomed"] === false));
      assert.equal(f.find("Image", props => Boolean(props.src)).props.style, undefined);
    } else {
      assert.equal(f.events.requestedClose, 0, `${origin} mantiene abierto el visor`);
      assert.ok(f.find("div", props => props["data-zoomed"] === true));
      assert.equal(f.find("Image", props => Boolean(props.src)).props.style.width, 640);
      f.button("Ajustar imagen a la pantalla").props.onClick(event); f.flush();
      assert.ok(f.find("div", props => props["data-zoomed"] === false));
      assert.equal(f.events.requestedClose, 0);
    }
    assert.equal(f.events.shown, 1); f.unmount();
  }
});

test("al cambiar de chat o perder acceso no devuelve el foco a una miniatura retirada", () => {
  const f = mount(); f.launcher.isConnected = false; f.unmount();
  assert.equal(f.events.restored, 0); assert.equal(f.dialog.open, false);
  assert.equal(f.document.body.style.overflow, "auto");
});
