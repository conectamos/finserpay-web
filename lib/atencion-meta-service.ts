import "server-only";
import { AttentionError } from "./atencion-core";
import { AttentionMetaError, createMetaAttentionAdapter, getMetaAttentionScope } from "./atencion-meta";
import { attentionMetaReplyMessage, createAttentionMetaStore } from "./atencion-meta-storage";
import type { AttentionActor } from "./atencion-types";
import type { AttentionDatabase } from "./atencion-storage";
import type { readAttentionMetaReply } from "./atencion-meta-http";
import { compileMetaTemplate, isAttentionCollectionTemplate, parseAttentionTemplateIntent, publicMetaTemplate, templateIntentFingerprint, type MetaTemplateSnapshot } from "./atencion-meta-templates";
import type { AttentionTemplateCatalogue, AttentionTemplateIntent } from "./atencion-template-types";
import { createAttentionCollectionTemplateStore, type AttentionCollectionReservation } from "./atencion-collection-template-storage";

type Adapter = ReturnType<typeof createMetaAttentionAdapter>;
type Store = ReturnType<typeof createAttentionMetaStore>;
type ReplyInput = Awaited<ReturnType<typeof readAttentionMetaReply>>;
type CollectionStore = ReturnType<typeof createAttentionCollectionTemplateStore>;

