import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  buildCreditAccessWhere,
  buildCreditLookupWhere,
  parseCreditRouteLookup,
} from "@/lib/credit-route-lookup";
import {
  buildFirmaSeguroCallbackUrl,
  collectFirmaSeguroUuidCandidates,
  extractFirmaSeguroSignedDocument,
  extractFirmaSeguroStatus,
  extractFirmaSeguroUuid,
  firmaSeguroCreateFull,
  firmaSeguroCreateFullByCompany,
  FirmaSeguroApiError,
  firmaSeguroGetAuthenticationTypes,
  firmaSeguroGetAuraQuanticDocumentByUuid,
  firmaSeguroGetDocumentByUuid,
  firmaSeguroGetDocumentsByUuid,
  firmaSeguroGetProcessStatus,
  firmaSeguroGetSignaturesStatus,
  firmaSeguroSignIn,
  getFirmaSeguroConfig,
  isFirmaSeguroCompletedStatus,
  isFirmaSeguroConfigured,
  isFirmaSeguroPermissionError,
  isFirmaSeguroUnauthorizedError,
  summarizeFirmaSeguroDocumentPayload,
} from "@/lib/firmaseguro";
import {
  buildFirmaSeguroCreditPdf,
  type CreditForFirmaSeguroPdf,
} from "@/lib/firmaseguro-credit-pdf";
import {
  getFirmaSeguroProcessByUuid,
  getLatestFirmaSeguroProcessByCredit,
  getLatestFirmaSeguroProcessByDraft,
  linkFirmaSeguroProcessToCredit,
  type FirmaSeguroProcessRow,
  updateFirmaSeguroProcess,
  upsertFirmaSeguroProcess,
} from "@/lib/firmaseguro-storage";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";

type StoredFirmaSeguroCredit = Prisma.CreditoGetPayload<{
  include: {
    usuario: {
      select: {
        id: true;
        nombre: true;
        usuario: true;
      };
    };
    vendedor: {
      select: {
        id: true;
        nombre: true;
        documento: true;
        telefono: true;
        email: true;
      };
    };
    sede: {
      select: {
        id: true;
        nombre: true;
        codigo: true;
        aliadoId: true;
      };
    };
  };
}>;

type FirmaSeguroCredit = CreditForFirmaSeguroPdf & {
  id?: number | null;
};

type AuthorizedCreditResult =
  | {
      ok: true;
      credito: StoredFirmaSeguroCredit;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

type PersonPayload = {
  firstName: string;
  secondName: string | null;
  firstLastName: string;
  secondLastName: string | null;
  document: string;
  email: string | null;
  phone: string;
};

export function serializeFirmaSeguroProcess(row: FirmaSeguroProcessRow | null) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    creditoId: row.creditoId,
    draftId: row.draftId,
    draftFolio: row.draftFolio,
    processUuid: row.processUuid,
    status: row.status,
    hasSignedDocument: Boolean(row.signedDocumentBase64),
    signedDocumentFileName: row.signedDocumentFileName,
    lastError: row.lastError,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    completedAt:
      row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt,
  };
}

export async function getAuthorizedFirmaSeguroCredit(
  routeId: string,
  options: { requireSupervisorOrAdmin?: boolean } = {}
): Promise<AuthorizedCreditResult> {
  const user = await getSessionUser();

  if (!user) {
    return { ok: false, status: 401, error: "No autenticado" };
  }

  const admin = isAdminRole(user.rolNombre);
  const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  const sellerSession = admin ? null : await getSellerSessionUser(user);
  const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";

  if (!admin && !sellerSession) {
    return { ok: false, status: 403, error: "No tienes acceso a este credito" };
  }

  if (options.requireSupervisorOrAdmin && !admin && !supervisor) {
    return {
      ok: false,
      status: 403,
      error: "Solo supervisor o administrador puede consultar este documento",
    };
  }

  const creditLookup = parseCreditRouteLookup(routeId);

  if (!creditLookup.id && !creditLookup.folio) {
    return { ok: false, status: 400, error: "Credito invalido" };
  }

  const credito = await prisma.credito.findFirst({
    where: {
      AND: [
        buildCreditLookupWhere(creditLookup),
        buildCreditAccessWhere({
          admin,
          adminCentral,
          aliadoId: user.aliadoAccesoId,
          sedeId: user.sedeId,
          sellerSedeId: sellerSession?.sedeId,
          supervisor,
        }),
      ],
    },
    include: {
      usuario: {
        select: {
          id: true,
          nombre: true,
          usuario: true,
        },
      },
      vendedor: {
        select: {
          id: true,
          nombre: true,
          documento: true,
          telefono: true,
          email: true,
        },
      },
      sede: {
        select: {
          id: true,
          nombre: true,
          codigo: true,
          aliadoId: true,
        },
      },
    },
  });

  if (!credito) {
    return { ok: false, status: 404, error: "Credito no encontrado" };
  }

  return { ok: true, credito };
}

