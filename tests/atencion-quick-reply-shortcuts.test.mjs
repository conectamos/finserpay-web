import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../app/dashboard/atencion/attention-quick-reply-shortcuts.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" ? text(value.props?.children) : ["string", "number"].includes(typeof value) ? String(value) : "";
const reply = (n, title, body = title) => ({ id: `reply-${n}`, title, text: body, approvedBy: "Central QA", approvedAt: "2026-11-01T15:00:00Z" });
const replies = [reply(1, "Bienvenida", "Hola, gracias por escribir."), reply(2, "Información de pago", "Puedes consultar tus canales de pago."), reply(3, "Revisión", "Estamos revisando la información recibida.")];

function mount(initial = {}) {
  let cursor = 0, dirty = false, effects = [], result, now = 0, timerId = 0;
  const slots = [], timers = new Map(), changes = [], errors = [];
  const popupList = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 300 }), querySelector() {
    const selected = nodes(result.menu).filter(node => node.props.role === "option").findIndex(node => node.props["aria-selected"]);
    return selected < 0 ? null : { getBoundingClientRect: () => ({ top: 100 + selected * 60 - this.scrollTop, bottom: 160 + selected * 60 - this.scrollTop }) };
  } };
  const input = { value: initial.text ?? "/", selectionStart: (initial.text ?? "/").length, selectionEnd: (initial.text ?? "/").length, disabled: false, focuses: 0,
    focus() { this.focuses++; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const props = { text: input.value, replies, disabled: false, maxLength: 4096, inputRef: { current: input },
    onChange(value) { changes.push(value); props.text = value; input.value = value; dirty = true; }, onError: value => errors.push(value), ...initial };
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[n].value, value => { slots[n].value = typeof value === "function" ? value(slots[n].value) : value; dirty = true; }]; },
    useRef(initial) { const n = cursor++; slots[n] ??= { current: initial }; return slots[n]; },
    useId() { const n = cursor++; slots[n] ??= { value: `:qa:${n}:` }; return slots[n].value; },
    useEffect(effect, deps) { const n = cursor++; if (!slots[n] || deps.some((value, i) => !Object.is(value, slots[n].deps[i]))) effects.push(() => { slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: effect() }; }); },
  };
  react.useLayoutEffect = react.useEffect;
  const loaded = { exports: {} };
  runInNewContext(source, { module: loaded, exports: loaded.exports,
    setTimeout(fn, delay) { const key = ++timerId; timers.set(key, { fn, at: now + delay }); return key; }, clearTimeout: key => timers.delete(key),
    require(name) { if (name === "react") return react; if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" }; if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) }; throw new Error(name); },
  });
  function render() { cursor = 0; dirty = false; effects = []; result = loaded.exports.useAttentionQuickReplyShortcuts(props); const list = nodes(result.menu).find(node => node.props.role === "listbox"); if (list?.props.ref) list.props.ref.current = popupList; effects.forEach(effect => effect()); }
  async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(); } }
  async function advance(ms = 0) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [key, timer] = next; timers.delete(key); now = timer.at; timer.fn(); await flush(); } now = until; await flush(); }
  function keyEvent(key, patch = {}) { return { key, defaultPrevented: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: key === "Enter" ? 13 : 0 }, currentTarget: input, preventDefault() { this.defaultPrevented = true; }, ...patch }; }
  render();
  return { changes, errors, input, props, popupList, flush, advance, result: () => result,
    all: () => nodes(result.menu), text: () => text(result.menu), options: () => nodes(result.menu).filter(node => node.props.role === "option"),
    async update(patch, caret) { Object.assign(props, patch); if ("text" in patch) { input.value = patch.text; input.selectionStart = caret ?? patch.text.length; input.selectionEnd = caret ?? patch.text.length; } render(); await flush(); },
    async caret(start, end = start) { input.selectionStart = start; input.selectionEnd = end; result.onCaretChange(); await flush(); },
    async key(key, patch = {}) { const event = keyEvent(key, patch), consumed = result.onKeyDown(event); await flush(); return { event, consumed }; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("slash muestra títulos y texto aprobados reales; listado accesible no inventa respuestas", async () => {
  const h = mount(); await h.advance();
  assert.equal(h.options().length, 3); assert.match(h.text(), /BienvenidaHola, gracias por escribir/); assert.match(h.text(), /Se inserta en el borrador/);
  assert.equal(h.result().expanded, true); assert.equal(h.result().popupProps["aria-expanded"], undefined); assert.equal(h.result().popupProps["aria-haspopup"], "listbox");
  const list = h.all().find(node => node.props.role === "listbox"); assert.equal(h.result().popupProps["aria-controls"], list.props.id); assert.equal(h.result().popupProps["aria-activedescendant"], h.options()[0].props.id);
  assert.equal(h.changes.length, 0); h.unmount();
});

test("consulta ignora acentos y mayúsculas y busca título o contenido; limita ocho opciones", async () => {
  const h = mount({ text: "/INFORMACION" }); await h.advance(); assert.equal(h.options().length, 2); assert.match(h.text(), /Información de pago/); assert.match(h.text(), /Revisión/);
  await h.update({ text: "/GRACIAS" }); await h.advance(); assert.equal(h.options().length, 1); assert.match(h.text(), /Bienvenida/);
  await h.update({ text: "/", replies: Array.from({ length: 12 }, (_, n) => reply(n, `Respuesta ${n}`)) }); await h.advance(); assert.equal(h.options().length, 8); h.unmount();
});

test("sólo abre con slash al inicio o después de un espacio; enlaces y doble slash siguen nativos", async () => {
  for (const value of ["Hola", "https://finserpay.com", "hola/bie", "//bie", "otro //bie", "sin /bien texto"]) {
    const h = mount({ text: value }); await h.advance(); assert.equal(h.result().menu, null, value); assert.equal((await h.key("Enter")).consumed, false); h.unmount();
  }
  for (const value of ["/bie", "Hola /bie", "Hola\n/bie"]) { const h = mount({ text: value }); await h.advance(); assert.ok(h.result().menu, value); h.unmount(); }
});

test("flechas recorren y envuelven opciones; Enter inserta sin enviar y restaura el cursor", async () => {
  const h = mount(); await h.advance();
  assert.equal((await h.key("ArrowUp")).consumed, true); assert.equal(h.options()[2].props["aria-selected"], true);
  await h.key("ArrowDown"); assert.equal(h.options()[0].props["aria-selected"], true);
  await h.key("ArrowDown"); const event = await h.key("Enter"); assert.equal(event.consumed, true); assert.equal(event.event.defaultPrevented, true);
  assert.deepEqual(h.changes, [replies[1].text]); assert.equal(h.result().menu, null); await h.advance(); assert.equal(h.input.selectionStart, replies[1].text.length); assert.equal(h.input.focuses, 1); h.unmount();
});

test("Tab inserta la selección visible y no activa un envío ni crea otro mensaje", async () => {
  const h = mount({ text: "/bie" }); await h.advance(); const action = await h.key("Tab"); assert.equal(action.consumed, true); assert.equal(action.event.defaultPrevented, true); assert.deepEqual(h.changes, [replies[0].text]); h.unmount();
});

test("flechas mantienen visible la octava opción desplazando únicamente la lista emergente", async () => {
  const h = mount({ replies: Array.from({ length: 8 }, (_, n) => reply(n, `Respuesta ${n}`)) }); await h.advance();
  assert.equal(h.popupList.scrollTop, 0); await h.key("ArrowUp"); assert.equal(h.options()[7].props["aria-selected"], true); assert.equal(h.popupList.scrollTop, 280);
  await h.key("ArrowDown"); assert.equal(h.options()[0].props["aria-selected"], true); assert.equal(h.popupList.scrollTop, 0); assert.equal(h.input.selectionStart, 1); assert.equal(h.changes.length, 0); h.unmount();
});

test("Escape cierra hasta cambiar consulta; mover caret sin cambiar query no lo reabre", async () => {
  const h = mount({ text: "/bi" }); await h.advance(); assert.equal((await h.key("Escape")).consumed, true); assert.equal(h.result().menu, null);
  await h.caret(3); await h.advance(); assert.equal(h.result().menu, null); assert.equal((await h.key("Enter")).consumed, false);
  await h.update({ text: "/bie" }); await h.advance(); assert.ok(h.result().menu); h.unmount();
});

test("una consulta distinta libera Escape aunque luego vuelva al mismo texto", async () => {
  const h = mount({ text: "/bi" }); await h.advance(); await h.key("Escape");
  await h.update({ text: "/" }); await h.advance(); assert.ok(h.result().menu);
  await h.update({ text: "/bi" }); await h.advance(); assert.ok(h.result().menu); h.unmount();
});

test("sin coincidencias Enter no envía el comando literal; lista vacía muestra estado real", async () => {
  const h = mount({ text: "/inexistente" }); await h.advance(); assert.equal(h.options().length, 0); assert.match(h.text(), /No hay respuestas que coincidan/); assert.equal(h.result().popupProps["aria-activedescendant"], undefined);
  const action = await h.key("Enter"); assert.equal(action.consumed, true); assert.equal(action.event.defaultPrevented, true); assert.equal(h.changes.length, 0); h.unmount();
  const empty = mount({ replies: [] }); await empty.advance(); assert.match(empty.text(), /No hay respuestas rápidas aprobadas/); assert.equal((await empty.key("Enter")).consumed, true); assert.equal(empty.changes.length, 0); empty.unmount();
});

test("IME, Shift y modificadores se conservan; Enter repetido se consume sin insertar", async () => {
  const h = mount(); await h.advance();
  for (const patch of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { defaultPrevented: true }]) {
    assert.equal((await h.key("Enter", patch)).consumed, false);
  }
  assert.equal((await h.key("Enter", { repeat: true })).consumed, true); assert.equal(h.changes.length, 0); assert.equal((await h.key("a")).consumed, false); h.unmount();
});

test("reemplaza token bajo el cursor conservando texto anterior y posterior sin agregar espacios", async () => {
  const value = "Inicio /bienvenida al final", h = mount({ text: value }); await h.advance(); await h.caret("Inicio /bie".length);
  assert.ok(h.result().menu); await h.key("Enter"); assert.deepEqual(h.changes, [`Inicio ${replies[0].text} al final`]); await h.advance(); assert.equal(h.input.selectionStart, "Inicio ".length + replies[0].text.length); h.unmount();
});

test("selección de texto no activa atajos y un caret cambiado antes del clic impide inserción obsoleta", async () => {
  const h = mount({ text: "/bie" }); await h.advance(); const option = h.options()[0];
  await h.caret(0, 4); assert.equal(h.result().menu, null); assert.equal((await h.key("Enter")).consumed, false);
  option.props.onClick(); await h.flush(); assert.equal(h.changes.length, 0); h.unmount();
});

test("clic conserva foco y sólo inserta; entrada modificada sin render descarta opción vieja", async () => {
  const h = mount({ text: "/bie" }); await h.advance(); const option = h.options()[0], event = { prevented: false, preventDefault() { this.prevented = true; } };
  option.props.onMouseDown(event); assert.equal(event.prevented, true); option.props.onClick(); await h.flush(); assert.deepEqual(h.changes, [replies[0].text]); h.unmount();
  const stale = mount({ text: "/bie" }); await stale.advance(); const old = stale.options()[0]; stale.input.value = "/pago"; stale.input.selectionStart = 5; stale.input.selectionEnd = 5; old.props.onClick(); await stale.flush(); assert.equal(stale.changes.length, 0); stale.unmount();
});

test("inserción que supera límite conserva borrador y menú; informa validación sin recortar texto", async () => {
  const h = mount({ text: "/bie", maxLength: 10 }); await h.advance(); assert.equal((await h.key("Enter")).consumed, true);
  assert.equal(h.changes.length, 0); assert.equal(h.props.text, "/bie"); assert.ok(h.result().menu); assert.match(h.errors[0], /límite de 10 caracteres/); h.unmount();
  const exact = mount({ text: "/bie", maxLength: replies[0].text.length }); await exact.advance(); await exact.key("Enter"); assert.deepEqual(exact.changes, [replies[0].text]); exact.unmount();
});

test("bloqueo o pérdida del catálogo oculta datos y no permite seleccionar una opción antigua", async () => {
  const h = mount(); await h.advance(); const old = h.options()[0]; await h.update({ disabled: true }); assert.equal(h.result().menu, null); assert.equal((await h.key("Enter")).consumed, false);
  old.props.onClick(); await h.flush(); assert.equal(h.changes.length, 0);
  await h.update({ disabled: false, replies: [] }); old.props.onClick(); await h.flush();
  assert.equal(h.changes.length, 0); assert.equal(h.options().length, 0); h.unmount();
});

test("desmontar cancela restauración del cursor y cambiar input evita enfocar otro chat", async () => {
  const h = mount(); await h.advance(); await h.key("Enter"); h.unmount(); await h.advance(); assert.equal(h.input.focuses, 0);
  const switched = mount(); await switched.advance(); await switched.key("Enter"); switched.props.inputRef.current = { value: "Otro chat" }; await switched.advance(); assert.equal(switched.input.focuses, 0); switched.unmount();
});
