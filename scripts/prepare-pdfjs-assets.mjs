import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(projectRoot, "node_modules", "pdfjs-dist");
const { version } = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Versión de PDF.js no válida.");
const destination = path.join(projectRoot, "public", "pdfjs", version);

// Only copy the installed version into a fixed workspace directory. Never clean
// arbitrary paths or fetch runtime code from a CDN during a document review.
await mkdir(destination, { recursive: true });
await cp(path.join(packageRoot, "build", "pdf.worker.min.mjs"), path.join(destination, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(path.join(packageRoot, folder), path.join(destination, folder), { recursive: true });
}
await cp(path.join(packageRoot, "LICENSE"), path.join(destination, "LICENSE"));
console.log(`PDF.js ${version}: worker y recursos preparados localmente.`);