function cleanText(value: string | null | undefined) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(value: string | null | undefined) {
  return cleanText(value)
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureProviderName(value: string | null | undefined, fallback: string) {
  const cleaned = cleanName(value).slice(0, 50).trim();
  if (cleaned.length >= 2) {
    return cleaned;
  }

  return fallback;
}

function normalizeEmail(value: string | null | undefined) {
  const email = cleanText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePhone(value: string | null | undefined) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length > 10) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("0") && digits.length > 7) {
    digits = digits.replace(/^0+/, "");
  }

  return digits.length >= 7 ? digits : "";
}

function splitClientName(credito: FirmaSeguroCredit): PersonPayload {
  const nameParts = cleanName(credito.clienteNombre).split(" ").filter(Boolean);
  const firstName = ensureProviderName(
    cleanName(credito.clientePrimerNombre) || nameParts[0] || "Cliente",
    "Cliente"
  );
  const firstLastName = ensureProviderName(
    cleanName(credito.clientePrimerApellido) ||
    nameParts.slice(1).join(" ") ||
    nameParts[0] ||
    "Finser",
    "Finser"
  );

  return {
    firstName,
    secondName: null,
    firstLastName,
    secondLastName: null,
    document: cleanText(credito.clienteDocumento),
    email: normalizeEmail(credito.clienteCorreo),
    phone: normalizePhone(credito.clienteTelefono),
  };
}

function redactBase64Payload(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (/token|password|authorization/i.test(key)) {
        return "[redacted]";
      }

      if (
        typeof item === "string" &&
        /base64|string|document/i.test(key) &&
        item.length > 500
      ) {
        return `[base64:${item.length}]`;
      }

      return item;
    })
  );
}

async function downloadFirmaSeguroSignedDocument(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/pdf,application/json,text/plain,*/*",
    },
    cache: "no-store",
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const body = buffer.toString("utf8").trim();
    throw new FirmaSeguroApiError(
      `FirmaSeguro no permitio descargar el PDF firmado desde el enlace entregado (${response.status})`,
      response.status,
      body ? body.slice(0, 500) : null
    );
  }

  if (/application\/json|text\//i.test(contentType)) {
    const text = buffer.toString("utf8").trim();
    let payload: unknown = text;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    const documentInfo = extractFirmaSeguroSignedDocument(payload);
    if (documentInfo.base64) {
      return documentInfo;
    }

    throw new FirmaSeguroApiError(
      "FirmaSeguro entrego un enlace, pero la respuesta no contiene un PDF firmado",
      500,
      text.slice(0, 500)
    );
  }

  if (buffer.length < 4 || buffer.subarray(0, 4).toString("ascii") !== "%PDF") {
    throw new FirmaSeguroApiError(
      "FirmaSeguro entrego un archivo que no parece ser PDF",
      500,
      { contentType, bytes: buffer.length }
    );
  }

  return {
    base64: buffer.toString("base64"),
    fileName: "",
    url,
  };
}

function summarizeFirmaSeguroDocumentAttempts(attempts: unknown[]) {
  return attempts
    .map((attempt) => {
      if (!attempt || typeof attempt !== "object") {
        return "";
      }

      const item = attempt as {
        source?: unknown;
        warning?: unknown;
        foundBase64?: unknown;
        foundUrl?: unknown;
        fileName?: unknown;
        payloadSummary?: unknown;
      };
      const source =
        typeof item.source === "string" && item.source.trim()
          ? item.source.trim()
          : "consulta";

      if (typeof item.warning === "string" && item.warning.trim()) {
        return `${source}: ${item.warning.trim().slice(0, 120)}`;
      }

      if (item.foundBase64) {
        return `${source}: PDF base64 encontrado`;
      }

      if (item.foundUrl) {
        return `${source}: enlace encontrado`;
      }

      const payloadSummary =
        item.payloadSummary &&
        typeof item.payloadSummary === "object" &&
        "keys" in item.payloadSummary
          ? item.payloadSummary
          : null;

      if (payloadSummary) {
        const keys = (payloadSummary as { keys?: unknown }).keys;
        const keyText = Array.isArray(keys)
          ? keys.filter((key) => typeof key === "string").slice(0, 6).join(", ")
          : "";
        return keyText
          ? `${source}: sin PDF; campos ${keyText}`
          : `${source}: sin PDF`;
      }

      return `${source}: sin PDF`;
    })
    .filter(Boolean)
    .join("; ")
    .slice(0, 900);
}

function getFirmaSeguroTags(credito: FirmaSeguroCredit) {
  return [
    { empresa: "FINSERPAY" },
    { credito: credito.folio },
    { cedula: credito.clienteDocumento || "-" },
  ];
}

function buildFirmaSeguroMessage(credito: FirmaSeguroCredit) {
  return [
    `Hola ${credito.clienteNombre}.`,
    "FINSER PAY solicita tu firma electronica para la autorizacion de datos, contrato, pagare y carta de instrucciones de tu credito.",
    `Folio: ${credito.folio}.`,
    "Por favor revisa el PDF completo y confirma la firma solo si estas de acuerdo.",
  ].join(" ");
}

function getSignerEmail(person: PersonPayload) {
  const config = getFirmaSeguroConfig();
  const senderEmail = normalizeEmail(config.email);

  if (!person.email) {
    return null;
  }

  if (person.email !== senderEmail) {
    return person.email;
  }

  const [localPart, domain] = person.email.split("@");
  if (!localPart || !domain || !/^(gmail|googlemail)\.com$/i.test(domain)) {
    return null;
  }

  const aliasSeed =
    person.document.replace(/\D/g, "") ||
    person.phone.replace(/\D/g, "") ||
    "firmante";
  const normalizedLocal = localPart.replace(/\+.*/, "");
  return `${normalizedLocal}+finserpay-${aliasSeed}@${domain}`;
}

