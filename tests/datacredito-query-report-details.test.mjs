import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createJiti } from 'jiti';
import { aggregateQueryDetails } from '../lib/datacredito/query-report-details.ts';
import { parseDataCreditoQuerySalesReportInput } from '../lib/datacredito/admin-query-sales-report-core.ts';

const base = { allyId:2,siteId:10,siteName:'Sede A',sellerKey:'seller:1',sellerName:'Nombre igual',originalQueries:2,approved:1,rejected:1,notEvaluated:0,reusedAssessments:1 };
test('agrupa por ID entre sedes, conserva nombres iguales distintos y todos los empates',()=>{
  const r=aggregateQueryDetails([base,{...base,siteId:11,siteName:'Sede B'},{...base,sellerKey:'seller:2',originalQueries:4,approved:3,reusedAssessments:0}], [{allyId:2,allyName:'JG COMPANY'},{allyId:3,allyName:'Sin actividad'}]);
  assert.equal(r.counts.get(2).originalQueries,8);
  assert.equal(r.sellers.length,2);
  assert.deepEqual(r.sellers.map(s=>s.originalQueries),[4,4]);
  assert.equal(r.leaders[0].sellers.length,2);
  assert.equal(r.leaders[1].sites.length,0);
  assert.equal(r.sites[0].originalQueries,6);
});
test('excluye otros aliados y filas centrales y no hace líderes con reutilizadas solamente',()=>{
  const r=aggregateQueryDetails([base,{...base,allyId:1},{...base,originalQueries:0,approved:0,rejected:0,sellerKey:'user:3'}],[{allyId:2,allyName:'JG'}]);
  assert.equal(r.counts.size,1);assert.equal(r.leaders[0].sellers.length,1);assert.equal(r.counts.get(2).reusedAssessments,2);
  assert.throws(()=>aggregateQueryDetails([{...base,approved:9}],[{allyId:2,allyName:'JG'}]),/RECONCILE/);
});
test('PostgreSQL cuenta resultados originales con fechas Bogotá, ambiente, retención y filtro de aliado',async()=>{
  const source=readFileSync(new URL('../lib/datacredito/admin-query-sales-report.ts',import.meta.url),'utf8');
  const sql=source.match(/export const QUERY_METRICS_SQL = `([\s\S]*?)`;/)[1];
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE "Sede" (id int, nombre text);CREATE TABLE "Vendedor" (id int,nombre text);CREATE TABLE "Usuario" (id int,nombre text);
      INSERT INTO "Sede" VALUES(10,'Sede A');INSERT INTO "Vendedor" VALUES(1,'Vendedor');INSERT INTO "Usuario" VALUES(5,'Usuario');
      CREATE TABLE "DataCreditoAssessment" ("aliadoId" int,"sedeId" int,"sellerId" int,"userId" int,"status" text,"durationMs" int,"transactionCode" text,"providerStatus" text,"errorCode" text,"reusedFromAssessmentId" text,"createdAt" timestamp,"providerEnvironment" text,"retainedUntil" timestamp);`);
    const insert=async(status,opts={})=>db.query('INSERT INTO "DataCreditoAssessment" VALUES($1,10,1,5,$2,$3,NULL,NULL,NULL,$4,$5,$6,$7)',[opts.allyId??2,status,opts.duration??null,opts.reuse??null,opts.date??'2026-10-02 10:00:00',opts.env??'production',opts.retained??'2099-01-01']);
    await insert('APROBADO');await insert('RECHAZADO');await insert('ERROR',{duration:400});
    await insert('ERROR');await insert('PENDING',{duration:200});await insert('APROBADO',{reuse:'original'});
    await insert('APROBADO',{date:'2026-10-01 05:00:00'});await insert('APROBADO',{date:'2026-10-01 04:59:59'});
    await insert('APROBADO',{date:'2026-10-09 05:00:00'});await insert('APROBADO',{env:'sandbox'});
    await insert('APROBADO',{retained:'2000-01-01'});await insert('APROBADO',{allyId:3});
    const parsed=parseDataCreditoQuerySalesReportInput({mode:'range',from:'2026-10-01',to:'2026-10-08',allyId:2});
    const result=await db.query(sql,[parsed.start.toISOString(),parsed.endExclusive.toISOString(),'production',2]);
    assert.equal(result.rows.length,1);const r=result.rows[0];
    assert.deepEqual(['originalQueries','approved','rejected','notEvaluated','reusedAssessments'].map(k=>Number(r[k])),[4,2,1,1,1]);
  }finally{await db.close();}
});

const jiti=createJiti(import.meta.url,{fsCache:false});
const { buildQueryReportExcel,buildQueryReportPdf,queryReportTables }=await jiti.import('../lib/datacredito/query-report-export.ts');
const makeReport=()=>{
  const d=aggregateQueryDetails([base],[{allyId:2,allyName:'JG COMPANY'}]);
  return {filters:{mode:'range',allyId:2,from:'2026-10-01',to:'2026-10-08'},period:{timezone:'America/Bogota',label:'01/10/2026 - 08/10/2026',start:'2026-10-01T05:00:00.000Z',endExclusive:'2026-10-09T05:00:00.000Z'},generatedAt:'2026-10-09T16:00:00.000Z',retentionDays:90,providerEnvironment:'production',rows:[{allyId:2,allyName:'JG COMPANY',...d.counts.get(2),sales:1,salesVsOriginalQueriesPercent:50}],summary:{...d.counts.get(2),sales:1,salesVsOriginalQueriesPercent:50},sites:d.sites,sellers:d.sellers,leaders:d.leaders};
};
test('Excel contiene ventas numéricas, resultados, rankings y filtros sin fórmulas inyectadas',async()=>{
  const report=makeReport();report.sellers[0].name='=HYPERLINK("https://example.com")';
  const buffer=await buildQueryReportExcel(report);
  const {default:ExcelJS}=await import('exceljs');const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
  assert.equal(wb.worksheets.length,5);assert.equal(wb.worksheets[0].getCell('G6').value,1);
  assert.equal(wb.worksheets[0].getCell('H6').value,0.5);
  assert.equal(wb.getWorksheet('Detalle vendedores').getCell('B6').value,report.sellers[0].name);
  assert.equal(wb.getWorksheet('Detalle vendedores').getCell('B6').type,3);
  assert.equal(queryReportTables(report)[0].rows[0][1],2);
});
test('PDF multipágina con nombres largos y tablas vacías genera archivo válido',async()=>{
  const report=makeReport();report.sellers=Array.from({length:55},(_,i)=>({...report.sellers[0],key:`seller:${i}`,name:'Nombre de vendedor largo para verificar el salto de página y el ajuste de líneas '+i}));
  const pdf=await buildQueryReportPdf(report);assert.equal(pdf.subarray(0,4).toString(),'%PDF');assert.ok(pdf.length>5000);
  const pageCount=[...pdf.toString('latin1').matchAll(/\/Type \/Page\b/g)].length;
  assert.ok(pageCount>=5 && pageCount<20, 'La paginación no debe añadir páginas de pie de página vacías');
  if(process.env.REPORT_QA_DIR){mkdirSync(process.env.REPORT_QA_DIR,{recursive:true});writeFileSync(process.env.REPORT_QA_DIR+'/report-pagination.pdf',pdf);writeFileSync(process.env.REPORT_QA_DIR+'/report.xlsx',await buildQueryReportExcel(makeReport()));}
  const empty=makeReport();empty.rows=[];empty.sites=[];empty.sellers=[];empty.leaders=[];
  assert.ok((await buildQueryReportPdf(empty)).length>1000);
});

test('PDF conserva todos los líderes empatados y pagina nombres largos',async()=>{
  const report=makeReport();
  report.leaders[0].sellers=Array.from({length:24},(_,i)=>({...report.sellers[0],key:`tie:${i}`,name:`Líder empatado ${i} con un nombre extenso para comprobar la continuación completa de los resultados`}));
  const pdf=await buildQueryReportPdf(report);
  assert.ok(pdf.length>8000);
  assert.ok([...pdf.toString('latin1').matchAll(/\/Type \/Page\b/g)].length>3);
});
