import { AttentionError } from "./atencion-core";
import { attentionEnrollmentChecks, type AttentionEnrollmentChecks } from "./atencion-work-enrollment-types";
export function parseAttentionEnrollmentAction(input:Record<string,unknown>) {
  if(Object.keys(input).some(k=>!["requestId","version","caseToken","action","checks"].includes(k)))throw new AttentionError("La confirmación contiene datos no admitidos.");
  const action=input.action??"confirm";
  if(action!=="confirm"&&action!=="record_existing")throw new AttentionError("Acción de enrolamiento inválida.");
  if(action==="record_existing"){
    if(input.checks!==undefined)throw new AttentionError("La autorización existente se registra sin declarar nuevas pruebas.");
    return {action,checks:null};
  }
  const checks=input.checks;
  if(!checks||typeof checks!=="object"||Array.isArray(checks)||Object.keys(checks).length!==4||
      attentionEnrollmentChecks.some(({key})=>(checks as Record<string,unknown>)[key]!==true))
    throw new AttentionError("Confirma las cuatro verificaciones del equipo antes de autorizar el enrolamiento.");
  return {action,checks:checks as AttentionEnrollmentChecks};
}
