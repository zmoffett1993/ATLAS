import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require = createRequire(new URL('../tools/delivery-pod/package.json', import.meta.url));
let PGlite;
try { ({PGlite} = require('@electric-sql/pglite')); }
catch { throw Error('POD SQL test prerequisite missing. Run npm ci --prefix tools/delivery-pod --ignore-scripts. No remote database is used.'); }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const CA=id(1),TX=id(2),office=id(10),driver=id(11),other=id(12),texas=id(13),order=id(30),submission=id(40);
const day='2026-09-21',hash='a'.repeat(64),pdfHash='b'.repeat(64);

test('POD SQL on isolated PostgreSQL: authorization, immutable links and receipt transactions', async t => {
 const db=await PGlite.create();
 t.after(()=>db.close());
 const query=(sql,args=[])=>db.query(sql,args);
 const scalar=async(sql,args=[])=>Object.values((await query(sql,args)).rows[0])[0];
 const admin=()=>db.exec('reset role');
 const user=async(who,role='authenticated',session=id(Number(who.slice(-12))+100))=>{
  await admin(); await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:who,session_id:session,user_metadata:{role:'admin'}})]);
  assert.ok(['authenticated','anon','service_role'].includes(role)); await db.exec(`set role ${role}`);
 };
 const bind=async(trip=0,revision=1)=>scalar('select public.atlas_pod_bind($1,$2,$3,$4,$5)',[day,revision,trip,order,driver]);
 const context=b=>scalar('select public.atlas_pod_context($1)',[b.id]);
 const receive=(b,overrides={})=>scalar('select public.atlas_pod_receive($1,$2,$3,$4,$5,$6,$7,$8)',[
  b.id,overrides.actor||driver,overrides.session||id(111),overrides.submission||submission,
  overrides.manifest||hash,overrides.filename||'POD-SO-68032-SHIPMENT-1-OF-2.pdf',overrides.pages||1,overrides.pdf||null]);
 const scenario=async(name,fn)=>t.test(name,async()=>{
  await admin();await db.exec('begin');
  try {await fn();} finally {await db.exec('rollback');await admin();}
 });
 await db.exec(await readFile(new URL('../tools/delivery-pod/test-prerequisites.sql',import.meta.url),'utf8'));
 // Synthetic Storage metadata stands in for buckets created through the hosted API.
 await db.exec("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('atlas-pod-originals','atlas-pod-originals',false,15000000,array['image/jpeg','image/png']),('atlas-pod-documents','atlas-pod-documents',false,25000000,array['application/pdf'])");
 await db.exec(await readFile(new URL('../tools/delivery-pod/schema-draft.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../tools/delivery-pod/email-schema-draft.sql',import.meta.url),'utf8'));
 assert.match(await scalar('select version()'),/PostgreSQL 17\./);
 await query('insert into warehouses values($1,$2,true),($3,$4,true)',[CA,'CA',TX,'TX']);
 for(const who of [office,driver,other,texas]){
  const wh=who===texas?TX:CA,role=who===office?'admin':'picker';
  await query('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[who,{role}]);
  await query('insert into auth.sessions values($1,$2,null)',[id(Number(who.slice(-12))+100),who]);
  await query('insert into profiles values($1,$2,$3)',[who,wh,role]);
  await query('insert into profile_warehouse_access values($1,$2)',[who,wh]);
  await query('insert into atlas_pod_private.members values($1,$2,$3,true)',[wh,who,who===office?'office':'driver']);
 }
 await query("insert into atlas_routing_preview_private.members values($1,$2,'editor',true)",[CA,office]);
 const shipment={orderId:order,palletSpaces:6,boxAllocation:[{sku:'TEST',boxes:120}]};
 const document={orders:[{id:order,orderNumber:'SO-US-68032',customer:'Synthetic customer',address:'Test address',dispatchedOn:day}],lockedTrips:[{assignment:'Bubba:truck',shipments:[shipment]},{assignment:'Bubba:truck',shipments:[{...shipment,palletSpaces:2}]}]};
 await query('insert into atlas_routing_preview_private.days values($1,$2,1,$3)',[CA,day,document]);

 await scenario('requires private buckets and creates RLS tables; unprivileged roles cannot bypass RPCs',async()=>{
  assert.equal(await scalar("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas_pod_private' and c.relkind='r' and c.relrowsecurity"),5);
  assert.equal(await scalar("select count(*)::int from storage.buckets where public"),0);
  for(const role of ['anon','authenticated']){
   assert.equal(await scalar("select has_table_privilege($1,'atlas_pod_private.bindings','SELECT')",[role]),false);
   assert.equal(await scalar("select has_function_privilege($1,'public.atlas_pod_receive(uuid,uuid,uuid,uuid,text,text,integer,text)','EXECUTE')",[role]),false);
  }
  await user(driver);await assert.rejects(query('select * from atlas_pod_private.bindings'),{code:'42501'});
 });
 await scenario('office binds exact saved split; assigned driver sees only assigned shipment',async()=>{
  await user(office);const b=await bind();assert.equal(b.shipment_number,1);assert.equal(b.shipment_total,2);
  await user(driver);assert.equal((await context(b)).actor_id,driver);
  assert.equal((await scalar('select public.atlas_pod_list($1)',[day])).shipments.length,1);
  await user(other);assert.equal((await scalar('select public.atlas_pod_list($1)',[day])).shipments.length,0);
 });
 await scenario('another driver cannot access a known binding ID',async()=>{
  await user(office);const b=await bind();await user(other);await assert.rejects(context(b),{code:'42501'});
 });
 await scenario('TX member cannot read CA shipments',async()=>{
  await user(office);const b=await bind();await user(texas);await assert.rejects(context(b),{code:'42501'});
 });
 await scenario('driver cannot create shipment bindings',async()=>{
  await user(driver);await assert.rejects(bind(),{code:'42501'});
 });
 await scenario('stale source revision is rejected',async()=>{
  await user(office);await assert.rejects(bind(0,2),{code:'40001'});
 });
 for(const [name,sql] of [
  ['disabled membership',"update atlas_pod_private.members set enabled=false where user_id=$1"],
  ['expired session',"update auth.sessions set not_after=now()-interval '1 minute' where user_id=$1"],
  ['revoked session','delete from auth.sessions where user_id=$1'],
  ['banned user',"update auth.users set banned_until=now()+interval '1 day' where id=$1"],
  ['anonymous user','update auth.users set is_anonymous=true where id=$1']
 ]) await scenario(`denies ${name}`,async()=>{
  await user(office);const b=await bind();await admin();await query(sql,[driver]);await user(driver);
  await assert.rejects(context(b),{code:'42501'});
 });
 await scenario('user-editable role claim cannot replace revoked trusted office role',async()=>{
  await admin();await query("update auth.users set raw_app_meta_data='{}' where id=$1",[office]);
  await user(office);await assert.rejects(bind(),{code:'42501'});
 });
 await scenario('immutable split binding becomes stale when allocation changes',async()=>{
  await user(office);const b=await bind();await admin();
  await query("update atlas_routing_preview_private.days set document=jsonb_set(document,'{lockedTrips,0,shipments,0,palletSpaces}','7')");
  await user(driver);await assert.rejects(context(b),{code:'40001'});
 });
 await scenario('same immutable retry finalizes once and emits one receipt event',async()=>{
  await user(office);const b=await bind();await user(driver,'service_role');
  assert.equal((await receive(b)).state,'uploading');
  assert.equal((await receive(b,{pdf:pdfHash})).state,'received');
  assert.equal((await receive(b,{pdf:pdfHash})).state,'received');
  await admin();assert.equal(await scalar("select count(*)::int from atlas_pod_private.events where event='pod_received'"),1);
 });
 await scenario('changed retry manifest is rejected without overwriting original',async()=>{
  await user(office);const b=await bind();await user(driver,'service_role');await receive(b);
  await assert.rejects(receive(b,{manifest:'c'.repeat(64)}),{code:'40001'});
 });
 await scenario('server finalization rechecks access after upload reservation',async()=>{
  await user(office);const b=await bind();await user(driver,'service_role');await receive(b);
  await admin();await query('update atlas_pod_private.members set enabled=false where user_id=$1',[driver]);
  await user(driver,'service_role');await assert.rejects(receive(b,{pdf:pdfHash}),{code:'42501'});
 });
 const denied=async fn=>{await db.exec('savepoint denied_email');try{await assert.rejects(fn(),{code:'42501'});}finally{await db.exec('rollback to savepoint denied_email');}};
 const emailClaim=(actor=driver,request=id(50),mode='send')=>scalar('select public.atlas_pod_email_claim($1,$2,$3,$4,$5)',[submission,actor,id(Number(actor.slice(-12))+100),request,mode]);
 const emailFinish=(request=id(50),message='gmail123',error=null)=>scalar('select public.atlas_pod_email_finish($1,$2,$3,$4)',[submission,request,message,error]);
 const received=async()=>{await user(office);const b=await bind();await user(driver,'service_role');await receive(b,{pdf:pdfHash});return b;};
 await scenario('email claims serialize duplicate calls, persist receipt and audit an explicit office resend',async()=>{
  await received();assert.equal((await emailClaim()).claimed,true);assert.equal((await emailClaim(driver,id(51))).claimed,false);
  const sent=await emailFinish();assert.equal(sent.email_status,'sent');assert.equal(sent.gmail_message_id,'gmail123');assert.ok(sent.email_sent_at);
  assert.equal((await emailClaim()).claimed,false);assert.equal((await emailClaim(driver,id(52))).claimed,false);
  await denied(()=>emailClaim(driver,id(52),'resend'));
  await admin();await query("update atlas_pod_private.submissions set email_attempted_at=now()-interval '1 minute'");
  await user(office,'service_role');assert.equal((await emailClaim(office,id(52),'resend')).claimed,true);await emailFinish(id(52),'gmail456');
  assert.equal((await emailClaim(office,id(52),'resend')).claimed,false);
  await user(office);const list=await scalar('select public.atlas_pod_list($1)',[day]);assert.equal(list.shipments[0].submission.email_retry_count,1);
  await admin();assert.equal(await scalar('select count(*)::int from atlas_pod_private.email_attempts'),2);
 });
 await scenario('email failure keeps PDF and uncertain outcomes require explicit resend',async()=>{
  await received();await emailClaim();await emailFinish(id(50),null,'GMAIL_SEND_REJECTED');
  await admin();assert.equal(await scalar('select pdf_hash from atlas_pod_private.submissions'),pdfHash);
  await query("update atlas_pod_private.submissions set email_attempted_at=now()-interval '1 minute'");
  await user(office,'service_role');assert.equal((await emailClaim(office,id(51),'retry')).claimed,true);await emailFinish(id(51),null,'SEND_OUTCOME_UNKNOWN');
  assert.equal((await emailClaim(office,id(52),'retry')).claimed,false);
  await admin();await query("update atlas_pod_private.submissions set email_attempted_at=now()-interval '1 minute'");
  await user(office,'service_role');assert.equal((await emailClaim(office,id(52),'resend')).claimed,true);
 });
 await scenario('email access stays scoped to assigned driver/CA, service RPCs and current sessions',async()=>{
  await received();
  for(const who of [other,texas]){await user(who);await denied(()=>scalar('select public.atlas_pod_email_context($1)',[submission]));}
  await user(driver);assert.equal((await scalar('select public.atlas_pod_email_context($1)',[submission])).document.id,submission);
  await denied(()=>emailClaim());await denied(()=>query('select * from atlas_pod_private.email_attempts'));
  await admin();await query('delete from auth.sessions where user_id=$1',[driver]);await user(driver,'service_role');await assert.rejects(emailClaim(),{code:'42501'});
 });

});
