import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root=path.resolve(import.meta.dirname,'..'),origin='https://finser.example',id=randomUUID();
const actor={userId:5,key:'analyst:5',central:false};
function compile(file,mocks){
  const source=ts.transpileModule(readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',source)(name=>{assert.ok(name in mocks,`No live dependency: ${name}`);return mocks[name];},mod,mod.exports);return mod.exports;
}
const core=compile('lib/atencion-core.ts',{}),types=compile('lib/atencion-board-types.ts',{});
const boardCore=compile('lib/atencion-board-core.ts',{'./atencion-core':core,'./atencion-board-types':types});
class ProviderError extends Error{}
const http=compile('lib/atencion-http.ts',{'./atencion-core':core,'./atencion-dapta':{AttentionDaptaError:ProviderError},'./atencion-meta':{AttentionMetaError:ProviderError}});
const files=[['board/route.ts','GET'],['board/route.ts','PATCH'],['board/cards/route.ts','GET'],['[id]/section/route.ts','GET'],['[id]/section/route.ts','POST']];
function harness(file,options={}){
  const calls={access:0,store:[]};
  const access={...core,getAttentionAccess:async()=>{calls.access++;if(options.accessError)throw options.accessError;return actor;}};
  const store=Object.fromEntries(['getAttentionBoard','getAttentionBoardPlacement','getAttentionBoardCards','configureAttentionBoard','moveAttentionBoardConversation'].map(name=>[name,async(...args)=>{calls.store.push({name,args});if(options.storeError)throw options.storeError;return {ok:true};}]));
  return {...compile(`app/api/atencion/${file}`,{'@/lib/atencion-core':access,'@/lib/atencion-board-core':boardCore,'@/lib/atencion-board-storage':store,'@/lib/atencion-http':http}),calls};
}
function request(method='POST',body={},options={}){
  const headers=new Headers({origin,'content-type':'application/json',...options.headers});
  return new Request(`${origin}/api/atencion${options.query||''}`,{method,headers,...(method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
}
const context={params:Promise.resolve({id})};
function privateResponse(res){assert.match(res.headers.get('cache-control'),/private, no-store/);assert.equal(res.headers.get('vary'),'Cookie');assert.equal(res.headers.get('x-content-type-options'),'nosniff');}

test('todas las rutas del tablero exigen sesión nominal antes de leer y conservan errores seguros',async()=>{
  for(const [file,method] of files){
    const h=harness(file,{accessError:new core.AttentionError('Inicia sesión',401)}),res=await h[method](request(method),context);
    assert.equal(res.status,401);privateResponse(res);assert.equal(h.calls.store.length,0);
  }
  for(const status of [403,404,409,503]){
    const h=harness('board/route.ts',{storeError:new core.AttentionError('Operación no disponible',status)}),res=await h.GET(request('GET'));
    assert.equal(res.status,status);privateResponse(res);
  }
  const h=harness('board/route.ts',{storeError:new Error('SQL customer token private')}),res=await h.GET(request('GET'));
  assert.equal(res.status,500);assert.ok(!(await res.text()).includes('SQL'));
});

test('escrituras rechazan CSRF y payloads que pretendan cambiar actor, estado o versión comercial',async()=>{
  for(const [file,method] of files.filter(([,method])=>method!=='GET')){
    const h=harness(file),res=await h[method](request(method,{}, {headers:{origin:'https://evil.example'}}),context);
    assert.equal(res.status,403);assert.equal(h.calls.access,0);assert.equal(h.calls.store.length,0);
  }
  const h=harness('[id]/section/route.ts'),valid={sectionId:null,boardVersion:3,requestId:randomUUID()};
  for(const body of [{...valid,version:7},{...valid,userId:1},{...valid,status:'closed'},{...valid,sectionId:'bad'},{...valid,boardVersion:0}])assert.equal((await h.POST(request('POST',body),context)).status,400);
  assert.equal((await h.POST(request('POST',valid),{params:Promise.resolve({id:'bad'})})).status,400);
  assert.equal((await h.POST(request('POST','['),context)).status,400);
  assert.equal((await h.POST(request('POST','x'.repeat(17000)),context)).status,413);
  assert.equal(h.calls.store.length,0);
  const res=await h.POST(request('POST',valid),context);assert.equal(res.status,200);privateResponse(res);
  assert.deepEqual(h.calls.store[0],{name:'moveAttentionBoardConversation',args:[actor,id,valid]});
});

test('lecturas paginadas usan búsqueda estricta y nunca toman permisos del cliente',async()=>{
  const h=harness('board/cards/route.ts');
  const res=await h.GET(request('GET',{}, {query:'?sectionId=none&page=2&search=Ana&central=true&userId=1'}));
  assert.equal(res.status,200);privateResponse(res);
  assert.deepEqual(h.calls.store[0],{name:'getAttentionBoardCards',args:[actor,{sectionId:null,search:'Ana',page:2}]});
  for(const query of ['?sectionId=none&sectionId=none','?sectionId=none&page=0','?sectionId=none&search=a&search=b'])assert.equal((await h.GET(request('GET',{}, {query}))).status,400);
  assert.equal(h.calls.store.length,1);
  const board=harness('board/route.ts');assert.equal((await board.GET(request('GET',{}, {query:'?search=a&search=b'}))).status,400);assert.equal(board.calls.store.length,0);
  const data={action:'create',name:'Nueva',color:'lime',requestId:randomUUID()};
  assert.equal((await board.PATCH(request('PATCH',data))).status,200);assert.deepEqual(board.calls.store[0],{name:'configureAttentionBoard',args:[actor,data]});
});

test('ubicación de ficha solo toma el chat validado y el actor de sesión con respuesta privada',async()=>{
  const h=harness('[id]/section/route.ts');
  const res=await h.GET(request('GET',{}, {query:'?central=true&userId=1&sectionId=none&boardVersion=900'}),context);
  assert.equal(res.status,200);privateResponse(res);
  assert.deepEqual(h.calls.store,[{name:'getAttentionBoardPlacement',args:[actor,id]}]);
  assert.equal((await h.GET(request('GET'),{params:Promise.resolve({id:'bad'})})).status,400);
  assert.equal(h.calls.store.length,1);
  for(const status of [403,404,503]){
    const blocked=harness('[id]/section/route.ts',{storeError:new core.AttentionError('Ficha no disponible',status)});
    const response=await blocked.GET(request('GET'),context);assert.equal(response.status,status);privateResponse(response);
  }
  const failure=harness('[id]/section/route.ts',{storeError:new Error('private SQL credential')});
  const response=await failure.GET(request('GET'),context);assert.equal(response.status,500);privateResponse(response);assert.ok(!(await response.text()).includes('private SQL'));
});
