import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  buildCreditAccessWhere,
  buildCreditLookupWhere,
  parseCreditRouteLookup,
} from "@/lib/credit-route-lookup";
import { sanitizeIphoneDeliveryEvidenceDataUrl } from "@/lib/iphone-delivery-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVIDENCE_KEYS = [
  "cedula-frente",
  "cedula-posterior",
  "selfie-cedula",
  "foto-entrega",
  "foto-remision",
] as const;

type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

const CANCELLED_CREDIT_STATES = new Set([
  "ANULADO",
  "ANULADA",
  "CANCELADO",
  "CANCELADA",
]);

const isCancelledCreditState = (value: unknown) =>
  CANCELLED_CREDIT_STATES.has(String(value || "").trim().toUpperCase());

type EvidencePresenceRow = {
  cedulaFrente: boolean;
  cedulaPosterior: boolean;
  selfieCedula: boolean;
  fotoEntrega: boolean;
  fotoRemision: boolean;
};

type EvidenceDataRow = {
  dataUrl: string | null;
};

const EVIDENCE_CONFIG: Record<
  EvidenceKey,
  {
    label: string;
    description: string;
    snapshotKey: string;
    presenceKey: keyof EvidencePresenceRow;
    databaseKey:
      | "contratoCedulaFrenteDataUrl"
      | "contratoCedulaRespaldoDataUrl"
      | "iphoneSelfieCedulaDataUrl"
      | "fotoEntregaDataUrl"
      | "fotoRemisionDataUrl";
    fileName: string;
  }
> = {
  "cedula-frente": {
    label: "Cedula frontal",
    description: "Frente del documento de identidad.",
    snapshotKey: "cedulaFrente",
    presenceKey: "cedulaFrente",
    databaseKey: "contratoCedulaFrenteDataUrl",
    fileName: "cedula-frontal",
  },
  "cedula-posterior": {
    label: "Cedula posterior",
    description: "Reverso del documento de identidad.",
    snapshotKey: "cedulaRespaldo",
    presenceKey: "cedulaPosterior",
    databaseKey: "contratoCedulaRespaldoDataUrl",
    fileName: "cedula-posterior",
  },
  "selfie-cedula": {
    label: "Selfie con cedula",
    description: "Rostro del cliente con su documento en mano.",
    snapshotKey: "selfieConCedula",
    presenceKey: "selfieCedula",
    databaseKey: "iphoneSelfieCedulaDataUrl",
    fileName: "selfie-con-cedula",
  },
  "foto-entrega": {
    label: "Foto de entrega",
    description: "Evidencia del equipo entregado al cliente.",
    snapshotKey: "fotoEntrega",
    presenceKey: "fotoEntrega",
    databaseKey: "fotoEntregaDataUrl",
    fileName: "foto-entrega",
  },
  "foto-remision": {
    label: "Remision",
    description: "Remision completa y legible de la entrega.",
    snapshotKey: "fotoRemision",
    presenceKey: "fotoRemision",
    databaseKey: "fotoRemisionDataUrl",
    fileName: "remision",
  },
};

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOrNull(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function evidenceAudit(snapshot: unknown, key: string) {
  const root = asRecord(snapshot);
  const evidence = asRecord(root?.evidencia);
  const item = asRecord(evidence?.[key]);

  return {
    capturedAt: textOrNull(item?.capturedAt),
    source: textOrNull(item?.source),
  };
}

function creditPlatform(snapshot: unknown) {
  const root = asRecord(snapshot);
  const equipment = asRecord(root?.equipo);
  return textOrNull(equipment?.plataforma)?.toUpperCase() || null;
}

function parseImageDataUrl(value: string | null) {
  const match = String(value || "").match(
    /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]*={0,2})$/i
  );

  if (!match) {
    return null;
  }

  const buffer = Buffer.from(match[2], "base64");

  if (!buffer.length) {
    return null;
  }

  return {
    buffer,
    contentType: match[1].toLowerCase().replace("image/jpg", "image/jpeg"),
  };
}

function hashImageDataUrl(value: string | null) {
  const parsed = parseImageDataUrl(value);
  return parsed
    ? createHash("sha256").update(parsed.buffer).digest("hex")
    : null;
}

