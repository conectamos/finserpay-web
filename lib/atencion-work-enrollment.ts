import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";
import { AttentionError } from "./atencion-core";
import { createAttentionWorkStore, type AttentionWorkWorkflowContext } from "./atencion-work-storage";
import type { AttentionDatabase } from "./atencion-storage";
import type { AttentionWorkActor } from "./atencion-work-types";
import { parseAttentionEnrollmentAction } from "./atencion-work-enrollment-core";
import type { AttentionEnrollmentStatus } from "./atencion-work-enrollment-types";
import {
  createIphoneEnrollmentCaseToken, verifyIphoneEnrollmentCaseToken, isIphoneEnrollmentCaseTokenForSession,
  hashIphoneEnrollmentDocument, hashIphoneEnrollmentImei, normalizeIphoneEnrollmentDocument,
  normalizeIphoneEnrollmentImei, buildIphoneEnrollmentChecklist,
} from "./iphone-enrollment";
import {
  findIphoneEnrollmentApplicationInTransaction, approveIphoneEnrollmentCaseInTransaction,
  type IphoneEnrollmentGrantSession,
} from "./iphone-enrollment-storage";

function currentIdentity(context:AttentionWorkWorkflowContext) {
  const document=normalizeIphoneEnrollmentDocument(context.target.document),imei=normalizeIphoneEnrollmentImei(context.target.imei);
  if(!document||!imei||context.target.platform!=="IPHONE")throw new AttentionError("La solicitud debe tener una cédula válida y el IMEI de un iPhone registrado.",409);
  return {solicitudId:context.work.targetId,document,imei};
}
function nominalGrant(grant:IphoneEnrollmentGrantSession,context:AttentionWorkWorkflowContext) {
  if(grant.accessMode!=="GRANT"||grant.issuedBy?.userId!==context.actor.userId||grant.analyst.externalId!==`FINSER-USER:${context.actor.userId}`)
    throw new AttentionError("La sesión de enrolamiento no pertenece a tu cuenta. Actualiza la solicitud.",401);
}
const unavailable:Record<string,string>={
  NOT_READY:"La venta todavía no cumple la etapa, identidad o firma necesarias para enrolamiento.",
  NOT_FOUND:"La venta no está disponible para enrolamiento con su cédula e IMEI actuales.",
  FINALIZED:"La venta ya fue finalizada y no permite una nueva autorización de enrolamiento.",
  AMBIGUOUS:"La identidad de la solicitud requiere revisión antes de continuar.",
};
export function createAttentionWorkEnrollment(database:AttentionDatabase) {
  const work=createAttentionWorkStore(database);
  return {
    status:(actor:AttentionWorkActor,id:string,grant:IphoneEnrollmentGrantSession)=>work.workflowRead(actor,id,"enrollment",async (context):Promise<AttentionEnrollmentStatus>=>{
      nominalGrant(grant,context);
      const base={version:context.work.version,document:context.target.document,imei:context.target.imei};
      let identity;try{identity=currentIdentity(context);}catch(error){if(error instanceof AttentionError)return {...base,available:false,status:"unavailable",reason:error.message,caseToken:null,review:null};throw error;}
      const found=await findIphoneEnrollmentApplicationInTransaction(identity,context.db as Prisma.TransactionClient);
      if(found.kind!=="FOUND")return {...base,available:false,status:"unavailable",reason:unavailable[found.kind],caseToken:null,review:null};
      const review=found.item.review;
      const caseToken=createIphoneEnrollmentCaseToken({solicitudId:context.work.targetId,targetType:"APPLICATION",targetId:null,
        documentHash:hashIphoneEnrollmentDocument(identity.document),imeiHash:hashIphoneEnrollmentImei(identity.imei),session:grant.session});
      return {...base,available:true,status:review?"approved":"ready",reason:null,caseToken,
        review:review?{id:review.id,analystName:review.analystName,approvedAt:review.approvedAt}:null};
    }),
    approve:(actor:AttentionWorkActor,id:string,input:Record<string,unknown>,grant:IphoneEnrollmentGrantSession)=>{
      const parsed=parseAttentionEnrollmentAction(input);
      return work.workflowMutate(actor,id,"enrollment",input,async context=>{
        nominalGrant(grant,context);
        const identity=currentIdentity(context),caseToken=verifyIphoneEnrollmentCaseToken(input.caseToken);
        if(!caseToken||caseToken.targetType!=="APPLICATION"||caseToken.targetId!==null||caseToken.solicitudId!==context.work.targetId||
            !isIphoneEnrollmentCaseTokenForSession(caseToken,grant.session)||caseToken.documentHash!==hashIphoneEnrollmentDocument(identity.document)||caseToken.imeiHash!==hashIphoneEnrollmentImei(identity.imei))
          throw new AttentionError("La consulta venció o cambió la cédula o el IMEI. Actualiza antes de confirmar.",409);
        // Recheck even when a canonical review already exists: a historic approval is not eligibility for a changed case.
        const found=await findIphoneEnrollmentApplicationInTransaction(identity,context.db as Prisma.TransactionClient);
        if(found.kind!=="FOUND")throw new AttentionError(unavailable[found.kind],409);
        if(parsed.action==="record_existing"&&!found.item.review)throw new AttentionError("No existe una autorización vigente para registrar. Revisa las pruebas del equipo.",409);
        const approved=await approveIphoneEnrollmentCaseInTransaction({caseToken,grant,checklist:buildIphoneEnrollmentChecklist(true)!,nominalActor:{id:context.actor.userId}},context.db as Prisma.TransactionClient);
        const confirmed=await findIphoneEnrollmentApplicationInTransaction(identity,context.db as Prisma.TransactionClient);
        if(confirmed.kind!=="FOUND"||confirmed.item.review?.id!==approved.review.id)
          throw new AttentionError("La autorización ya no coincide con la identidad o las validaciones vigentes. Actualiza la solicitud.",409);
        const review={id:approved.review.id,analystName:approved.review.analystName,approvedAt:approved.review.approvedAt};
        return {result:{review,alreadyApproved:approved.alreadyApproved,checks:parsed.checks,source:parsed.action==="record_existing"?"existing_review":"analyst_checks"},
          summary:`Enrolamiento autorizado. ${approved.alreadyApproved?"Se registró la autorización vigente de":"Confirmado por"} ${review.analystName}. La solicitud de enrolamiento quedó finalizada.`,complete:true};
      });
    },
  };
}
