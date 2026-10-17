import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revisionComment = /^\/\/ FINSER_PAY_BUILD_REVISION:[^\r\n]*(?:\r?\n|$)/gm;

export async function stampClientWorker(root = projectRoot) {
  const workerPath = path.join(root, "public", "sw.js");
  const [rawBuildId, source] = await Promise.all([
    readFile(path.join(root, ".next", "BUILD_ID"), "utf8"),
    readFile(workerPath, "utf8"),
  ]);
  const buildId = rawBuildId.trim();
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(buildId)) {
    throw new Error("El BUILD_ID de Next.js no es válido para publicar el worker.");
  }

  // A revision changes the worker bytes on every build without caching app data.
  // Docker copies public/ after npm's postbuild, including this stamped worker.
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const stamped = `// FINSER_PAY_BUILD_REVISION: ${buildId}${newline}${source.replace(revisionComment, "")}`;
  const changed = stamped !== source;
  if (changed) await writeFile(workerPath, stamped, "utf8");
  return { buildId, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { buildId } = await stampClientWorker();
  console.log(`Worker de clientes preparado para el build ${buildId}.`);
}
