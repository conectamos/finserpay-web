import "server-only";
import { createDaptaAttentionAdapter } from "./atencion-dapta";
import { createMetaAttentionAdapter, getMetaAttentionScope } from "./atencion-meta";
import { attentionMetaSchemaReady, createAttentionMetaStore } from "./atencion-meta-storage";
import type { AttentionActor, AttentionDetail, AttentionIntegration } from "./atencion-types";
import type { AttentionDatabase } from "./atencion-storage";

type Options = { env?: NodeJS.ProcessEnv; database?: AttentionDatabase; now?:()=>Date };

/** Local configuration and database reads only; polling never calls either provider. */
export function createAttentionReadModel(options:Options={}) {
  const env=options.env??process.env;
  const dapta=createDaptaAttentionAdapter({env});
  const meta=createMetaAttentionAdapter({env});
  async function database() {
    if(options.database)return options.database;
    const {default:prisma}=await import("./prisma");
    return prisma as unknown as AttentionDatabase;
  }
  return {
    async integration(schemaReady:boolean):Promise<AttentionIntegration> {
      const previous=dapta.attentionIntegrationStatus();
      const status=meta.status();
      if(!getMetaAttentionScope(env))return previous;
      const canSend=Boolean(schemaReady&&status.canSend&&await attentionMetaSchemaReady(await database()));
      return {...previous,configured:previous.configured||status.configured,canSend,canHandoff:false,
        status:canSend?"meta_ready":"meta_pending",
        message:canSend
          ? "Envío por Meta habilitado. Cada respuesta requiere permisos, línea verificada y una ventana de atención abierta. El historial Dapta conserva su sincronización independiente."
          : "La conexión con Meta está en preparación. Puedes consultar el historial y seguir respondiendo en Dapta mientras termina la configuración."};
    },
    async detail(actor:AttentionActor,detail:AttentionDetail):Promise<AttentionDetail> {
      const scope=getMetaAttentionScope(env);
      if(!scope)return {...detail,permissions:{...detail.permissions,canSend:false},
        messaging:{windowExpiresAt:null,canReply:false,reason:"La conexión de envío con Meta está pendiente de configuración."}};
      const status=meta.status();
      const store=createAttentionMetaStore(await database(),{scope,sendingEnabled:status.canSend,
        cutoverConfirmed:status.cutoverConfirmed,now:options.now});
      // Never swallow 401/403/404: a reassignment between reads must remove the
      // entire detail response, not return data captured before access changed.
      const messaging=await store.getMessaging(actor,detail.conversation.id);
      return {...detail,messaging,permissions:{...detail.permissions,canSend:detail.permissions.manage&&messaging.canReply}};
    },
  };
}

export async function attentionReadIntegration(schemaReady:boolean) {return createAttentionReadModel().integration(schemaReady);}
export async function attentionReadDetail(actor:AttentionActor,detail:AttentionDetail) {return createAttentionReadModel().detail(actor,detail);}
