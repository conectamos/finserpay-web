import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { harness, nodes } from "./cartera-ui-harness.mjs";
const group=(key,name,share,extra={})=>({key,name,context:'Comercio',unassigned:false,activeCredits:10,overdueCredits:2,overdueSharePercent:share,overduePortfolioPercent:share*.06,...extra});
const detail={activeCredits:100,overdueCredits:20,overduePortfolioPercent:6,sites:[group('sede:1','Centro',75),group('sede:2','Norte',25)],sellers:[group('vendedor:1','Ana',70),group('vendedor:2','Juan',30)],leadingSiteKeys:['sede:1'],leadingSellerKeys:['vendedor:1']};
const flow=(props={})=>harness('../app/dashboard/cartera/detalle-mora/delinquency-workspace.tsx',{detail,canViewBalances:false,scopeLabel:'Propio',updatedAt:'2026-10-06T19:12:00.000Z',exportHref:'/api/dashboard/cartera/detalle-mora/export?aliadoId=7',creditLinks:{'sede:1':'/detalle?grupo=sede1','seller:vendedor:1':'/detalle?grupo=ana'},...props});
test('una sola tabla con pestañas, resumen preciso y concentración de sede/vendedor',()=>{const f=flow();const html=f.render();assert.equal(nodes(f.tree(),n=>n.type==='table').length,1);assert.equal(nodes(f.tree(),n=>n.type==='th').length,5);assert.match(html,/6,00%/);assert.match(html,/75,00%/);assert.match(html,/4,50 pp/);assert.match(html,/Mayor concentración por vendedor/);assert.match(html,/Ana/);assert.match(html,/href="\/detalle\?grupo=sede1"/);assert.match(f.click('Por vendedor'),/href="\/detalle\?grupo=ana"/);});
test('aliado no renderiza saldos aunque reciba accidentalmente importes',()=>{const html=flow({detail:{...detail,overdueBalance:987654321,sites:[group('sede:1','Centro',100,{overdueBalance:123456789})]}}).render();assert.doesNotMatch(html,/987|123\.456|\$|<th[^>]*>Saldo/);});
test('central mantiene saldos y exportación autorizada; la actualización usa Bogotá',()=>{const f=flow({canViewBalances:true,detail:{...detail,overdueBalance:60000,sites:[group('sede:1','Centro',100,{overdueBalance:60000})]}});const html=f.render();assert.equal(nodes(f.tree(),n=>n.type==='th').length,6);assert.match(html,/Saldo pendiente en mora/);assert.match(html,/60\.000/);assert.match(html,/href="\/api\/dashboard\/cartera\/detalle-mora\/export\?aliadoId=7"/);assert.match(html,/2:12/);assert.doesNotMatch(html,/type="month"/);});
test('buscador, filtros desplegables y ordenamiento conservan el resumen del comercio',()=>{const f=flow();f.render();assert.match(f.search('Norte'),/Norte/);assert.doesNotMatch(f.render(),/<strong>Centro<\/strong><small/);f.search('');f.click('Filtros');assert.match(f.filter('Sede','sede:2'),/25,00%/);assert.match(f.render(),/6,00%/);f.click('Limpiar filtros');f.click('Aporte a cartera');assert.match(f.render(),/aria-sort="ascending"/);});
test('grupos sin mora y cartera vacía no producen NaN ni líderes ficticios',()=>{const html=flow({detail:{...detail,overdueCredits:0,overduePortfolioPercent:0,sites:[],sellers:[],leadingSiteKeys:[],leadingSellerKeys:[]}}).render();assert.match(html,/Sin créditos en mora/);assert.match(html,/Sin grupos/);assert.doesNotMatch(html,/NaN|Infinity/);});

test('central muestra el selector por aliado sin abrir Filtros y no lo duplica',()=>{
 const filters=createElement('form',{action:'/dashboard/cartera/detalle-mora',method:'get'},createElement('select',{name:'aliadoId',defaultValue:'7'},createElement('option',{value:'7'},'Comercio elegido')));
 const f=flow({canViewBalances:true,filters});
 assert.match(f.render(),/Filtrar por aliado/);
 assert.equal(nodes(f.tree(),n=>n.type==='select'&&n.props.name==='aliadoId').length,1);
 f.click('Filtros');assert.equal(nodes(f.tree(),n=>n.type==='select'&&n.props.name==='aliadoId').length,1);
 const ally=flow({filters});assert.doesNotMatch(ally.render(),/Filtrar por aliado|Comercio elegido/);
});
