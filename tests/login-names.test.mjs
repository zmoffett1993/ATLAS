import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../atlas-login.js';
const login=globalThis.AtlasLogin;
for(const code of ['CA','TX']) test(code+' visible Receiver name preserves spaces and case',()=>{
  assert.deepEqual(login.identity(login.receiverName(code)),{name:code+' COC Receiver',key:code.toLowerCase()+'cocreceiver'});
});
test('case, repeated whitespace and compatibility Unicode share one credential key',()=>{
  for(const name of ['TX COC Receiver','tx coc receiver','  TX   COC\tReceiver  ','ＴＸ ＣＯＣ Receiver','TX\u00a0COC Receiver']) assert.equal(login.identity(name).key,'txcocreceiver');
});
test('composed and decomposed accents share a key without losing visible accent',()=>{
  assert.deepEqual(login.identity('Jose\u0301 Smith'),{name:'José Smith',key:'josesmith'});
});
test('existing employee ASCII credential keys are unchanged',()=>{
  for(const name of ['zach','Separate.Login','first_last','first-last','officecocstation','officecocreceiver']) assert.equal(login.identity(name).key,name.toLowerCase());
  assert.equal(login.identity('Zach Moffett').key,'zachmoffett');
});
test('empty, email, unsupported characters and overlong names are rejected rather than truncated',()=>{
  for(const value of ['',null,'  ','a','name@example.com','john+doe','😀😀','a'.repeat(49),'a '.repeat(31)]) assert.throws(()=>login.identity(value));
});
test('database proposal defers identity check and generates its key rules from the shared specification',()=>{
  const p=JSON.parse(fs.readFileSync(new URL('../release/receiver-login-proposal.json',import.meta.url)));
  assert.match(p.sql,/login_key text primary key/);
  assert.match(p.sql,/coalesce\(u.raw_app_meta_data->>'login_key',u.raw_app_meta_data->>'login_name'\)/);
  assert.match(p.sql,/login_key := atlas_account_private.login_key\(login_name\)/);
  assert.match(p.sql,/for no key update/);
  assert.doesNotMatch(p.sql,/lower\(new.email\) is distinct from \(old.raw_app_meta_data->>'login_name'\)/);
  assert.match(p.sql,/'login_key',new.raw_app_meta_data->>'login_key'/);
  assert.match(p.sql,/ASSIGNMENT_REVISION_CONFLICT/);
  // This is a proposal/source assertion, not a PostgreSQL integration test.
});
