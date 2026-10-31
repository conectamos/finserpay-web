import "server-only";
import { cookies } from "next/headers";
import { getAttentionWorkAccess } from "./atencion-work-access";
import { attentionWorkStore } from "./atencion-work-storage";
import { createAttentionWorkEnrollment } from "./atencion-work-enrollment";
import type { AttentionDatabase } from "./atencion-storage";
import { AttentionError } from "./atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "./atencion-http";
import { CreditApprovalError } from "./credit-approval-errors";
import { getIphoneEnrollmentPortalConfiguration, verifyIphoneEnrollmentPortalSession, hashIphoneEnrollmentRateLimitKey } from "./iphone-enrollment";
import { createIphoneEnrollmentAccessGrant, exchangeIphoneEnrollmentAccessGrant, validateIphoneEnrollmentPortalSession,
  prepareIphoneEnrollmentWorkflow, consumeIphoneEnrollmentRateLimit, IphoneEnrollmentGrantError, IphoneEnrollmentApprovalError,
  type IphoneEnrollmentGrantSession } from "./iphone-enrollment-storage";
import type { AttentionActor } from "./atencion-types";

const cookieName=()=>process.env.NODE_ENV==="production"?"__Secure-finser-attention-enrollment":"finser-attention-enrollment";
async function limit(actor:AttentionActor,action:"ACCESS"|"LOOKUP"|"APPROVE",maximum:number) {
  const result=await consumeIphoneEnrollmentRateLimit({subjectHash:hashIphoneEnrollmentRateLimitKey("session",`nominal-user:${actor.userId}`),action,maximum});
  if(!result.allowed)throw new AttentionError("Demasiados intentos. Espera unos minutos antes de volver a intentar.",429);
}
async function grantFor(actor:AttentionActor,create:boolean):Promise<IphoneEnrollmentGrantSession> {
  const cookieStore=await cookies(),signed=verifyIphoneEnrollmentPortalSession(cookieStore.get(cookieName())?.value);
  if(signed?.accessMode==="GRANT"){
    const grant=await validateIphoneEnrollmentPortalSession(signed);
    if(grant?.issuedBy?.userId===actor.userId&&grant.analyst.externalId===`FINSER-USER:${actor.userId}`)return grant;
  }
  if(!create)throw new AttentionError("Actualiza la gestión de enrolamiento para verificar nuevamente tu acceso.",401);
  await limit(actor,"ACCESS",12);
  const issued=await createIphoneEnrollmentAccessGrant({analystName:actor.name,analystExternalId:`FINSER-USER:${actor.userId}`,
    expiresInMinutes:480,issuedByUserId:actor.userId,issuedByName:actor.name});
  const exchanged=await exchangeIphoneEnrollmentAccessGrant(issued.token);
  cookieStore.set(cookieName(),exchanged.session.value,{expires:exchanged.session.expiresAt,httpOnly:true,
    secure:process.env.NODE_ENV==="production",sameSite:"strict",path:"/api/atencion/solicitudes"});
  return exchanged.grant;
}
function enabled(){const c=getIphoneEnrollmentPortalConfiguration();if(!c.enabled||!c.configured)throw new AttentionError("El servicio de enrolamiento no está configurado. Puedes continuar la conversación mientras se habilita.",503);}
function failure(error:unknown){
  if(error instanceof IphoneEnrollmentGrantError)return attentionHttpError(new AttentionError("La autorización de acceso venció. Actualiza la solicitud.",401));
  if(error instanceof IphoneEnrollmentApprovalError)return attentionHttpError(new AttentionError(error.message,409));
  if(error instanceof CreditApprovalError)return attentionHttpError(new AttentionError(error.message,error.status));
  return attentionHttpError(error);
}
export async function readAttentionWorkEnrollment(request:Request,context:{params:Promise<{id:string}>}) {
  try {
    const site=request.headers.get("sec-fetch-site");if(site&&site!=="same-origin"&&site!=="none")throw new AttentionError("Origen de solicitud no permitido.",403);
    const actor=await getAttentionWorkAccess("attention"),id=(await context.params).id;
    if(actor.type!=="attention")throw new AttentionError("Acceso no autorizado.",403);
    await(await attentionWorkStore()).workflowRead(actor,id,"enrollment",async()=>true);
    enabled();const grant=await grantFor(actor.actor,true);await limit(actor.actor,"LOOKUP",30);await prepareIphoneEnrollmentWorkflow();
    const {default:prisma}=await import("./prisma");
    return attentionJson(await createAttentionWorkEnrollment(prisma as unknown as AttentionDatabase).status(actor,id,grant));
  }catch(error){return failure(error);}
}
export async function approveAttentionWorkEnrollment(request:Request,context:{params:Promise<{id:string}>}) {
  try {
    assertAttentionOrigin(request);const actor=await getAttentionWorkAccess("attention"),id=(await context.params).id;
    if(actor.type!=="attention")throw new AttentionError("Acceso no autorizado.",403);
    const input=await readAttentionJson(request,{maxBytes:4096});enabled();const grant=await grantFor(actor.actor,false);
    await limit(actor.actor,"APPROVE",15);await prepareIphoneEnrollmentWorkflow();const {default:prisma}=await import("./prisma");
    return attentionJson(await createAttentionWorkEnrollment(prisma as unknown as AttentionDatabase).approve(actor,id,input,grant));
  }catch(error){return failure(error);}
}
