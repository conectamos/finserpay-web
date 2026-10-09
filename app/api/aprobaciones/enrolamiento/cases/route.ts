import { NextRequest } from "next/server";
import {
  analystEnrollmentErrorResponse,
  enrollmentResponse,
  limitAnalystEnrollment,
  requireAnalystEnrollmentSession,
} from "@/lib/analyst-enrollment-access";
import {
  createIphoneEnrollmentCaseToken,
  hashIphoneEnrollmentDocument,
  hashIphoneEnrollmentImei,
  normalizeIphoneEnrollmentDocument,
  normalizeIphoneEnrollmentImei,
  readLimitedIphoneEnrollmentJson,
} from "@/lib/iphone-enrollment";
import { findIphoneEnrollmentCase } from "@/lib/iphone-enrollment-storage";
import { lookupNominalIphoneEnrollmentDiagnostics } from "@/lib/iphone-enrollment-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { actor, signedSession } = await requireAnalystEnrollmentSession(request);
    const body = await readLimitedIphoneEnrollmentJson<{ document?: unknown; imei?: unknown }>(request);
    const limited = await limitAnalystEnrollment(actor, "LOOKUP", 30);
    if (limited) return limited;
    const document = normalizeIphoneEnrollmentDocument(body.document);
    const imei = normalizeIphoneEnrollmentImei(body.imei);
    if (!document || !imei) return enrollmentResponse({ ok: false, error: "Ingresa una cédula válida y un IMEI de 15 dígitos." }, 400);

    // Diagnostics never authorize enrollment. Only the authoritative exact-pair
    // lookup can issue a session-bound case token.
    const result = await findIphoneEnrollmentCase({ document, imei });
    if (result.kind !== "FOUND") {
      const diagnostics = await lookupNominalIphoneEnrollmentDiagnostics({ document, imei }, { userId: actor.id });
      const errors = {
        NOT_READY: "La solicitud aún no está lista para enrolamiento. Revisa la etapa y las validaciones pendientes.",
        FINALIZED: "Este crédito ya fue finalizado. Consulta su registro o la operación de cambio por garantía.",
        NOT_FOUND: diagnostics.kind === "MISMATCH"
          ? "La cédula y el IMEI no coinciden en un mismo registro. Revisa los datos encontrados."
          : "No se encontró una solicitud iPhone disponible con esos datos.",
        AMBIGUOUS: "Hay más de una solicitud con esos datos. Revisa los registros antes de continuar.",
      };
      return enrollmentResponse({ ok: false, code: result.kind, error: errors[result.kind], submitted: { document, imei }, diagnostics }, result.kind === "NOT_FOUND" ? 404 : 409);
    }
    const item = result.item;
    const caseToken = createIphoneEnrollmentCaseToken({
      solicitudId: item.solicitudId, targetType: item.targetType, targetId: item.targetId,
      documentHash: hashIphoneEnrollmentDocument(document), imeiHash: hashIphoneEnrollmentImei(imei), session: signedSession,
    });
    return enrollmentResponse({ ok: true, caseToken, item: {
      solicitudId: item.solicitudId, solicitudNumero: item.solicitudNumero,
      operationType: item.targetType === "DEVICE_REPLACEMENT" ? "WARRANTY_REPLACEMENT" : "SALE",
      operationLabel: item.operationLabel, clienteNombre: item.clienteNombre,
      documento: document, imei, equipo: item.equipo, sede: item.sede, aliado: item.aliado,
      creditDecision: "APROBADA", enrollmentStatus: item.review ? "ENROLADO_CORRECTAMENTE" : "LISTO_PARA_ENROLAR",
      review: item.review ? { id: item.review.id, decision: item.review.decision, analystName: item.review.analystName, analystExternalId: item.review.analystExternalId, approvedAt: item.review.approvedAt } : null,
    } });
  } catch (error) { return analystEnrollmentErrorResponse(error); }
}
