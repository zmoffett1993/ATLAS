/* Origin-local POD drafts. No credentials; uploads still require current server authorization. */
(() => {
  'use strict';
  const database='atlas-pod-drafts-v1';
  const conflict=()=>Object.assign(Error('This scan changed in another tab. Reopen the saved scan.'),{code:'DRAFT_CONFLICT'});
  function scopeKey(scope){
    if(!scope?.userId || !['CA','TX'].includes(scope.warehouse))throw Error('A signed-in account and warehouse are required.');
    return JSON.stringify([scope.userId,scope.warehouse]);
  }
  let connection;
  function open(){
    if(!connection)connection=new Promise((resolve,reject)=>{
      const request=indexedDB.open(database,1);
      request.onupgradeneeded=()=>{const table=request.result.createObjectStore('drafts',{keyPath:'key'});table.createIndex('scope','scope');};
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Close other ATLAS tabs and reopen your saved scans.'));
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
    }).catch(error=>{connection=null;throw error;});
    return connection;
  }
  function clean(scope,input){
    const b=input.binding, naming=window.atlasRoutingPodCore;
    naming.submissionId(b?.id);naming.naming(b.sales_order,b.shipment_number,b.shipment_total,b.is_test===true);
    if(input.submissionId)naming.submissionId(input.submissionId);
    if(!['draft','queued','attention','received'].includes(input.status)||!Array.isArray(input.pages)||input.pages.length>10)throw Error('Invalid saved POD.');
    const pages=input.pages.map(p=>{
      if(!(p.original instanceof Blob)||!(p.blob instanceof Blob)||!['image/jpeg','image/png'].includes(p.original.type)||p.blob.type!=='image/jpeg')throw Error('Invalid POD image.');
      return {original:p.original,blob:p.blob,rotation:p.rotation||0,lowResolution:!!p.lowResolution};
    });
    if(pages.reduce((n,p)=>n+p.original.size+p.blob.size,0)>24_000_000)throw Error('These pages are too large to submit together. Use smaller photos.');
    const partition=scopeKey(scope);
    return {key:JSON.stringify([scope.userId,scope.warehouse,b.id]),scope:partition,
      binding:{id:b.id,warehouse_id:b.warehouse_id,...(b.workflow==='assigned-trip'?{workflow:b.workflow,is_test:b.is_test===true,trip_version:b.trip_version}:{}),customer:String(b.customer||''),sales_order:b.sales_order,
        shipment_number:b.shipment_number,shipment_total:b.shipment_total,trip_index:b.trip_index,address:String(b.address||'')},
      date:input.date,pages,status:input.status,submissionId:input.submissionId||null,
      attempts:input.attempts||0,retryAt:input.retryAt||0,message:String(input.message||''),updatedAt:Date.now()};
  }
  async function list(scope){
    const db=await open();return new Promise((resolve,reject)=>{
      const tx=db.transaction('drafts','readonly'),r=tx.objectStore('drafts').index('scope').getAll(scopeKey(scope));
      tx.oncomplete=()=>resolve(r.result.sort((a,b)=>b.updatedAt-a.updatedAt));tx.onerror=()=>reject(tx.error);
    });
  }
  async function write(scope,input,expectedRevision=0){
    const record=clean(scope,input),db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.get(record.key);let failure;
      r.onsuccess=()=>{
        const previous=r.result;
        if((previous?.revision||0)!==expectedRevision){failure=conflict();tx.abort();return;}
        if(previous?.submissionId && (record.submissionId!==previous.submissionId || record.status==='draft')){
          failure=conflict();tx.abort();return;
        }
        record.revision=expectedRevision+1;store.put(record);
      };
      tx.oncomplete=()=>resolve(record);tx.onabort=()=>reject(failure||tx.error||Error('Scan could not be saved on this device.'));
    });
  }
  async function remove(scope,bindingId,revision){
    const key=JSON.stringify([scope.userId,scope.warehouse,bindingId]),db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.get(key);let failure;
      r.onsuccess=()=>{if(r.result?.revision!==revision){failure=conflict();tx.abort();return;}store.delete(key);};
      tx.oncomplete=resolve;tx.onabort=()=>reject(failure||tx.error);
    });
  }
  window.atlasRoutingPodQueue=Object.freeze({list,write,remove});
})();
