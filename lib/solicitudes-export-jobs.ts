import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOLICITUD_EXPORT_SCHEMA } from "@/lib/solicitudes-export-schema";
import { exportViewerFromSession } from "@/lib/solicitudes-export-access";
import { ExportError, assertExportViewer, normalizeExportFilters, type ExportFilters, type ExportViewer } from "@/lib/solicitudes-export-core";
import { countExportRows, iterateExportRows, validateExportScope, type ExportDatabase } from "@/lib/solicitudes-export-data";
import { writeSolicitudExportWorkbook } from "@/lib/solicitudes-export-excel";

type Database = ExportDatabase & {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(callback: (tx: Database) => Promise<T>, options?: { isolationLevel?: "RepeatableRead"; timeout: number; maxWait: number }): Promise<T>;
};
type Job = {
  id: string; userId: number; viewerKind: string; aliadoId: number | null;
  filters: ExportFilters; status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  count: number; processed: number; filename: string; error: string | null;
  bytes: bigint | number | null; chunks: number | null; expiresAt: Date | string;
};
const JOB_COLUMNS = `"id", "userId", "viewerKind", "aliadoId", "filters", "status", "count", "processed", "filename", "error", "bytes", "chunks", "expiresAt"`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_BYTES = 1024 * 1024;

export function exportAuditFilters(filters: ExportFilters) {
  // Search can be a document, name or IMEI: never copy it into the audit log.
  const { q, ...safe } = filters;
  return { ...safe, searchApplied: Boolean(q) };
}

export function exportFilename(viewer: ExportViewer, filters: ExportFilters) {
  const scope = viewer.kind === "ALLY_ADMIN" || filters.aliadoIds.length === 1
    ? "Aliado" : filters.aliadoIds.length ? "Aliados" : "General";
  const period = filters.period === "all" ? "Historico" : filters.period === "month"
    ? filters.month : `${filters.desde || "Inicio"}_${filters.hasta || "Actualidad"}`;
  return `FINSERPAY_Clientes_${scope}_${period}.xlsx`;
}

export function serializeExportJob(job: Job) {
  return {
    id: job.id, status: job.status, count: job.count, processed: job.processed,
    filename: job.filename, error: job.error, expiresAt: new Date(job.expiresAt).toISOString(),
    downloadUrl: job.status === "READY" ? `/api/solicitudes/export/${job.id}/download` : undefined,
  };
}

