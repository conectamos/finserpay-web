import sharp from "sharp";
import { loadApprovalModule, service, approvalDatabase } from "./credit-approval-test-loader.mjs";

export { loadApprovalModule, service };
const actorModule = loadApprovalModule("lib/credit-approval-actor.ts");
export const history = loadApprovalModule("lib/credit-approval-evidence-history.ts", { "@/lib/credit-approval-actor": actorModule });
export const sanitizer = loadApprovalModule("lib/iphone-delivery-evidence.ts", { sharp: { default: sharp } });
export const evidence = loadApprovalModule("lib/credit-approval-evidence.ts", {
  "@/lib/credit-approval-actor": actorModule,
  "@/lib/credit-approval-novelty-state": { markNoveltyPhotoCorrected: async () => false },
  "@/lib/credit-approval": service,
  "@/lib/iphone-delivery-evidence": sanitizer,
  "@/lib/credit-approval-evidence-history": history,
});
export const photos = await Promise.all(["red", "green", "blue", "yellow", "white", "black"].map(async (background) =>
  "data:image/png;base64," + (await sharp({ create: { width: 3, height: 3, channels: 3, background } }).png().toBuffer()).toString("base64")));
export const actor = { id: 7, nombre: "Analista sintético" };

export function evidenceDatabase(overrides = {}) {
  const base = approvalDatabase({ review: { status: "APPROVED", revision: 2, approvedRevision: 2,
    approvedAt: new Date(), approvedByName: "Analista anterior", reviewHash: "a".repeat(64) }, ...overrides });
  const originalQuery = base.db.$queryRawUnsafe;
  const originalWrite = base.db.$executeRawUnsafe;
  base.state.archives = [];
  base.db.$queryRawUnsafe = async (sql, ...params) => {
    if (sql.includes('FROM "Credito" WHERE "id" = $1 FOR UPDATE')) {
      base.state.queries.push({ sql, params }); return base.state.credit ? [base.state.credit] : [];
    }
    return originalQuery(sql, ...params);
  };
  base.db.$executeRawUnsafe = async (sql, ...params) => {
    if (sql.includes('INSERT INTO "CreditApprovalEvidenceRevision"')) {
      base.state.archives.push(params); return 1;
    }
    if (sql.startsWith('UPDATE "Credito" SET')) {
      const field = sql.match(/SET "([^"]+)"/)[1];
      Object.assign(base.state.credit, { [field]: params[1], contratoSnapshot: JSON.parse(params[2]) });
      base.state.review = { ...base.state.review, status: "PENDING", revision: base.state.review.revision + 1,
        approvedRevision: null, approvedAt: null, approvedByName: null, reviewHash: null };
      return 1;
    }
    return originalWrite(sql, ...params);
  };
  return base;
}

export async function correctionInput(db, dataUrl = photos[0], key = "foto-entrega", id = 81) {
  const detail = await service.getCreditApprovalDetail(db, id);
  return evidence.prepareEvidenceCorrection({ key, dataUrl, revision: detail.review.revision, reviewHash: detail.review.reviewHash });
}
