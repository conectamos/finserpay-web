import "server-only";
import { AttentionError } from "./atencion-core";
import { createDaptaAttentionAdapter } from "./atencion-dapta";
import { getDaptaEventScope } from "./atencion-dapta-events";
import { getMetaAttentionScope } from "./atencion-meta";
import { createDianaExtensionStore } from "./diana-extension-storage";
import type { AttentionDatabase } from "./atencion-storage";

export function dianaExtensionsEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.DIANA_EXTENSIONS_ENABLED !== "true" || env.DAPTA_ATTENTION_EVENTS_ENABLED !== "true") return false;
  const eventToken = env.DAPTA_ATTENTION_EVENT_TOKEN?.trim() || "";
  if (eventToken.length < 32 || eventToken.length > 4096 || /\s/.test(eventToken)) return false;
  const scope = getDaptaEventScope(env), meta = getMetaAttentionScope(env);
  return Boolean(scope && meta && scope.phoneNumberId === meta.phoneNumberId && scope.wabaId === meta.wabaId
    && createDaptaAttentionAdapter({ env }).attentionIntegrationStatus().canSync);
}
export async function dianaExtensionRuntime() {
  const scope = getDaptaEventScope();
  if (!scope || !dianaExtensionsEnabled()) throw new AttentionError("La gestión automática de prórrogas no está habilitada.", 503);
  const { default: prisma } = await import("./prisma");
  const store = createDianaExtensionStore(prisma as unknown as AttentionDatabase, { scope, enabled: true });
  return { store };
}
