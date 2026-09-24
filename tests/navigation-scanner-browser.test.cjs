// Real browser, synthetic services only. Requires the existing bundled Playwright and Edge runtime.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require(process.env.ATLAS_PLAYWRIGHT_PATH||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
test('mobile scanner readiness, recovery, direct native pickers and safe exit',async t=>{
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{let body=fs.readFileSync(file);if(pathname.endsWith('routing-intake-browser.html'))body=body.toString().replace(/if\(entryCheck\)checkDirectEntry[^\n]+/,'window.fixtureReady=true;');res.setHeader('Content-Type',pathname.endsWith('.html')?'text/html':pathname.endsWith('.css')?'text/css':'text/javascript');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({executablePath:process.env.ATLAS_BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}/tests/routing-intake-browser.html?scanner=1`);await page.waitForFunction(()=>window.fixtureReady);
 await page.evaluate(()=>{window.readyCalls=0;window.atlasRoutingConnectionReady=()=>{readyCalls++;return new Promise(resolve=>window.finishReady=resolve);};void atlasOpenRouting({intent:'scan-order'});});
 await page.locator('[data-scanner-startup="opening"]').waitFor();
 await page.evaluate(()=>{window.atlasRoutingConnectionReady=async()=>{};finishReady();});
 await page.locator('.atlas-document-flow[open] [data-intake-action="camera"]').waitFor();
 assert.equal(await page.locator('.atlas-document-flow[open]').evaluate(el=>el.inert),false);
 await page.evaluate(()=>{window.pickerCalls=[];const click=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type==='file'){pickerCalls.push(this.hasAttribute('capture')?'camera':'photos');this.dispatchEvent(new Event('cancel'));return;}return click.call(this);};});
 await page.locator('[data-intake-action="camera"]').click();await page.locator('[data-intake-action="photos"]').click();
 assert.deepEqual(await page.evaluate(()=>pickerCalls),['camera','photos']);assert.equal(await page.locator('input[data-intake-camera]').count(),1);
 await page.locator('[data-intake-action="back"]').click();assert.equal(await page.locator('#atlasDeliveryRouting').isVisible(),false);
 await page.evaluate(()=>{window.atlasRoutingConnectionReady=async()=>{throw Error('Synthetic temporary connection failure');};void atlasOpenRouting({intent:'scan-order'});});
 await page.locator('[data-scanner-startup="unavailable"]').waitFor();
 await page.evaluate(()=>{window.atlasRoutingConnectionReady=async()=>{readyCalls++;};});await page.locator('[data-scanner-retry]').click();await page.locator('.atlas-document-flow[open]').waitFor();
 await page.locator('[data-intake-action="back"]').click();
 for(let i=0;i<2;i++){await page.evaluate(()=>atlasOpenRouting({intent:'scan-order'}));assert.equal(await page.locator('input[data-intake-camera]').count(),1);await page.locator('[data-intake-action="back"]').click();}
 await page.context().setOffline(true);await page.evaluate(()=>atlasOpenRouting({intent:'scan-order'}));await page.locator('[data-scanner-startup="offline"]').waitFor();await page.locator('[data-scanner-cancel]').click();assert.equal(await page.locator('#atlasDeliveryRouting').isVisible(),false);await page.context().setOffline(false);
 await page.evaluate(()=>{atlasRoutingPOD.access=async()=>({capability:'viewer',canEdit:false});void atlasOpenRouting({intent:'scan-order'});});await page.locator('[data-scanner-startup="unauthorized"]').waitFor();await page.locator('[data-scanner-cancel]').click();assert.equal(await page.locator('#atlasDeliveryRouting').isVisible(),false);
 assert.deepEqual(errors,[]);
});
