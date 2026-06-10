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
  firmaSeguroGetDocumentsByUuid,
  firmaSeguroGetProcessStatus,
  firmaSeguroGetSignaturesStatus,
  firmaSeguroSignIn,
  getFirmaSeguroConfig,
  isFirmaSeguroCompletedStatus,
  isFirmaSeguroConfigured,
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
    "FINSER PAY solicita tu firma electronica para los documentos de tu credito.",
    `Folio: ${credito.folio}.`,
    "Por favor revisa el documento completo y confirma la firma solo si estas de acuerdo.",
  ].join(" ");
}

function getSignerEmail(person: PersonPayload) {
  const config = getFirmaSeguroConfig();
  return person.email || normalizeEmail(config.email) || "firmas@finserpay.com";
}

function buildCreateFullByCompanyPayload(
  credito: FirmaSeguroCredit,
  person: PersonPayload,
  pdfBase64: string,
  callbackUrl: string
) {
  const config = getFirmaSeguroConfig();
  const fileName = `finserpay-${credito.folio}.pdf`;
  const signerEmail = getSignerEmail(person);
  const sendByEmail = Boolean(person.email);

  return {
    process: {
      process_type_id: config.processTypeId,
      signature_method_id: config.signatureMethodId,
      balance_type_id: config.balanceTypeId,
      is_in_order: false,
      tags: getFirmaSeguroTags(credito),
      is_read: true,
      language: "es",
      is_hand_written: true,
      is_photographic: false,
      isSendByEmail: sendByEmail,
      isSendByWhatsApp: true,
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
        authentication_method_id: config.authMethodId,
        indicative: "57",
        number: person.phone,
        email: signerEmail,
        first_name: person.firstName,
        second_name: person.secondName,
        first_last_name: person.firstLastName,
        second_last_name: person.secondLastName,
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
  callbackUrl: string
) {
  const config = getFirmaSeguroConfig();
  const fileName = `finserpay-${credito.folio}.pdf`;
  const signerEmail = getSignerEmail(person);
  const sendByEmail = Boolean(person.email);

  return {
    processTypeId: config.processTypeId,
    signatureMethodId: config.signatureMethodId,
    deadlineDays: config.deadlineDays,
    isInOrder: false,
    tags: getFirmaSeguroTags(credito),
    isRead: true,
    isSendByEmail: sendByEmail,
    isSendByWhatsApp: true,
    language: "es",
    isHandWritten: true,
    isPhotographic: false,
    callback: callbackUrl,
    subjectEmail: `Firma documentos FINSER PAY ${credito.folio}`,
    messageEmail: buildFirmaSeguroMessage(credito),
    balanceTypeId: config.balanceTypeId,
    signatures: [
      {
        order: 1,
        rol: "DEUDOR",
        authenticationMethodId: config.authMethodId,
        signerSignatureMethodId: config.signatureMethodId,
        contactInformation: {
          phone: {
            indicative: "57",
            number: person.phone,
          },
          email: signerEmail,
          person: {
            firstName: person.firstName,
            secondName: person.secondName,
            firstLastName: person.firstLastName,
            secondLastName: person.secondLastName,
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
  if (!person.phone) {
    throw new FirmaSeguroApiError(
      "El credito no tiene telefono valido del cliente para enviar OTP",
      400,
      null
    );
  }

  const config = getFirmaSeguroConfig();
  const pdf = await buildFirmaSeguroCreditPdf(credito);
  const pdfBase64 = pdf.toString("base64");
  const requestPayload = config.nit
    ? buildCreateFullByCompanyPayload(credito, person, pdfBase64, callbackUrl)
    : buildCreateFullPayload(credito, person, pdfBase64, callbackUrl);
  const { token, payload: authPayload } = await firmaSeguroSignIn();
  const createPayload = config.nit
    ? await firmaSeguroCreateFullByCompany(token, requestPayload)
    : await firmaSeguroCreateFull(token, requestPayload);
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
      endpoint: config.nit ? "create-full-by-company" : "create-full",
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
  const { token } = await firmaSeguroSignIn();
  const statusPayload = await firmaSeguroGetProcessStatus(token, process.processUuid);
  let signaturesPayload: unknown = null;
  let documentsPayload: unknown = null;
  let signedDocumentBase64 = process.signedDocumentBase64;
  let signedDocumentFileName = process.signedDocumentFileName;
  const status =
    extractFirmaSeguroStatus(statusPayload) ||
    extractFirmaSeguroStatus(process.statusPayload) ||
    process.status;

  try {
    signaturesPayload = await firmaSeguroGetSignaturesStatus(
      token,
      process.processUuid
    );
  } catch (error) {
    signaturesPayload = {
      warning:
        error instanceof Error
          ? error.message
          : "No se pudo consultar estado de firmantes",
    };
  }

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
