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
 assert.equal(identity.names,''); assert.equal(identity.firstSurname,'');assert.equal(identity.fullName,'María del Mar De la Peña');assert.equal(identity.nameMode,'FULL_NAME_ONLY');
 assert.deepEqual(identity.missing,['Número de documento','Tipo de documento']);
});
test('complete unstructured identity is canonical without inferred components',()=>{
 const fullName='María del Mar  De la Peña Muñoz del Río';
 const identity=extract(fixture({conInformacion:true,nombreCompleto:` ${fullName} `,tipoDocumento:'CC',numeroDocumento:'1.234.567'}),'1234567');
 assert.equal(identity.fullName,fullName);assert.deepEqual(identity.missing,[]);
 const resolved=resolve(identity,{...input,clienteNombre:fullName,clientePrimerNombre:'Inventado',clientePrimerApellido:'Inventado',clienteSegundoApellido:'Inventado'});
 assert.equal(resolved.fullName,fullName);assert.equal(resolved.names,'');assert.equal(resolved.firstSurname,'');assert.equal(resolved.secondSurname,'');
 for(const [key,value] of [['clienteNombre','Otra Persona'],['clienteDocumento','7654321'],['clienteTipoDocumento','PASAPORTE']]) assert.throws(()=>resolve(identity,{...input,clienteNombre:fullName,[key]:value}),/LOCKED_FIELDS/);
 assert.equal(resolve(identity,{...input,clienteNombre:undefined}).fullName,fullName);
});
test('partial structured fields are preserved alongside full name without supplying the missing component',()=>{
 const identity=extract(fixture({conInformacion:true,nombreCompleto:'José María De la Peña',primerNombre:'José María',tipoDocumento:'CC',numeroDocumento:'1234567'}),'1234567');
 assert.equal(identity.nameMode,'FULL_NAME_ONLY');assert.equal(identity.names,'José María');assert.equal(identity.firstSurname,'');assert.deepEqual(identity.missing,[]);
 assert.equal(resolve(identity,input).firstSurname,'');
});
test('unstructured identity still requires provider document and type before use',()=>{
 const identity=extract(fixture({conInformacion:true,nombreCompleto:'José María De la Peña'}),'1234567');
 assert.throws(()=>resolve(identity,{clienteDocumento:'',clienteTipoDocumento:''}),/INCOMPLETE/);
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

test('numeric provider document and CC type preserve exact safe integers without coercing names',()=>{
 const identity=extract(fixture({...basics,numeroDocumento:1110178524,tipoDocumento:1,primerNombre:123}),'1110178524');
 assert.equal(identity.documentNumber,'1110178524');assert.equal(identity.documentType,'CEDULA_DE_CIUDADANIA');
 assert.equal(identity.names,'José');assert.deepEqual(identity.missing,[]);
 assert.throws(()=>extract(fixture({...basics,numeroDocumento:1110178525,tipoDocumento:1}),'1110178524'),/DOCUMENT_MISMATCH/);
 for(const value of [Number.MAX_SAFE_INTEGER+1,1.5,true,false,NaN,Infinity]) {
  const missing=extract(fixture({...basics,numeroDocumento:value,tipoDocumento:value}),'1234567');
  assert.equal(missing.documentNumber,'');assert.equal(missing.documentType,'');
  assert.deepEqual(missing.missing,['Número de documento','Tipo de documento']);
 }
});

test('explicit CC document type recognizes case, accents and whitespace without changing names',()=>{
 for(const tipoDocumento of ['CÉDULA DE CIUDADANÍA','cédula de ciudadanía','  Cédula   de   ciudadanía  ','cc',' c.c. ','cedula_de_ciudadania']) {
  const identity=extract(fixture({...basics,tipoDocumento}),'1234567');
  assert.equal(identity.documentType,'CEDULA_DE_CIUDADANIA');assert.equal(identity.firstSurname,'De la Peña');
  assert.equal(identity.names,'María del Mar José');
 }
 assert.equal(extract(fixture({...basics,tipoDocumento:'PASAPORTE'}),'1234567').documentType,'PASAPORTE');
});

test('a trusted server query binds absent provider metadata without filling or verifying it',()=>{
 const identity=extract(fixture({conInformacion:true,nombreCompleto:'José María De la Peña'}),'1234567');
 const query={documentNumber:'1234567',documentType:'CEDULA_DE_CIUDADANIA'};
 const resolved=resolve(identity,{...input,clienteNombre:identity.fullName},query);
 assert.equal(resolved.documentNumber,'');assert.equal(resolved.documentType,'');
 assert.deepEqual(resolved.missing,['Número de documento','Tipo de documento']);
 assert.equal(resolved.fullName,identity.fullName);assert.equal(resolved.firstSurname,'');
 assert.equal(resolve(identity,{...input,clienteNombre:identity.fullName,clienteTipoDocumento:''},query).documentType,'');
 for(const [patch,code] of [
  [{clienteDocumento:'7654321'},/DOCUMENT_MISMATCH/],
  [{clienteTipoDocumento:'PASAPORTE'},/LOCKED_FIELDS/],
  [{clienteNombre:'Otra Persona'},/LOCKED_FIELDS/],
 ]) assert.throws(()=>resolve(identity,{...input,clienteNombre:identity.fullName,...patch},query),code);
 assert.throws(()=>resolve({...identity,documentNumber:'7654321'},{...input,clienteNombre:identity.fullName},query),/DOCUMENT_MISMATCH/);
 assert.throws(()=>resolve({...identity,documentType:'PASAPORTE'},{...input,clienteNombre:identity.fullName},query),/LOCKED_FIELDS/);
 assert.throws(()=>resolve(identity,{...input,clienteNombre:identity.fullName},{...query,documentType:'PASAPORTE'}),/LOCKED_FIELDS/);
});
