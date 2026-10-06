import { getMoraActor } from "@/lib/analyst-mora-access";
import { downloadMoraSupport } from "@/lib/analyst-mora-support";
import { approvalErrorResponse,approvalPrivateHeaders } from "@/lib/credit-approval-http";
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){
  try{await getMoraActor();const {id}=await context.params;const item=await downloadMoraSupport(id);
    return new Response(new Uint8Array(item.bytes!),{headers:{...approvalPrivateHeaders,"Content-Type":item.mimeType,"Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(item.fileName)}});
  }catch(error){return approvalErrorResponse(error);}
}
