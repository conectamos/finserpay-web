// Run from an authorized server environment with the existing application variables.
// Verification is the default. --apply records the verified result; it never sends a contract.
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const allowed = new Set(["--draft-id", "--dispatch-id", "--process-uuid", "--actor-id"]);
const options = {};
let apply = false;
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--help") {
    console.log("node scripts/reconcile-firmaseguro-draft.mjs --draft-id ID --dispatch-id UUID --process-uuid UUID --actor-id ID [--apply]");
    process.exit(0);
  }
  if (flag === "--apply") { apply = true; continue; }
  if (!allowed.has(flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
    throw new Error("Argumentos inválidos; usa --help.");
  }
  options[flag] = process.argv[++i];
}
const draftId = Number(options["--draft-id"]);
const actorId = Number(options["--actor-id"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!Number.isSafeInteger(draftId) || draftId < 1 || !Number.isSafeInteger(actorId) || actorId < 1 ||
  !uuid.test(options["--dispatch-id"] || "") || !uuid.test(options["--process-uuid"] || "")) {
  throw new Error("Faltan identificadores válidos; usa --help.");
}

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, {
  alias: { "@": root, "server-only": require.resolve("next/dist/compiled/server-only/empty.js") },
});
let prisma;
try {
  ({ default: prisma } = await jiti.import("../lib/prisma.ts"));
  const [{ isAdminRole }, { isFinserPayCentralAlly }, ledger, reconciliation] = await Promise.all([
    jiti.import("../lib/roles.ts"),
    jiti.import("../lib/aliados.ts"),
    jiti.import("../lib/firmaseguro-draft-dispatch-ledger.ts"),
    jiti.import("../lib/firmaseguro-draft-reconciliation.ts"),
  ]);
  const actors = await prisma.$queryRawUnsafe(`
    SELECT u."id",u."nombre",r."nombre" AS "role",a."codigo" AS "ally"
    FROM "Usuario" u JOIN "Rol" r ON r."id"=u."rolId"
    JOIN "Sede" s ON s."id"=u."sedeId" JOIN "Aliado" a ON a."id"=s."aliadoId"
    WHERE u."id"=$1::integer AND u."activo"=true`, actorId);
  const actor = actors[0];
  if (!actor || !isAdminRole(actor.role) || !isFinserPayCentralAlly(actor.ally)) {
    throw new ledger.DraftDispatchError("RECONCILIATION_ACTOR_FORBIDDEN", "El actor debe ser un administrador central activo.", 403);
  }
  const dispatch = await ledger.getDraftDispatch(options["--dispatch-id"]);
  if (!dispatch || dispatch.draftId !== draftId) {
    throw new ledger.DraftDispatchError("RECONCILIATION_DRAFT_MISMATCH", "El envío no pertenece a la solicitud indicada.", 404);
  }
  const input = {
    dispatchId: dispatch.id,
    processUuid: options["--process-uuid"],
    actor: { id: actor.id, nombre: actor.nombre },
  };
  if (!apply) {
    const plan = await reconciliation.verifyDraftDispatchReconciliation(input);
    console.log(JSON.stringify({ ok: true, mode: "verified_read_only", draftId,
      dispatchId: plan.dispatchId, processUuid: plan.processUuid,
      providerStatus: plan.providerStatus, evidenceKind: plan.evidence.kind }));
  } else {
    const result = await reconciliation.reconcileDraftDispatchFromProvider(input);
    const requiresReview = result.status !== "AWAITING_SIGNATURE";
    console.log(JSON.stringify({ ok: !requiresReview, mode: "applied", recovered: true, requiresReview, draftId,
      dispatchId: result.id, processUuid: result.processUuid, status: result.status }));
    if (requiresReview) process.exitCode = 2;
  }
} catch (error) {
  // Provider errors and database exceptions can contain secrets or customer data.
  console.error(JSON.stringify({ ok: false,
    code: typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "RECONCILIATION_FAILED",
    errorType: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
}
