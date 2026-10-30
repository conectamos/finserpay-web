import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import { attentionBoardColors, type AttentionBoardColor, type AttentionBoardMove, type AttentionBoardSectionMutation } from "./atencion-board-types";

function exact(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new AttentionError("La solicitud del tablero contiene campos no admitidos.");
}
function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483646) throw new AttentionError("La versión del tablero no es válida.");
  return value;
}
function name(value: unknown) {
  const valueText=attentionText(value,60).normalize("NFKC").replace(/\s+/g," ").trim();
  if (!valueText || valueText.length>60 || /[\p{Cc}\p{Cf}]/u.test(valueText) || valueText.normalize("NFD").replace(/[\p{M}\s]/gu,"").toLowerCase()==="sinseccion") throw new AttentionError("Escribe un nombre de sección de hasta 60 caracteres, distinto de Sin sección.");
  return valueText;
}
function color(value: unknown): AttentionBoardColor {
  if (typeof value!=="string" || !(attentionBoardColors as readonly string[]).includes(value)) throw new AttentionError("El color de la sección no es válido.");
  return value as AttentionBoardColor;
}
export function parseAttentionBoardSearch(params: URLSearchParams) {
  if (params.getAll("search").length>1) throw new AttentionError("La búsqueda no puede repetirse.");
  return attentionText(params.get("search")||"",100,false);
}
export function parseAttentionBoardCards(params: URLSearchParams) {
  if (["sectionId","page"].some(key=>params.getAll(key).length>1)) throw new AttentionError("Los filtros del tablero no pueden repetirse.");
  const rawSection=params.get("sectionId");
  if (!rawSection) throw new AttentionError("Selecciona una sección del tablero.");
  const page=params.get("page")||"1";
  if (!/^[1-9]\d{0,3}$/.test(page)) throw new AttentionError("Página del tablero inválida.");
  return {sectionId:rawSection==="none"?null:attentionUuid(rawSection),page:Number(page),search:parseAttentionBoardSearch(params)};
}
export function parseAttentionBoardMove(body: Record<string, unknown>): AttentionBoardMove {
  exact(body,["sectionId","boardVersion","requestId"]);
  return {sectionId:body.sectionId===null?null:attentionUuid(body.sectionId),boardVersion:version(body.boardVersion),requestId:attentionUuid(body.requestId)};
}
export function parseAttentionBoardMutation(body: Record<string, unknown>): AttentionBoardSectionMutation {
  const requestId=attentionUuid(body.requestId);
  if(body.action==="create") {exact(body,["action","requestId","name","color"]);return {action:body.action,requestId,name:name(body.name),color:color(body.color)};}
  if(body.action==="reorder") {
    exact(body,["action","requestId","ordered"]);
    if(!Array.isArray(body.ordered)||body.ordered.length>20)throw new AttentionError("El orden de las secciones no es válido.");
    const ordered=body.ordered.map(value=>{
      if(!value||typeof value!=="object"||Array.isArray(value))throw new AttentionError("El orden de las secciones no es válido.");
      const item=value as Record<string,unknown>;exact(item,["id","version"]);return {id:attentionUuid(item.id),version:version(item.version)};
    });
    if(new Set(ordered.map(item=>item.id)).size!==ordered.length)throw new AttentionError("Una sección no puede repetirse en el orden.");
    return {action:body.action,requestId,ordered};
  }
  if(body.action==="rename"||body.action==="color"||body.action==="archive") {
    exact(body,["action","requestId","id","version",...(body.action==="rename"?["name"]:body.action==="color"?["color"]:[])]);
    const common={requestId,id:attentionUuid(body.id),version:version(body.version)};
    return body.action==="rename"?{...common,action:body.action,name:name(body.name)}:body.action==="color"?{...common,action:body.action,color:color(body.color)}:{...common,action:body.action};
  }
  throw new AttentionError("La operación del tablero no está admitida.");
}
