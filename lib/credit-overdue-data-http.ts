import { createHash, timingSafeEqual } from "node:crypto";
import type { CreditOverdueDataOptions, CreditOverdueDataReport } from "@/lib/credit-overdue-data-campaign";

function equalSecret(received: string, expected: string | undefined) {
  const secret = expected?.trim();
  return Boolean(secret && received && timingSafeEqual(
    createHash("sha256").update(received).digest(), createHash("sha256").update(secret).digest(),
  ));
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Authorization, Cookie" } });
}
function validPreviewDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T12:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function createCreditOverdueDataHandlers(deps: {
  getAdmin: () => Promise<boolean>; cronTokens: () => Array<string | undefined>;
  previewToken: () => string | undefined;
  run: (options: CreditOverdueDataOptions) => Promise<CreditOverdueDataReport>;
}) {
  async function authorize(req: Request, previewOnly: boolean) {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "")?.[1]
      || req.headers.get("x-mora-sync-token")?.trim() || "";
    if (deps.cronTokens().some(expected => equalSecret(token, expected))) return true;
    if (previewOnly && equalSecret(token, deps.previewToken())) return true;
    return deps.getAdmin();
  }
  return {
    GET: async (req: Request) => {
      if (!await authorize(req, true)) return json({ ok: false, error: "No autorizado" }, 401);
      const today = new URL(req.url).searchParams.get("today");
      if (today && !validPreviewDate(today)) return json({ ok: false, error: "Fecha de preview invalida" }, 400);
      try { return json(await deps.run({ dryRun: true, ...(today ? { previewDate: today } : {}) })); }
      catch { return json({ ok: false, error: "No se pudo consultar la campaña Datos" }, 500); }
    },
    POST: async (req: Request) => {
      if (!await authorize(req, false)) return json({ ok: false, error: "No autorizado" }, 401);
      let body: unknown;
      try { body = await req.json(); }
      catch { return json({ ok: false, error: "JSON invalido" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || ("dryRun" in body && typeof body.dryRun !== "boolean")) return json({ ok: false, error: "dryRun debe ser booleano" }, 400);
      try {
        // Only an explicit false can dispatch; external date/limit controls are ignored.
        const report = await deps.run({ dryRun: !("dryRun" in body && body.dryRun === false) });
        return json(report, report.ok ? 200 : 207);
      } catch { return json({ ok: false, error: "No se pudo procesar la campaña Datos" }, 500); }
    },
  };
}
