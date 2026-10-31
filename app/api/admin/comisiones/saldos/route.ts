import {commissionAccess,commissionHttpError,commissionJson} from "@/lib/commissions-http";
import {listAdminCommissionBalances,parseAdminCommissionBalancesQuery} from "@/lib/commissions-storage";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{
    const {userId}=await commissionAccess("central");
    return commissionJson(await listAdminCommissionBalances(userId,parseAdminCommissionBalancesQuery(new URL(request.url).searchParams)));
  }catch(error){return commissionHttpError(error);}
}
