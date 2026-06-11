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
  extractFirmaSeguroSignedDocument,
  extractFirmaSeguroStatus,
  extractFirmaSeguroUuid,
  firmaSeguroCreateFull,
  firmaSeguroCreateFullByCompany,
  FirmaSeguroApiError,
  firmaSeguroGetAuthenticationTypes,
  firmaSeguroGetDocumentsByUuid,
  firmaSeguroGetProcessStatus,
  firmaSeguroGetSignaturesStatus,
  firmaSeguroSignIn,
  getFirmaSeguroConfig,
  isFirmaSeguroCompletedStatus,
  isFirmaSeguroConfigured,
  isFirmaSeguroPermissionError,
  isFirmaSeguroUnauthorizedError,
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
  const firstName =
    cleanName(credito.clientePrimerNombre) || nameParts[0] || "Cliente";
  const firstLastName =
    cleanName(credito.clientePrimerApellido) ||
    nameParts.slice(1).join(" ") ||
    nameParts[0] ||
    "Finser";

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

  if (person.email && person.email !== senderEmail) {
    return person.email;
  }

  return null;
}

function getOptionalEnvNumber(name: string) {
  const parsed = Number(process.env[name] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getFirmaSeguroDelivery(person: PersonPayload) {
  const config = getFirmaSeguroConfig();
  const signerEmail = getSignerEmail(person);
  const channel = cleanText(process.env.FIRMASEGURO_DELIVERY_CHANNEL).toLowerCase();
  const forceWhatsapp = ["whatsapp", "otp_whatsapp", "otp-whatsapp"].includes(channel);
  const forceEmail = ["email", "otp_email", "otp-email"].includes(channel);
  const sendByEmail = Boolean(signerEmail && (forceEmail || !forceWhatsapp));
  const sendByWhatsApp = Boolean(
    person.phone && (forceWhatsapp || (!forceEmail && !sendByEmail))
  );
  const emailAuthMethodId =
    getOptionalEnvNumber("FIRMASEGURO_EMAIL_AUTH_METHOD_ID") ||
    config.authMethodId;

  return {
    signerEmail,
    sendByEmail,
    sendByWhatsApp,
    authMethodId: sendByEmail ? emailAuthMethodId : config.authMethodId,
    authMethodSource: sendByEmail ? "email-env" : "default",
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

function findEmailAuthMethodId(value: unknown): number | null {
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
    const isOtherOtp =
      text.includes("whatsapp") ||
      text.includes("sms") ||
      text.includes("llamada") ||
      text.includes("call");

    if (id && isEmail && !isOtherOtp) {
      candidates.push({
        id,
        score: text.includes("otp") ? 2 : 1,
      });
    }

    Object.values(record).forEach(visit);
  }

  visit(value);
  candidates.sort((a, b) => b.score - a.score || a.id - b.id);
  return candidates[0]?.id ?? null;
}

async function resolveFirmaSeguroDeliveryAuth(
  token: string,
  delivery: ReturnType<typeof getFirmaSeguroDelivery>
): Promise<ReturnType<typeof getFirmaSeguroDelivery>> {
  if (!delivery.sendByEmail) {
    return delivery;
  }

  try {
    const authenticationTypes = await firmaSeguroGetAuthenticationTypes(token);
    const emailAuthMethodId = findEmailAuthMethodId(authenticationTypes);
    if (!emailAuthMethodId) {
      return delivery;
    }

    return {
      ...delivery,
      authMethodId: emailAuthMethodId,
      authMethodSource: "provider-email-catalog",
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

function addFirmaSeguroConfigContext(
  error: unknown,
  config: ReturnType<typeof getFirmaSeguroConfig>,
  endpoint: string,
  delivery?: ReturnType<typeof getFirmaSeguroDelivery>
) {
  if (!(error instanceof FirmaSeguroApiError) || !isFirmaSeguroBalanceError(error)) {
    return error;
  }

  const balanceTypeId = getCreditPackageBalanceTypeId(config);
  const authMethodId = delivery?.authMethodId ?? config.authMethodId;
  return new FirmaSeguroApiError(
    `${error.message}. Configuracion enviada: signatureMethodId=${config.signatureMethodId}, authMethodId=${authMethodId}, balanceTypeId=${balanceTypeId}, email=${delivery?.sendByEmail ? "si" : "no"}, whatsapp=${delivery?.sendByWhatsApp ? "si" : "no"}, authSource=${delivery?.authMethodSource || "config"}`,
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
        sendByEmail: delivery?.sendByEmail ?? false,
        sendByWhatsApp: delivery?.sendByWhatsApp ?? false,
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
      is_hand_written: true,
      is_photographic: false,
      isSendByEmail: delivery.sendByEmail,
      isSendByWhatsApp: delivery.sendByWhatsApp,
      deadline_days: config.deadlineDays,
      callback: callbackUrl,
      subject_email: `Firma documentos FINSER PAY ${credito.folio}`,
      message_email: buildFirmaSeguroMessage(credito),
      process_name: `Credito FINSER PAY ${credito.folio}`,
      nit: config.nit,
      email_user: config.email,
    },
    signers: [
      {
        order: 1,
        rol: "DEUDOR",
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
    documentsOnlyRead: [],
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
    isSendByEmail: delivery.sendByEmail,
    isSendByWhatsApp: delivery.sendByWhatsApp,
    language: "es",
    isHandWritten: true,
    isPhotographic: false,
    callback: callbackUrl,
    subjectEmail: `Firma documentos FINSER PAY ${credito.folio}`,
    messageEmail: buildFirmaSeguroMessage(credito),
    balanceTypeId: getCreditPackageBalanceTypeId(config),
    signatures: [
      {
        order: 1,
        rol: "DEUDOR",
        authenticationMethodId: delivery.authMethodId,
        signerSignatureMethodId: config.signatureMethodId,
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
    documentsOnlyRead: [],
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

  const config = getFirmaSeguroConfig();
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
        Boolean(config.nit && config.useCompanyEndpoint) &&
        (isFirmaSeguroPermissionError(error) ||
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
  const status =
    extractFirmaSeguroStatus(statusPayload) ||
    extractFirmaSeguroStatus(process.statusPayload) ||
    process.status;

  const completed =
    isFirmaSeguroCompletedStatus(status) ||
    isFirmaSeguroCompletedStatus(extractFirmaSeguroStatus(signaturesPayload));
  const completedAt = completed ? process.completedAt || new Date() : null;

  if (completed) {
    try {
      documentsPayload = await firmaSeguroGetDocumentsByUuid(process.processUuid);
      const documentInfo = extractFirmaSeguroSignedDocument(documentsPayload);
      signedDocumentBase64 = documentInfo.base64 || signedDocumentBase64;
      signedDocumentFileName =
        documentInfo.fileName ||
        signedDocumentFileName ||
        `finserpay-firmado-${process.processUuid}.pdf`;
    } catch (error) {
      documentsPayload = {
        warning:
          error instanceof Error
            ? error.message
            : "No se pudo descargar documento firmado",
      };
    }
  }

  const updated = await updateFirmaSeguroProcess(process.processUuid, {
    status,
    statusPayload,
    signaturesPayload,
    documentsPayload: redactBase64Payload(documentsPayload),
    signedDocumentBase64,
    signedDocumentFileName,
    lastError: null,
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
