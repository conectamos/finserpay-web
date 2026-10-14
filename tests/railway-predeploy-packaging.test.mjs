import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { runnerBuilderCopies, runnerPackagesFile } from "./helpers/dockerfile-packaging.mjs";

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
  const visited = new Set();
  const pending = ["scripts/railway-predeploy.mjs"];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (/\.[cm]?js$/.test(file)) pending.push(...localDependencies(file));
  }
  const missing = [...visited].filter(file => !runnerPackagesFile(dockerfile, file));
  assert.deepEqual(missing, [], "Predeploy dependencies missing from the production Docker image: " + missing.join(", "));
});

test("packaging checks resolve multi-source COPY destinations without accepting the wrong folder", () => {
  const docker = "FROM node AS runner\nCOPY --from=builder \\\n  /app/scripts/first.mjs \\\n  /app/scripts/second.sql \\\n  ./scripts/\n";
  assert.equal(runnerBuilderCopies(docker).length, 2);
  assert.equal(runnerPackagesFile(docker, "scripts/first.mjs"), true);
  assert.equal(runnerPackagesFile(docker, "scripts/second.sql"), true);
  assert.equal(runnerPackagesFile(docker, "scripts/missing.mjs"), false);
  assert.equal(runnerPackagesFile(docker.replace("./scripts/", "./wrong/"), "scripts/first.mjs"), false);
  assert.throws(() => runnerBuilderCopies(docker.replace("./scripts/", "./scripts")), /trailing-slash/);
  assert.equal(runnerPackagesFile("FROM node AS runner\n# COPY --from=builder /app/scripts/first.mjs ./scripts/first.mjs\n", "scripts/first.mjs"), false);
});
