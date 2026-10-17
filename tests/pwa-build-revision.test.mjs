import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stampClientWorker } from "../scripts/stamp-client-worker.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const workerSource = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");
const execFileAsync = promisify(execFile);
const withoutRevision = (source) => source.replace(/^\/\/ FINSER_PAY_BUILD_REVISION:[^\r\n]*(?:\r?\n|$)/gm, "");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "finser-worker-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("finser-worker-test-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "public"));
  await mkdir(path.join(root, ".next", "standalone"), { recursive: true });
  await writeFile(path.join(root, "public", "sw.js"), workerSource);
  return root;
}

test("cada BUILD_ID cambia los bytes del worker sin alterar su lógica ni acumular comentarios", async (t) => {
  const root = await fixture(t);
  const workerPath = path.join(root, "public", "sw.js");
  await writeFile(path.join(root, ".next", "BUILD_ID"), "build-first\n");
  assert.deepEqual(await stampClientWorker(root), { buildId: "build-first", changed: true });
  const first = await readFile(workerPath, "utf8");
  assert.match(first, /^\/\/ FINSER_PAY_BUILD_REVISION: build-first\r?\n/);
  assert.equal(withoutRevision(first), withoutRevision(workerSource));
  assert.deepEqual(await stampClientWorker(root), { buildId: "build-first", changed: false });
  assert.equal(await readFile(workerPath, "utf8"), first);

  await writeFile(path.join(root, ".next", "BUILD_ID"), "build-second");
  assert.deepEqual(await stampClientWorker(root), { buildId: "build-second", changed: true });
  const second = await readFile(workerPath, "utf8");
  assert.notEqual(second, first);
  assert.equal((second.match(/FINSER_PAY_BUILD_REVISION:/g) || []).length, 1);
  assert.doesNotMatch(second, /build-first/);
  assert.equal(withoutRevision(second), withoutRevision(workerSource));
});

test("BUILD_ID ausente o inválido falla sin publicar un worker alterado", async (t) => {
  const root = await fixture(t);
  await assert.rejects(stampClientWorker(root), { code: "ENOENT" });
  for (const value of ["", "build\nthrow new Error('invalid')", "build\u2028invalid"]) {
    await writeFile(path.join(root, ".next", "BUILD_ID"), value);
    await assert.rejects(stampClientWorker(root), /BUILD_ID/);
    assert.equal(await readFile(path.join(root, "public", "sw.js"), "utf8"), workerSource);
  }
});

test("postbuild estampa public antes de que Docker lo copie junto al servidor standalone", async (t) => {
  const root = await fixture(t);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const dockerfile = await readFile(path.join(projectRoot, "Dockerfile"), "utf8");
  assert.equal(packageJson.scripts.postbuild, "node scripts/stamp-client-worker.mjs");
  assert.ok(dockerfile.indexOf("RUN npm run build") < dockerfile.indexOf("COPY --from=builder /app/public ./public"));
  assert.match(dockerfile, /COPY --from=builder \/app\/\.next\/standalone \.\//);

  await writeFile(path.join(root, ".next", "BUILD_ID"), "standalone-build");
  await writeFile(path.join(root, ".next", "standalone", "server.js"), "// standalone fixture\n");
  await mkdir(path.join(root, "scripts"));
  await cp(path.join(projectRoot, "scripts", "stamp-client-worker.mjs"), path.join(root, "scripts", "stamp-client-worker.mjs"));
  await execFileAsync(process.execPath, [path.join(root, "scripts", "stamp-client-worker.mjs")], { cwd: path.join(root, ".next") });
  const runner = path.join(root, "runner");
  await mkdir(runner);
  await cp(path.join(root, "public"), path.join(runner, "public"), { recursive: true });
  await cp(path.join(root, ".next", "standalone"), runner, { recursive: true });
  const packagedWorker = await readFile(path.join(runner, "public", "sw.js"), "utf8");
  assert.match(packagedWorker, /^\/\/ FINSER_PAY_BUILD_REVISION: standalone-build/);
  assert.equal(withoutRevision(packagedWorker), withoutRevision(workerSource));
  assert.equal(await readFile(path.join(runner, "server.js"), "utf8"), "// standalone fixture\n");
});
