type CentralSession = { id: number; centralAdmin: boolean } | null;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
  } });
}

async function readRequestId(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  if (Number(request.headers.get("content-length")) > 1024) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(1024);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, size);
      size += value.length;
    }
  } finally { reader.releaseLock(); }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.requestId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId)) return null;
    return record.requestId.toLowerCase();
  } catch { return null; }
}

/** Only the central account can create a global portfolio batch. GET never queues messages. */
export function createCuotaVencidaWhatsAppHandlers<T>(deps: {
  session: () => Promise<CentralSession>;
  sameOrigin: (request: Request) => boolean;
  configured: () => boolean;
  latest: () => Promise<T | null>;
  create: (input: { requestId: string; actorId: number }) => Promise<{ created: boolean; batch: T }>;
  start: () => void;
}) {
  async function authorize() {
    const user = await deps.session();
    if (!user) return { error: json({ ok: false, error: "Inicia sesión para gestionar los envíos." }, 401) };
    if (!user.centralAdmin || !Number.isSafeInteger(user.id) || user.id < 1) {
      return { error: json({ ok: false, error: "Solo el administrador central puede enviar esta plantilla a toda la cartera." }, 403) };
    }
    return { user };
  }
  return {
    GET: async () => {
      try {
        const access = await authorize();
        if (access.error) return access.error;
        return json({ ok: true, configured: deps.configured(), batch: await deps.latest() });
      } catch { return json({ ok: false, error: "No se pudo consultar el estado del envío." }, 500); }
    },
    POST: async (request: Request) => {
      try {
        if (!deps.sameOrigin(request)) return json({ ok: false, error: "El envío debe iniciarse desde FINSER PAY." }, 403);
        const access = await authorize();
        if (access.error) return access.error;
        const requestId = await readRequestId(request);
        if (!requestId) return json({ ok: false, error: "Solicitud de envío no válida." }, 400);
        if (!deps.configured()) return json({ ok: false, configured: false, error: "El envío de Cuotavencida no está configurado." }, 503);
        const result = await deps.create({ requestId, actorId: access.user!.id });
        // Queue processing survives the response and continues in the internal worker.
        deps.start();
        return json({ ok: true, configured: true, batch: result.batch }, result.created ? 202 : 200);
      } catch { return json({ ok: false, error: "No se pudo iniciar el envío. Consulta su estado antes de volver a intentarlo." }, 500); }
    },
  };
}
