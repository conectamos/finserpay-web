import { createHash, timingSafeEqual } from "node:crypto";

type Dependencies = {
  token: () => string | undefined;
  agentId: () => string | undefined;
  actorId: () => number;
  read: (id: number) => Promise<unknown>;
  record: (id: number, input: Record<string, unknown>, actorId: number) => Promise<unknown>;
  error: (error: unknown) => Response;
};
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

/** Stable UUID shared by all retries of one Dapta call, including changed payloads. */
export function collectionCallKey(agentId: string, callId: string) {
  const hex = createHash("sha256").update(JSON.stringify(["dapta-cobranza", agentId, callId])).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function createCollectionsHandlers(deps: Dependencies) {
  async function body(request: Request): Promise<Record<string, unknown> | Response> {
    const expected = deps.token()?.trim();
    if (!expected || expected.length < 32) return json({ ok: false, error: "Integración de cobranza no configurada" }, 503);
    const supplied = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ ok: false, error: "No autorizado" }, 401);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      return json({ ok: false, error: "Usa application/json" }, 415);
    const reader = request.body?.getReader();
    if (!reader) return json({ ok: false, error: "Solicitud vacía" }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 12000) { await reader.cancel(); return json({ ok: false, error: "Solicitud demasiado extensa" }, 413); }
        chunks.push(part.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "Solicitud inválida" }, 400);
      const data = value as Record<string, unknown>;
      if (!Number.isSafeInteger(data.creditoId) || Number(data.creditoId) < 1)
        return json({ ok: false, error: "creditoId inválido" }, 400);
      return data;
    } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
    finally { reader.releaseLock(); }
  }
  return {
    consulta: async (request: Request) => {
      try {
        const data = await body(request);
        if (data instanceof Response) return data;
        if (Object.keys(data).some(key => key !== "creditoId")) return json({ ok: false, error: "Campos no permitidos" }, 400);
        return json({ ok: true, ...await deps.read(Number(data.creditoId)) as object });
      } catch (error) { return deps.error(error); }
    },
    gestion: async (request: Request) => {
      try {
        const data = await body(request);
        if (data instanceof Response) return data;
        const actorId = deps.actorId(), agentId = deps.agentId()?.trim();
        if (!Number.isSafeInteger(actorId) || actorId < 1 || !agentId)
          return json({ ok: false, error: "Agente y responsable de cobranza no configurados" }, 503);
        const allowed = ["creditoId", "agentId", "callId", "actedAt", "result", "comment", "nextFollowUpAt", "agreementDate", "agreementAmount", "agreementConfirmed"];
        if (Object.keys(data).some(key => !allowed.includes(key))) return json({ ok: false, error: "Campos no permitidos" }, 400);
        if (data.agentId !== agentId) return json({ ok: false, error: "Agente no autorizado para esta integración" }, 403);
        if (typeof data.callId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(data.callId))
          return json({ ok: false, error: "callId inválido" }, 400);
        const statuses: Record<string, string> = {
          SIN_RESPUESTA: "SIN_RESPUESTA", MEDIOS_PAGO: "CONTACTADO", PAGO_REALIZADO: "SEGUIMIENTO", ACUERDO_PAGO: "ACUERDO_PAGO",
        };
        const status = typeof data.result === "string" && Object.hasOwn(statuses, data.result) ? statuses[data.result] : undefined;
        if (!status) return json({ ok: false, error: "Resultado no admitido para el agente" }, 400);
        if (data.result === "ACUERDO_PAGO" && data.agreementConfirmed !== true)
          return json({ ok: false, error: "El cliente debe confirmar fecha y valor del acuerdo" }, 400);
        if (data.result !== "ACUERDO_PAGO" && (data.agreementDate != null || data.agreementAmount != null || data.agreementConfirmed != null))
          return json({ ok: false, error: "Los términos solo aplican a un acuerdo" }, 400);
        if (typeof data.comment !== "string" || data.comment.trim().length < 5 || data.comment.length > 1500)
          return json({ ok: false, error: "Comentario inválido" }, 400);
        const input = {
          action: "LLAMADA", actedAt: data.actedAt, responsibleUserId: actorId,
          result: data.result, comment: `[Dapta cobranza; agente ${agentId}; llamada ${data.callId}] ${data.comment.trim()}`,
          nextFollowUpAt: data.nextFollowUpAt, managementStatus: status,
          idempotencyKey: collectionCallKey(agentId, data.callId),
          ...(data.result === "ACUERDO_PAGO" ? { agreementDate: data.agreementDate, agreementAmount: data.agreementAmount } : {}),
        };
        // The repository transaction validates the actor, dates, amount and current mora.
        // Only a persisted return is reported as registered; errors never fall back to Sheets.
        return json({ ok: true, registrado: true, ...await deps.record(Number(data.creditoId), input, actorId) as object });
      } catch (error) { return deps.error(error); }
    },
  };
}
