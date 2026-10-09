import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url);
const p=await jiti.import('../lib/collection-voice-policy.ts');
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
