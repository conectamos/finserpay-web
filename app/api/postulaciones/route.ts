import { createMerchantApplicationHandler } from "@/lib/merchant-applications";
import { merchantApplicationStore } from "@/lib/merchant-applications-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createMerchantApplicationHandler(merchantApplicationStore);
