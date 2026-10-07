import assert from "node:assert/strict";
import test from "node:test";
import { harness, load, nodes, ui } from "./cartera-ui-harness.mjs";
const risk=load("../lib/product-risk.ts");
const credit=(id, changes={})=>({id,folio:`FC-${id}`,numeroCreditoVisible:`01000${id}`,cliente:'Cliente',marca:'Apple',referencia:'iPhone 13',tipo:'IPHONE',aliado:'Propio',sede:'Centro',fecha:'2026-10-01',capital:1234567,saldo:765432,vencido:123456,activo:true,dias:10,gestion:'Gestión',...changes});
const raw=[credit(1),credit(2,{activo:false,saldo:0,dias:0}),credit(3,{marca:'Samsung',referencia:'A55',tipo:'ANDROID',dias:0})];
const flow=(props={})=>harness('../app/dashboard/riesgo-referencia/risk-console.tsx',{credits:risk.projectProductRiskCredits(raw),cutoff:'2026-10-06',scopeLabel:'Propio',...props},{'@/lib/product-risk':risk});
const columns=tree=>nodes(tree,n=>n.type === 'th');
test('referencias: una tabla, paneles por plataforma y columnas aliadas exactas sin importes',()=>{
 const f=flow({credits:raw});const html=f.render();assert.match(html,/Mora por modelo/);assert.match(html,/Todas las referencias/);assert.match(html,/33,33%/);assert.equal(columns(f.tree()).length,5);assert.doesNotMatch(html,/1\.234\.567|765\.432|123\.456|\$|Capital colocado|Saldo vencido/);
 const open=nodes(f.tree(),n=>n.type === 'button' && n.props['aria-label']==='Ver créditos de IPHONE 13 128GB')[0];open.props.onClick();const detail=f.render();assert.match(detail,/010001/);assert.match(detail,/010002/);assert.doesNotMatch(detail,/\$|Valor financiado|Saldo vencido/);
});
test('central conserva saldo vencido y datos financieros solo en el detalle',()=>{const f=flow({adminCentral:true,credits:raw});const html=f.render();assert.equal(columns(f.tree()).length,6);assert.match(html,/Saldo vencido/);assert.match(html,/246\.912/);});
test('filtros de estados y pestañas funcionan con DTO sin dinero y denominador ponderado',()=>{
 const f=flow();f.render();f.click('Filtros');f.filter('Estado de cartera','pagado');assert.match(f.render(),/0,00%/);assert.doesNotMatch(f.render(),/<td>A55<\/td>/);f.filter('Estado de cartera','mora');assert.match(f.render(),/100,00%/);f.click('Limpiar filtros');const android=f.click('Android');assert.match(android,/A55/);assert.doesNotMatch(android,/IPHONE 13 128GB<\/td>/);f.click('Todas las referencias');assert.match(f.search('iphone'),/50,00%/);
});
test('paginación, ordenamiento y filtros inválidos no alteran totales de unidades',()=>{
 const f=flow({credits:Array.from({length:10},(_,i)=>credit(i+1,{referencia:`Modelo ${i}`,dias:0}))});f.render();assert.equal(nodes(f.tree(),n=>n.type==='tr').length,8);const next=nodes(f.tree(),n=>n.type===ui.Button&&n.props['aria-label']==='Página siguiente')[0];next.props.onClick();assert.match(f.render(),/8–10 de 10/);assert.equal(nodes(f.tree(),n=>n.type==='tr').length,4);f.click('Referencia');f.click('Filtros');f.filter('Venta desde','2026-10-05');assert.match(f.filter('Venta hasta','2026-10-01'),/role="alert"/);
});
test('cartera vacía no inventa tasas ni referencias',()=>{const html=flow({credits:[]}).render();assert.match(html,/0,00%/);assert.match(html,/Sin créditos/);assert.doesNotMatch(html,/NaN|Infinity/);});
