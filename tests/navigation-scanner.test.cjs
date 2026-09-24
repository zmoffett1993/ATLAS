const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const start=html.indexOf('(0, T.jsx)(`nav`, {\r\n              className: `bottom-nav`');
const source=html.slice(start,html.indexOf('\r\n            S\r\n',start)).trim().replace(/,$/,'');
test('authoritative navigation keeps four items and personal scanner across all sections and rerenders',()=>{
 assert.ok(start>=0);const calls=[],jsx=(tag,props)=>({tag,...props});
 for(const allowed of [true,false])for(const section of ['home','aisles','inventory','home']){
 const tree=vm.runInNewContext(source,{e:section,atlasScannerShortcut:allowed,T:{jsx,jsxs:jsx},window:{atlasPersonalScannerAllowed:()=>allowed,AtlasNavigation:{open:key=>calls.push(key)}}});
 const buttons=tree.children.children;assert.equal(buttons.length,4);assert.equal(buttons[3].children[1].children,allowed?'Scan Orders':'COC');
 buttons[3].onClick();assert.equal(calls.pop(),allowed?'order-scanner':'coc');
 for(const [index,key] of ['home','aisles','inventory'].entries()){buttons[index].onClick();assert.equal(calls.pop(),key);}
 }
});
test('drawer uses stable navigation commands instead of finding bottom buttons by label',()=>{
 const begin=html.indexOf('const premiumNavigate ='),end=html.indexOf('const atlasNavigationLayoutQuery',begin);
 assert.match(html.slice(begin,end),/AtlasNavigation\?\.open\(action\)/);assert.doesNotMatch(html.slice(begin,end),/textContent|querySelector|\.click/);
 assert.match(html,/data-nav="coc"/);assert.match(html,/"Scan Orders": '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2"/);
});
