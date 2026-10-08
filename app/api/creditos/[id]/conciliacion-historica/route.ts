import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { HistoricalReconciliationError, validateHistoricalSource, historicalSnapshot } from "@/lib/credit-historical-reconciliation";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { hashPrincipalPayment, findPrincipalPaymentRevision, persistPrincipalPaymentRevision } from "@/lib/credit-principal-payment-storage";
import { creditCajaDescription, CREDIT_ABONO_CAJA_MARKER } from "@/lib/credit-factory";
export const runtime="nodejs";
export async function POST(req:Request,context:{params:Promise<{id:string}>}) {
 const user=await getSessionUser();
 if(!user) return NextResponse.json({error:"No autenticado"},{status:401});
 if(!isAdminRole(user.rolNombre)||!isFinserPayCentralAlly(user.aliadoAccesoCodigo)) return NextResponse.json({error:"Solo Admin Central puede conciliar el historial."},{status:403});
 const publicHost=req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host") || new URL(req.url).host;
 const origin=req.headers.get("origin");
 if(origin!==`https://${publicHost}` && origin!==new URL(req.url).origin) return NextResponse.json({error:"Origen inválido."},{status:403});
 const id=Number((await context.params).id);
 if(!Number.isSafeInteger(id)||id<=0) return NextResponse.json({error:"Crédito inválido."},{status:400});
 try {
  const text=await req.text();if(text.length>250000) throw new HistoricalReconciliationError("Documento demasiado grande.");
  const body=JSON.parse(text);const source=validateHistoricalSource(body.source);
  if(!["PREVISUALIZAR","CONFIRMAR"].includes(body.accion)) throw new HistoricalReconciliationError("Acción inválida.");
  await ensureCreditAbonoAuditColumns();
  const requestHash=hashPrincipalPayment(source),key=`HISTORICAL:${requestHash}`;
  const result=await prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Credito" WHERE id=${id} FOR UPDATE`;
   const prior=await findPrincipalPaymentRevision(tx,id,key);
   if(prior) return prior.resultado;
   const credit=await tx.credito.findUnique({where:{id}});
   if(!credit||credit.clienteDocumento!==source.documento||credit.folio!==source.folioFinser) throw new HistoricalReconciliationError("La identidad del documento no coincide con el crédito.");
   const origin=(credit.contratoSnapshot as {origen?:{tipo?:string}}|null)?.origen?.tipo;
   if(credit.equalityService!=="IMPORTACION_MASIVA"||origin!=="IMPORTACION_MASIVA") throw new HistoricalReconciliationError("La conciliación histórica está limitada a cartera importada.");
   if(credit.planCapitalVigente||credit.pazYSalvoEmitidoAt||/ANUL|CANCEL/.test(credit.estado)) throw new HistoricalReconciliationError("El crédito tiene una revisión o cierre que requiere conciliación independiente.");
   const old=await tx.creditoAbono.findMany({where:{creditoId:id,estado:{not:"ANULADO"}},orderBy:{id:"asc"}});
   if(!old.length||old.some(p=>p.metodoPago!=="EFECTIVO"&&p.metodoPago!=="OTRO")) throw new HistoricalReconciliationError("Solo se pueden sustituir registros históricos manuales; revisa los recaudos externos.");
   const linked=await tx.wompiPaymentIntent.count({where:{processedAbonoId:{in:old.map(p=>p.id)}}});
   if(linked) throw new HistoricalReconciliationError("Hay recaudos externos vinculados; no se pueden sustituir.");
   const previewHash=hashPrincipalPayment({credit,old,source,user:user.id});
   const trial=historicalSnapshot(source,source.abonos.map((p,i)=>({id:i+1,valor:p.total})));
   const future=trial.cuotas.reduce((n,r)=>n+r.valorProgramado-r.valorAbonadoAlCorte,0);
   const preview={ok:true,previewHash,cliente:credit.clienteNombre,documento:credit.clienteDocumento,folio:credit.folio,abonosAnteriores:old.map(p=>({id:p.id,valor:p.valor,fecha:p.fechaAbono})),abonosNuevos:source.abonos,saldoCapital:trial.saldoCapitalAlCorte,saldoPendiente:future,proximaCuota:trial.cuotas[source.numeroUltimaCuotaPagada],cuotas:trial.cuotas,fuente:source.fuente};
   if(body.accion==="PREVISUALIZAR") return preview;
   if(body.previewHash!==previewHash) throw new HistoricalReconciliationError("El crédito cambió. Previsualiza de nuevo.");
   const reason=`Conciliación histórica documentada: ${source.fuente}`;
   for(const p of old) {
    await tx.creditoAbono.update({where:{id:p.id},data:{estado:"ANULADO",anuladoAt:new Date(),anuladoPorUsuarioId:user.id,anulacionMotivo:reason,observacion:[p.observacion,reason].filter(Boolean).join(" | ")}});
    // Reverse only movements that exist, with an exact payment marker.
    const movements=await tx.cajaMovimiento.findMany({where:{tipo:"INGRESO",descripcion:{contains:`${CREDIT_ABONO_CAJA_MARKER}${p.id}`}},select:{descripcion:true,valor:true,sedeId:true}});
    for(const m of movements.filter(m=>new RegExp(`${CREDIT_ABONO_CAJA_MARKER}${p.id}(?:\\D|$)`).test(m.descripcion||""))) await tx.cajaMovimiento.create({data:{tipo:"EGRESO",concepto:"REVERSA CONCILIACION HISTORICA",valor:m.valor,sedeId:m.sedeId,descripcion:`${reason} | Abono original ${p.id}`}});
   }
   const saved=[];
   for(const p of source.abonos) {
    const observation=`CONCILIACION HISTORICA | Comprobante ${p.documento} | Capital ${p.capital} | Interés ${p.interes} | Mora ${p.mora} | Otros ${p.otros} | Seguro ${p.seguro} | Saldo capital ${p.saldoCapital} | ${source.fuente}`;
    const payment=await tx.creditoAbono.create({data:{creditoId:id,usuarioId:user.id,sedeId:credit.sedeId,valor:p.total,metodoPago:"OTRO",observacion:observation,fechaAbono:new Date(p.fecha+"T12:00:00Z")}});saved.push({id:payment.id,valor:payment.valor});
    await tx.cajaMovimiento.create({data:{tipo:"INGRESO",concepto:"CONCILIACION HISTORICA DOCUMENTADA",valor:p.total,sedeId:credit.sedeId,createdAt:payment.fechaAbono,descripcion:creditCajaDescription({id:payment.id,creditoFolio:credit.folio,clienteNombre:credit.clienteNombre,metodoPago:"OTRO",observacion:observation})}});
   }
   const snapshot=historicalSnapshot(source,saved);
   const montoCredito=snapshot.totalAbonadoAlCorte+future;
   const plan=buildCreditPaymentPlan({...credit,montoCredito,planCapitalVigente:snapshot,abonos:saved});
   await tx.credito.update({where:{id},data:{planCapitalVigente:snapshot as unknown as Prisma.InputJsonValue,montoCredito,fechaProximoPago:new Date(plan.nextInstallment!.fechaVencimiento+"T12:00:00Z")}});
   const response={...preview,aplicado:true,totalAbonos:snapshot.totalAbonadoAlCorte,abonoIds:saved.map(p=>p.id)};
   await persistPrincipalPaymentRevision(tx,{creditoId:id,abonoId:saved[0].id,revision:1,idempotencyKey:key,requestHash,previewHash,snapshotBefore:{credit,abonos:old},snapshotAfter:snapshot,conciliacion:source,resultado:response,usuarioId:user.id});
   return response;
  },{timeout:30000});return NextResponse.json(result);
 } catch(error) {return NextResponse.json({error:error instanceof HistoricalReconciliationError?error.message:"No se pudo conciliar. Ningún cambio fue guardado."},{status:400});}
}
