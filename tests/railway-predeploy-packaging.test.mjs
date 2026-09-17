import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function localDependencies(file) {
  const dependencies = new Set();
  const source = ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const add = value => {
    if (value && ts.isStringLiteralLike(value) && value.text.startsWith(".")) {
      dependencies.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), value.text)));
    }
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" &&
        node.arguments?.[1]?.getText(source) === "import.meta.url") add(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return dependencies;
}

test("Railway runner packages predeploy and every transitive local import and SQL asset", () => {
  const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
  const runner = dockerfile.split(/^FROM .* AS runner\s*$/im)[1];
  assert.ok(runner, "Dockerfile must define its production runner stage");
  const copies = [...runner.matchAll(/^COPY\s+--from=builder\s+(\/app\/\S+)\s+(\S+)\s*$/gm)]
    .map(([, source, destination]) => ({
      source: path.posix.normalize(source.slice("/app/".length)),
      destination: path.posix.normalize(destination.startsWith("/app/") ? destination.slice("/app/".length) : destination),
    }));
  const packaged = file => copies.some(({ source, destination }) =>
    (file === source && file === destination) ||
    (file.startsWith(source.replace(/\/$/, "") + "/") &&
      path.posix.join(destination, path.posix.relative(source, file)) === file));
  const visited = new Set();
  const pending = ["scripts/railway-predeploy.mjs"];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (/\.[cm]?js$/.test(file)) pending.push(...localDependencies(file));
  }
  const missing = [...visited].filter(file => !packaged(file));
  assert.deepEqual(missing, [], "Predeploy dependencies missing from the production Docker image: " + missing.join(", "));
});
