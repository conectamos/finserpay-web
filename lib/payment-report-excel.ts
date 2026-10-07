import ExcelJS from "exceljs";
import {creditDisplayNumber} from "@/lib/credit-display-number";
import {creditReportDocument,creditReportSadmin} from "@/lib/credit-report-identifiers";
import {paymentReportCollector,paymentReportDate,type PaymentReportItem,type PaymentByDay} from "@/lib/payment-report";

export function buildPaymentReportWorkbook(items: PaymentReportItem[], byDay: PaymentByDay[]) {
  const workbook=new ExcelJS.Workbook();workbook.creator="FINSER PAY";
  const sheet=workbook.addWorksheet("Pagos registrados",{views:[{state:"frozen",ySplit:1,showGridLines:false}]});
  sheet.columns=["Fecha","Cliente","Documento","Número crédito","Folio original","Aliado","Sede","Vendedor/Supervisor","Metodo","Valor","Estado","Anulado el","Motivo anulacion","Observacion","Número Sadmin"].map(header=>({header,width:header==="Observacion"||header==="Motivo anulacion"?40:25}));
  for(const item of items){sheet.addRow([
    paymentReportDate(item.fechaAbono,true),item.credito.clienteNombre,creditReportDocument(item.credito.clienteDocumento),creditDisplayNumber(item.credito),item.credito.folio,item.sede.aliado?.nombre||"",item.sede.nombre,paymentReportCollector(item),item.metodoPago,item.valor,item.estado||"ACTIVO",item.anuladoAt?paymentReportDate(item.anuladoAt,true):"",item.anulacionMotivo||"",item.observacion||"",creditReportSadmin(item.credito)||"PENDIENTE SADMIN",
  ]);}
  const daily=workbook.addWorksheet("Recaudo día a día",{views:[{state:"frozen",ySplit:1,showGridLines:false}]});daily.columns=[{header:"Fecha",width:25},{header:"Abonos",width:20},{header:"Total",width:25}];
  for(const day of byDay)daily.addRow([paymentReportDate(day.fecha),day.cantidad,day.total]);
  for(const current of [sheet,daily]){
    current.columns.forEach((column,index)=>{const isMoney=current===sheet?index===9:index===2;const isCount=current===daily&&index===1;column.numFmt=isMoney?'"$" #,##0.00':isCount?'0':'@';column.font={name:"Calibri",size:11,color:{argb:"FF151A21"}};column.alignment={vertical:"middle",horizontal:isMoney||isCount?"right":"left",wrapText:true};});
    current.eachRow((row,index)=>{row.height=index===1?30:36;row.eachCell({includeEmpty:true},cell=>{cell.border={bottom:{style:"hair",color:{argb:"FFD8DEE5"}}};if(index===1){cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF171E21"}};cell.font={name:"Calibri",size:11,bold:true,color:{argb:"FFFFFFFF"}};}else cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:index%2===0?"FFFFFFFF":"FFF5F6F4"}};});});
    current.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,current.rowCount),column:current.columnCount}};
  }
  return workbook;
}
