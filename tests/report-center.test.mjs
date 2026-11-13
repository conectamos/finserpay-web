import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import test from 'node:test';import ts from 'typescript';import {createRequire} from 'node:module';import {createJiti} from 'jiti';
const root=process.cwd(),require=createRequire(import.meta.url),jiti=createJiti(import.meta.url,{alias:{'@':root}});const{buildCreditPaymentPlan}=await jiti.import('../lib/credit-payment-plan.ts');
class FixedDate extends Date{constructor(...args){super(...(args.length?args:["2026-10-07T15:00:00Z"]));}static now(){return new Date("2026-10-07T15:00:00Z").getTime();}}
const source=ts.transpileModule(fs.readFileSync(path.join(root,'app/dashboard/reportes/page.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
async function render(role='central',params={},fixture={}){const calls={};const sedes=role==='supervisor'?[{id:10,nombre:'Sede autorizada'}]:[{id:10,nombre:'Sede autorizada'},{id:20,nombre:'Otra sede'}];const credits=fixture.credits??[{id:1,estado:'ACTIVO',montoCredito:3376686561.810005,valorCuota:3376686561.810005,plazoMeses:1,frecuenciaPago:'MENSUAL',fechaPrimerPago:new Date('2026-12-01T05:00:00Z'),fechaProximoPago:null,planCapitalVigente:null,pazYSalvoEmitidoAt:null},{id:2,estado:'ANULADO',montoCredito:100,valorCuota:100,plazoMeses:1}];const db={sede:{findMany:async q=>(calls.sedes=q,sedes)},credito:{findMany:async q=>(calls.credits=q,credits)},creditoAbono:{groupBy:async q=>(calls.paid=q,[]),aggregate:async q=>(calls.collected=q,{_sum:{valor:107195414.83999997}})}};const mod={exports:{}};const mocks={'@/lib/prisma':{default:db},'@/lib/dashboard-access':{requireAdminOrSupervisorDashboardAccess:async()=>({admin:role!=='supervisor',session:{nombre:'Usuario conectado',rolNombre:role==='supervisor'?'Supervisor':'Administrador',aliadoAccesoCodigo:role==='central'?'FINSERPAY':'ALIADO',aliadoAccesoId:5,sedeId:10}})},'@/lib/aliados':{isFinserPayCentralAlly:code=>code==='FINSERPAY'},'@/lib/credit-payment-plan':{buildCreditPaymentPlan},'@/app/dashboard/_components/finser-navigation':{default:'Navigation'},'./report-center':{default:'Center'},'./report-center.module.css':{default:{}}};vm.runInNewContext(source,{exports:mod.exports,module:mod,require:name=>mocks[name]||require(name),Intl,URLSearchParams,Date:FixedDate,Map});const tree=await mod.exports.default({searchParams:Promise.resolve(params)});return{calls,tree,props:tree.props.children[1].props.children.props,nav:tree.props.children[0].props};}
test('importes completos sin decimales y enlaces del período, sin alterar el plan de pagos',async()=>{const{props,calls,nav}=await render('central',{sedeId:'20',period:'previous-month'});assert.equal(props.reports.length,7);assert.equal(props.metrics.activeCredits,'1');assert.equal(props.metrics.collected.replace(/\s/g,''),'$107.195.415');assert.equal(props.metrics.portfolioBalance.replace(/\s/g,''),'$3.376.686.562');assert.equal(props.metrics.mora,'0%');assert.equal(nav.nombreUsuario,'Usuario conectado');assert.deepEqual(JSON.parse(JSON.stringify(calls.credits.where.sedeId)),{in:[20]});assert.equal(calls.credits.where.fechaCreacion,undefined);assert.ok(calls.collected.where.fechaAbono.gte);for(const r of props.reports){if(['credits','payments'].includes(r.kind)){assert.match(r.href,/from=/);assert.match(r.href,/to=/);assert.match(r.href,/sedeId=20/);}else assert.ok(!r.href.includes('?'));}});
test('permisos y sede no autorizada mantienen el alcance',async()=>{const ally=await render('ally',{sedeId:'999'});assert.equal(ally.props.reports.length,5);assert.equal(ally.calls.sedes.where.aliadoId,5);assert.equal(ally.props.selectedSedeId,'');assert.deepEqual(JSON.parse(JSON.stringify(ally.calls.credits.where.sedeId)),{in:[10,20]});const supervisor=await render('supervisor');assert.equal(supervisor.props.reports.length,2);assert.equal(supervisor.calls.sedes.where.id,10);assert.deepEqual(JSON.parse(JSON.stringify(supervisor.calls.credits.where.sedeId)),{in:[10]});});
test('todo el historial no impone fechas ni filtros de plataforma inexistentes',async()=>{const{props,calls}=await render('central',{period:'all'});assert.equal(calls.collected.where.fechaAbono,undefined);assert.ok(props.reports.every(r=>!r.href.includes('?')));});
if(process.env.REPORT_CENTER_QA_OUTPUT){fs.writeFileSync(process.env.REPORT_CENTER_QA_OUTPUT,JSON.stringify((await render()).props));}

test('recaudo por corte aparece únicamente al administrador central', async () => {
  const { props } = await render('central');
  const report = props.reports.find(item => item.kind === 'cut-collection');
  assert.ok(report);
  assert.equal(report.title, 'Recaudo por corte');
  assert.equal(report.href, '/dashboard/reportes/recaudo-por-corte');
  assert.deepEqual(Array.from(report.formats), ['Excel']);
  for (const role of ['ally', 'supervisor']) {
    const { props } = await render(role);
    assert.equal(props.reports.some(item => item.kind === 'cut-collection'), false, `El perfil ${role} no recibe la tarjeta`);
    assert.equal(props.reports.some(item => item.href === '/dashboard/reportes/recaudo-por-corte'), false);
  }
});

const financialFixture = {
  credits: [
    { id: 11, estado: 'ACTIVO', montoCredito: 123456.78, valorCuota: 123456.78, plazoMeses: 1,
      frecuenciaPago: 'MENSUAL', fechaPrimerPago: new Date('2026-09-01T05:00:00Z'),
      fechaProximoPago: null, planCapitalVigente: null, pazYSalvoEmitidoAt: null },
    { id: 12, estado: 'ACTIVO', montoCredito: 876543.21, valorCuota: 876543.21, plazoMeses: 1,
      frecuenciaPago: 'MENSUAL', fechaPrimerPago: new Date('2026-12-01T05:00:00Z'),
      fechaProximoPago: null, planCapitalVigente: null, pazYSalvoEmitidoAt: null },
  ],
};

function assertNoFinancialPayload(tree, forbiddenValues) {
  const seen = new WeakSet();
  function visit(value) {
    if (typeof value === 'string') {
      for (const forbidden of forbiddenValues) {
        assert.equal(value.includes(forbidden), false, `Un valor financiero no debe viajar en texto o metadatos: ${forbidden}`);
      }
      if (/^\s*[\[{]/.test(value)) {
        let parsed;
        try { parsed = JSON.parse(value); } catch { return; }
        visit(parsed);
      }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['portfolioBalance', 'mora'].includes(key), `Campo reservado presente en props anidadas: ${key}`);
      visit(child);
    }
  }
  visit(tree);
  const serialized = JSON.stringify(tree);
  assert.doesNotMatch(serialized, /"(?:portfolioBalance|mora)"\s*:/);
  for (const forbidden of forbiddenValues) assert.equal(serialized.includes(forbidden), false);
}

test('central conserva las cuatro métricas y la mora real sin sustituir valores', async () => {
  const { props, nav } = await render('central', {}, financialFixture);
  assert.equal(props.adminCentral, true);
  assert.equal(nav.adminCentral, true);
  assert.deepEqual(Object.keys(props.metrics).sort(), ['activeCredits', 'collected', 'mora', 'portfolioBalance']);
  assert.equal(props.metrics.activeCredits, '2');
  assert.equal(props.metrics.collected.replace(/\s/g, ''), '$107.195.415');
  assert.equal(props.metrics.portfolioBalance.replace(/\s/g, ''), '$1.000.000');
  assert.equal(props.metrics.mora, '12,3%');
});

for (const role of ['ally', 'supervisor']) {
  test(`${role} recibe sólo créditos activos y recaudo del período, sin saldo ni mora en props o JSON`, async () => {
    const central = await render('central', {}, financialFixture);
    const result = await render(role, {}, financialFixture);
    assert.equal(result.props.adminCentral, false);
    assert.equal(result.nav.adminCentral, false);
    assert.deepEqual(Object.keys(result.props.metrics).sort(), ['activeCredits', 'collected']);
    assert.equal(Object.hasOwn(result.props.metrics, 'portfolioBalance'), false, 'El saldo debe omitirse, no reemplazarse por cero');
    assert.equal(Object.hasOwn(result.props.metrics, 'mora'), false, 'La mora debe omitirse, no reemplazarse por cero');
    assert.equal(result.props.metrics.activeCredits, central.props.metrics.activeCredits);
    assert.equal(result.props.metrics.collected, central.props.metrics.collected);
    assertNoFinancialPayload(result.tree, [central.props.metrics.portfolioBalance, central.props.metrics.mora, '999999.99', '123456.78']);
  });
}

test('rol, central, aliado y sede falsificados en URL no amplían métricas ni alcance', async () => {
  const central = await render('central', {}, financialFixture);
  for (const role of ['ally', 'supervisor']) {
    const result = await render(role, {
      role: 'ADMIN', rolNombre: 'ADMIN', admin: 'true', central: 'true', adminCentral: 'true',
      aliadoAccesoCodigo: 'FINSERPAY', codigo: 'FINSERPAY', aliadoId: '999', sedeId: '999',
      period: 'previous-month', q: 'referencia de prueba',
    }, financialFixture);
    const allowedSedes = role === 'ally' ? [10, 20] : [10];
    assert.equal(result.props.adminCentral, false);
    assert.equal(result.props.admin, role === 'ally');
    assert.deepEqual(Object.keys(result.props.metrics).sort(), ['activeCredits', 'collected']);
    assertNoFinancialPayload(result.tree, [central.props.metrics.portfolioBalance, central.props.metrics.mora]);
    assert.equal(result.props.selectedSedeId, '');
    assert.equal(result.props.period, 'previous-month');
    assert.equal(result.props.initialQuery, 'referencia de prueba');
    assert.deepEqual(JSON.parse(JSON.stringify(result.calls.sedes.where)), role === 'ally' ? { aliadoId: 5 } : { id: 10 });
    for (const where of [result.calls.credits.where, result.calls.paid.where.credito, result.calls.collected.where]) {
      assert.deepEqual(Array.from(where.sedeId.in), allowedSedes);
    }
    for (const report of result.props.reports.filter(item => ['credits', 'payments'].includes(item.kind))) {
      const link = new URL(report.href, 'https://finserpay.test');
      assert.ok(link.searchParams.has('from'));
      assert.ok(link.searchParams.has('to'));
      assert.equal(link.searchParams.has('sedeId'), false);
      assert.equal(link.searchParams.has('aliadoId'), false);
      assert.equal(link.searchParams.has('adminCentral'), false);
    }
  }
});

test('los filtros de sede y período autorizados se conservan al omitir los indicadores financieros', async () => {
  for (const [role, sedeId] of [['ally', 20], ['supervisor', 10]]) {
    const result = await render(role, { sedeId: String(sedeId), period: 'previous-month', q: 'créditos' }, financialFixture);
    assert.equal(result.props.selectedSedeId, String(sedeId));
    assert.equal(result.props.period, 'previous-month');
    assert.equal(result.props.initialQuery, 'créditos');
    assert.equal(result.props.metrics.activeCredits, '2');
    assert.equal(result.props.metrics.collected.replace(/\s/g, ''), '$107.195.415');
    assert.deepEqual(Object.keys(result.props.metrics).sort(), ['activeCredits', 'collected']);
    for (const where of [result.calls.credits.where, result.calls.paid.where.credito, result.calls.collected.where]) {
      assert.deepEqual(Array.from(where.sedeId.in), [sedeId]);
    }
    for (const report of result.props.reports.filter(item => ['credits', 'payments'].includes(item.kind))) {
      const link = new URL(report.href, 'https://finserpay.test');
      assert.equal(link.searchParams.get('sedeId'), String(sedeId));
      assert.equal(link.searchParams.get('from'), '2026-09-01');
      assert.equal(link.searchParams.get('to'), '2026-09-30');
    }
  }
});
