import { ECDH } from "node:crypto";
import { AttentionError } from "./atencion-core";

export type AttentionPushSubscription = { endpoint:string; keys:{p256dh:string;auth:string} };
export function validateAttentionPushSubscription(input:unknown):AttentionPushSubscription {
  if (!input || typeof input !== "object") throw new AttentionError("Suscripción del dispositivo inválida.");
  const value=input as Record<string,unknown>;
  if(typeof value.endpoint!=="string"||value.endpoint.length>2048)throw new AttentionError("Destino de notificación inválido.");
  let endpoint:URL;
  try { endpoint=new URL(value.endpoint); } catch { throw new AttentionError("Destino de notificación inválido."); }
  const h=endpoint.hostname;
  const allowed=h==="fcm.googleapis.com"||h==="updates.push.services.mozilla.com"||h.endsWith(".push.apple.com")||h.endsWith(".notify.windows.com");
  if(!allowed||endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.port||endpoint.hash)
    throw new AttentionError("El navegador usa un servicio de notificaciones no compatible.");
  const keys=value.keys as Record<string,unknown>|undefined;
  function key(name:"auth"|"p256dh",size:number){
    const key=keys?.[name];
    if(typeof key!=="string"||!/^[-_A-Za-z0-9]+={0,2}$/.test(key)||key.length>100||Buffer.from(key,"base64url").length!==size)
      throw new AttentionError("Claves de notificación inválidas.");
    return key;
  }
  const auth=key("auth",16),p256dh=key("p256dh",65);
  try { ECDH.convertKey(Buffer.from(p256dh,"base64url"),"prime256v1"); } catch {throw new AttentionError("Clave del dispositivo inválida.");}
  return {endpoint:endpoint.href,keys:{auth,p256dh}};
}
export function attentionPushConfig(env:NodeJS.ProcessEnv=process.env){
  const publicKey=env.ATTENTION_VAPID_PUBLIC_KEY?.trim(),privateKey=env.ATTENTION_VAPID_PRIVATE_KEY?.trim();
  const subject=env.ATTENTION_VAPID_SUBJECT?.trim();
  if(!publicKey||!privateKey||!subject||!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject))return null;
  try {if(Buffer.from(publicKey,"base64url").length!==65||Buffer.from(privateKey,"base64url").length!==32)return null; ECDH.convertKey(Buffer.from(publicKey,"base64url"),"prime256v1");}catch{return null;}
  return {publicKey,privateKey,subject};
}
export function attentionPushRetry(status:number,attempts:number){
  if(status===404||status===410)return {remove:true,terminal:true,delay:0};
  if((status>=400&&status<500&&status!==429)||attempts>=6)return {remove:false,terminal:true,delay:0};
  return {remove:false,terminal:false,delay:Math.min(3600,15*2**Math.max(0,attempts-1))};
}
export function attentionPushPayload(id:string,kind:string,workKind:string){
  const subject=workKind==="enrollment"?"enrolamiento iPhone":"aprobación · bienvenida";
  const body=kind==="created"?`Nueva solicitud de ${subject}.`:kind==="assigned"?`Te asignaron una solicitud de ${subject}.`:kind==="reply"?`Recibiste una respuesta en tu solicitud de ${subject}.`:`Hay un nuevo mensaje en una solicitud de ${subject}.`;
  return {title:"FINSER PAY · Solicitudes",body,tag:`work-${id}`,url:"/dashboard?notifications=1"};
}
