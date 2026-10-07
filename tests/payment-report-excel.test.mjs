import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {createJiti} from "jiti";
import {fileURLToPath} from "node:url";
const jiti=createJiti(import.meta.url,{alias:{"@":fileURLToPath(new URL("../",import.meta.url))}});
const {buildPaymentReportWorkbook}=await jiti.import("../lib/payment-report-excel.ts");
const {paymentReportCollector}=await jiti.import("../lib/payment-report.ts");
const row={id:1,valor:123456.09,metodoPago:"NEQUI",observacion:"=SUM(A1:A2)",estado:"ACTIVO",anuladoAt:null,anulacionMotivo:null,fechaAbono:"2026-10-07T04:10:00Z",credito:{id:4,folio:"000FC-4",numeroSadmin:"00012345678901234567890",numeroCreditoVisible:"00012345678901234567890",clienteNombre:"Cliente prueba",clienteDocumento:"00.123.456"},usuario:{id:1,nombre:"Registrador prueba",usuario:"qa"},vendedor:{id:8,nombre:"Responsable prueba",usuario:"qa8"},sede:{id:10,nombre:"Sede prueba",codigo:"QA",aliado:{id:5,nombre:"Aliado prueba",codigo:"QA"}}};
async function roundTrip(items,daily=[]){const data=await buildPaymentReportWorkbook(items,daily).xlsx.writeBuffer();const book=new ExcelJS.Workbook();await book.xlsx.load(data);return book;}
test("XLSX conserva las 14 columnas anteriores e incluye Sadmin como texto sin redondear identificadores",async()=>{
 const book=await roundTrip([row]);const sheet=book.getWorksheet("Pagos registrados");
 assert.deepEqual(sheet.getRow(1).values.slice(1),["Fecha","Cliente","Documento","Número crédito","Folio original","Aliado","Sede","Vendedor/Supervisor","Metodo","Valor","Estado","Anulado el","Motivo anulacion","Observacion","Número Sadmin"]);
 for(const [cell,value]of [["C2","00123456"],["D2",row.credito.numeroSadmin],["E2",row.credito.folio],["N2",row.observacion],["O2",row.credito.numeroSadmin]]){assert.equal(sheet.getCell(cell).value,value);assert.equal(sheet.getCell(cell).type,ExcelJS.ValueType.String);assert.equal(sheet.getCell(cell).numFmt,"@");assert.equal(sheet.getCell(cell).formula,undefined);}
 assert.equal(sheet.getCell("J2").value,row.valor);assert.equal(sheet.getCell("J2").type,ExcelJS.ValueType.Number);assert.equal(sheet.getCell("H2").value,row.vendedor.nombre);assert.match(sheet.getCell("A2").value,/6\/10\/26/);
});
test("pendiente Sadmin conserva folio y estado del pago",async()=>{
 const item={...row,estado:"ANULADO",anuladoAt:"2026-10-07T14:10:00Z",anulacionMotivo:"Motivo prueba",credito:{...row.credito,numeroSadmin:null,numeroCreditoVisible:row.credito.folio}};
 const original=structuredClone(item);const book=await roundTrip([item]);const sheet=book.getWorksheet("Pagos registrados");
 assert.equal(sheet.getCell("O2").value,"PENDIENTE SADMIN");assert.equal(sheet.getCell("E2").value,row.credito.folio);assert.equal(sheet.getCell("K2").value,"ANULADO");assert.equal(sheet.getCell("M2").value,"Motivo prueba");assert.deepEqual(item,original);
});
test("exporta todos los resultados y el resumen diario recibido, independiente de la página",async()=>{
 const items=Array.from({length:605},(_,i)=>({...row,id:i+1,valor:100.25}));const daily=[{fecha:"2026-10-06",cantidad:605,total:60651.25}];
 const book=await roundTrip(items,daily);assert.equal(book.getWorksheet("Pagos registrados").rowCount,606);const sheet=book.getWorksheet("Recaudo día a día");assert.equal(sheet.getCell("B2").value,605);assert.equal(sheet.getCell("C2").value,60651.25);
});
test("responsable digital y responsable asignado conservan origen actual",()=>{
 assert.equal(paymentReportCollector(row),"Responsable prueba");assert.equal(paymentReportCollector({...row,sede:{...row.sede,codigo:"RECAUDO_DIGITAL"}}),"DIGITAL");assert.equal(paymentReportCollector({...row,vendedor:null}),"Registrador prueba");
});
