import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const jsx = (type, props, key) => ({ type, props: props || {}, key });
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === "object" ? [value, ...flatten(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" ? text(value.props?.children) : typeof value === "string" || typeof value === "number" ? String(value) : "";
function receivedFiles(detail) {
  const source = readFileSync(new URL("../app/dashboard/atencion/attention-contact-summary.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", output)(name => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (name === "@/lib/atencion-work-types") return {};
    if (name === "lucide-react" || name === "@/app/_components/finser-ui") return new Proxy({}, { get: (_, key) => String(key) });
    assert.fail(`Unexpected live dependency: ${name}`);
  }, mod, mod.exports);
  return mod.exports.AttentionReceivedFiles({ detail });
}
const conversationId = "00000000-0000-4000-8000-000000000001", messageId = "00000000-0000-4000-8000-000000000002";
const received = (id, url, kind = "document", fileName = "Soporte recibido.pdf") => ({ id, direction: "inbound", sentAt: "2026-10-30T18:00:00Z", attachment: { id, kind, fileName, url } });

test("la ficha bajo demanda conserva solo archivos realmente recibidos y sus rutas privadas", () => {
  const metaUrl = `/api/atencion/${conversationId}/messages/${messageId}/media`;
  const workUrl = `/api/atencion/solicitudes/${conversationId}/files/${messageId}`;
  const tree = receivedFiles({ historyTruncated: true, messages: [
    received(messageId, metaUrl), received("work", workUrl, "image", null),
    { ...received("out", metaUrl), direction: "outbound" },
    { id: "text-only", direction: "inbound", text: "Sin archivo" },
    received("external", "https://untrusted.invalid/customer-document.pdf"),
    received("foreign-route", "/api/admin/private-document"), received("empty", null),
  ] });
  assert.equal(tree.type, "section"); assert.equal(tree.props["aria-label"], "Archivos recibidos");
  assert.ok(text(tree).includes("Archivos recibidos (5)"));
  assert.ok(text(tree).includes("Archivos del historial disponible."));
  const links = flatten(tree).filter(node => node.type === "a");
  assert.deepEqual(links.map(node => node.props.href), [metaUrl, workUrl]);
  assert.ok(links.every(node => node.props.target === "_blank" && node.props.rel === "noopener noreferrer"));
  assert.deepEqual(links.map(node => node.props["aria-label"]), ["Abrir archivo recibido: Soporte recibido.pdf", "Abrir archivo recibido: Imagen"]);
  assert.equal(flatten(tree).filter(node => node.type === "li").length, 5);
  assert.equal(text(tree).includes("untrusted.invalid"), false);
  assert.equal(flatten(tree).some(node => node.type === "aside"), false, "el listado no depende de la ficha fija oculta en móvil");
});

test("la ficha presenta vacío real sin inventar documentos ni mostrar archivos enviados", () => {
  for (const messages of [[], [{ ...received(messageId, null), direction: "outbound" }]]) {
    const tree = receivedFiles({ historyTruncated: false, messages });
    assert.ok(text(tree).includes("Archivos recibidos (0)"));
    assert.ok(text(tree).includes("No hay archivos recibidos en el historial disponible."));
    assert.equal(flatten(tree).filter(node => node.type === "a").length, 0);
    assert.equal(text(tree).includes("Archivos del historial disponible."), false);
  }
});
