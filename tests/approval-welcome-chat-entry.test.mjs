import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const workId = "00000000-0000-4000-8000-000000000081";
const jsx = (type, props) => ({ type, props });
const component = name => Object.defineProperty(() => null, "name", { value: name });
const Workspace = component("ApprovalWorkspace");
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== "object" ? [] : [value, ...nodes(value.props?.children)];

function page({shared=undefined,nominalId=1,userId=1}={}) {
  const linkModule = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/atencion-work-links.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module: linkModule, exports: linkModule.exports });
  const loaded = { exports: {} };
  const dependencies = {
    "next/navigation": { redirect: href => { throw new Error(`REDIRECT ${href}`); } },
    "@/app/_components/finser-ui": { Card: component("Card") },
    "@/app/revision-creditos/shared-logout": { default: component("SharedLogout") },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/auth": { getCreditApprovalSessionUser: async () => ({ id: userId, nombre: "QA", rolNombre: "ADMIN" }), getNominalApprovalWorkspaceSessionUser: async () => nominalId ? ({ id: nominalId }) : null },
    "@/lib/roles": { canManageApprovalAnalysts: () => true, canReviewCreditApprovals: () => true, isApprovalAnalystRole: () => false },
    "./approval-dashboard-shell": { default: component("Shell") },
    "./approval-workspace": { default: Workspace },
    "@/lib/atencion-work-links": linkModule.exports,
    "react/jsx-runtime": { jsx, jsxs: jsx },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../app/dashboard/aprobaciones/page.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module: loaded, exports: loaded.exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
  });
  return loaded.exports.default;
}

test("la ruta entrega la solicitud exacta únicamente a la sesión nominal sin acceso compartido", async () => {
  for (const [context, expected] of [[{}, workId], [{shared:null},null], [{shared:{id:"legacy"}},null], [{nominalId:null},null], [{nominalId:2},null]]) {
    const tree = await page(context)({ searchParams: Promise.resolve({credito:"81",solicitud:workId}) });
    const props = nodes(tree).find(node => node.type === Workspace).props;
    assert.equal(props.welcomeChatWorkId,expected);
    assert.equal(props.initialFocusApprovalCreditId,81);
  }
});

test("la ruta no acepta un contexto ambiguo, repetido o sin crédito", async () => {
  for (const searchParams of [{credito:["81","82"],solicitud:workId},{credito:"81",solicitud:[workId,workId]},{solicitud:workId},{credito:"0",solicitud:workId},{credito:"81",solicitud:`${workId}&credito=82`}]) {
    const tree = await page()({ searchParams: Promise.resolve(searchParams) });
    assert.equal(nodes(tree).find(node => node.type === Workspace).props.welcomeChatWorkId,null);
  }
});
