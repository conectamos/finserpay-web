import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceUrl = new URL("../lib/firmaseguro-portal.ts", import.meta.url);
const outputUrl = new URL("./generated/firmaseguro-portal.mjs", import.meta.url);

export function compileFirmaSeguroPortalProbe(source) {
  const parsed = ts.createSourceFile("firmaseguro-portal.ts", source, ts.ScriptTarget.Latest, true);
  const markers = parsed.statements.filter(statement => ts.isImportDeclaration(statement)
    && !statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === "server-only");
  if (markers.length !== 1) throw new Error("PORTAL_PROBE_SERVER_MARKER_INVALID");
  const marker = markers[0];
  // Node runs this server-only CLI outside Next. Remove only the framework marker;
  // all portal logic, imports, origins and browser options come from the real driver.
  const standalone = source.slice(0, marker.getStart(parsed)) + source.slice(marker.end);
  const result = ts.transpileModule(standalone, {
    fileName: "firmaseguro-portal.ts",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error))
    throw new Error("PORTAL_PROBE_COMPILATION_FAILED");
  return result.outputText;
}

export async function buildFirmaSeguroPortalProbe() {
  const output = compileFirmaSeguroPortalProbe(await readFile(sourceUrl, "utf8"));
  await mkdir(dirname(fileURLToPath(outputUrl)), { recursive: true });
  await writeFile(outputUrl, output, "utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await buildFirmaSeguroPortalProbe();
    console.log(JSON.stringify({ ok: true, code: "PORTAL_PROBE_BUILT" }));
  } catch {
    console.error(JSON.stringify({ ok: false, code: "PORTAL_PROBE_BUILD_FAILED" }));
    process.exitCode = 1;
  }
}