function parseCorrectionBody(value: unknown) {
  const body = asRecord(value);

  if (!body) return null;

  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "dataUrl" ||
    keys[1] !== "key" ||
    !EVIDENCE_KEYS.includes(body.key as EvidenceKey) ||
    typeof body.dataUrl !== "string"
  ) {
    return null;
  }

  return {
    key: body.key as EvidenceKey,
    dataUrl: body.dataUrl,
  };
}

function creditEvidenceUpdateData(
  key: EvidenceKey,
  dataUrl: string
): Prisma.CreditoUpdateInput {
  switch (key) {
    case "cedula-frente":
      return { contratoCedulaFrenteDataUrl: dataUrl };
    case "cedula-posterior":
      return { contratoCedulaRespaldoDataUrl: dataUrl };
    case "selfie-cedula":
      return { iphoneSelfieCedulaDataUrl: dataUrl };
    case "foto-entrega":
      return { fotoEntregaDataUrl: dataUrl };
    case "foto-remision":
      return { fotoRemisionDataUrl: dataUrl };
  }
}

function correctedContractSnapshot(
  snapshot: unknown,
  options: {
    key: EvidenceKey;
    previousSha256: string | null;
    nextSha256: string;
    correctedAt: string;
    actor: {
      id: number;
      nombre: string;
      usuario: string;
      rol: string;
      aliadoCodigo: string | null;
    };
  }
) {
  const root = { ...(asRecord(snapshot) || {}) };
  const evidence = { ...(asRecord(root.evidencia) || {}) };
  const config = EVIDENCE_CONFIG[options.key];
  const previousEvidence = {
    ...(asRecord(evidence[config.snapshotKey]) || {}),
  };
  const previousAudit = Array.isArray(root.correccionesEvidencia)
    ? root.correccionesEvidencia
    : [];

  evidence[config.snapshotKey] = {
    ...previousEvidence,
    registrada: true,
    capturedAt: options.correctedAt,
    source: "CORRECCION_ADMIN_CENTRAL",
    sha256: options.nextSha256,
  };

  return {
    ...root,
    evidencia: evidence,
    correccionesEvidencia: [
      ...previousAudit,
      {
        version: 1,
        evidenceKey: options.key,
        databaseField: config.databaseKey,
        correctedAt: options.correctedAt,
        actor: options.actor,
        previousSha256: options.previousSha256,
        nextSha256: options.nextSha256,
      },
    ],
  };
}

function evidenceValue(
  credit: {
    contratoCedulaFrenteDataUrl: string | null;
    contratoCedulaRespaldoDataUrl: string | null;
    iphoneSelfieCedulaDataUrl: string | null;
    fotoEntregaDataUrl: string | null;
    fotoRemisionDataUrl: string | null;
  },
  key: EvidenceKey
) {
  return credit[EVIDENCE_CONFIG[key].databaseKey] || null;
}