/** A request owns one durable outbox lease; an ambiguous provider POST is never repeated. */
export function createAttentionMetaService(store: Store, adapter: Adapter, collection?: CollectionStore) {
  return {
    async templates(actor: AttentionActor, conversationId: string): Promise<AttentionTemplateCatalogue> {
      const access=await store.getTemplateAccess(actor,conversationId);
      if(!adapter.status().configured)return {...access,templates:[],canSend:false,reason:"La conexión de Meta para Atención está pendiente de configurar."};
      const definitions=await adapter.listManualTemplates();
      let financial:Awaited<ReturnType<CollectionStore["list"]>>|null=null;
      if(collection && definitions.some(template=>isAttentionCollectionTemplate(template.name))){
        try{financial=await collection.list(actor,conversationId);}
        catch(error){if(!(error instanceof AttentionError && error.status===503))throw error;}
      }
      const current=await store.getTemplateAccess(actor,conversationId);
      if(financial && financial.version!==current.conversationVersion)throw new AttentionError("La conversación cambió. Actualiza el catálogo antes de confirmar.",409);
      const counts=new Map<string,number>();for(const template of definitions)counts.set(template.key,(counts.get(template.key)||0)+1);
      return {...current,templates:definitions.map(publicMetaTemplate).map(template=>{
        if(isAttentionCollectionTemplate(template.name))template={...template,financial:{
          blockedReason:financial?.blockedReason??(financial?null:"La validación de cartera está pendiente de configurar."),
          candidates:(financial?.credits||[]).map(credit=>{
            const option=credit.options.find(value=>value.templateName===template.name),review=option?.review;
            return {creditId:credit.id,creditLabel:credit.number,revision:review?.reviewHash??null,
              parameters:review?.parameters??{},eligible:option?.eligible===true,reason:option?.reason??(option?null:"Esta plantilla no corresponde al crédito."),
              installmentNumber:review?.installmentNumber??null,dueDate:review?.dueDate??null,checkedOn:review?.day??null,
              coveredCredits:review?.coveredCredits??[]};
          })}};
        return counts.get(template.key)!>1?{...template,available:false,reason:"Meta devolvió varias versiones para esta plantilla. Actualiza el catálogo."}:template;
      })};
    },
    async sendTemplate(actor: AttentionActor, conversationId: string, raw: AttentionTemplateIntent) {
      const input=parseAttentionTemplateIntent(raw),fingerprint=templateIntentFingerprint(conversationId,input);
      let queued=await store.findReply(actor,conversationId,input.requestId);
      if(queued && (!queued.template||queued.fingerprint!==fingerprint))throw new AttentionError("La solicitud ya se usó con otro contenido.",409);
      if(!queued){
        const access=await store.getTemplateAccess(actor,conversationId);
        if(!access.canSend)throw new AttentionError(access.reason||"El envío no está disponible.",409);
        const matches=(await adapter.listManualTemplates()).filter(template=>template.key===input.templateKey);
        if(matches.length!==1||matches[0].revision!==input.revision)throw new AttentionError("La plantilla cambió o dejó de estar aprobada. Actualiza el catálogo y revísala antes de confirmar.",409);
        const template:MetaTemplateSnapshot={definition:matches[0],parameters:input.parameters};
        if(isAttentionCollectionTemplate(template.definition.name)){
          if(!collection||!input.creditId||!input.financialRevision)throw new AttentionError("Selecciona y revisa un crédito elegible antes de confirmar esta plantilla.",409);
          const financial=await collection.list(actor,conversationId),option=financial.credits.find(credit=>credit.id===input.creditId)?.options.find(value=>value.templateName===template.definition.name);
          if(financial.version!==input.version||!option?.eligible||!option.review||option.review.reviewHash!==input.financialRevision)
            throw new AttentionError(option?.reason||financial.blockedReason||"Los datos del crédito cambiaron. Actualiza el catálogo y revisa la plantilla.",409);
          template.parameters={...option.review.parameters};
          template.financial={creditId:input.creditId,reviewHash:input.financialRevision,templateName:template.definition.name};
        }else if(input.creditId!==undefined||input.financialRevision!==undefined)throw new AttentionError("Esta plantilla no utiliza una revisión de cartera.",409);
        const compiled=compileMetaTemplate(template);
        queued=await store.queueReply(actor,conversationId,{requestId:input.requestId,version:input.version,text:compiled.text,template});
      }
      if(queued.status!=="queued")return {message:attentionMetaReplyMessage(queued),uncertain:["sending","uncertain"].includes(queued.status)};
      const claim=await store.claimReply(actor,conversationId,input.requestId);let row=claim.reply;
      if(!claim.claimed||!row.leaseToken)return {message:attentionMetaReplyMessage(row),uncertain:["queued","sending","uncertain"].includes(row.status)};
      const leaseToken=row.leaseToken;let networkAttempted=false,providerMessageId:string|undefined,reservation:AttentionCollectionReservation|undefined,financialFinished=false;
      try{
        if(!row.template)throw new AttentionError("El intento no corresponde a una plantilla.",409);
        if(row.template.definition.headerImageUrl&&!row.uploadedMediaId){
          row=await store.setTemplateMedia(actor,row.id,leaseToken,await adapter.prepareTemplateMedia(row.template));
        }
        const snapshot=row.template!;
        if(snapshot.financial){
          if(!collection)throw new AttentionError("La validación de cartera está pendiente de configurar.",503);
          reservation=await collection.claim(actor,conversationId,{requestId:row.id,version:row.conversationVersion,...snapshot.financial});
          if(reservation.phone!==`+${row.contactId}`)throw new AttentionError("El teléfono del crédito no coincide con el destinatario del chat.",409);
        }
        const guard=reservation&&collection?<T>(send:()=>Promise<T>)=>collection.withSendGuard(actor,conversationId,reservation!,send):undefined;
        const receipt=await adapter.sendTemplate({recipient:row.contactId,attemptId:row.id,snapshot,cutoverConfirmed:adapter.status().cutoverConfirmed,
          ...(row.uploadedMediaId?{headerMediaId:row.uploadedMediaId}:{})},
          async()=>{await store.beforeSend(actor,row.id,leaseToken);},guard,()=>{networkAttempted=true;});
        providerMessageId=receipt.providerMessageId;
        if(reservation&&collection){await collection.finish(reservation,{status:"ACCEPTED",providerReference:providerMessageId,started:true});financialFinished=true;}
        return {message:attentionMetaReplyMessage(await store.acceptReply(row.id,leaseToken,receipt.providerMessageId)),uncertain:false};
      }catch(error){
        // Persisting `sending` is not evidence of a POST: the financial guard may
        // still reject a new payment, extension or reassignment immediately after.
        const uncertain=networkAttempted && !(error instanceof AttentionMetaError && error.code==="META_HTTP_ERROR" && !error.uncertain);
        const code=error instanceof AttentionMetaError?error.code:uncertain?"ACK_PENDING":"TEMPLATE_PRECONDITION_FAILED";
        let failed:Awaited<ReturnType<Store["failReply"]>>|undefined,cleanupError:unknown;
        try{failed=await store.failReply(row.id,leaseToken,{code,uncertain});}catch(persistenceError){cleanupError=persistenceError;}
        if(reservation&&collection&&!financialFinished){
          // A signed callback may have confirmed the message before a timed-out
          // POST returns. Conversely, cancellation can invalidate the lease
          // before POST: its financial reservation must still be released.
          const confirmed=providerMessageId||(failed?.messageId?failed.wamid:undefined)||undefined;
          try{await collection.finish(reservation,{status:confirmed?"ACCEPTED":uncertain?"UNKNOWN":"FAILED",
            providerReference:confirmed,code,started:networkAttempted});}catch(persistenceError){cleanupError??=persistenceError;}
        }
        if(!uncertain && ((error instanceof AttentionError && [401,403,404,409].includes(error.status))
          || (error instanceof AttentionMetaError && error.status===409)))throw error;
        if(cleanupError)throw cleanupError;
        return {message:attentionMetaReplyMessage(failed!),uncertain:["uncertain","sending"].includes(failed!.status)};
      }
    },
    async send(actor: AttentionActor, conversationId: string, input: ReplyInput) {
      const queued = await store.queueReply(actor, conversationId, input);
      if (queued.status !== "queued") return { message: attentionMetaReplyMessage(queued), uncertain: ["sending", "uncertain"].includes(queued.status) };
      const claim = await store.claimReply(actor, conversationId, input.requestId);
      let row = claim.reply;
      if (!claim.claimed || !row.leaseToken) return { message: attentionMetaReplyMessage(row), uncertain: ["queued", "sending", "uncertain"].includes(row.status) };
      const leaseToken = row.leaseToken;
      let sendingStarted = false;
      try {
        if (!claim.lastInboundAt) throw new AttentionError("Hace falta un mensaje reciente del contacto para responder.", 409);
        if (row.attachment && !row.uploadedMediaId) {
          if (!input.bytes) throw new AttentionError("Adjunta nuevamente el archivo de este mensaje.", 400);
          const uploaded = await adapter.uploadMedia({ bytes: input.bytes, mimeType: row.attachment.mimeType,
            fileName: row.attachment.fileName || "archivo", kind: row.attachment.kind });
          row = await store.setUploadedMedia(actor, row.id, leaseToken, uploaded.mediaId);
        }
        const beforeSend = async () => { await store.beforeSend(actor, row.id, leaseToken); sendingStarted = true; };
        const send = { recipient: row.contactId, attemptId: row.id, lastInboundAt: claim.lastInboundAt,
          cutoverConfirmed: adapter.status().cutoverConfirmed };
        const receipt = row.attachment
          ? await adapter.sendMedia({ ...send, mediaId: row.uploadedMediaId!, kind: row.attachment.kind,
            ...(row.text ? { caption: row.text } : {}), ...(row.attachment.kind === "document" && row.attachment.fileName ? { fileName: row.attachment.fileName } : {}) }, beforeSend)
          : await adapter.sendText({ ...send, text: row.text }, beforeSend);
        const accepted = await store.acceptReply(row.id, leaseToken, receipt.providerMessageId);
        return { message: attentionMetaReplyMessage(accepted), uncertain: false };
      } catch (error) {
        // A confirmed provider rejection is definitive. A lost response or failed
        // database ACK after the POST stays uncertain until its signed callback.
        const uncertain = error instanceof AttentionMetaError ? error.uncertain : sendingStarted;
        const code = error instanceof AttentionMetaError ? error.code : uncertain ? "ACK_PENDING" : "SEND_PRECONDITION_FAILED";
        const failed = await store.failReply(row.id, leaseToken, { code, uncertain });
        return { message: attentionMetaReplyMessage(failed), uncertain: failed.status === "uncertain" || failed.status === "sending" };
      }
    },
    async find(actor: AttentionActor, conversationId: string, requestId: string) {
      const reply = await store.findReply(actor, conversationId, requestId);
      return { message: reply ? attentionMetaReplyMessage(reply) : null };
    },
    async cancel(actor: AttentionActor, conversationId: string, requestId: string) {
      return store.cancelReply(actor, conversationId, requestId);
    },
    async media(actor: AttentionActor, conversationId: string, messageId: string, range?: string | null) {
      const descriptor = await store.getMedia(actor, conversationId, messageId);
      const result = await adapter.downloadMedia({ mediaId: descriptor.mediaId, range });
      // Re-check assignment after network I/O before returning private bytes.
      const current = await store.getMedia(actor, conversationId, messageId);
      if (current.mediaId !== descriptor.mediaId || current.mimeType !== result.mimeType) throw new AttentionError("El archivo cambió. Actualiza la conversación.", 409);
      return { ...result, fileName: current.fileName, kind: current.kind };
    },
  };
}

export async function attentionMetaRuntime() {
  const adapter = createMetaAttentionAdapter();
  const scope = getMetaAttentionScope();
  if (!scope) throw new AttentionError("La conexión de Meta para Atención está pendiente de configurar.", 503);
  const status = adapter.status();
  const { default: prisma } = await import("./prisma");
  const store = createAttentionMetaStore(prisma as unknown as AttentionDatabase, { scope,
    sendingEnabled: status.canSend, cutoverConfirmed: status.cutoverConfirmed });
  return { adapter, store, service: createAttentionMetaService(store, adapter,createAttentionCollectionTemplateStore(prisma as unknown as AttentionDatabase)) };
}
