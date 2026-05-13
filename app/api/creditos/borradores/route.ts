import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { sanitizeSearch, sanitizeText } from "@/lib/credit-factory";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DRAFT_PAYLOAD_BYTES = 700_000;

type SaveDraftBody = {
  id?: unknown;
  currentStep?: unknown;
  payload?: unknown;
  estado?: unknown;
};

type DraftPayload = Record<string, unknown>;

type DraftRow = {
  id: number;
  estado: string;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  currentStep: number;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string | null;
  payload: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  closedAt: Date | string | null;
  usuarioNombre: string | null;
  usuarioLogin: string | null;
  vendedorNombre: string | null;
  vendedorDocumento: string | null;
  sedeNombre: string | null;
};

let draftTableReady: Promise<void> | null = null;

function toDateIso(value: Date | string | null) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toLimitedText(value: unknown, maxLength = 180) {
  const text = sanitizeText(value).slice(0, maxLength);
  return text || null;
}

function clampStep(value: unknown) {
  const parsed = Math.trunc(Number(value || 1));
  return Math.max(1, Math.min(5, Number.isFinite(parsed) ? parsed : 1));
}

function parseDraftId(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTake(value: unknown) {
  const parsed = Math.trunc(Number(value || 12));
  return Math.max(1, Math.min(30, Number.isFinite(parsed) ? parsed : 12));
}

function normalizePayload(value: unknown): DraftPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const json = JSON.stringify(value);

  if (Buffer.byteLength(json, "utf8") > MAX_DRAFT_PAYLOAD_BYTES) {
    throw new Error("El borrador es demasiado grande para guardarlo automaticamente");
  }

  return JSON.parse(json) as DraftPayload;
}

function extractDraftFields(payload: DraftPayload) {
  const firstName = toLimitedText(payload.clientePrimerNombre, 90);
  const lastName = toLimitedText(payload.clientePrimerApellido, 90);
  const fullName =
    toLimitedText(payload.clienteNombre, 180) ||
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    null;

  return {
    clienteNombre: fullName,
    clienteDocumento: toLimitedText(payload.clienteDocumento, 60),
    clienteTelefono: toLimitedText(payload.clienteTelefono, 60),
    imei: toLimitedText(payload.imei, 60),
  };
}

function serializeDraft(row: DraftRow) {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as DraftPayload)
      : {};

  return {
    id: row.id,
    estado: row.estado,
    currentStep: row.currentStep,
    clienteNombre: row.clienteNombre,
    clienteDocumento: row.clienteDocumento,
    clienteTelefono: row.clienteTelefono,
    imei: row.imei,
    payload,
    createdAt: toDateIso(row.createdAt),
    updatedAt: toDateIso(row.updatedAt),
    closedAt: toDateIso(row.closedAt),
    usuario: {
      id: row.usuarioId,
      nombre: row.usuarioNombre || "Usuario",
      usuario: row.usuarioLogin || "",
    },
    vendedor: row.vendedorId
      ? {
          id: row.vendedorId,
          nombre: row.vendedorNombre || "Asesor",
          documento: row.vendedorDocumento,
        }
      : null,
    sede: {
      id: row.sedeId,
      nombre: row.sedeNombre || "Sede",
    },
  };
}

async function ensureDraftTable() {
  if (!draftTableReady) {
    draftTableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "CreditoBorrador" (
          "id" SERIAL PRIMARY KEY,
          "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
          "usuarioId" INTEGER NOT NULL,
          "vendedorId" INTEGER,
          "sedeId" INTEGER NOT NULL,
          "currentStep" INTEGER NOT NULL DEFAULT 1,
          "clienteNombre" TEXT,
          "clienteDocumento" TEXT,
          "clienteTelefono" TEXT,
          "imei" TEXT,
          "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "closedAt" TIMESTAMPTZ
        )
      `);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_estado_updatedAt_idx" ON "CreditoBorrador" ("estado", "updatedAt" DESC)`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_sede_estado_idx" ON "CreditoBorrador" ("sedeId", "estado")`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_documento_idx" ON "CreditoBorrador" ("clienteDocumento")`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_imei_idx" ON "CreditoBorrador" ("imei")`
      );
    })();
  }

  await draftTableReady;
}

