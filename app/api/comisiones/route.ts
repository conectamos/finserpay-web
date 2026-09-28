import { commissionAccess, commissionHttpError, commissionJson } from "@/lib/commissions-http";
import { getSellerCommissionDashboard } from "@/lib/commissions-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { seller } = await commissionAccess("seller");
    return commissionJson(await getSellerCommissionDashboard(seller!.id));
  } catch (error) { return commissionHttpError(error); }
}
