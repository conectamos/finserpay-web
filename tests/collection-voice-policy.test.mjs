import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url);
const p=await jiti.import('../lib/collection-voice-policy.ts');

test('todos los estados sin acuerdo son elegibles si el crédito sigue en mora',()=>{
  const now=new Date('2026-10-16T15:00:00Z');
  assert.equal(p.collectionPortfolioEligibility(true,[],now,true).suspended,false);
  for(const managementStatus of ['SIN_RESPUESTA','SEGUIMIENTO','PENDIENTE','CONTACTADO','CERRADO','SOLUCIONADO']) {
    const event={id:'ordinary',managementStatus,resultCode:'SIN_RESPUESTA',nextFollowUpAt:'2026-10-17T15:00:00Z'};
    assert.equal(p.collectionPortfolioEligibility(true,[event],now,true).suspended,false,managementStatus);
    assert.equal(p.collectionPortfolioEligibility(false,[event],now,true).suspended,true,managementStatus);
  }
});

test('un acuerdo en Seguimiento queda protegido antes de su fecha y habilita seguimiento al vencer',()=>{
  const agreement={id:'promise',managementStatus:'SEGUIMIENTO',resultCode:'ACUERDO_PAGO',agreementDate:'2026-10-16',nextFollowUpAt:'2026-10-16T15:00:00Z'};
  assert.equal(p.collectionPortfolioEligibility(true,[agreement],new Date('2026-10-15T22:00:00Z'),true).suspended,true);
  assert.equal(p.collectionPortfolioEligibility(true,[agreement],new Date('2026-10-16T14:59:00Z'),true).suspended,true);
  const due=p.collectionPortfolioEligibility(true,[agreement],new Date('2026-10-16T15:00:00Z'),true);
  assert.equal(due.suspended,false);assert.equal(due.followupFor,'promise');
  assert.equal(p.collectionPortfolioEligibility(true,[agreement],new Date('2026-10-16T15:00:00Z'),false).suspended,true);
  const newer={id:'newer',managementStatus:'SIN_RESPUESTA',resultCode:'SIN_RESPUESTA',nextFollowUpAt:'2026-10-16T15:00:00Z'};
  assert.equal(p.collectionPortfolioEligibility(true,[newer,agreement],new Date('2026-10-15T22:00:00Z'),true).suspended,true);
  assert.equal(p.collectionPortfolioEligibility(true,[newer,agreement],new Date('2026-10-16T15:00:00Z'),true).followupFor,'promise');
  const completed=p.collectionPortfolioEligibility(true,[newer,agreement],new Date('2026-10-17T15:00:00Z'),true,true);
  assert.equal(completed.suspended,false);assert.equal(completed.followupFor,null);
  assert.equal(p.collectionPortfolioEligibility(true,[agreement],new Date('2026-10-15T15:00:00Z'),true,true).suspended,true);
});

test('pagos informados, créditos al día y acuerdos incompletos no se cobran',()=>{
  const now=new Date('2026-10-16T15:00:00Z');
  const paid={id:'paid',managementStatus:'SEGUIMIENTO',resultCode:'PAGO_REALIZADO',nextFollowUpAt:'2026-10-16T15:00:00Z'};
  assert.equal(p.collectionPortfolioEligibility(true,[paid],now,true).suspended,true);
  assert.equal(p.collectionPortfolioEligibility(false,[],now,true).suspended,true);
  for(const agreementDate of [null,'2026-02-30','2026-10-17']) {
    const event={id:'promise',managementStatus:'ACUERDO_PAGO',agreementDate,nextFollowUpAt:'2026-10-16T15:00:00Z'};
    assert.equal(p.collectionPortfolioEligibility(true,[event],now,true).suspended,true);
  }
});
test('horarios colombianos, sábado, domingo y festivos',()=>{
  for(const iso of ['2026-10-09T11:59:59Z','2026-10-09T24:00:00Z','2026-10-10T12:59:59Z','2026-10-10T20:00:00Z','2026-10-11T15:00:00Z','2026-10-12T15:00:00Z'])assert.equal(p.collectionCallingAllowed(new Date(iso)),false,iso);
  for(const iso of ['2026-10-09T12:00:00Z','2026-10-10T13:00:00Z','2026-10-10T19:59:59Z'])assert.equal(p.collectionCallingAllowed(new Date(iso)),true,iso);
});
test('tres ventanas y ejecución inmediata únicamente en horario hábil',()=>{
  assert.equal(p.collectionSlot(new Date('2026-10-09T19:04:00Z')),'2026-10-09T14');
  assert.equal(p.collectionSlot(new Date('2026-10-09T19:11:00Z')),null);
  assert.equal(p.collectionSlot(new Date('2026-10-09T19:11:00Z'),true),'2026-10-09Tmanual');
  assert.equal(p.collectionSlot(new Date('2026-10-10T22:00:00Z'),true),null);
});
test('festivos fijos, Emiliani y Semana Santa',()=>{
  const dates=p.colombiaHolidays(2026);
  for(const day of ['2026-01-01','2026-01-12','2026-04-02','2026-04-03','2026-05-18','2026-06-08','2026-06-15','2026-10-12','2026-11-02','2026-11-16','2026-12-25']) assert.equal(dates.has(day),true,day);
});
test('seguimiento posterior y nunca en domingo o festivo',()=>{
  assert.equal(p.nextCollectionDate(new Date('2026-10-10T19:00:00Z')),'2026-10-13T15:00:00.000Z');
  assert.throws(()=>p.nextCollectionDate(new Date('2026-10-09T15:00:00Z'),'2026-02-30'));
});
test('el vínculo de sesión firmado no admite cambios ni otro secreto',()=>{
  const id='00000000-0000-4000-8000-000000000081',secret='synthetic-collection-test-secret-000000';
  const token=p.collectionSessionToken(id,secret);
  assert.equal(p.verifyCollectionSessionToken(token,secret),id);
  assert.equal(p.verifyCollectionSessionToken(token+'x',secret),null);
  assert.equal(p.verifyCollectionSessionToken(token,secret+'other'),null);
});