async function readDrafts(whereSql: string, values: unknown[], take = 20) {
  const limitIndex = values.length + 1;
  const rows = await prisma.$queryRawUnsafe<DraftRow[]>(
    `
      SELECT
        d.*,
        u."nombre" AS "usuarioNombre",
        u."usuario" AS "usuarioLogin",
        v."nombre" AS "vendedorNombre",
        v."documento" AS "vendedorDocumento",
        s."nombre" AS "sedeNombre"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE ${whereSql}
      ORDER BY d."updatedAt" DESC
      LIMIT $${limitIndex}
    `,
    ...values,
    take
  );

  return rows;
}

function pushScopeWhere(
  where: string[],
  values: unknown[],
  admin: boolean,
  userSedeId: number,
  sellerSession: Awaited<ReturnType<typeof getSellerSessionUser>>
) {
  if (admin) {
    return;
  }

  values.push(userSedeId);
  where.push(`d."sedeId" = $${values.length}`);

  if (sellerSession?.tipoPerfil !== "SUPERVISOR") {
    values.push(sellerSession?.id || 0);
    where.push(`d."vendedorId" = $${values.length}`);
  }
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    await ensureDraftTable();

    const { searchParams } = new URL(req.url);
    const id = parseDraftId(searchParams.get("id"));
    const search = sanitizeSearch(searchParams.get("search"));
    const searchDigits = search.replace(/\D/g, "");
    const take = parseTake(searchParams.get("take"));
    const where = [`d."estado" = 'ABIERTO'`];
    const values: unknown[] = [];

    pushScopeWhere(where, values, admin, user.sedeId, sellerSession);

    if (id) {
      values.push(id);
      where.push(`d."id" = $${values.length}`);
      const rows = await readDrafts(where.join(" AND "), values, 1);
      const item = rows[0] ? serializeDraft(rows[0]) : null;

      if (!item) {
        return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
      }

      return NextResponse.json({ ok: true, item });
    }

    if (!search) {
      return NextResponse.json({
        ok: true,
        scope: admin ? "global" : "sede",
        search,
        items: [],
      });
    }

    const searchLike = `%${search}%`;
    values.push(searchLike);
    const searchIndex = values.length;
    const searchWhere = [
      `d."clienteNombre" ILIKE $${searchIndex}`,
      `d."clienteDocumento" ILIKE $${searchIndex}`,
      `d."clienteTelefono" ILIKE $${searchIndex}`,
      `d."imei" ILIKE $${searchIndex}`,
    ];

    if (searchDigits.length >= 3 && searchDigits !== search) {
      values.push(`%${searchDigits}%`);
      const digitsIndex = values.length;
      searchWhere.push(
        `d."clienteDocumento" ILIKE $${digitsIndex}`,
        `d."clienteTelefono" ILIKE $${digitsIndex}`,
        `d."imei" ILIKE $${digitsIndex}`
      );
    }

    where.push(`(${searchWhere.join(" OR ")})`);
    const rows = await readDrafts(where.join(" AND "), values, take);

    return NextResponse.json({
      ok: true,
      scope: admin ? "global" : "sede",
      search,
      items: rows.map(serializeDraft),
    });
  } catch (error) {
    console.error("ERROR LISTANDO BORRADORES:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudieron cargar los borradores" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    await ensureDraftTable();

    const body = (await req.json().catch(() => ({}))) as SaveDraftBody;
    const draftId = parseDraftId(body.id);
    const currentStep = clampStep(body.currentStep);
    const payload = normalizePayload(body.payload);
    const fields = extractDraftFields(payload);
    const payloadJson = JSON.stringify(payload);

    if (draftId) {
      const where = [`"id" = $1`, `"estado" = 'ABIERTO'`];
      const values: unknown[] = [draftId];

      if (!admin) {
        values.push(user.sedeId);
        where.push(`"sedeId" = $${values.length}`);

        if (sellerSession?.tipoPerfil !== "SUPERVISOR") {
          values.push(sellerSession?.id || 0);
          where.push(`"vendedorId" = $${values.length}`);
        }
      }

      values.push(
        currentStep,
        fields.clienteNombre,
        fields.clienteDocumento,
        fields.clienteTelefono,
        fields.imei,
        payloadJson
      );

      const currentStepIndex = values.length - 5;
      const nombreIndex = values.length - 4;
      const documentoIndex = values.length - 3;
      const telefonoIndex = values.length - 2;
      const imeiIndex = values.length - 1;
      const payloadIndex = values.length;

      await prisma.$executeRawUnsafe(
        `
          UPDATE "CreditoBorrador"
          SET
            "currentStep" = $${currentStepIndex},
            "clienteNombre" = $${nombreIndex},
            "clienteDocumento" = $${documentoIndex},
            "clienteTelefono" = $${telefonoIndex},
            "imei" = $${imeiIndex},
            "payload" = $${payloadIndex}::jsonb,
            "updatedAt" = NOW()
          WHERE ${where.join(" AND ")}
        `,
        ...values
      );

      const readWhere = [`d."id" = $1`];
      const readValues: unknown[] = [draftId];
      pushScopeWhere(readWhere, readValues, admin, user.sedeId, sellerSession);
      const rows = await readDrafts(readWhere.join(" AND "), readValues, 1);
      const item = rows[0] ? serializeDraft(rows[0]) : null;

      return NextResponse.json({ ok: true, item });
    }

    const rows = await prisma.$queryRawUnsafe<DraftRow[]>(
      `
        INSERT INTO "CreditoBorrador" (
          "usuarioId",
          "vendedorId",
          "sedeId",
          "currentStep",
          "clienteNombre",
          "clienteDocumento",
          "clienteTelefono",
          "imei",
          "payload",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
        RETURNING *
      `,
      user.id,
      sellerSession?.id || null,
      user.sedeId,
      currentStep,
      fields.clienteNombre,
      fields.clienteDocumento,
      fields.clienteTelefono,
      fields.imei,
      payloadJson
    );

    const created = rows[0];

    if (!created) {
      throw new Error("No se pudo crear el borrador");
    }

    const itemRows = await readDrafts(`d."id" = $1`, [created.id], 1);

    return NextResponse.json({ ok: true, item: serializeDraft(itemRows[0] || created) });
  } catch (error) {
    console.error("ERROR GUARDANDO BORRADOR:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo guardar el borrador" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    await ensureDraftTable();

    const body = (await req.json().catch(() => ({}))) as SaveDraftBody;
    const draftId = parseDraftId(body.id);

    if (!draftId) {
      return NextResponse.json({ error: "Borrador invalido" }, { status: 400 });
    }

    const nextEstado =
      sanitizeText(body.estado).toUpperCase() === "CERRADO" ? "CERRADO" : "ABIERTO";
    const where = [`"id" = $1`];
    const values: unknown[] = [draftId, nextEstado];

    if (!admin) {
      values.push(user.sedeId);
      where.push(`"sedeId" = $${values.length}`);

      if (sellerSession?.tipoPerfil !== "SUPERVISOR") {
        values.push(sellerSession?.id || 0);
        where.push(`"vendedorId" = $${values.length}`);
      }
    }

    await prisma.$executeRawUnsafe(
      `
        UPDATE "CreditoBorrador"
        SET
          "estado" = $2,
          "closedAt" = CASE WHEN $2 = 'CERRADO' THEN NOW() ELSE NULL END,
          "updatedAt" = NOW()
        WHERE ${where.join(" AND ")}
      `,
      ...values
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO BORRADOR:", error);
    return NextResponse.json(
      { error: "No se pudo actualizar el borrador" },
      { status: 500 }
    );
  }
}
