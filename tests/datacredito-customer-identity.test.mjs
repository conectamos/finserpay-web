import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { extractDataCreditoIdentity: extract, resolveDataCreditoIdentity: resolve } = await jiti.import('../lib/datacredito/identity.ts');
const basics = { conInformacion: true, primerNombre: 'María del Mar', segundoNombre: 'José', primerApellido: 'De la Peña', segundoApellido: 'Muñoz del Río', tipoDocumento: 'CC', numeroDocumento: '1.234.567' };
const fixture = data => ({ content: { infoTransaccion: { apellidoDigitado: 'NO VERIFICADO' }, respuesta: { validacion: { datosBasicos: data } } } });
const input = { clientePrimerNombre: 'María del Mar José', clientePrimerApellido: 'De la Peña', clienteSegundoApellido: 'Muñoz del Río', clienteTipoDocumento: 'CEDULA_DE_CIUDADANIA', clienteDocumento: '1234567' };
test('structured provider identity preserves all names, compounds, accents and undotted document', () => {
 const identity=extract(fixture(basics),'1234567');
 assert.equal(identity.names,'María del Mar José');assert.equal(identity.firstSurname,'De la Peña');assert.equal(identity.secondSurname,'Muñoz del Río');assert.equal(identity.documentNumber,'1234567');assert.deepEqual(identity.missing,[]);
});
test('full name alone never splits names or trusts typed surname',()=>{
 const identity=extract(fixture({conInformacion:true,nombreCompleto:'María del Mar De la Peña'}),'1234567');
 assert.equal(identity.names,''); assert.equal(identity.firstSurname,'');assert.equal(identity.fullName,'María del Mar De la Peña');assert.ok(identity.missing.includes('Primer apellido'));
});
test('a different document fails closed',()=>assert.throws(()=>extract(fixture({...basics,numeroDocumento:'7654321'}),'1234567'),/DOCUMENT_MISMATCH/));
test('no information does not verify echoed fields',()=>{const identity=extract(fixture({...basics,conInformacion:false}),'1234567');assert.equal(identity.names,'');assert.equal(identity.firstSurname,'');assert.equal(identity.documentNumber,'');});
test('second surname can be absent without blocking',()=>{const identity=extract(fixture({...basics,segundoApellido:''}),'1234567');assert.deepEqual(identity.missing,[]);assert.equal(resolve(identity,{...input,clienteSegundoApellido:''}).fullName,'María del Mar José De la Peña');});
test('only names and second surname can be corrected',()=>{
 const original=extract(fixture(basics),'1234567'); const corrected=resolve(original,{...input,clientePrimerNombre:'María José',clienteSegundoApellido:''});assert.equal(corrected.fullName,'María José De la Peña');assert.equal(original.names,'María del Mar José');assert.equal(original.secondSurname,'Muñoz del Río');
 for(const [key,value] of [['clientePrimerApellido','Otro'],['clienteDocumento','7654321'],['clienteTipoDocumento','PASAPORTE']]) assert.throws(()=>resolve(original,{...input,[key]:value}),/LOCKED_FIELDS/);
});
test('missing names can be completed but missing locked identity cannot',()=>{
 const identity=extract(fixture({...basics,primerNombre:'',segundoNombre:''}),'1234567');assert.equal(resolve(identity,input).names,input.clientePrimerNombre);
 assert.throws(()=>resolve(extract(fixture({conInformacion:true}),'1234567'),{...input,clientePrimerApellido:'',clienteDocumento:'',clienteTipoDocumento:''}),/INCOMPLETE/);
});
test('invalid or empty names cannot reach documents',()=>{const identity=extract(fixture(basics),'1234567');assert.throws(()=>resolve(identity,{...input,clientePrimerNombre:''}),/INVALID_NAMES/);assert.throws(()=>resolve(identity,{...input,clientePrimerNombre:'<script>'}),/INVALID_NAMES/);});

test('FirmaSeguro receives structured corrected names without splitting compounds', async () => {
 const {dataCreditoIdentityToFirmaSeguroNames}=await jiti.import('../lib/datacredito/identity.ts');
 const corrected=resolve(extract(fixture(basics),'1234567'),{...input,clienteSegundoApellido:''});
 assert.deepEqual(dataCreditoIdentityToFirmaSeguroNames(corrected),{firstName:'María del Mar José',secondName:null,firstLastName:'De la Peña',secondLastName:null});
});

test('fixed-width CC padding is accepted only for the same numeric document',()=>{
 const identity=extract(fixture({...basics,numeroDocumento:'0000001234567'}),'1234567');
 assert.equal(identity.documentNumber,'1234567');
 assert.equal(identity.names,'María del Mar José');
 assert.throws(()=>extract(fixture({...basics,numeroDocumento:'0000007654321'}),'1234567'),/DOCUMENT_MISMATCH/);
 assert.throws(()=>extract(fixture({...basics,numeroDocumento:'0001234567X'}),'1234567'),/DOCUMENT_MISMATCH/);
});
