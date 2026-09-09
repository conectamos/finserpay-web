import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as crypto from "node:crypto";

export function loadBlacklistModule(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    exports: loadedModule.exports, module: loadedModule,
    require: (name) => {
      if (name === "node:crypto") return crypto;
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    console, URL, URLSearchParams, Date, Request, Response,
  }, { filename: path });
  return loadedModule.exports;
}

export const core = loadBlacklistModule("lib/document-blacklist-core.ts");
export const store = loadBlacklistModule("lib/document-blacklist-store.ts", { "@/lib/document-blacklist-core": core });
