import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const folder = new URL('../docs/integrations/dapta-collections-voice/', import.meta.url);
const flow = name => JSON.parse(readFileSync(new URL(`${name}-flow.draft.json`, folder), 'utf8'));
const run = (name, id, params) => {
  const code = flow(name).api_nodes.find(node => node.id === id).api_action.code_action.code;
  const scope = { params, module: { exports: null } };
  vm.runInNewContext(code, scope, { timeout: 1000 });
  return JSON.parse(JSON.stringify(scope.module.exports));
};
const event = '22222222-2222-4222-8222-222222222222';
const agent = '546f13ab-19cf-47a3-bb13-49240e42ec6b';

test('collections call rejects caller substitution and exports only scoped transport fields', () => {
  const data = { event_id: event, credito_id: '1', event_token: 'synthetic_token', to_number: '+573000000001',
    from_number: '+573124085562', agent_id: agent, customer_name: 'Never disclose', customer_document: '001234567' };
  assert.deepEqual(Object.keys(run('call', 'nrmCl', { trigger: { body: data } })).sort(),
    ['credito_id', 'event_id', 'event_token', 'to_number']);
  for (const patch of [{ from_number: '+17624659863' }, { agent_id: '11111111-1111-4111-8111-111111111111' },
    { to_number: '+13000000001' }, { event_id: 'invalid' }]) {
    assert.throws(() => run('call', 'nrmCl', { trigger: { body: { ...data, ...patch } } }));
  }
  const native = flow('call').api_nodes.find(node => node.id === 'natCl').api_action.custom_action.values;
  assert.equal(native.from_number, '+573124085562');
  assert.equal(native.agent_id, agent);
  assert.deepEqual(native.variables.map(variable => variable.key), ['event_id', 'credito_id', 'event_token']);
});

test('identity normalization preserves literal ASR and rejects conflicting args envelopes', () => {
  const data = { event_id: event, customer_name: 'Ana "María" Prueba', customer_document: 'cero cero, doce, treinta y cuatro, cincuenta y seis' };
  for (const body of [data, { args: data }]) {
    assert.deepEqual(JSON.parse(run('identity', 'nrmId', { trigger: { body } }).request_body), data);
  }
  assert.throws(() => run('identity', 'nrmId', { trigger: { body: { ...data, args: data } } }));
  assert.throws(() => run('identity', 'nrmId', { trigger: { body: { args: [] } } }));
});

test('identity response never exposes finance without strict verified status and complete speech', () => {
  const credito = { creditId: 1, valorVencido: 159150, diasMora: 20,
    speech: { valorVencido: 'ciento cincuenta y nueve mil ciento cincuenta pesos', diasMora: 'veinte días' } };
  assert.equal(run('identity', 'chkId', { verificar_identidad: { ok: true, verificado: true, credito } }).verificado, true);
  for (const raw of [{ ok: true, verificado: false, credito }, { ok: true, verificado: 'true', credito },
    { ok: true, verificado: true, credito: { ...credito, speech: null } },
    { ok: true, verificado: true, credito: { ...credito, speech: { diasMora: 'veinte días' } } }]) {
    const result = run('identity', 'chkId', { verificar_identidad: raw });
    assert.equal(result.verificado, false); assert.equal(result.credito, null);
  }
  assert.equal(run('identity', 'chkId', { verificar_identidad: { ok: true, verificado: false, code: 'DOCUMENT_NOT_UNDERSTOOD' } }).code,
    'DOCUMENT_NOT_UNDERSTOOD');
});

test('management cannot invent an agreement or conflate registration with a sent message', () => {
  const data = { event_id: event, result: 'MEDIOS_PAGO', comment: 'Solicitó información', next_follow_up_at: '2026-10-13T15:00:00Z' };
  assert.deepEqual(JSON.parse(run('management', 'nrmId', { trigger: { body: { args: data } } }).request_body), data);
  assert.throws(() => run('management', 'nrmId', { trigger: { body: { ...data, result: 'ACUERDO_PAGO' } } }));
  assert.throws(() => run('management', 'nrmId', { trigger: { body: { ...data, args: data } } }));
  assert.deepEqual(run('management', 'chkId', { verificar_identidad: { ok: true, registrado: true } }),
    { ok: true, registrado: true, enviado: false, code: null });
  assert.equal(run('management', 'chkId', { verificar_identidad: { ok: false, registrado: true, enviado: true } }).enviado, false);
});

test('native receipt requires a call id and rejects errors in sibling wrappers', () => {
  assert.equal(run('call', 'chkCl', { llamada_cobranza: { response: { result: { call_id: 'call_synthetic' } } } }).ok, true);
  for (const native of [{ response: { success: true } }, { response: { call_id: 'call_synthetic', error: 'failed' } },
    { response: { result: { call_id: 'call_synthetic' }, sibling: { errors: ['failed'] } } }]) {
    const result = run('call', 'chkCl', { llamada_cobranza: native });
    assert.equal(result.ok, false); assert.equal(result.call_id, null);
  }
});
