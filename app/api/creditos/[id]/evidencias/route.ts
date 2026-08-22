import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  buildCreditAccessWhere,
  buildCreditLookupWhere,
  parseCreditRouteLookup,
} from "@/lib/credit-route-lookup";

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
    fileName: string;
  }
> = {
  "cedula-frente": {
    label: "Cedula frontal",
    description: "Frente del documento de identidad.",
    snapshotKey: "cedulaFrente",
    presenceKey: "cedulaFrente",
    fileName: "cedula-frontal",
  },
  "cedula-posterior": {
    label: "Cedula posterior",
    description: "Reverso del documento de identidad.",
    snapshotKey: "cedulaRespaldo",
    presenceKey: "cedulaPosterior",
    fileName: "cedula-posterior",
  },
  "selfie-cedula": {
    label: "Selfie con cedula",
    description: "Rostro del cliente con su documento en mano.",
    snapshotKey: "selfieConCedula",
    presenceKey: "selfieCedula",
    fileName: "selfie-con-cedula",
  },
  "foto-entrega": {
    label: "Foto de entrega",
    description: "Evidencia del equipo entregado al cliente.",
    snapshotKey: "fotoEntrega",
    presenceKey: "fotoEntrega",
    fileName: "foto-entrega",
  },
  "foto-remision": {
    label: "Remision",
    description: "Remision completa y legible de la entrega.",
    snapshotKey: "fotoRemision",
    presenceKey: "fotoRemision",
    fileName: "remision",
  },
};

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
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
    /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/]*={0,2})$/i
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
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";

    if (!admin && !supervisor) {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede consultar evidencias" },
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
      sellerSedeId: sellerSession?.sedeId,
      supervisor,
    });
    const credito = await prisma.credito.findFirst({
      where: {
        AND: [buildCreditLookupWhere(creditLookup), accessWhere],
      },
      select: {
        id: true,
        folio: true,
        equipoMarca: true,
        equipoModelo: true,
        contratoSnapshot: true,
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

      const extension = parsed.contentType === "image/png" ? "png" : "jpg";
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
            href: `/api/creditos/${credito.id}/evidencias?tipo=${key}`,
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
