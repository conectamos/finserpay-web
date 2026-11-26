// Operator-only recovery: verification is read-only by default. --apply reserves
// an explicitly authorized paid retry; --send uses the normal single-send ledger.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

let inputFile;
let apply = false;
let send = false;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--help") {
    console.log("node scripts/authorize-paid-firmaseguro-draft-retry.mjs --input-file FILE [--apply [--send]]");
    process.exit(0);
  }
  if (flag === "--apply") { apply = true; continue; }
  if (flag === "--send") { send = true; continue; }
  if (flag === "--input-file" && !inputFile && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    inputFile = process.argv[++index];
    continue;
  }
  throw new Error("Argumentos inválidos; usa --help.");
}
if (!inputFile || (send && !apply)) throw new Error("Indica --input-file; --send requiere --apply.");

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, {
  alias: { "@": root, "server-only": require.resolve("next/dist/compiled/server-only/empty.js") },
});
let prisma;
try {
  const requested = JSON.parse(await readFile(inputFile, "utf8"));
  if (!Number.isSafeInteger(requested.actorId) || requested.actorId < 1) throw new Error("Actor inválido.");
  ({ default: prisma } = await jiti.import("../lib/prisma.ts"));
  const [{ isAdminRole }, { isFinserPayCentralAlly }, retry, ledger] = await Promise.all([
    jiti.import("../lib/roles.ts"), jiti.import("../lib/aliados.ts"),
    jiti.import("../lib/firmaseguro-draft-paid-retry.ts"),
    jiti.import("../lib/firmaseguro-draft-dispatch-ledger.ts"),
  ]);
  const actors = await prisma.$queryRawUnsafe(`
    SELECT u."id",u."nombre",r."nombre" AS "role",a."codigo" AS "ally"
    FROM "Usuario" u JOIN "Rol" r ON r."id"=u."rolId"
    JOIN "Sede" s ON s."id"=u."sedeId" JOIN "Aliado" a ON a."id"=s."aliadoId"
    WHERE u."id"=$1::integer AND u."activo"=true`, requested.actorId);
  const actor = actors[0];
  if (!actor || !isAdminRole(actor.role) || !isFinserPayCentralAlly(actor.ally)) {
    throw new ledger.DraftDispatchError("PAID_RETRY_ACTOR_FORBIDDEN", "El actor debe ser un administrador central activo.", 403);
  }
  const input = { draftId: requested.draftId, dispatchId: requested.dispatchId,
    actor: { id: actor.id, nombre: actor.nombre }, reason: requested.reason,
    providerReviewConfirmed: requested.providerReviewConfirmed,
    remoteOutcomeUnknownAccepted: requested.remoteOutcomeUnknownAccepted,
    newChargeAccepted: requested.newChargeAccepted, expectedFingerprint: requested.expectedFingerprint };
  const plan = await retry.verifyAuthorizedPaidDraftRetry(input);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, mode: "verified_read_only", plan }));
  } else {
    const reserved = await retry.reserveAuthorizedPaidDraftRetry({ ...input, expectedFingerprint: plan.expectedFingerprint });
    const result = send ? await ledger.dispatchReservedDraft(reserved.replacementDispatchId) : reserved;
    const status = result.status;
    const requiresReview = send && status !== "AWAITING_SIGNATURE";
    console.log(JSON.stringify({ ok: !requiresReview, mode: send ? "dispatched" : "reserved",
      draftId: input.draftId, replacementDispatchId: reserved.replacementDispatchId,
      status, processUuid: result.processUuid || null, requiresReview }));
    if (requiresReview) process.exitCode = 2;
  }
} catch (error) {
  // Provider and database errors can contain credentials or customer data.
  console.error(JSON.stringify({ ok: false,
    code: typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "PAID_RETRY_FAILED",
    errorType: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
}
