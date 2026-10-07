import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const exports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/credit-report-identifiers.ts', import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
test('Sadmin pendiente conserva un folio contractual con ceros sin utilizarlo como crédito externo',()=>{
  const credit={folio:'00000000217',numeroSadmin:null,numeroCreditoVisible:'00000000217'};
  assert.equal(exports.creditReportSadmin(credit),null);
  assert.equal(credit.folio,'00000000217');
});
test('Sadmin confirmado permanece como texto incluso si coincide con el folio o supera la precisión numérica',()=>{
  assert.equal(exports.creditReportSadmin({folio:'00000300085',numeroSadmin:'00000300085'}),'00000300085');
  assert.equal(exports.creditReportSadmin({folio:'interno',numeroSadmin:'000099999999999999999999'}),'000099999999999999999999');
});
test('la cédula pierde separadores sin perder ceros iniciales',()=>{
  assert.equal(exports.creditReportDocument('00.123.456 789'),'00123456789');
});
