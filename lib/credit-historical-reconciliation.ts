import { CAPITAL_PLAN_VERSION, parseCapitalPlanSnapshot, type CapitalPlanSnapshot } from "./credit-principal-payment";

type Row = { numero: number; fechaVencimiento: string; capital: number; interes: number; otros: number; seguro: number; totalCuota: number; saldoCapital: number };
type Payment = { fecha: string; total: number; capital: number; interes: number; mora: number; otros: number; seguro: number; saldoCapital: number; documento: string };
export type HistoricalSource = { documento: string; folioFinser: string; fuente: string; capitalInicial: number; tasaPeriodo: number; numeroUltimaCuotaPagada: number; saldoCapitalTrasUltimoAbono: number; cuotas: Row[]; abonos: Payment[]; capitalExtraordinario: number };
export class HistoricalReconciliationError extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new HistoricalReconciliationError(message); }
function amount(value: unknown): asserts value is number { check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 1e10, "Importe documental inválido."); }
function date(value: string) { check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + "T12:00:00Z").toISOString().slice(0,10) === value, "Fecha documental inválida."); }
export function validateHistoricalSource(value: unknown): HistoricalSource {
 check(value && typeof value === "object", "Falta la conciliación documental.");
 const s = value as HistoricalSource;
 check(/^\d{5,15}$/.test(s.documento) && typeof s.folioFinser === "string" && s.folioFinser.length < 100, "Identificación del crédito inválida.");
 check(typeof s.fuente === "string" && s.fuente.length >= 10 && s.fuente.length <= 500, "Indica la fuente documental.");
 check(Array.isArray(s.cuotas) && s.cuotas.length > 0 && s.cuotas.length <= 600 && Array.isArray(s.abonos) && s.abonos.length > 0 && s.abonos.length <= 600, "Calendario o historial incompleto.");
 amount(s.capitalInicial);amount(s.capitalExtraordinario);amount(s.saldoCapitalTrasUltimoAbono);
 check(Number.isInteger(s.numeroUltimaCuotaPagada) && s.numeroUltimaCuotaPagada >= 0 && s.numeroUltimaCuotaPagada < s.cuotas.length, "Corte de cuotas inválido.");
 check(Number.isFinite(s.tasaPeriodo) && s.tasaPeriodo >= 0 && s.tasaPeriodo <= 1, "Tasa periódica inválida.");
 let prior="", balance=s.capitalInicial;
 for (const [i,r] of s.cuotas.entries()) {
  check(r.numero===i+1,"Numeración incompleta.");date(r.fechaVencimiento);check(r.fechaVencimiento>prior,"Vencimientos desordenados.");prior=r.fechaVencimiento;
  for (const k of ["capital","interes","otros","seguro","totalCuota","saldoCapital"] as const) amount(r[k]);
  check(r.capital+r.interes+r.otros+r.seguro===r.totalCuota,"Los componentes no concilian con la cuota.");
  balance-=r.capital;
  check(balance===r.saldoCapital,"El saldo capital de una cuota no coincide.");
  if(i===0) balance-=s.capitalExtraordinario;
 }
 check(balance===0,"El calendario no cierra el capital.");
 prior="";const receipts=new Set<string>();let paidCapital=0;
 for(const p of s.abonos) {
  date(p.fecha);check(p.fecha>=prior,"Abonos desordenados.");prior=p.fecha;
  for(const k of ["total","capital","interes","mora","otros","seguro","saldoCapital"] as const) amount(p[k]);
  check(p.total>0 && p.capital+p.interes+p.mora+p.otros+p.seguro===p.total,"Los componentes del abono no concilian.");
  check(typeof p.documento==="string" && p.documento.length>0 && p.documento.length<100 && !receipts.has(p.documento),"Comprobante inválido o duplicado.");receipts.add(p.documento);paidCapital+=p.capital;
  check(s.capitalInicial-paidCapital===p.saldoCapital,"El capital abonado no concilia con el historial.");
 }
 check(s.abonos.at(-1)!.saldoCapital===s.saldoCapitalTrasUltimoAbono,"El saldo del corte no coincide.");
 check(s.cuotas.filter(r=>r.numero>s.numeroUltimaCuotaPagada).reduce((n,r)=>n+r.capital,0)===s.saldoCapitalTrasUltimoAbono,"El capital futuro no coincide con el corte.");
 check(s.cuotas[s.numeroUltimaCuotaPagada].fechaVencimiento>s.abonos.at(-1)!.fecha,"La próxima cuota debe estar después del último pago.");
 return s;
}
export function historicalSnapshot(s: HistoricalSource, payments: {id:number;valor:number}[]): CapitalPlanSnapshot {
 const next=s.cuotas[s.numeroUltimaCuotaPagada];
 check(payments.length===s.abonos.length && payments.every((p,i)=>p.valor===s.abonos[i].total),"Los abonos guardados no coinciden.");
 const snapshot={version:CAPITAL_PLAN_VERSION,revision:1,numeroCuotasOriginal:s.cuotas.length,
 totalAbonadoAlCorte:payments.reduce((n,p)=>n+p.valor,0),abonosAlCorte:payments,saldoCapitalAlCorte:s.saldoCapitalTrasUltimoAbono,
 parametros:{capitalPendiente:s.saldoCapitalTrasUltimoAbono,tasaPeriodo:s.tasaPeriodo,cuotaCredito:next.capital+next.interes,fianzaCuota:next.otros,seguroCuota:next.seguro,numeroProximaCuota:next.numero,fuente:s.fuente},
 cuotas:s.cuotas.map(r=>({numero:r.numero,fechaVencimiento:r.fechaVencimiento,valorProgramado:r.totalCuota,valorAbonadoAlCorte:r.numero<=s.numeroUltimaCuotaPagada?r.totalCuota:0,eliminada:r.totalCuota===0,capital:r.capital,interes:r.interes,fianza:r.otros,seguro:r.seguro,saldoCapital:r.saldoCapital}))};
 return parseCapitalPlanSnapshot(snapshot)!;
}
