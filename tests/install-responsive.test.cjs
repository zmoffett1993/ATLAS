const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
test('invitation selects device guidance, preserves controls and stays reachable across viewports',async t=>{
 const server=http.createServer((req,res)=>{let p=new URL(req.url,'http://localhost').pathname;if(p.endsWith('/'))p+='index.html';const f=path.join(root,p);try{res.setHeader('Content-Type',f.endsWith('.css')?'text/css':f.endsWith('.js')?'text/javascript':f.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(f));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());
 const cases=[['iphone390',390,664,'iPhone','iphone'],['iphone393',393,672,'iPhone','iphone'],['iphone375',375,627,'iPhone','iphone'],['iphone430',430,752,'iPhone','iphone'],['small320',320,480,'iPhone','iphone'],['android360',360,656,'Android','android'],['android412',412,771,'Android','android'],['android-prompt',360,656,'Android','android'],['ipad',768,850,'Macintosh','iphone'],['embedded',390,664,'iPhone FBAN/FBIOS','iphone'],['android-embedded',412,771,'Android; wv','android'],['landscape',844,250,'iPhone','iphone'],['desktop',1280,800,'Desktop','browser-guidance'],['large-text',390,664,'iPhone','iphone']];
 for(const [name,width,height,ua,expected]of cases){const page=await browser.newPage({viewport:{width,height},userAgent:ua,serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 if(name==='ipad')await page.addInitScript(()=>{Object.defineProperty(navigator,'platform',{value:'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{value:5});});
 await page.goto('http://127.0.0.1:'+server.address().port+'/install/');
 for(let i=0;i<2;i++){for(const id of ['iphone','android','browser-guidance'])assert.equal(await page.locator('#'+id).isVisible(),id===expected,name+': '+id);if(!i)await page.reload();}
 assert.equal(await page.locator('#page-title').textContent(),expected==='browser-guidance'?'ATLAS on your computer':'Install ATLAS');assert.equal(await page.locator('#install-button').isVisible(),false);
 assert.equal(await page.locator('.install-link').textContent(),'https://zmoffett1993.github.io/ATLAS/install/');assert.equal(await page.locator('#open-app').getAttribute('href'),'../index.html');assert.equal(await page.locator('#open-app span').isVisible(),true);
 if(name==='android-prompt'){
 await page.evaluate(()=>{const event=new Event('beforeinstallprompt');event.prompt=async()=>{};event.userChoice=Promise.resolve({outcome:'dismissed'});window.dispatchEvent(event);});
 assert.equal(await page.locator('#install-button').isVisible(),true);assert.equal(await page.locator('#open-app').isVisible(),true);
 }
 if(name==='large-text')await page.addStyleTag({content:'html{font-size:32px}'});
 const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,footer:document.querySelector('footer').getBoundingClientRect().bottom}));assert.ok(size.width<=width,name+' horizontal overflow');
 if(['iphone390','iphone393','android360','android412','android-prompt'].includes(name))assert.ok(size.footer<=height,name+' first viewport footer '+size.footer+' > '+height);
 if(process.env.ATLAS_INVITATION_SCREENSHOTS)await page.screenshot({path:path.join(process.env.ATLAS_INVITATION_SCREENSHOTS,name+'.png')});
 await page.locator('footer').scrollIntoViewIfNeeded();assert.ok(await page.locator('footer').isVisible());assert.deepEqual(errors,[]);await page.close();
 }
});
