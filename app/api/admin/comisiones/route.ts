import { commissionAccess, commissionHttpError, commissionJson } from "@/lib/commissions-http";
import { listAdminCommissionRequests, listAdminCommissionBags } from "@/lib/commissions-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await commissionAccess("central");
    const requests = await listAdminCommissionRequests(userId);
    const bags = await listAdminCommissionBags(userId);
    return commissionJson({ requests, bags });
  } catch (error) { return commissionHttpError(error); }
}
