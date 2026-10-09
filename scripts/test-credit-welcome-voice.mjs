// Local operational tool. No HTTP endpoint and no automatic queue selection.
import path from "node:path";
import { fileURLToPath } from "node:url";

function controlledTestError(code) {
  return Object.assign(new Error("No se puede ejecutar la prueba dirigida."), { code });
}

const eventUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseControlledWelcomeVoiceTestArgs(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--credit-id", "--expected-phone", "--test-phone", "--repeat-of"].includes(flag) || flag in values ||
      !args[index + 1] || args[index + 1].startsWith("--")) throw controlledTestError("INVALID_ARGUMENTS");
    values[flag] = args[index + 1];
  }
  const creditId = Number(values["--credit-id"]);
  const expectedPhone = values["--expected-phone"];
  const testPhone = values["--test-phone"];
  const repeatOf = values["--repeat-of"];
  if (!/^\d+$/.test(values["--credit-id"] || "") || !Number.isSafeInteger(creditId) || creditId < 1 ||
    typeof expectedPhone !== "string" || !expectedPhone || expectedPhone.length > 80 ||
    typeof testPhone !== "string" || !testPhone || testPhone.length > 80 ||
    (repeatOf !== undefined && (typeof repeatOf !== "string" || !eventUuid.test(repeatOf)))) {
    throw controlledTestError("INVALID_ARGUMENTS");
  }
  return { creditId, expectedPhone, testPhone, ...(repeatOf === undefined ? {} : { repeatOf }) };
}

/** Dependencies make the only network boundary testable without production credentials. */
export async function runControlledWelcomeVoiceTest(input, deps) {
  if (!Number.isSafeInteger(input.creditId) || input.creditId < 1 || typeof input.expectedPhone !== "string" ||
    !input.expectedPhone || input.expectedPhone.length > 80 || typeof input.testPhone !== "string" ||
    !input.testPhone || input.testPhone.length > 80 ||
    (input.repeatOf !== undefined && (typeof input.repeatOf !== "string" || !eventUuid.test(input.repeatOf)))) {
    throw controlledTestError("INVALID_ARGUMENTS");
  }
  const expectedPhone = deps.normalizePhone(input.expectedPhone);
  const testPhone = deps.normalizePhone(input.testPhone);
  if (!expectedPhone || !testPhone) throw controlledTestError("INVALID_ARGUMENTS");
  if (deps.env.DAPTA_WELCOME_VOICE_ENABLED !== "false") throw controlledTestError("GLOBAL_FEATURE_MUST_BE_DISABLED");
  // This copy enables configuration validation for this request only; process.env is unchanged.
  const config = deps.getConfig({ ...deps.env, DAPTA_WELCOME_VOICE_ENABLED: "true" });
  if (!config) throw controlledTestError("INVALID_DISPATCH_CONFIG");
  await deps.ensureSchema();
  let claim;
  let claimed = false;
  const requireClaim = eventId => {
    if (!claim || claim.eventId !== eventId || claim.creditId !== input.creditId) {
      throw controlledTestError("CONTROLLED_TEST_SCOPE_MISMATCH");
    }
  };
  const report = await deps.dispatch({ limit: 1 }, {
    config, ensureSchema: async () => {},
    claim: async () => {
      if (claimed) throw controlledTestError("CONTROLLED_TEST_ALREADY_ATTEMPTED");
      claimed = true;
      claim = await deps.store.prepareCreditWelcomeVoiceControlledTest({ creditId: input.creditId, expectedPhone: input.expectedPhone,
        ...(input.repeatOf === undefined ? {} : { repeatOf: input.repeatOf }) });
      requireClaim(claim.eventId);
      if (input.repeatOf !== undefined && String(claim.eventId).toLowerCase() === input.repeatOf.toLowerCase()) {
        throw controlledTestError("CONTROLLED_TEST_SCOPE_MISMATCH");
      }
      if (claim.snapshot.phone !== expectedPhone) throw controlledTestError("CONTROLLED_TEST_SCOPE_MISMATCH");
      return [claim];
    },
    prepare: async eventId => {
      requireClaim(eventId);
      const prepared = await deps.store.prepareCreditWelcomeVoiceDispatch(eventId);
      if (prepared && (prepared.eventId !== claim.eventId || prepared.creditId !== input.creditId ||
        prepared.snapshot.phone !== claim.snapshot.phone)) {
        throw controlledTestError("CONTROLLED_TEST_SCOPE_MISMATCH");
      }
      // The backend retains the real contact and financial snapshot. Only this
      // local request's destination is replaced after every stored-data check.
      return prepared ? { ...prepared, snapshot: { ...prepared.snapshot, phone: testPhone } } : null;
    },
    accepted: async (eventId, callId) => {
      requireClaim(eventId);
      await deps.store.markCreditWelcomeVoiceDispatchAccepted(eventId, callId);
    },
    failed: async (eventId, code) => {
      requireClaim(eventId);
      await deps.store.markCreditWelcomeVoiceDispatchFailed(eventId, code);
    },
    unknown: async (eventId, code) => {
      requireClaim(eventId);
      await deps.store.markCreditWelcomeVoiceDispatchUnknown(eventId, code);
    },
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
  });
  return { eventId: claim?.eventId ?? null, creditId: input.creditId,
    status: report.accepted ? "ACCEPTED" : report.unknown ? "UNKNOWN" : report.skipped ? "SKIPPED" : "NOT_DISPATCHED" };
}

async function main() {
  let prisma;
  try {
    const input = parseControlledWelcomeVoiceTestArgs(process.argv.slice(2));
    if (!input) {
      console.log("node scripts/test-credit-welcome-voice.mjs --credit-id ID --expected-phone +57CELULAR_REGISTRADO --test-phone +57NUMERO_PERSONAL_AUTORIZADO [--repeat-of UUID_EVENTO_TERMINADO]");
      return;
    }
    if (process.env.DAPTA_WELCOME_VOICE_ENABLED !== "false") throw controlledTestError("GLOBAL_FEATURE_MUST_BE_DISABLED");
    const [{ createRequire }, { createJiti }] = await Promise.all([import("node:module"), import("jiti")]);
    const require = createRequire(import.meta.url);
    const jiti = createJiti(import.meta.url, { alias: {
      "@": fileURLToPath(new URL("../", import.meta.url)),
      "server-only": require.resolve("next/dist/compiled/server-only/empty.js"),
    } });
    const dispatch = await jiti.import("../lib/credit-welcome-voice-dispatch.ts");
    const ledger = await jiti.import("../lib/credit-welcome-voice-store.ts");
    const { normalizeColombianMobile } = await jiti.import("../lib/dapta-welcome.ts");
    ({ default: prisma } = await jiti.import("../lib/prisma.ts"));
    const result = await runControlledWelcomeVoiceTest(input, { env: process.env,
      getConfig: dispatch.getCreditWelcomeVoiceConfig, dispatch: dispatch.dispatchCreditWelcomeVoice,
      normalizePhone: normalizeColombianMobile,
      ensureSchema: ledger.ensureCreditWelcomeVoiceSchema,
      store: ledger.createCreditWelcomeVoiceStore({ database: prisma, enabled: () => true }) });
    console.log(JSON.stringify(result));
    if (result.status !== "ACCEPTED") process.exitCode = 1;
  } catch (error) {
    // Never print the exception message, request body, private URL, phone or token.
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "CONTROLLED_TEST_FAILED";
    console.error(JSON.stringify({ status: code }));
    process.exitCode = 1;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