async function readEvidenceDataUrl(creditId: number, key: EvidenceKey) {
  switch (key) {
    case "cedula-frente": {
      const rows = await prisma.$queryRaw<EvidenceDataRow[]>`
        SELECT "contratoCedulaFrenteDataUrl" AS "dataUrl"
        FROM "Credito"
        WHERE "id" = ${creditId}
        LIMIT 1
      `;
      return rows[0]?.dataUrl || null;
    }
    case "cedula-posterior": {
      const rows = await prisma.$queryRaw<EvidenceDataRow[]>`
        SELECT "contratoCedulaRespaldoDataUrl" AS "dataUrl"
        FROM "Credito"
        WHERE "id" = ${creditId}
        LIMIT 1
      `;
      return rows[0]?.dataUrl || null;
    }
    case "selfie-cedula": {
      const rows = await prisma.$queryRaw<EvidenceDataRow[]>`
        SELECT "iphoneSelfieCedulaDataUrl" AS "dataUrl"
        FROM "Credito"
        WHERE "id" = ${creditId}
        LIMIT 1
      `;
      return rows[0]?.dataUrl || null;
    }
    case "foto-entrega": {
      const rows = await prisma.$queryRaw<EvidenceDataRow[]>`
        SELECT "fotoEntregaDataUrl" AS "dataUrl"
        FROM "Credito"
        WHERE "id" = ${creditId}
        LIMIT 1
      `;
      return rows[0]?.dataUrl || null;
    }
    case "foto-remision": {
      const rows = await prisma.$queryRaw<EvidenceDataRow[]>`
        SELECT "fotoRemisionDataUrl" AS "dataUrl"
        FROM "Credito"
        WHERE "id" = ${creditId}
        LIMIT 1
      `;
      return rows[0]?.dataUrl || null;
    }
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const correctionMode =
      new URL(request.url).searchParams.get("correction") === "1";

    if (correctionMode && !adminCentral) {
      return NextResponse.json(
        {
          error:
            "Solo el administrador central de FINSER PAY puede abrir la correccion",
        },
        { status: 403 }
      );
    }

    if (!admin) {
      return NextResponse.json(
        { error: "Solo administradores pueden consultar evidencias" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditLookup = parseCreditRouteLookup(params.id);

    if (!creditLookup.id && !creditLookup.folio) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const accessWhere = buildCreditAccessWhere({
      admin,
      adminCentral,
      aliadoId: user.aliadoAccesoId,
      sedeId: user.sedeId,
      sellerSedeId: null,
      supervisor: false,
    });
    const credito = await prisma.credito.findFirst({
      where: {
        AND: [buildCreditLookupWhere(creditLookup), accessWhere],
      },
      select: {
        id: true,
        folio: true,
        clienteNombre: true,
        clienteDocumento: true,
        imei: true,
        referenciaEquipo: true,
        equipoMarca: true,
        equipoModelo: true,
        contratoSnapshot: true,
        estado: true,
        updatedAt: true,
      },
    });

    if (!credito) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const url = new URL(request.url);
    const requestedKey = url.searchParams.get("tipo");

    if (requestedKey) {
      if (!EVIDENCE_KEYS.includes(requestedKey as EvidenceKey)) {
        return NextResponse.json({ error: "Evidencia invalida" }, { status: 400 });
      }

      const evidenceKey = requestedKey as EvidenceKey;
      const parsed = parseImageDataUrl(
        await readEvidenceDataUrl(credito.id, evidenceKey)
      );

      if (!parsed) {
        return NextResponse.json(
          { error: "Evidencia no disponible" },
          { status: 404 }
        );
      }

      const extension = parsed.contentType.replace("image/", "")
        .replace("jpeg", "jpg");
      const disposition = url.searchParams.get("download") === "1"
        ? "attachment"
        : "inline";

      return new Response(new Uint8Array(parsed.buffer), {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "Content-Disposition": `${disposition}; filename="${EVIDENCE_CONFIG[evidenceKey].fileName}-${credito.folio}.${extension}"`,
          "Content-Length": String(parsed.buffer.length),
          "Content-Type": parsed.contentType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const presenceRows = await prisma.$queryRaw<EvidencePresenceRow[]>`
      SELECT
        ("contratoCedulaFrenteDataUrl" IS NOT NULL AND "contratoCedulaFrenteDataUrl" <> '') AS "cedulaFrente",
        ("contratoCedulaRespaldoDataUrl" IS NOT NULL AND "contratoCedulaRespaldoDataUrl" <> '') AS "cedulaPosterior",
        ("iphoneSelfieCedulaDataUrl" IS NOT NULL AND "iphoneSelfieCedulaDataUrl" <> '') AS "selfieCedula",
        ("fotoEntregaDataUrl" IS NOT NULL AND "fotoEntregaDataUrl" <> '') AS "fotoEntrega",
        ("fotoRemisionDataUrl" IS NOT NULL AND "fotoRemisionDataUrl" <> '') AS "fotoRemision"
      FROM "Credito"
      WHERE "id" = ${credito.id}
      LIMIT 1
    `;
    const presence = presenceRows[0] || {
      cedulaFrente: false,
      cedulaPosterior: false,
      selfieCedula: false,
      fotoEntrega: false,
      fotoRemision: false,
    };
    const snapshotPlatform = creditPlatform(credito.contratoSnapshot);
    const equipmentLabel = `${credito.equipoMarca || ""} ${credito.equipoModelo || ""}`
      .trim()
      .toUpperCase();
    const isIphone =
      snapshotPlatform === "IPHONE" ||
      equipmentLabel.includes("IPHONE") ||
      presence.selfieCedula ||
      presence.fotoEntrega ||
      presence.fotoRemision;

    return NextResponse.json(
      {
        ok: true,
        creditId: credito.id,
        folio: credito.folio,
        platform: isIphone ? "IPHONE" : snapshotPlatform || "ANDROID",
        estado: credito.estado,
        updatedAt: credito.updatedAt.toISOString(),
        canCorrect:
          correctionMode && adminCentral && !isCancelledCreditState(credito.estado),
        summary: correctionMode
          ? {
              clientName: credito.clienteNombre,
              document: credito.clienteDocumento,
              imei: credito.imei,
              equipment:
                credito.referenciaEquipo ||
                `${credito.equipoMarca || ""} ${credito.equipoModelo || ""}`.trim(),
            }
          : null,
        items: EVIDENCE_KEYS.map((key) => {
          const config = EVIDENCE_CONFIG[key];
          const audit = evidenceAudit(credito.contratoSnapshot, config.snapshotKey);

          return {
            key,
            label: config.label,
            description: config.description,
            available: Boolean(presence[config.presenceKey]),
            capturedAt: audit.capturedAt,
            source: audit.source,
            href: `/api/creditos/${credito.id}/evidencias?tipo=${key}&v=${credito.updatedAt.getTime()}`,
          };
        }),
      },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
        },
      }
    );
  } catch (error) {
    console.error("GET /api/creditos/[id]/evidencias", error);
    return NextResponse.json(
      { error: "No se pudieron cargar las evidencias" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const adminCentral =
      isAdminRole(user.rolNombre) &&
      isFinserPayCentralAlly(user.aliadoAccesoCodigo);

    if (!adminCentral) {
      return NextResponse.json(
        {
          error:
            "Solo el administrador central de FINSER PAY puede corregir evidencias",
        },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditLookup = parseCreditRouteLookup(params.id);

    if (!creditLookup.id && !creditLookup.folio) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Solicitud de correccion invalida" },
        { status: 400 }
      );
    }

    const correction = parseCorrectionBody(rawBody);
    if (!correction) {
      return NextResponse.json(
        {
          error:
            "Solo se permite reemplazar una de las cinco evidencias autorizadas",
        },
        { status: 400 }
      );
    }

    const sanitizedDataUrl =
      await sanitizeIphoneDeliveryEvidenceDataUrl(correction.dataUrl);

    if (!sanitizedDataUrl) {
      return NextResponse.json(
        { error: "La evidencia debe ser una imagen PNG o JPEG valida" },
        { status: 400 }
      );
    }

    const credit = await prisma.credito.findFirst({
      where: buildCreditLookupWhere(creditLookup),
      select: {
        id: true,
        folio: true,
        estado: true,
        contratoSnapshot: true,
        contratoCedulaFrenteDataUrl: true,
        contratoCedulaRespaldoDataUrl: true,
        iphoneSelfieCedulaDataUrl: true,
        fotoEntregaDataUrl: true,
        fotoRemisionDataUrl: true,
      },
    });

    if (!credit) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    if (isCancelledCreditState(credit.estado)) {
      return NextResponse.json(
        { error: "No se pueden corregir evidencias de un credito anulado" },
        { status: 409 }
      );
    }

    const previousSha256 = hashImageDataUrl(
      evidenceValue(credit, correction.key)
    );
    const nextSha256 = hashImageDataUrl(sanitizedDataUrl);

    if (!nextSha256) {
      return NextResponse.json(
        { error: "No fue posible verificar la evidencia" },
        { status: 400 }
      );
    }

    if (previousSha256 === nextSha256) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        creditId: credit.id,
        folio: credit.folio,
        key: correction.key,
      });
    }

    const correctedAt = new Date().toISOString();
    const contratoSnapshot = correctedContractSnapshot(
      credit.contratoSnapshot,
      {
        key: correction.key,
        previousSha256,
        nextSha256,
        correctedAt,
        actor: {
          id: user.id,
          nombre: user.nombre,
          usuario: user.usuario,
          rol: user.rolNombre,
          aliadoCodigo: user.aliadoAccesoCodigo,
        },
      }
    );

    const updated = await prisma.credito.update({
      where: { id: credit.id },
      data: {
        ...creditEvidenceUpdateData(correction.key, sanitizedDataUrl),
        contratoSnapshot: contratoSnapshot as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        folio: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      ok: true,
      unchanged: false,
      creditId: updated.id,
      folio: updated.folio,
      key: correction.key,
      correctedAt,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("PATCH /api/creditos/[id]/evidencias", error);
    return NextResponse.json(
      { error: "No se pudo corregir la evidencia" },
      { status: 500 }
    );
  }
}
