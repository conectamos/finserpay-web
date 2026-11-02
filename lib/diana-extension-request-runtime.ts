import "server-only";
import { AttentionError } from "./atencion-core";
import { getDaptaEventScope } from "./atencion-dapta-events";
import type { AttentionDatabase } from "./atencion-storage";
import { dianaExtensionIntegrationConfigured } from "./diana-extension-runtime";
import { createDianaExtensionRequestStore } from "./diana-extension-request-storage";

/** A separate rollout floor prevents replaying requests from before activation. */
export function dianaRequestExtensionsActivatedAt(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = env.DIANA_REQUEST_EXTENSIONS_ACTIVATED_AT?.trim() || "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === raw.slice(0, 19) ? parsed : null;
}

export function dianaRequestExtensionsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.DIANA_REQUEST_EXTENSIONS_ENABLED === "true"
    && dianaRequestExtensionsActivatedAt(env) !== null
    && dianaExtensionIntegrationConfigured(env);
}

export async function dianaExtensionRequestRuntime() {
  const scope = getDaptaEventScope(), activatedAt = dianaRequestExtensionsActivatedAt();
  if (!scope || !activatedAt || !dianaRequestExtensionsEnabled()) {
    throw new AttentionError("La gestión directa de prórrogas no está habilitada.", 503);
  }
  const { default: prisma } = await import("./prisma");
  return { store: createDianaExtensionRequestStore(prisma as unknown as AttentionDatabase, { scope, enabled: true, activatedAt }) };
}
