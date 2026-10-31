import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, globals = {}, mocks = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const node = (type, props) => ({ type, props });
  runInNewContext(source, { module, exports: module.exports, URL, Uint8Array, atob, setTimeout, clearTimeout,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node };
      if (name === "next/navigation") return { redirect: value => { throw new Error(`redirect:${value}`); } };
      if (name === "next/link") return { default: "Link" };
      if (name.endsWith("attention-console")) return { default: "AttentionConsole" };
      if (name.endsWith("attention-work-queues")) return { default: "AttentionWorkQueues" };
      if (name.endsWith("finser-navigation")) return { default: "FinserNavigation" };
      if (name.endsWith("atencion-notification-links")) return links;
      throw new Error(`Unexpected import ${name}`);
    }, ...globals });
  return module.exports;
}
const links = load("lib/atencion-notification-links.ts");
const workId = "a0000000-0000-4000-8000-000000000001";
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];

test("notification links accept only actual work inboxes and canonical identifiers", () => {
  for (const page of ["atencion", "gestion-comercial"]) for (const tipo of ["welcome", "enrollment"]) {
    const queue = `/dashboard/${page}?tipo=${tipo}`;
    assert.equal(links.attentionNotificationHref(queue), queue);
    assert.equal(links.attentionNotificationHref(`${queue}&solicitud=${workId}`), `${queue}&solicitud=${workId}`);
  }
  for (const href of ["https://example.com", "//example.com/dashboard/atencion?tipo=welcome", "/dashboard/usuarios?tipo=welcome", "/dashboard/atencion?tipo=unknown", "/dashboard/atencion?tipo=welcome&solicitud=bad", "/dashboard/atencion?tipo=welcome&redirect=https://example.com", "/dashboard/atencion?tipo=welcome#x", "/dashboard/atencion?tipo=welcome&tipo=enrollment"]) {
    assert.equal(links.attentionNotificationHref(href), null, href);
  }
});

test("direct notification links open the actual case and mobile detail for both workspaces", async () => {
  class AttentionError extends Error {}
  const actor = { key: "analyst:5" };
  const staff = load("app/dashboard/atencion/page.tsx", {}, { "@/lib/atencion-core": { AttentionError, getAttentionAccess: async () => actor } }).default;
  const seller = load("app/dashboard/gestion-comercial/page.tsx", {}, {
    "@/lib/atencion-core": { AttentionError },
    "@/lib/atencion-work-access": { getAttentionWorkAccess: async () => ({ type: "seller", key: "seller:2:11", sellerId: 11, name: "Prueba", supervisor: false }) },
  }).default;
  for (const tipo of ["welcome", "enrollment"]) {
    const result = await staff({ searchParams: Promise.resolve({ tipo, solicitud: workId }) });
    assert.equal(result.props.initialWorkKind, tipo);
    assert.equal(result.props.initialWorkId, workId);
    const commercial = await seller({ searchParams: Promise.resolve({ tipo, solicitud: workId }) });
    const queue = nodes(commercial).find(item => item.type === "AttentionWorkQueues");
    assert.equal(queue.props.kind, tipo); assert.equal(queue.props.initialId, workId); assert.equal(queue.props.sellerId, 11);
  }
  assert.equal((await staff({ searchParams: Promise.resolve({ tipo: "welcome", solicitud: "invalid" }) })).props.initialWorkId, null);
});

test("shared-device push cleanup never unsubscribes the customer worker", async () => {
  let unsubscribed = 0, dispatched = 0;
  let registration = { scope: "https://finserpay.com/", pushManager: { getSubscription: async () => ({ unsubscribe: async () => { unsubscribed++; return true; } }) } };
  const browser = load("lib/atencion-notification-browser.ts", {
    Event: class { constructor(type) { this.type = type; } },
    navigator: { serviceWorker: { getRegistration: async scope => { assert.equal(scope, "/dashboard/"); return registration; } } },
    window: { location: { origin: "https://finserpay.com" }, dispatchEvent: () => { dispatched++; } },
  });
  await browser.stopAttentionDevicePush(); assert.equal(unsubscribed, 0);
  registration = { ...registration, scope: "https://finserpay.com/dashboard/" };
  await browser.stopAttentionDevicePush(); assert.equal(unsubscribed, 1); assert.equal(dispatched, 2);
  assert.deepEqual([...browser.attentionPushKey("AQID")], [1, 2, 3]);
});

test("push activation waits for its own worker instead of the root customer worker", async () => {
  const browser = load("lib/atencion-notification-browser.ts");
  let listener;
  const worker = { state: "installing", addEventListener: (_, handler) => { listener = handler; }, removeEventListener: () => {} };
  let done = false;
  const pending = browser.waitForAttentionPushWorker({ active: null, installing: worker }).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  worker.state = "activated"; listener(); await pending; assert.equal(done, true);
  await assert.rejects(browser.waitForAttentionPushWorker({ active: null, installing: null, waiting: null }), /preparar/);
});
