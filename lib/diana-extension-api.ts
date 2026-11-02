import { timingSafeEqual } from "node:crypto";
import { AttentionError } from "./atencion-core";
import { readAttentionJson } from "./atencion-http";
import type { DianaExtensionProposalInput, DianaExtensionProposalView } from "./diana-extension-types";
import type { DianaExtensionRequestView } from "./diana-extension-request-types";

type Dependencies = {
  enabled: () => boolean;
  token: () => string | undefined;
  propose: (input: DianaExtensionProposalInput) => Promise<DianaExtensionProposalView>;
  status: (code: string) => Promise<DianaExtensionProposalView>;
  requestEnabled?: () => boolean;
  requestStatus?: (input: { cedula: string; folio: string }) => Promise<DianaExtensionRequestView>;
};
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization",
    "X-Content-Type-Options": "nosniff",
  } });
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new AttentionError("La solicitud contiene campos no admitidos.", 400);
}
function text(value: unknown, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new AttentionError("Los datos de la propuesta no son válidos.", 400);
  return value.trim();
}
export function parseDianaExtensionAction(body: Record<string, unknown>) {
  if (body.accion === "consultar_solicitud") {
    fields(body, ["accion", "cedula", "folio"]);
    const cedula = text(body.cedula, 5, 15), folio = text(body.folio, 1, 120);
    if (!/^\d{5,15}$/.test(cedula) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(folio)) throw new AttentionError("Cédula o folio no válido.", 400);
    return { action: "request_status" as const, input: { cedula, folio } };
  }
  if (body.accion === "consultar") {
    fields(body, ["accion", "codigo"]);
    const code = text(body.codigo, 10, 80);
    if (!/^PR-[A-F0-9]{16}$/.test(code)) throw new AttentionError("Código de propuesta no válido.", 400);
    return { action: "status" as const, code };
  }
  if (body.accion !== "proponer") throw new AttentionError("Selecciona proponer o consultar.", 400);
  fields(body, ["accion", "cedula", "folio", "dias", "valorCompromiso", "fechaCompromiso", "motivo"]);
  const cedula = text(body.cedula, 5, 15), folio = text(body.folio, 1, 120);
  if (!/^\d{5,15}$/.test(cedula) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(folio)) throw new AttentionError("Cédula o folio no válido.", 400);
  if (typeof body.dias !== "number" || ![1, 2, 3, 4].includes(body.dias)) throw new AttentionError("Selecciona entre uno y cuatro días.", 400);
  const amount = body.valorCompromiso;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1e12 || Math.round(amount * 100) / 100 !== amount) throw new AttentionError("Indica un compromiso de pago válido.", 400);
  const date = text(body.fechaCompromiso, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`))
      || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new AttentionError("Fecha de compromiso no válida.", 400);
  return { action: "propose" as const, input: { cedula, folio, days: body.dias as 1 | 2 | 3 | 4,
    promiseAmount: amount, promiseDate: date, reason: text(body.motivo, 5, 500) } };
}
/** The model reads native-request outcomes; it never supplies authorization. */
export function createDianaExtensionHandler(deps: Dependencies) {
  return async (request: Request) => {
    try {
      const expected = deps.token()?.trim() || "";
      if (expected.length < 32 || expected.length > 4096 || /\s/.test(expected)) return json({ ok: false, error: "La integración de prórrogas no está configurada." }, 503);
      const received = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") || "")?.[1] || "";
      const a = Buffer.from(received), b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ ok: false, error: "No autorizado." }, 401);
      const legacyEnabled = deps.enabled(), requestEnabled = deps.requestEnabled?.() === true;
      if (!legacyEnabled && !requestEnabled) return json({ ok: false, error: "La gestión automática de prórrogas no está habilitada." }, 503);
      const action = parseDianaExtensionAction(await readAttentionJson(request, { maxBytes: 8192 }));
      if (action.action === "request_status") {
        if (!requestEnabled || !deps.requestStatus) return json({ ok: false, error: "La gestión directa de prórrogas no está habilitada." }, 503);
        const result = await deps.requestStatus(action.input);
        return json({ ok: true, estado: result.status,
          aprobada: ["GRANTED", "ACTIVE"].includes(result.status) && result.approved === true,
          yaExistia: result.existing === true, dias: result.days,
          cuotaNumero: result.installmentNumber, vencimientoCuota: result.installmentDueDate,
          fechaLimite: result.expiresOn, motivo: result.reason });
      }
      if (!legacyEnabled) return json({ ok: false, error: "La gestión de propuestas no está habilitada." }, 503);
      const result = action.action === "propose" ? await deps.propose(action.input) : await deps.status(action.code);
      return json({ ok: true, codigo: result.code, estado: result.status,
        aprobada: result.status === "GRANTED" && result.approved === true,
        oferta: result.offerText, propuestaVenceAt: result.expiresAt,
        dias: result.days, cuotaNumero: result.installmentNumber,
        vencimientoCuota: result.installmentDueDate, fechaLimite: result.expiresOn,
        compromiso: { valor: result.promiseAmount, fecha: result.promiseDate } });
    } catch (error) {
      if (error instanceof AttentionError) return json({ ok: false, error: error.message }, error.status);
      // Do not disclose SQL, customer identifiers, tokens or provider payloads.
      return json({ ok: false, error: "No fue posible consultar o preparar la prórroga. Solicita revisión con un analista." }, 503);
    }
  };
}