export function createSolicitudExportStore(db: Database) {
  let schemaPromise: Promise<void> | undefined;
  async function ensure() {
    schemaPromise ??= (async () => {
      if (process.env.NODE_ENV === "production") {
        const tables = ["SolicitudExportJob", "SolicitudExportChunk", "SolicitudExportMember", "SolicitudExportAudit"];
        const present = await db.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name
          FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, tables);
        if (present.length !== tables.length) throw new Error("Prepare el esquema de exportaciones en predeploy.");
        return;
      }
      for (const statement of SOLICITUD_EXPORT_SCHEMA) await db.$executeRawUnsafe(statement);
    })().catch(error => { schemaPromise = undefined; throw error; });
    await schemaPromise;
  }
  async function resolveViewer(userId: number, database: ExportDatabase = db) {
    const [user] = await database.$queryRawUnsafe<Array<{
      id: number; rolNombre: string; aliadoAccesoCodigo: string | null;
      aliadoAccesoId: number | null; sedeAccesoId: number;
    }>>(`SELECT u."id", r."nombre" AS "rolNombre", s."id" AS "sedeAccesoId",
      s."aliadoId" AS "aliadoAccesoId", a."codigo" AS "aliadoAccesoCodigo"
      FROM "Usuario" u JOIN "Rol" r ON r."id" = u."rolId"
      JOIN "Sede" s ON s."id" = u."sedeId" LEFT JOIN "Aliado" a ON a."id" = s."aliadoId"
      WHERE u."id" = $1 AND u."activo" = TRUE`, userId);
    return exportViewerFromSession(user ?? null);
  }
  function assertJobOwner(job: Job, viewer: ExportViewer) {
    assertExportViewer(viewer);
    if (job.userId !== viewer.userId || job.viewerKind !== viewer.kind ||
        (viewer.kind === "ALLY_ADMIN" && job.aliadoId !== viewer.aliadoId)) {
      throw new ExportError(403, "No tienes permiso para acceder a esta descarga.");
    }
  }
  async function audit(database: Database, job: Job, event: string) {
    await database.$executeRawUnsafe(`INSERT INTO "SolicitudExportAudit"
      ("jobId", "userId", "event", "filters", "count") VALUES ($1::uuid,$2,$3,$4::jsonb,$5)`,
    job.id, job.userId, event, JSON.stringify({
      ...exportAuditFilters(job.filters), scope: job.viewerKind, authorizedAliadoId: job.aliadoId,
    }), job.count);
  }
  async function cleanup() {
    await ensure();
    // A crashed worker must never expose a partial artifact. The user can retry.
    await db.$executeRawUnsafe(`UPDATE "SolicitudExportJob" SET "status" = 'FAILED',
      "error" = 'La generación se interrumpió. Solicita nuevamente la descarga.', "updatedAt" = NOW()
      WHERE "status" = 'PROCESSING' AND "updatedAt" < NOW() - INTERVAL '3 minutes'`);
    await db.$executeRawUnsafe(`DELETE FROM "SolicitudExportJob" WHERE "expiresAt" <= NOW()`);
  }
  async function create(viewer: ExportViewer, input: unknown, expectedCount: unknown) {
    assertExportViewer(viewer);
    const filters = normalizeExportFilters(input);
    if (!Number.isSafeInteger(expectedCount) || Number(expectedCount) < 0) {
      throw new ExportError(400, "Actualiza el conteo antes de descargar.");
    }
    await ensure();
    await validateExportScope(viewer, filters, db);
    return db.$transaction(async tx => {
      // Serialize creation per user to prevent double clicks across tabs.
      // Prisma cannot deserialize PostgreSQL's void return type; select an int.
      await tx.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(73191, $1::integer)`, viewer.userId);
      const [active] = await tx.$queryRawUnsafe<Array<{ total: bigint }>>(`SELECT COUNT(*) AS total
        FROM "SolicitudExportJob" WHERE "userId"=$1 AND "status" IN ('PENDING','PROCESSING') AND "expiresAt">NOW()`, viewer.userId);
      if (Number(active.total) >= 2) throw new ExportError(429, "Ya tienes descargas en preparación. Espera a que terminen.");
      const count = await countExportRows(viewer, filters, tx);
      if (count !== expectedCount) throw new ExportError(409, "Las solicitudes cambiaron. Actualiza el conteo y vuelve a descargar.");
      const [job] = await tx.$queryRawUnsafe<Job[]>(`INSERT INTO "SolicitudExportJob"
        ("id","userId","viewerKind","aliadoId","filters","count","filename")
        VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7) RETURNING ${JOB_COLUMNS}`,
      randomUUID(), viewer.userId, viewer.kind, viewer.aliadoId, JSON.stringify(filters), count, exportFilename(viewer, filters));
      await audit(tx, job, "REQUESTED");
      return serializeExportJob(job);
    }, { timeout: 120_000, maxWait: 10_000 });
  }
  async function get(viewer: ExportViewer, id: string, database: Database = db) {
    assertExportViewer(viewer);
    if (!UUID.test(id)) throw new ExportError(404, "Descarga no encontrada.");
    await ensure();
    const [job] = await database.$queryRawUnsafe<Job[]>(`SELECT ${JOB_COLUMNS} FROM "SolicitudExportJob"
      WHERE "id"=$1::uuid AND "expiresAt">NOW()`, id);
    if (!job) throw new ExportError(404, "La descarga no existe o ha vencido. Genera un nuevo archivo.");
    assertJobOwner(job, viewer);
    await validateExportScope(viewer, job.filters, database);
    return job;
  }
  async function run(id: string) {
    await ensure();
    const [job] = await db.$queryRawUnsafe<Job[]>(`UPDATE "SolicitudExportJob"
      SET "status"='PROCESSING', "updatedAt"=NOW() WHERE "id"=$1::uuid AND "status"='PENDING'
      AND "expiresAt">NOW() RETURNING ${JOB_COLUMNS}`, id);
    if (!job) return;
    let tempDirectory: string | undefined;
    const heartbeat = setInterval(() => {
      void db.$executeRawUnsafe(`UPDATE "SolicitudExportJob" SET "updatedAt"=NOW()
        WHERE "id"=$1::uuid AND "status"='PROCESSING'`, id).catch(() => undefined);
    }, 20_000);
    heartbeat.unref?.();
    try {
      const viewer = await resolveViewer(job.userId);
      assertJobOwner(job, viewer);
      tempDirectory = await mkdtemp(join(tmpdir(), "finserpay-export-"));
      const filename = join(tempDirectory, "clientes.xlsx");
      let bytes = 0, chunks = 0;
      await db.$transaction(async tx => {
        await validateExportScope(viewer, job.filters, tx);
        const count = await countExportRows(viewer, job.filters, tx);
        if (count !== job.count) throw new ExportError(409, "Las solicitudes cambiaron durante la preparación. Actualiza el conteo y vuelve a descargar.");
        const pendingMembers: Array<{ source: string; entityId: number }> = [];
        async function flushMembers() {
          if (!pendingMembers.length) return;
          await tx.$executeRawUnsafe(`INSERT INTO "SolicitudExportMember" ("jobId","source","entityId")
            SELECT $1::uuid, x.source, x."entityId" FROM jsonb_to_recordset($2::jsonb) AS x(source text,"entityId" integer)`,
          id, JSON.stringify(pendingMembers));
          pendingMembers.length = 0;
        }
        async function* rows() {
          for await (const row of iterateExportRows(viewer, job.filters, tx)) {
            pendingMembers.push({ source: row.source, entityId: row.entityId });
            if (pendingMembers.length === 1000) await flushMembers();
            yield row;
          }
          await flushMembers();
        }
        const result = await writeSolicitudExportWorkbook(rows(), filename, async processed => {
          await db.$executeRawUnsafe(`UPDATE "SolicitudExportJob" SET "processed"=$2,"updatedAt"=NOW()
            WHERE "id"=$1::uuid AND "status"='PROCESSING'`, id, processed);
        });
        if (result.count !== job.count) throw new Error("Export count mismatch");
        // Publish chunks atomically with READY. Files remain private and work across replicas.
        const file = await open(filename, "r");
        try {
          const buffer = Buffer.alloc(CHUNK_BYTES);
          while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            await tx.$executeRawUnsafe(`INSERT INTO "SolicitudExportChunk" ("jobId","sequence","data") VALUES ($1::uuid,$2,$3)`,
              id, chunks++, buffer.subarray(0, bytesRead));
            bytes += bytesRead;
          }
        } finally { await file.close(); }
      }, { isolationLevel: "RepeatableRead", timeout: 30 * 60 * 1000, maxWait: 10_000 });
      // Publish only after the complete snapshot and all chunks are committed.
      // A separate transaction avoids conflicts with progress/heartbeat updates.
      assertJobOwner(job, await resolveViewer(job.userId));
      await db.$transaction(async tx => {
        const updated = await tx.$executeRawUnsafe(`UPDATE "SolicitudExportJob" SET "status"='READY',
          "processed"="count","bytes"=$2,"chunks"=$3,"updatedAt"=NOW()
          WHERE "id"=$1::uuid AND "status"='PROCESSING' AND "expiresAt">NOW()`, id, bytes, chunks);
        if (updated !== 1) throw new Error("Export no longer active");
        await audit(tx, job, "GENERATED");
      });
    } catch (error) {
      // Never persist raw DB/provider errors: they can contain customer data.
      const message = error instanceof ExportError ? error.message : "No se pudo generar el archivo completo. Intenta nuevamente.";
      await db.$executeRawUnsafe(`UPDATE "SolicitudExportJob" SET "status"='FAILED',"error"=$2,"updatedAt"=NOW()
        WHERE "id"=$1::uuid AND "status"='PROCESSING'`, id, message);
      await db.$executeRawUnsafe(`DELETE FROM "SolicitudExportChunk" WHERE "jobId"=$1::uuid`, id);
      await db.$executeRawUnsafe(`DELETE FROM "SolicitudExportMember" WHERE "jobId"=$1::uuid`, id);
      await audit(db, job, "FAILED");
    } finally {
      clearInterval(heartbeat);
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    }
  }
  async function work() {
    await cleanup();
    const pending = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "SolicitudExportJob"
      WHERE "status"='PENDING' AND "expiresAt">NOW() ORDER BY "createdAt" LIMIT 4`);
    for (const job of pending) await run(job.id);
  }
  async function download(viewer: ExportViewer, id: string) {
    const job = await get(viewer, id);
    if (job.status !== "READY") throw new ExportError(409, "El archivo todavía no está disponible.");
    // Revalidate every exported request against its CURRENT ownership, without reading PII.
    const [check] = await db.$queryRawUnsafe<Array<{ total: bigint; forbidden: bigint }>>(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE COALESCE(c."id",d."id") IS NULL OR ($2::integer IS NOT NULL AND s."aliadoId" IS DISTINCT FROM $2)) AS forbidden
      FROM "SolicitudExportMember" m
      LEFT JOIN "Credito" c ON m."source"='CREDIT' AND c."id"=m."entityId"
      LEFT JOIN "CreditoBorrador" d ON m."source"='DRAFT' AND d."id"=m."entityId"
      LEFT JOIN "Sede" s ON s."id"=COALESCE(c."sedeId",d."sedeId") WHERE m."jobId"=$1::uuid`,
    id, viewer.kind === "ALLY_ADMIN" ? viewer.aliadoId : null);
    if (Number(check.total) !== job.count || Number(check.forbidden) !== 0) {
      throw new ExportError(403, "El alcance de las solicitudes cambió. Genera un nuevo archivo con tus permisos actuales.");
    }
    const [integrity] = await db.$queryRawUnsafe<Array<{ total: bigint; bytes: bigint; first: number | null; last: number | null }>>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(octet_length("data")),0) AS bytes, MIN("sequence") AS first, MAX("sequence") AS last
      FROM "SolicitudExportChunk" WHERE "jobId"=$1::uuid`, id);
    if (!job.chunks || Number(integrity.total) !== job.chunks || Number(integrity.bytes) !== Number(job.bytes) ||
        integrity.first !== 0 || integrity.last !== job.chunks - 1) {
      throw new ExportError(409, "El archivo no está completo. Genera una nueva descarga.");
    }
    // Keep cleanup from deleting a complete artifact while a near-expiry
    // download is in progress. Most jobs retain their original 24-hour expiry.
    const [lease] = await db.$queryRawUnsafe<Array<{ expiresAt: Date | string }>>(`UPDATE "SolicitudExportJob"
      SET "expiresAt"=GREATEST("expiresAt",NOW()+INTERVAL '15 minutes')
      WHERE "id"=$1::uuid AND "status"='READY' AND "expiresAt">NOW() RETURNING "expiresAt"`, id);
    if (!lease) throw new ExportError(404, "La descarga venció. Genera un nuevo archivo.");
    job.expiresAt = lease.expiresAt;
    await audit(db, job, "DOWNLOAD_STARTED");
    let sequence = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (sequence === job.chunks) { controller.close(); return; }
          const [chunk] = await db.$queryRawUnsafe<Array<{ data: Uint8Array }>>(`SELECT "data" FROM "SolicitudExportChunk"
            WHERE "jobId"=$1::uuid AND "sequence"=$2`, id, sequence++);
          if (!chunk) throw new Error("Incomplete export");
          controller.enqueue(new Uint8Array(chunk.data));
        } catch (error) { controller.error(error); }
      },
    });
    return { job: serializeExportJob(job), bytes: Number(job.bytes), stream };
  }
  return { ensure, cleanup, create, get, run, work, download };
}

let store: ReturnType<typeof createSolicitudExportStore> | undefined;
export async function getSolicitudExportStore() {
  if (!store) {
    const { default: prisma } = await import("@/lib/prisma");
    store = createSolicitudExportStore(prisma as unknown as Database);
  }
  return store;
}

let worker: Promise<void> | undefined;
export async function processSolicitudExports() {
  worker ??= (async () => { await (await getSolicitudExportStore()).work(); })()
    .finally(() => { worker = undefined; });
  await worker;
}

declare global {
  var __finserpayExportTimer: ReturnType<typeof setInterval> | undefined;
}

export function startSolicitudExportWorker() {
  if (process.env.NODE_ENV !== "production" || globalThis.__finserpayExportTimer) return;
  const tick = () => { void processSolicitudExports().catch(() => {
    console.error("[solicitudes-export] No se pudo procesar la cola de exportaciones.");
  }); };
  globalThis.__finserpayExportTimer = setInterval(tick, 60_000);
  globalThis.__finserpayExportTimer.unref?.();
  tick();
}