function getOptionalEnvNumber(name: string) {
  const parsed = Number(process.env[name] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getFirmaSeguroDelivery(person: PersonPayload) {
  const config = getFirmaSeguroConfig();
  const signerEmail = getSignerEmail(person);
  const channel =
    cleanText(process.env.FIRMASEGURO_DELIVERY_CHANNEL).toLowerCase() ||
    "whatsapp";
  const forceWhatsapp = ["whatsapp", "otp_whatsapp", "otp-whatsapp"].includes(channel);
  const forceEmail = ["email", "otp_email", "otp-email"].includes(channel);
  const sendByEmail = Boolean(signerEmail && forceEmail);
  const sendByWhatsApp = Boolean(
    person.phone && (forceWhatsapp || (!forceEmail && !sendByEmail))
  );
  const notifyByEmail = Boolean(
    config.notifyByEmail && signerEmail
  );
  const notifyByWhatsApp = Boolean(
    config.notifyByWhatsApp && person.phone
  );
  const emailAuthMethodId =
    getOptionalEnvNumber("FIRMASEGURO_EMAIL_AUTH_METHOD_ID") ||
    config.authMethodId;
  const whatsappAuthMethodId =
    getOptionalEnvNumber("FIRMASEGURO_WHATSAPP_AUTH_METHOD_ID") ||
    config.authMethodId;
  const authMethodId = sendByEmail ? emailAuthMethodId : whatsappAuthMethodId;
  const authMethodSource = sendByEmail
    ? "email-env"
    : sendByWhatsApp
      ? "whatsapp-env"
      : "default";

  return {
    signerEmail,
    sendByEmail,
    sendByWhatsApp,
    notifyByEmail,
    notifyByWhatsApp,
    authMethodId,
    authMethodSource,
  };
}

function optionalText(value: string | null | undefined) {
  const cleaned = cleanText(value);
  return cleaned || undefined;
}

function getCreditPackageBalanceTypeId(
  config: ReturnType<typeof getFirmaSeguroConfig>
) {
  return config.balanceTypeId;
}

function normalizeProviderText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getProviderObjectId(record: Record<string, unknown>) {
  const keys = [
    "id",
    "Id",
    "ID",
    "authenticationMethodId",
    "AuthenticationMethodId",
    "authentication_method_id",
    "autenticationTypeId",
    "AutenticationTypeId",
    "autentication_type_id",
  ];

  for (const key of keys) {
    const numeric = Number(record[key]);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

function getProviderObjectText(record: Record<string, unknown>) {
  return Object.entries(record)
    .filter(([key, value]) => {
      if (typeof value !== "string") {
        return false;
      }
      return /name|nombre|description|descripcion|method|metodo|type|tipo/i.test(
        key
      );
    })
    .map(([, value]) => value)
    .join(" ");
}

type AuthenticationMethodPreference = "email" | "whatsapp";

function findAuthenticationMethodId(
  value: unknown,
  preference: AuthenticationMethodPreference
): number | null {
  const candidates: Array<{ id: number; score: number }> = [];

  function visit(item: unknown) {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }

    if (typeof item !== "object" || item === null) {
      return;
    }

    const record = item as Record<string, unknown>;
    const id = getProviderObjectId(record);
    const text = normalizeProviderText(getProviderObjectText(record));
    const isEmail = text.includes("email") || text.includes("correo");
    const isWhatsapp =
      text.includes("whatsapp") ||
      text.includes("whats app");
    const isSms = text.includes("sms");
    const isCall =
      text.includes("llamada") ||
      text.includes("call") ||
      text.includes("telefono");
    const isOtherOtp =
      (preference === "email" && (isWhatsapp || isSms || isCall)) ||
      (preference === "whatsapp" && (isEmail || isSms || isCall));
    const isPreferred =
      preference === "email" ? isEmail : isWhatsapp;

    if (id && isPreferred && !isOtherOtp) {
      candidates.push({
        id,
        score: (text.includes("otp") ? 4 : 1) + (text.includes("certificada") ? 1 : 0),
      });
    } else if (id && isPreferred) {
      candidates.push({
        id,
        score: text.includes("otp") ? 2 : 1,
      });
    } else if (
      id &&
      preference === "whatsapp" &&
      text.includes("documentos") &&
      text.includes("otp")
    ) {
      candidates.push({
        id,
        score: 1,
      });
    }

    Object.values(record).forEach(visit);
  }

  visit(value);
  candidates.sort((a, b) => b.score - a.score || a.id - b.id);
  return candidates[0]?.id ?? null;
}

function findEmailAuthMethodId(value: unknown): number | null {
  return findAuthenticationMethodId(value, "email");
}

function findWhatsappAuthMethodId(value: unknown): number | null {
  return findAuthenticationMethodId(value, "whatsapp");
}

async function resolveFirmaSeguroDeliveryAuth(
  token: string,
  delivery: ReturnType<typeof getFirmaSeguroDelivery>
): Promise<ReturnType<typeof getFirmaSeguroDelivery>> {
  const target = delivery.sendByEmail
    ? "email"
    : delivery.sendByWhatsApp
      ? "whatsapp"
      : null;

  if (!target) {
    return delivery;
  }

  try {
    const authenticationTypes = await firmaSeguroGetAuthenticationTypes(token);
    const authMethodId =
      target === "email"
        ? findEmailAuthMethodId(authenticationTypes)
        : findWhatsappAuthMethodId(authenticationTypes);
    if (!authMethodId) {
      return delivery;
    }

    return {
      ...delivery,
      authMethodId,
      authMethodSource: `provider-${target}-catalog`,
    };
  } catch {
    return delivery;
  }
}

function isFirmaSeguroBalanceError(error: unknown) {
  if (!(error instanceof FirmaSeguroApiError)) {
    return false;
  }

  const raw = [
    error.message,
    typeof error.detail === "string" ? error.detail : "",
    JSON.stringify(error.detail || {}),
  ].join(" ");
  const normalized = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    normalized.includes("saldo suficiente") ||
    normalized.includes("saldo insuficiente") ||
    normalized.includes("insufficient balance")
  );
}

function needsFirmaSeguroConfigContext(error: unknown) {
  if (!(error instanceof FirmaSeguroApiError)) {
    return false;
  }

  if (isFirmaSeguroBalanceError(error)) {
    return true;
  }

  return isFirmaSeguroInputError(error);
}

function isFirmaSeguroInputError(error: unknown) {
  if (!(error instanceof FirmaSeguroApiError)) {
    return false;
  }

  const raw = [
    error.message,
    typeof error.detail === "string" ? error.detail : "",
    JSON.stringify(error.detail || {}),
  ].join(" ");
  const normalized = raw.toLowerCase();

  return (
    normalized.includes("value cannot be null") ||
    normalized.includes("parameter 'input'") ||
    normalized.includes('parameter "input"')
  );
}

function addFirmaSeguroConfigContext(
  error: unknown,
  config: ReturnType<typeof getFirmaSeguroConfig>,
  endpoint: string,
  delivery?: ReturnType<typeof getFirmaSeguroDelivery>
) {
  if (!(error instanceof FirmaSeguroApiError) || !needsFirmaSeguroConfigContext(error)) {
    return error;
  }

  const balanceTypeId = getCreditPackageBalanceTypeId(config);
  const authMethodId = delivery?.authMethodId ?? config.authMethodId;
  return new FirmaSeguroApiError(
    `${error.message}. Configuracion enviada: signatureMethodId=${config.signatureMethodId}, authMethodId=${authMethodId}, balanceTypeId=${balanceTypeId}, email=${delivery?.notifyByEmail ? "si" : "no"}, whatsapp=${delivery?.notifyByWhatsApp ? "si" : "no"}, authSource=${delivery?.authMethodSource || "config"}`,
    error.status,
    {
      ...(typeof error.detail === "object" && error.detail
        ? (error.detail as Record<string, unknown>)
        : { originalDetail: error.detail }),
      endpoint,
      firmaSeguroConfig: {
        signatureMethodId: config.signatureMethodId,
        authMethodId,
        balanceTypeId,
        sendByEmail: delivery?.notifyByEmail ?? false,
        sendByWhatsApp: delivery?.notifyByWhatsApp ?? false,
        authMethodSource: delivery?.authMethodSource,
      },
    }
  );
}

function buildCreateFullByCompanyPayload(
  credito: FirmaSeguroCredit,
  person: PersonPayload,
  pdfBase64: string,
  callbackUrl: string,
  delivery: ReturnType<typeof getFirmaSeguroDelivery>
) {
  const config = getFirmaSeguroConfig();
  const fileName = `paquete-finserpay-${credito.folio}.pdf`;

  return {
    process: {
      process_type_id: config.processTypeId,
      signature_method_id: config.signatureMethodId,
      balance_type_id: getCreditPackageBalanceTypeId(config),
      is_in_order: false,
      tags: getFirmaSeguroTags(credito),
      is_read: true,
      language: "es",
      is_hand_written: config.handwrittenEvidence,
      is_photographic: config.photographicEvidence,
      isSendByEmail: delivery.notifyByEmail,
      isSendByWhatsApp: delivery.notifyByWhatsApp,
      deadline_days: config.deadlineDays,
      callback: callbackUrl,
      ...(delivery.notifyByEmail
        ? {
            subject_email: `Firma documentos FINSER PAY ${credito.folio}`,
            message_email: buildFirmaSeguroMessage(credito),
          }
        : {}),
      process_name: `Credito FINSER PAY ${credito.folio}`,
      nit: config.nit,
      email_user: config.email,
    },
    signers: [
      {
        order: 1,
        rol: "Firmante",
        authentication_method_id: delivery.authMethodId,
        indicative: "57",
        ...(person.phone ? { number: person.phone } : {}),
        ...(delivery.signerEmail ? { email: delivery.signerEmail } : {}),
        first_name: person.firstName,
        second_name: optionalText(person.secondName),
        first_last_name: person.firstLastName,
        second_last_name: optionalText(person.secondLastName),
        identification: person.document,
        identification_type_id: config.identificationTypeId,
        type_person_id: config.typePersonId,
        signatory_type: "Firmante",
      },
    ],
    document: {
      file_name: fileName,
      document_type_id: 1,
      base64_string: pdfBase64,
    },
  };
}

function buildCreateFullPayload(
  credito: FirmaSeguroCredit,
  person: PersonPayload,
  pdfBase64: string,
  callbackUrl: string,
  delivery: ReturnType<typeof getFirmaSeguroDelivery>
) {
  const config = getFirmaSeguroConfig();
  const fileName = `paquete-finserpay-${credito.folio}.pdf`;

  return {
    processTypeId: config.processTypeId,
    signatureMethodId: config.signatureMethodId,
    deadlineDays: config.deadlineDays,
    isInOrder: false,
    tags: getFirmaSeguroTags(credito),
    isRead: true,
    isSendByEmail: delivery.notifyByEmail,
    isSendByWhatsApp: delivery.notifyByWhatsApp,
    language: "es",
    isHandWritten: config.handwrittenEvidence,
    isPhotographic: config.photographicEvidence,
    callback: callbackUrl,
    ...(delivery.notifyByEmail
      ? {
          subjectEmail: `Firma documentos FINSER PAY ${credito.folio}`,
          messageEmail: buildFirmaSeguroMessage(credito),
        }
      : {}),
    balanceTypeId: getCreditPackageBalanceTypeId(config),
    signatures: [
      {
        order: 1,
        rol: "Firmante",
        authenticationMethodId: delivery.authMethodId,
        contactInformation: {
          ...(person.phone
            ? {
                phone: {
                  indicative: "57",
                  number: person.phone,
                },
              }
            : {}),
          ...(delivery.signerEmail ? { email: delivery.signerEmail } : {}),
          person: {
            firstName: person.firstName,
            firstLastName: person.firstLastName,
            identification: person.document,
            identificationTypeId: config.identificationTypeId,
            typePersonId: config.typePersonId,
          },
        },
        signatory_type: "Firmante",
      },
    ],
    documents: {
      fileName,
      documentTypeId: 1,
      base64String: pdfBase64,
    },
  };
}

function mergeFirmaSeguroSnapshot(
  snapshot: unknown,
  patch: Record<string, unknown>
) {
  const root =
    typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
      ? { ...(snapshot as Record<string, unknown>) }
      : {};
  const evidencia =
    typeof root.evidencia === "object" &&
    root.evidencia !== null &&
    !Array.isArray(root.evidencia)
      ? { ...(root.evidencia as Record<string, unknown>) }
      : {};
  const firmaSeguro =
    typeof evidencia.firmaSeguro === "object" &&
    evidencia.firmaSeguro !== null &&
    !Array.isArray(evidencia.firmaSeguro)
      ? { ...(evidencia.firmaSeguro as Record<string, unknown>) }
      : {};

  return {
    ...root,
    evidencia: {
      ...evidencia,
      firmaSeguro: {
        ...firmaSeguro,
        ...patch,
      },
    },
  };
}

export async function markCreditoFirmaSeguroCompleted(
  creditoId: number,
  options: {
    processUuid: string;
    status: string;
    signedDocumentFileName?: string | null;
    completedAt?: Date | null;
  }
) {
  const credito = await prisma.credito.findUnique({
    where: { id: creditoId },
    select: {
      id: true,
      clienteTelefono: true,
      clienteCorreo: true,
      contratoAceptadoAt: true,
      pagareAceptadoAt: true,
      contratoOtpCanal: true,
      contratoOtpDestino: true,
      contratoOtpVerificadoAt: true,
      contratoSnapshot: true,
    },
  });

  if (!credito) {
    return null;
  }

  const completedAt = options.completedAt || new Date();
  const snapshot = mergeFirmaSeguroSnapshot(credito.contratoSnapshot, {
    uuid: options.processUuid,
    estado: options.status,
    firmadoAt: completedAt.toISOString(),
    documentoFirmado: options.signedDocumentFileName || null,
    proveedor: "FirmaSeguro",
  });

  return prisma.credito.update({
    where: { id: credito.id },
    data: {
      contratoAceptadoAt: credito.contratoAceptadoAt || completedAt,
      pagareAceptadoAt: credito.pagareAceptadoAt || completedAt,
      contratoOtpCanal: credito.contratoOtpCanal || "FIRMASEGURO",
      contratoOtpDestino:
        credito.contratoOtpDestino ||
        credito.clienteTelefono ||
        credito.clienteCorreo ||
        null,
      contratoOtpVerificadoAt: credito.contratoOtpVerificadoAt || completedAt,
      contratoSnapshot: snapshot as Prisma.InputJsonValue,
    },
  });
}

async function runWithFirmaSeguroAuth<T>(
  operation: (token: string) => Promise<T>
) {
  let auth = await firmaSeguroSignIn();
  const authSource =
    typeof auth.payload === "object" &&
    auth.payload !== null &&
    !Array.isArray(auth.payload)
      ? String((auth.payload as Record<string, unknown>).source || "")
      : "";

  try {
    return {
      auth,
      result: await operation(auth.token),
    };
  } catch (error) {
    const config = getFirmaSeguroConfig();
    const canRefreshToken = Boolean(
      config.email &&
        config.password &&
        config.authMode !== "token" &&
        config.authMode !== "access_token" &&
        authSource !== "FIRMASEGURO_ACCESS_TOKEN"
    );

    if (
      (!isFirmaSeguroUnauthorizedError(error) &&
        !isFirmaSeguroPermissionError(error)) ||
      !canRefreshToken
    ) {
      throw error;
    }

    auth = await firmaSeguroSignIn({ ignoreAccessToken: true });

    return {
      auth,
      result: await operation(auth.token),
    };
  }
}

async function createFirmaSeguroProcess(
  credito: FirmaSeguroCredit,
  options: {
    creditoId?: number | null;
    draftId?: number | null;
    draftFolio?: string | null;
    draftPayload?: unknown;
  } = {}
) {
  if (!isFirmaSeguroConfigured()) {
    throw new FirmaSeguroApiError(
      "Falta configurar FIRMASEGURO_ACCESS_TOKEN o FIRMASEGURO_EMAIL y FIRMASEGURO_PASSWORD",
      500,
      null
    );
  }

  const callbackUrl = buildFirmaSeguroCallbackUrl(options.creditoId || undefined);
  if (!callbackUrl) {
    throw new FirmaSeguroApiError(
      "Falta configurar NEXT_PUBLIC_APP_URL, APP_URL o FIRMASEGURO_CALLBACK_URL",
      500,
      null
    );
  }

  const person = splitClientName(credito);
  if (!person.document) {
    throw new FirmaSeguroApiError(
      "El credito no tiene documento del cliente para firmar",
      400,
      null
    );
  }
  const config = getFirmaSeguroConfig();
  let delivery = getFirmaSeguroDelivery(person);
  if (!delivery.sendByEmail && !delivery.sendByWhatsApp) {
    const message = cleanText(process.env.FIRMASEGURO_DELIVERY_CHANNEL)
      .toLowerCase()
      .includes("email")
      ? "El credito no tiene correo valido del cliente para enviar OTP Email"
      : "El credito no tiene correo ni telefono valido del cliente para enviar OTP";
    throw new FirmaSeguroApiError(
      message,
      400,
      null
    );
  }

  if (config.notifyByEmail && !delivery.signerEmail) {
    throw new FirmaSeguroApiError(
      "FirmaSeguro requiere correo del firmante para crear el proceso. Usa un correo valido del cliente y diferente al remitente de FirmaSeguro.",
      400,
      null
    );
  }

  const pdf = await buildFirmaSeguroCreditPdf(credito);
  const pdfBase64 = pdf.toString("base64");
  const useCompanyEndpoint = Boolean(config.nit && config.useCompanyEndpoint);
  let requestPayload: unknown = null;
  let endpoint = useCompanyEndpoint ? "create-full-by-company" : "create-full";

  const submitCreateRequest = async (token: string) => {
    delivery = await resolveFirmaSeguroDeliveryAuth(token, delivery);
    requestPayload =
      endpoint === "create-full-by-company"
        ? buildCreateFullByCompanyPayload(
            credito,
            person,
            pdfBase64,
            callbackUrl,
            delivery
          )
        : buildCreateFullPayload(credito, person, pdfBase64, callbackUrl, delivery);

    try {
      return endpoint === "create-full-by-company"
        ? await firmaSeguroCreateFullByCompany(token, requestPayload)
        : await firmaSeguroCreateFull(token, requestPayload);
    } catch (error) {
      const canTryCompanyEndpoint =
        endpoint === "create-full" &&
        Boolean(config.nit) &&
        (isFirmaSeguroInputError(error) ||
          isFirmaSeguroPermissionError(error) ||
          isFirmaSeguroUnauthorizedError(error));

      if (canTryCompanyEndpoint) {
        requestPayload = buildCreateFullByCompanyPayload(
          credito,
          person,
          pdfBase64,
          callbackUrl,
          delivery
        );
        endpoint = "create-full-by-company";
        return firmaSeguroCreateFullByCompany(token, requestPayload);
      }

      const canTryDefaultEndpoint =
        endpoint === "create-full-by-company" &&
        (isFirmaSeguroPermissionError(error) ||
          isFirmaSeguroUnauthorizedError(error));

      if (!canTryDefaultEndpoint) {
        throw error;
      }

      requestPayload = buildCreateFullPayload(
        credito,
        person,
        pdfBase64,
        callbackUrl,
        delivery
      );
      endpoint = "create-full";
      return firmaSeguroCreateFull(token, requestPayload);
    }
  };

  let auth: Awaited<ReturnType<typeof firmaSeguroSignIn>>;
  let createPayload: unknown;
  try {
    const response = await runWithFirmaSeguroAuth(submitCreateRequest);
    auth = response.auth;
    createPayload = response.result;
  } catch (error) {
    throw addFirmaSeguroConfigContext(error, config, endpoint, delivery);
  }
  const authPayload = auth.payload;
  const processUuid = extractFirmaSeguroUuid(createPayload);

  if (!processUuid) {
    throw new FirmaSeguroApiError(
      "FirmaSeguro no retorno UUID del proceso",
      500,
      createPayload
    );
  }

  const status = extractFirmaSeguroStatus(createPayload) || "CREATED";
  const row = await upsertFirmaSeguroProcess({
    creditoId: options.creditoId || null,
    draftId: options.draftId || null,
    draftFolio: options.draftFolio || null,
    draftPayload: options.draftPayload,
    processUuid,
    status,
    requestPayload: redactBase64Payload({
      endpoint,
      payload: requestPayload,
    }),
    createPayload,
  });

  if (options.creditoId) {
    const snapshot = mergeFirmaSeguroSnapshot(credito.contratoSnapshot, {
      uuid: processUuid,
      estado: status,
      creadoAt: new Date().toISOString(),
      proveedor: "FirmaSeguro",
      auth: redactBase64Payload(authPayload),
    });

    await prisma.credito.update({
      where: { id: options.creditoId },
      data: {
        contratoSnapshot: snapshot as Prisma.InputJsonValue,
      },
    });
  }

  return row;
}

export async function createFirmaSeguroProcessForCredit(
  credito: StoredFirmaSeguroCredit
) {
  return createFirmaSeguroProcess(credito, {
    creditoId: credito.id,
  });
}

export async function createFirmaSeguroProcessForDraft(
  credito: FirmaSeguroCredit,
  options: {
    draftId: number;
    draftFolio: string;
    draftPayload?: unknown;
  }
) {
  return createFirmaSeguroProcess(credito, {
    draftId: options.draftId,
    draftFolio: options.draftFolio,
    draftPayload: options.draftPayload,
  });
}

export async function refreshFirmaSeguroProcess(
  process: FirmaSeguroProcessRow,
  options: { credito?: FirmaSeguroCredit | null } = {}
) {
  const { result: refreshPayload } = await runWithFirmaSeguroAuth(
    async (token) => {
      const statusPayload = await firmaSeguroGetProcessStatus(
        token,
        process.processUuid
      );
      let signaturesPayload: unknown = null;

      try {
        signaturesPayload = await firmaSeguroGetSignaturesStatus(
          token,
          process.processUuid
        );
      } catch (error) {
        if (isFirmaSeguroUnauthorizedError(error)) {
          throw error;
        }

        signaturesPayload = {
          warning:
            error instanceof Error
              ? error.message
              : "No se pudo consultar estado de firmantes",
        };
      }

      return { statusPayload, signaturesPayload };
    }
  );
  const { statusPayload, signaturesPayload } = refreshPayload;
  let documentsPayload: unknown = null;
  let signedDocumentBase64 = process.signedDocumentBase64;
  let signedDocumentFileName = process.signedDocumentFileName;
  const documentAttempts: unknown[] = [];
  const status =
    extractFirmaSeguroStatus(statusPayload) ||
    extractFirmaSeguroStatus(process.statusPayload) ||
    process.status;

  const completed =
    isFirmaSeguroCompletedStatus(status) ||
    isFirmaSeguroCompletedStatus(extractFirmaSeguroStatus(signaturesPayload));
  const completedAt = completed ? process.completedAt || new Date() : null;
  let documentDownloadError: string | null = null;

  if (completed) {
    const trySignedDocumentPayload = async (
      source: string,
      fetchPayload: () => Promise<unknown>
    ) => {
      try {
        const payload = await fetchPayload();
        const info = extractFirmaSeguroSignedDocument(payload);
        documentAttempts.push({
          source,
          foundBase64: Boolean(info.base64),
          foundUrl: Boolean(info.url),
          fileName: info.fileName || null,
          payloadSummary: summarizeFirmaSeguroDocumentPayload(payload),
          payload: redactBase64Payload(payload),
        });
        return { payload, info };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "No se pudo consultar documento firmado";
        documentAttempts.push({ source, warning: message });
        return null;
      }
    };

    try {
      const documentUuidCandidates = [
        process.processUuid,
        ...collectFirmaSeguroUuidCandidates(
          statusPayload,
          signaturesPayload,
          process.statusPayload,
          process.signaturesPayload,
          process.documentsPayload
        ),
      ].filter((uuid, index, list) => uuid && list.indexOf(uuid) === index);

      let documentResult: Awaited<
        ReturnType<typeof trySignedDocumentPayload>
      > = null;
      let documentInfo = {
        base64: "",
        fileName: "",
        url: "",
      };

      for (const documentUuid of documentUuidCandidates) {
        const label =
          documentUuid === process.processUuid ? "proceso" : "relacionado";

        documentResult = await trySignedDocumentPayload(
          `Document/ByUUID public (${label})`,
          () => firmaSeguroGetDocumentsByUuid(documentUuid)
        );
        documentInfo = documentResult?.info || documentInfo;

        if (documentInfo.base64 || documentInfo.url) {
          break;
        }

        documentResult = await trySignedDocumentPayload(
          `Document/ByUUID autenticado (${label})`,
          async () => {
            const { result } = await runWithFirmaSeguroAuth((token) =>
              firmaSeguroGetDocumentsByUuid(documentUuid, token)
            );
            return result;
          }
        );
        documentInfo = documentResult?.info || documentInfo;

        if (documentInfo.base64 || documentInfo.url) {
          break;
        }

        documentResult = await trySignedDocumentPayload(
          `Document Aura Quantic autenticado (${label})`,
          async () => {
            const { result } = await runWithFirmaSeguroAuth((token) =>
              firmaSeguroGetAuraQuanticDocumentByUuid(documentUuid, token)
            );
            return result;
          }
        );
        documentInfo = documentResult?.info || documentInfo;

        if (documentInfo.base64 || documentInfo.url) {
          break;
        }

        documentResult = await trySignedDocumentPayload(
          `Document individual public (${label})`,
          () => firmaSeguroGetDocumentByUuid(documentUuid)
        );
        documentInfo = documentResult?.info || documentInfo;

        if (documentInfo.base64 || documentInfo.url) {
          break;
        }

        documentResult = await trySignedDocumentPayload(
          `Document individual autenticado (${label})`,
          async () => {
            const { result } = await runWithFirmaSeguroAuth((token) =>
              firmaSeguroGetDocumentByUuid(documentUuid, token)
            );
            return result;
          }
        );
        documentInfo = documentResult?.info || documentInfo;

        if (documentInfo.base64 || documentInfo.url) {
          break;
        }
      }

      documentsPayload =
        documentResult?.payload || { attempts: documentAttempts };

      if (!documentInfo.base64 && documentInfo.url) {
        const downloadedDocument = await downloadFirmaSeguroSignedDocument(
          documentInfo.url
        );
        signedDocumentBase64 =
          downloadedDocument.base64 || signedDocumentBase64;
        signedDocumentFileName =
          downloadedDocument.fileName ||
          documentInfo.fileName ||
          signedDocumentFileName ||
          `finserpay-firmado-${process.processUuid}.pdf`;
      } else {
        signedDocumentBase64 = documentInfo.base64 || signedDocumentBase64;
      }

      signedDocumentFileName =
        documentInfo.fileName ||
        signedDocumentFileName ||
        `finserpay-firmado-${process.processUuid}.pdf`;

      if (!signedDocumentBase64) {
        const attemptsSummary =
          summarizeFirmaSeguroDocumentAttempts(documentAttempts);
        documentDownloadError =
          "FirmaSeguro reporto firma exitosa, pero no devolvio el PDF firmado en las consultas de documentos." +
          (attemptsSummary ? ` Intentos: ${attemptsSummary}` : "");
      }
    } catch (error) {
      documentDownloadError =
        error instanceof Error
          ? error.message
          : "No se pudo descargar documento firmado";
      documentsPayload = {
        warning: documentDownloadError,
      };
    }
  }

  const updated = await updateFirmaSeguroProcess(process.processUuid, {
    status,
    statusPayload,
    signaturesPayload,
    documentsPayload: redactBase64Payload(
      documentAttempts.length
        ? { selected: documentsPayload, attempts: documentAttempts }
        : documentsPayload
    ),
    signedDocumentBase64,
    signedDocumentFileName,
    lastError: documentDownloadError,
    completedAt,
  });

  if (updated && completed && updated.creditoId) {
    await markCreditoFirmaSeguroCompleted(updated.creditoId, {
      processUuid: updated.processUuid,
      status: updated.status,
      signedDocumentFileName: updated.signedDocumentFileName,
      completedAt: updated.completedAt || completedAt,
    });
  }

  return updated;
}

export async function getLatestFirmaSeguroProcessForCredit(creditoId: number) {
  return getLatestFirmaSeguroProcessByCredit(creditoId);
}

export async function getLatestFirmaSeguroProcessForDraft(draftId: number) {
  return getLatestFirmaSeguroProcessByDraft(draftId);
}

export async function linkFirmaSeguroProcessForCredit(
  processUuid: string,
  creditoId: number
) {
  return linkFirmaSeguroProcessToCredit(processUuid, creditoId);
}

export async function getFirmaSeguroProcessForCallback(processUuid: string) {
  return getFirmaSeguroProcessByUuid(processUuid);
}
