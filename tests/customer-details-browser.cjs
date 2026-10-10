/** Isolated browser QA for the real form. No database or DataCredito calls.
 * Run: node tests/customer-details-browser.cjs
 * Requires Playwright/Chrome. Optional QA_PLAYWRIGHT_MODULE_PATH and QA_CHROME_PATH.
 * Uses synthetic fixture data; screenshots/results: output/customer-details.
 */
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'finser-customer-details-'));
const output=path.join(root,'output/customer-details');fs.mkdirSync(output,{recursive:true});
const {chromium}=require(process.env.QA_PLAYWRIGHT_MODULE_PATH||'playwright');
fs.writeFileSync(path.join(dir,'entry.tsx'),fs.readFileSync(path.join(__dirname,'fixtures/customer-details-browser.tsx.fixture'),'utf8'));
(async()=>{
const webpack=require(path.join(root,'node_modules/next/dist/compiled/webpack/webpack')).webpack;
const consoleSource=fs.readFileSync(path.join(root,'app/dashboard/creditos/credit-factory-console.tsx'),'utf8');
fs.writeFileSync(path.join(dir,'name-bar.tsx'),'import React from "react";export '+consoleSource.slice(consoleSource.indexOf('function DataCreditoClientNameBar('),consoleSource.indexOf('function serializeCreditDraftSaveRequest')));
fs.writeFileSync(path.join(dir,'image.tsx'),'import React from "react"; export default function Image({preload,priority,unoptimized,sizes,...props}) { return <img {...props}/>; }');
fs.writeFileSync(path.join(dir,'ts-loader.cjs'),`const ts=require(${JSON.stringify(path.join(root,'node_modules/typescript'))});module.exports=source=>ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
fs.writeFileSync(path.join(dir,'css-loader.cjs'),`module.exports=source=>'export default '+JSON.stringify(Object.fromEntries([...source.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],'qa_'+m[1]])))`);

await new Promise((resolve,reject)=>webpack({mode:'development',entry:path.join(dir,'entry.tsx'),output:{path:dir,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':root,'next/image':path.join(dir,'image.tsx')},modules:[path.join(root,'node_modules')]},module:{rules:[{test:/\.tsx?$/,use:path.join(dir,'ts-loader.cjs')},{test:/\.css$/,use:path.join(dir,'css-loader.cjs')}]},node:{},},(error,stats)=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve()));
 const globals=fs.readFileSync(path.join(root,'app/globals.css'),'utf8').replace(/^@import.*$/gm,'');
 const moduleCss=require(path.join(root,'node_modules/postcss')).parse(fs.readFileSync(path.join(root,'app/dashboard/creditos/customer-details-form.module.css'),'utf8'));moduleCss.walkRules(rule=>{rule.selector=rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g,(_,name)=>'.qa_'+name)});
 const css=globals+'\n'+moduleCss.toString();
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--font-sans:Arial,Helvetica,sans-serif}*{box-sizing:border-box;border:0 solid;margin:0;padding:0}body{margin:0;font-family:Arial}button,input,select{font:inherit}button{cursor:pointer;background:transparent}h1,h2,h3{font-size:inherit}.grid{display:grid}.gap-4{gap:16px}.mt-4{margin-top:16px}@media(min-width:768px){.md\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}}'+css+'</style><div id="root"></div><script src="/bundle.js"></script></html>');

const browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)});
try {
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const requests=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>requests.push(r.url()));
await page.route('**/*',route=>{const url=new URL(route.request().url());let file=url.pathname==='/bundle.js'?path.join(dir,'bundle.js'):url.pathname.startsWith('/assets/')?path.join(root,'public',url.pathname):path.join(dir,'index.html');if(!fs.existsSync(file)){console.error('Missing fixture asset '+file);return route.abort();}return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.png')?'image/png':'text/html',body:fs.readFileSync(file)});});
const go=async(mode='')=>{await page.goto('http://127.0.0.1:4387/?mode='+mode);await page.locator('#clienteNombre').waitFor({state:'attached'});};
const block=n=>page.locator(`[data-customer-block="${n}"] > div > button[aria-controls]`);
const open=async(n)=>assert.equal(await block(n).getAttribute('aria-expanded'),'true',`block ${n} open`);
const visible=n=>page.locator('#customer-block-'+n).isVisible();
await go();await open(0);assert(await block(1).isDisabled());assert(await block(2).isDisabled());assert(!(await visible(1)));assert(!(await visible(2)));assert(await page.getByRole('button',{name:'Continuar',exact:true}).isDisabled());
assert.equal(await page.locator('#clienteDocumento').inputValue(),'12345678');assert(await page.locator('#clienteDocumento').getAttribute('readonly')!==null);assert(await page.locator('#clienteTipoDocumento').isDisabled());assert(await page.locator('#clienteNombre').getAttribute('readonly')!==null);
await page.getByRole('button',{name:'Ver condiciones'}).click();assert(await page.locator('#customer-approved-conditions').isVisible());assert((await page.locator('#customer-approved-conditions').innerText()).includes('2.000.000'));
await page.getByRole('button',{name:'Ver condiciones'}).click();
await page.locator('#clienteFechaExpedicion').fill('2015-01-01');await page.locator('#clienteFechaNacimiento').fill('1990-01-01');await open(0);assert(await block(1).isDisabled());assert.equal(await page.evaluate(()=>document.activeElement.id),'clienteFechaNacimiento');
await page.getByRole('button',{name:'Cancelar',exact:true}).click();await page.waitForTimeout(70);await open(1);assert(!(await visible(0)));assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Cancelar');
for(const [field,value] of Object.entries({clienteTelefono:'3100000000',clienteCorreo:'qa@example.test',clienteDepartamento:'Tolima',clienteCiudad:'Ibagué',clienteGenero:'FEMENINO',clienteEstadoCivil:'SOLTERO',clienteEstrato:'3',clienteDireccion:'Calle de pruebas 123'})){
 const el=page.locator('#'+field);if((await el.evaluate(e=>e.tagName))==='SELECT')await el.selectOption(value);else await el.fill(value);
}
await open(1);assert(await block(2).isDisabled());await page.getByRole('button',{name:'Cancelar',exact:true}).click();await page.waitForTimeout(70);await open(2);
for(const [field,value] of Object.entries({referenciaFamiliar1Nombre:'Referencia QA uno',referenciaFamiliar1Parentesco:'Madre',referenciaFamiliar1Telefono:'3110000000',referenciaFamiliar2Nombre:'Referencia QA dos',referenciaFamiliar2Parentesco:'Padre',referenciaFamiliar2Telefono:'3110000000'}))await page.locator('#'+field).fill(value);
await page.getByRole('button',{name:'Cancelar',exact:true}).click();assert(await page.getByRole('button',{name:'Continuar',exact:true}).isDisabled());assert.equal(await page.locator('#referenciaFamiliar2Telefono').getAttribute('aria-invalid'),'true');
await page.locator('#referenciaFamiliar2Telefono').fill('3100000000');await page.getByRole('button',{name:'Cancelar',exact:true}).click();assert(await page.getByRole('button',{name:'Continuar',exact:true}).isDisabled());await open(2);assert(await block(1).isEnabled());
await page.locator('#referenciaFamiliar2Telefono').fill('3120000000');await page.getByRole('button',{name:'Cancelar',exact:true}).click();assert(await page.getByRole('button',{name:'Continuar',exact:true}).isEnabled());
await block(0).click();await page.locator('#clienteFechaNacimiento').fill('');assert(await page.getByRole('button',{name:'Continuar',exact:true}).isDisabled());assert(await block(1).isDisabled());assert(await block(2).isDisabled());assert.equal(await page.evaluate(()=>window.qaValues.referenciaFamiliar2Telefono),'3120000000');await page.locator('#clienteFechaNacimiento').fill('1990-01-01');await page.getByRole('button',{name:'Cancelar',exact:true}).click();await page.waitForTimeout(70);await open(1);
await page.getByRole('button',{name:'Editar',exact:true}).click();assert(await page.locator('#clientePrimerNombre').isVisible());assert.equal(await page.locator('#clientePrimerApellido').count(),0);assert(await page.locator('#clienteDocumento').getAttribute('readonly')!==null);await page.locator('#clientePrimerNombre').fill('ANA LUCIA');assert((await page.locator('#clienteNombre').inputValue()).includes('ANA LUCIA PRUEBA'));await page.getByRole('button',{name:'Listo',exact:true}).click();
console.log('PASS progressive on blur, focus remains on clicked target, required gating, phone conflicts stay editable, correction invalidation preserves downstream, name/document restriction');
for(const [mode,expected] of [['contact',1],['references',2],['complete',0]]){await go(mode);await open(expected);}
console.log('PASS first pending block recovered from data');
await go('contact');await page.locator('#clienteCorreo').fill('qa@example.test');await page.keyboard.press('Tab');await open(1);assert.equal(await page.evaluate(()=>document.activeElement.id),'clienteDepartamento');
await page.locator('#clienteDireccion').focus();await page.keyboard.press('Tab');await page.waitForTimeout(70);await open(2);assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Cancelar');
await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.qa_mascot').evaluate(e=>getComputedStyle(e).animationName),'none');
console.log('PASS keyboard retains focus and reduced-motion disables mascot animation');
const layout=[];
for(const width of [1440,390,320]){
 await page.setViewportSize({width,height:1000});await go('complete');
 for(const section of [0,1,2]){if(section)await block(section).click();await page.screenshot({path:path.join(output,`${width}-block-${section}.png`),fullPage:true});layout.push(await page.evaluate(({width,section})=>{const e=document.querySelector('.qa_stage'),btn=document.querySelector('.qa_continue'),mascot=document.querySelector('.qa_mascot');const b=e.getBoundingClientRect();return{width,section,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,padding:getComputedStyle(e).padding,radius:getComputedStyle(e).borderRadius,buttonColor:getComputedStyle(btn).backgroundColor,mascotBox:mascot.getBoundingClientRect().toJSON()};},{width,section}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width}/${section}`);}
}
assert.deepEqual(errors,[]);assert(requests.every(url=>new URL(url).hostname==='127.0.0.1'));fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({layout,errors,requests:[...new Set(requests)]},null,2));console.log('PASS desktop 1440/mobile 390/320 layout no overflow; no runtime errors; only fixture requests');

} finally { await browser.close(); }

})().catch(error=>{console.error(error);process.exitCode=1});
