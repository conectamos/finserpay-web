import PDFDocument from "pdfkit";
import path from "node:path";
import type { DetailedQueryReport } from "./query-report-export";
import type { QueryRankingRow } from "./query-report-details";

const graphite="#191e21", lime="#a5db2d", muted="#69727c", border="#d3d9df", soft="#f3f5f5";
const count=(n:number)=>n.toLocaleString("es-CO");
const pct=(n:number|null)=>n===null?"—":`${n.toLocaleString("es-CO",{minimumFractionDigits:1,maximumFractionDigits:1})} %`;
export async function buildQueryReportPdf(report:DetailedQueryReport) {
  const doc=new PDFDocument({size:"A4",layout:"landscape",margin:34,bufferPages:true,info:{Title:"Consultas DataCrédito y ventas | FINSER PAY"}});
  doc.registerFont("Regular",path.join(process.cwd(),"public/assets/dashboard/roboto-400.ttf"));
  doc.registerFont("Bold",path.join(process.cwd(),"public/assets/dashboard/roboto-700.ttf"));
  const chunks:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{doc.on("data",chunk=>chunks.push(Buffer.from(chunk)));doc.on("end",()=>resolve(Buffer.concat(chunks)));doc.on("error",reject);});
  const w=doc.page.width-68;
  const scope=report.filters.allyId===null||report.filters.allyId===undefined?"Todos los aliados":report.rows[0]?.allyName??"Aliado seleccionado";
  const text=(value:string,x:number,y:number,size=10,bold=false,color=graphite,width=w,align:"left"|"right"="left")=>{doc.font(bold?"Bold":"Regular").fontSize(size).fillColor(color).text(value,x,y,{width,align,lineGap:1});};
  const height=(value:string,width:number,size=10,bold=false)=>doc.font(bold?"Bold":"Regular").fontSize(size).heightOfString(value,{width,lineGap:1});
  const header=(title:string,subtitle:string)=>{
    doc.rect(0,0,doc.page.width,55).fill(graphite);
    text("FINSER",34,15,21,true,"white",90);text("PAY",116,15,21,true,lime,60);
    text(scope,doc.page.width-330,13,12,true,"white",296,"right");
    text(report.period.label,doc.page.width-330,32,8,false,"#cbd1d5",296,"right");
    text(title,34,70,24,true);text(subtitle,34,103,11,false,muted);
  };
  const next=(title:string,subtitle:string)=>{doc.addPage();header(title,subtitle);};
  header("Consultas DataCrédito y ventas","Resumen de resultados del aliado"+(report.rows.length>1?" · Todos los aliados":""));
  const s=report.summary;
  const gap=12,cw=(w-gap*2)/3;
  const cards=[{label:"CONSULTAS NUEVAS",value:count(s.originalQueries)},{label:"VENTAS FINALIZADAS",value:count(s.sales)},{label:"VENTAS / CONSULTAS",value:pct(s.salesVsOriginalQueriesPercent)}];
  cards.forEach((item,i)=>{const x=34+i*(cw+gap);doc.roundedRect(x,142,cw,104,9).fill(i===0?graphite:soft);text(item.label,x+19,160,9,true,i===0?lime:muted,cw-38);text(item.value,x+19,190,37,true,i===0?"white":graphite,cw-38);});
  const approval=s.originalQueries?100*s.approved/s.originalQueries:null;
  text("Resultado de las consultas nuevas",34,262,14,true);text(`${pct(approval)} de aprobación`,doc.page.width-290,262,14,true,"#477c16",256,"right");
  const values=[s.approved,s.rejected,s.notEvaluated],colors=[lime,"#d4787d","#c7cdd1"];
  let barX=34;
  if(s.originalQueries)values.forEach((n,i)=>{const segment=w*n/s.originalQueries;if(segment>0)doc.rect(barX,287,segment,9).fill(colors[i]);barX+=segment;});else doc.rect(34,287,w,9).fill(border);
  [ {n:s.approved,label:"Aprobadas",color:"#477c16"},{n:s.rejected,label:"Rechazadas",color:"#ad444a"},{n:s.notEvaluated,label:"No evaluadas",color:muted},{n:s.reusedAssessments,label:"Reutilizadas sin cobro",color:graphite}].forEach((item,i)=>{const x=34+i*w/4;text(count(item.n),x,310,26,true,item.color,w/4-10);text(item.label,x,343,10,false,muted,w/4-10);});
  doc.moveTo(34,374).lineTo(doc.page.width-34,374).strokeColor(border).stroke();
  text("Mayor actividad en consultas nuevas",34,388,14,true);
  let y=418;
  for(const leader of report.leaders){
    const items=[{label:"SEDE",rows:leader.sites},{label:"VENDEDOR / CONSULTÓ",rows:leader.sellers}];
    if(report.rows.length>1){if(y+28>510){next("Mayor actividad por aliado","Consultas nuevas · Incluye todos los empates");y=136;}text(leader.allyName,34,y,12,true);y+=24;}
    // Each winner is rendered in full; long tie lists continue onto additional pages.
    const lines=items.map(item=>item.rows.length?item.rows.map(r=>({name:r.name,detail:`${count(r.originalQueries)} consultas${s.originalQueries?` · ${pct(100*r.originalQueries/(report.rows.find(a=>a.allyId===leader.allyId)?.originalQueries||s.originalQueries))} del total`:""}`})):[{name:"Sin consultas nuevas",detail:""}]);
    const offsets=[0,0];
    while(offsets.some((n,i)=>n<lines[i].length)){
      if(y+65>510){next("Mayor actividad por aliado","Consultas nuevas · Incluye todos los empates");y=136;}
      const rowWidth=(w-16)/2;
      const selected=lines.map((list,i)=>{const result:{name:string;detail:string}[]=[];let h=30;while(offsets[i]<list.length){const value=list[offsets[i]],lh=height(value.name,rowWidth-42,18,true)+height(value.detail,rowWidth-42,9)+12;if(h+lh>510-y&&result.length)break;if(h+lh>510-y)break;result.push(value);offsets[i]++;h+=lh;}return{result,h};});
      if(selected.every(a=>!a.result.length)){
        if(y>136){next("Mayor actividad por aliado",`${leader.allyName} · Consultas nuevas · Incluye todos los empates`);y=136;continue;}
        throw new Error("REPORT_PDF_ROW_TOO_TALL");
      }
      const rh=Math.max(74,...selected.map(a=>a.h+10));
      selected.forEach((item,i)=>{const x=34+i*(rowWidth+16);doc.roundedRect(x,y,rowWidth,rh,8).fill(soft);doc.rect(x+15,y+18,3,rh-36).fill(lime);text(items[i].label,x+28,y+16,8,true,muted,rowWidth-42);let ly=y+35;for(const line of item.result){text(line.name,x+28,ly,18,true,graphite,rowWidth-42);ly+=height(line.name,rowWidth-42,18,true)+4;text(line.detail,x+28,ly,9,false,muted,rowWidth-42);ly+=height(line.detail,rowWidth-42,9)+8;}});
      y+=rh+14;
    }
  }
  if(!report.leaders.length)text("Sin actividad para los filtros consultados.",34,y,11,false,muted);
  function table(title:string,subtitle:string,headers:string[],rows:(string|number)[][],widths:number[],total?:(string|number)[]){
    next(title,subtitle);let ty=132;
    const tableHeader=()=>{doc.rect(34,ty,w,25).fill(graphite);let x=34;headers.forEach((label,i)=>{text(label,x+7,ty+7,8,true,"white",widths[i]-14,i>0?"right":"left");x+=widths[i];});ty+=25;};
    tableHeader();
    if(!rows.length){text("Sin actividad para los filtros consultados.",41,ty+18,11,false,muted);return;}
    const all=total?[...rows,total]:rows;
    for(const [idx,row] of all.entries()){
      const bold=Boolean(total)&&idx===all.length-1;
      const cells=row.map(value=>typeof value==="number"?count(value):value);
      const rh=Math.max(17,...cells.map((value,i)=>height(value,widths[i]-14,8,bold)+7));
      if(ty+rh>509){next(title+" (continuación)",subtitle);ty=132;tableHeader();}
      doc.rect(34,ty,w,rh).fill(bold?"#e7eddf":idx%2?soft:"white");
      let x=34;cells.forEach((value,i)=>{text(value,x+7,ty+4,8,bold,graphite,widths[i]-14,i>0?"right":"left");x+=widths[i];});
      ty+=rh;doc.moveTo(34,ty).lineTo(34+w,ty).strokeColor(border).lineWidth(.3).stroke();
    }
  }
  if(report.rows.length>1)table("Resultados por aliado","Resumen del período consultado",["Aliado","Nuevas","Aprobadas","Rechazadas","No evaluadas","Reutilizadas","Ventas","Ventas / consultas"],report.rows.map(r=>[r.allyName,r.originalQueries,r.approved,r.rejected,r.notEvaluated,r.reusedAssessments,r.sales,pct(r.salesVsOriginalQueriesPercent)]),[w-523,65,68,68,83,78,55,106],["TOTAL",s.originalQueries,s.approved,s.rejected,s.notEvaluated,s.reusedAssessments,s.sales,pct(s.salesVsOriginalQueriesPercent)]);
  for(const [title,details] of [["Consultas por sede",report.sites],["Consultas por vendedor",report.sellers]] as const){
    const groups=report.rows.length?report.rows.map(ally=>({ally,rows:details.filter(r=>r.allyId===ally.allyId)})):[{ally:null,rows:[] as QueryRankingRow[]}];
    for(const group of groups){const rows=group.rows;const totals=rows.reduce((a,r)=>({originalQueries:a.originalQueries+r.originalQueries,approved:a.approved+r.approved,rejected:a.rejected+r.rejected,notEvaluated:a.notEvaluated+r.notEvaluated,reusedAssessments:a.reusedAssessments+r.reusedAssessments}),{originalQueries:0,approved:0,rejected:0,notEvaluated:0,reusedAssessments:0});
      table(title,`${group.ally?.allyName??scope} · ${rows.length} ${title.endsWith("sede")?"sedes":"vendedores"} · Ordenados por consultas nuevas`,[title.endsWith("sede")?"Sede":"Vendedor / consultó","Nuevas","Aprobadas","Rechazadas","No evaluadas","Reutilizadas","% aprob."],rows.map(r=>[r.name,r.originalQueries,r.approved,r.rejected,r.notEvaluated,r.reusedAssessments,pct(r.originalQueries?100*r.approved/r.originalQueries:null)]),[w-465,65,75,75,90,85,75],["TOTAL",totals.originalQueries,totals.approved,totals.rejected,totals.notEvaluated,totals.reusedAssessments,pct(totals.originalQueries?100*totals.approved/totals.originalQueries:null)]);
    }
  }
  const pages=doc.bufferedPageRange();
  const cutoff=new Date(report.generatedAt).toLocaleString("es-CO",{timeZone:"America/Bogota"});
  for(let i=0;i<pages.count;i++){
    doc.switchToPage(i);doc.moveTo(34,524).lineTo(doc.page.width-34,524).strokeColor(border).lineWidth(.6).stroke();
    text("Reutilizadas: no son consultas nuevas. No evaluadas: sin decisión comercial; no son rechazos. Rankings: consultas nuevas, con todos los empates.",34,532,7,false,muted);
    text(`Ventas: créditos DataCrédito no anulados creados en el período. Ventas / consultas compara eventos, no cohortes; puede superar 100 %. Retención: ${report.retentionDays} días.`,34,543,7,false,muted);
    doc.font("Regular").fontSize(7).fillColor(muted).text(`${report.period.label} · America/Bogota · Corte: ${cutoff} · Fuente: FINSER PAY · ${report.providerEnvironment}`,34,566,{lineBreak:false});
    doc.font("Bold").fontSize(8).text(`${i+1} / ${pages.count}`,doc.page.width-63,566,{lineBreak:false});
  }
  doc.end();return done;
}
