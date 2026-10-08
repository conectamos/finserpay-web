import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export function loadWelcomeModule(path, dependencies = {}) {
  const loadedModule = { exports: {} };
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(output, {
    module: loadedModule, exports: loadedModule.exports, Buffer, Date, URL, Request, Response, Uint8Array, TextDecoder,
    require(name) {
      if (name === "server-only") return {};
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${path}: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}
export const errors = loadWelcomeModule("lib/credit-approval-errors.ts");
export const actors = loadWelcomeModule("lib/credit-approval-actor.ts");
export const roles = loadWelcomeModule("lib/roles.ts");
const policy = loadWelcomeModule("lib/credit-approval-policy.ts", {
  "./credit-import-flags": loadWelcomeModule("lib/credit-import-flags.ts"),
});
export const queue = loadWelcomeModule("lib/credit-approval-queue.ts", {
  "@/lib/credit-approval-policy": policy,
  "@/lib/credit-approval-actor": actors,
  "@/lib/credit-approval-errors": errors,
});
export const reader = loadWelcomeModule("lib/approval-welcome-alerts-read.ts", {
  "@/lib/credit-approval-queue": queue,
  "@/lib/credit-approval-errors": errors,
});
export const plain = value => JSON.parse(JSON.stringify(value));
