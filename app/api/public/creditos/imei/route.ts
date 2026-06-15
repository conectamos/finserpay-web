import { GET as handleCreditByImei } from "@/app/api/integraciones/creditos/imei/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleCreditByImei(req);
}
