/* Native POD capture with account/warehouse-scoped recovery. Disabled until activation. */
(() => {
  'use strict';
  const endpoint='https://dwrrbpiprcmajfyronlf.supabase.co/functions/v1/delivery-pod';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let enabled=false,root=null,date=()=>'',owner=null,generation=0,controller=null,shipments=[],selected=null,pages=[],draft=null,drafts=[],busy=false,error='',view='list',dirty=false,syncing=false,timer=null;
  const urls=new Set(),queue=()=>window.atlasRoutingPodQueue;
  // Routing and its server list are currently CA-only. Never infer warehouse from user-editable metadata.
  const scope=()=>({userId:owner,warehouse:'CA'});
  const active=gen=>gen===generation && owner===window.AtlasAuth?.getSession()?.user?.id;
  function release(){urls.forEach(url=>URL.revokeObjectURL(url));urls.clear();pages=[];selected=null;draft=null;dirty=false;}
  function reset(){generation++;clearTimeout(timer);controller?.abort();controller=null;release();shipments=[];drafts=[];owner=null;busy=false;syncing=false;error='';view='list';render();}
  async function request(body,signal){
    const requestOwner=owner,gen=generation,session=await window.AtlasAuth?.getValidSession();
    if(!session||session.user.id!==requestOwner||!active(gen))throw Object.assign(Error('Sign in again to continue.'),{retryable:false});
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body),cache:'no-store',redirect:'error',signal});
    if(!response.ok){const result=await response.json().catch(()=>({}));throw Object.assign(Error(result.error==='POD_NOT_ACTIVATED'?'POD storage has not been activated.':response.status===401?'Sign in again before retrying.':response.status===403?'This account no longer has access to this shipment.':response.status===409?'The shipment or submission changed. Contact the office.':response.status<500&&response.status!==429?'The POD needs review before retrying.':'Connection interrupted. The scan remains saved on this device.'),{retryable:result.error!=='POD_NOT_ACTIVATED'&&(response.status>=500||response.status===429)});}
    return response;
  }
  async function refreshDrafts(gen=generation){const result=await queue().list(scope());if(active(gen))drafts=result;}
  async function saveCapture(){
    const gen=generation;dirty=true;
    const result=await queue().write(scope(),{binding:selected,date:draft?.date||date(),pages,status:draft?.status||'draft',submissionId:draft?.submissionId||null,attempts:draft?.attempts||0,retryAt:draft?.retryAt||0,message:draft?.message||''},draft?.revision||0);
    if(!active(gen))return;draft=result;dirty=false;await refreshDrafts(gen);
  }
  async function load(){
    if(!enabled||busy||syncing)return;const session=window.AtlasAuth?.getSession();if(!session)return;
    if(dirty&&!confirm('These pages have not been saved. Leave them?'))return;
    reset();owner=session.user.id;busy=true;const gen=generation;controller=new AbortController();render();
    try{await refreshDrafts(gen);if(!active(gen))return;
      if(navigator.onLine){const result=await(await request({action:'list',date:date()},controller.signal)).json();if(!active(gen))return;
        if(result.warehouse&&result.warehouse!=='CA')throw Error('Unexpected warehouse. Reopen Delivery Routing.');shipments=result.shipments||[];
      }else error='Offline. Saved scans are available below.';
    }catch(e){if(active(gen)&&e.name!=='AbortError')error=e.message;}
    finally{if(active(gen)){busy=false;render();void drain();}}
  }
  const label=d=>d.status==='received'?'POD received':d.status==='queued'?(d.attempts>=3?'Saved · Retry needed':'Saved · Waiting to send'):d.status==='attention'?'Saved · Needs attention':'Saved draft · Not submitted';
  function render(){
    if(!root)return;
    if(!enabled){root.innerHTML='<h2>Delivery documents</h2><p>POD storage is awaiting activation.</p><p>Driver access and private storage must be verified before real PODs can be submitted. No emails are being sent.</p>';return;}
    root.innerHTML=`<div class="atlas-pod-heading"><div><small>CHUBBY GORILLA · DELIVERY DOCUMENTS</small><h2>${view==='list'?'Delivery documents':'Review POD'}</h2></div><button type="button" class="atlas-route-button" data-pod-action="refresh" ${busy||syncing?'disabled':''}>${view==='list'?'Refresh':'Done'}</button></div>${error?`<p role="alert" class="atlas-route-planning-review">${esc(error)}</p>`:''}${busy?'<p role="status">Saving… Keep this page open.</p>':syncing?'<p role="status">Sending saved POD…</p>':''}`;
    if(view==='list'){
      if(drafts.length)root.insertAdjacentHTML('beforeend',`<h3>Saved on this device</h3>${drafts.map(d=>`<article class="atlas-pod-delivery"><div><strong>${esc(d.binding.customer)}</strong><p>${esc(d.binding.sales_order)} · ${esc(d.date)}</p><small>${label(d)}</small></div><button type="button" class="atlas-route-button" data-pod-resume="${esc(d.binding.id)}" ${busy||syncing?'disabled':''}>${d.status==='received'?'View saved copy':'Resume'}</button></article>`).join('')}`);
      root.insertAdjacentHTML('beforeend',shipments.length?shipments.map(s=>`<article class="atlas-pod-delivery"><div><strong>${esc(s.customer)}</strong><p>${esc(s.sales_order)} · Trip ${s.trip_index+1} · Shipment ${s.shipment_number} of ${s.shipment_total}</p><small>${esc(s.address)}</small><p>${s.submission?.state==='received'?'POD received · Email disabled':s.current?'POD not received':'Shipment changed · Office review required'}</p></div><button type="button" class="atlas-route-button ${s.submission?.state==='received'?'':'atlas-route-primary'}" data-pod-${s.submission?.state==='received'?'download':'scan'}="${esc(s.id)}" ${!s.current||busy||syncing?'disabled':''}>${s.submission?.state==='received'?'Download PDF':drafts.some(d=>d.binding.id===s.id)?'Resume scan':'Scan POD'}</button></article>`).join(''):'<div class="atlas-route-plan-empty"><strong>No assigned POD deliveries loaded</strong><p>Saved scans above remain available. New deliveries require a connection and an office-approved shipment link.</p></div>');
    }else if(selected){
      const frozen=!!draft?.submissionId,received=draft?.status==='received';
      root.insertAdjacentHTML('beforeend',`<div class="atlas-pod-delivery"><div><strong>${esc(selected.customer)}</strong><p>${esc(window.atlasRoutingPodCore.naming(selected.sales_order,selected.shipment_number,selected.shipment_total).filename)}</p></div></div><p>Check that signatures, dates, stamps and all page edges are readable.</p><div class="atlas-pod-pages">${pages.map((p,i)=>`<figure><img src="${p.url}" alt="POD page ${i+1}"/><figcaption>Page ${i+1}${p.lowResolution?' · Low resolution — check readability':''}</figcaption><div><button type="button" class="atlas-route-button" data-pod-rotate="${i}" ${busy||syncing||frozen?'disabled':''}>Rotate</button><button type="button" class="atlas-route-button" data-pod-remove="${i}" ${busy||syncing||frozen?'disabled':''}>Remove</button></div></figure>`).join('')}</div><input data-pod-file type="file" accept="image/jpeg,image/png" capture="environment" hidden/><div class="atlas-route-card-tools"><button type="button" class="atlas-route-button" data-pod-action="photo" ${busy||syncing||frozen||pages.length>=10?'disabled':''}>${pages.length?'Add Page':'Take Photo'}</button><button type="button" class="atlas-route-button atlas-route-primary" data-pod-action="submit" ${busy||syncing||!pages.length||received?'disabled':''}>${received?'POD received':frozen?'Retry saved POD':'Submit POD'}</button>${dirty?'<button type="button" class="atlas-route-button" data-pod-action="save">Retry saving</button>':''}${received?'<button type="button" class="atlas-route-button" data-pod-action="remove-copy">Remove saved copy</button>':''}</div><p role="status" class="atlas-dispatch-muted">${dirty?'Not saved — keep this page open and retry saving.':draft?`${label(draft)}. ${esc(draft.message)}`:'Take a photo to begin.'}</p><p class="atlas-dispatch-muted">Saved scans stay on this device for this account. Do not clear site data before receipt. Sending resumes while ATLAS is open; phone storage cleanup can remove local data. Email is disabled.</p>`);
    }
  }
  function showDraft(record){release();draft=record;selected=record.binding;pages=record.pages.map(p=>{const url=URL.createObjectURL(p.blob);urls.add(url);return {...p,url};});view='capture';error='';render();}
  async function transform(original,rotation=0){
    const bitmap=await createImageBitmap(original),scale=Math.min(1,2200/Math.max(bitmap.width,bitmap.height));
    const w=Math.round(bitmap.width*scale),h=Math.round(bitmap.height*scale),canvas=document.createElement('canvas');canvas.width=rotation%180?h:w;canvas.height=rotation%180?w:h;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(bitmap,-w/2,-h/2,w,h);bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.92));if(!blob)throw Error('Unable to read this photo. Use a JPEG or PNG.');
    const url=URL.createObjectURL(blob);urls.add(url);return {original,blob,url,rotation,lowResolution:Math.min(w,h)<1000};
  }
  async function submit(){
    if(busy||syncing||!pages.length||!selected)return;busy=true;error='';const gen=generation;render();
    try{if(dirty||!draft)await saveCapture();if(!active(gen)||dirty)return;
      draft=await queue().write(scope(),{...draft,status:'queued',submissionId:draft.submissionId||crypto.randomUUID(),attempts:0,retryAt:0,message:''},draft.revision);
      if(!active(gen))return;await refreshDrafts(gen);
    }catch(e){if(active(gen))error=e.message;}
    finally{if(active(gen)){busy=false;render();void drain();}}
  }
  async function drain(){
    if(!enabled||!owner||syncing||busy||!navigator.onLine||document.hidden||!drafts.some(d=>d.status==='queued'&&d.attempts<3))return;
    const gen=generation,partition=scope();let contended=false;syncing=true;clearTimeout(timer);render();
    try{
      const run=async()=>{
        if(!active(gen))return;await refreshDrafts(gen);if(!active(gen))return;
        const candidate=drafts.find(d=>d.status==='queued'&&d.attempts<3&&d.retryAt<=Date.now());if(!candidate)return;
        // Atomic revision check prevents two tabs from claiming the same draft; lease bounds overlap without Web Locks.
        let current=await queue().write(partition,{...candidate,attempts:candidate.attempts+1,retryAt:Date.now()+60000},candidate.revision);
        if(!active(gen))return;controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),45000);render();
        try{
          const result=await(await request({action:'list',date:current.date},controller.signal)).json();if(!active(gen))return;
          const binding=result.shipments?.find(b=>b.id===current.binding.id);
          if(!binding||binding.warehouse_id!==current.binding.warehouse_id)throw Object.assign(Error('Shipment access changed. Contact the office.'),{retryable:false});
          if(binding.submission?.state==='received'){
            if(binding.submission.id!==current.submissionId)throw Object.assign(Error('Another POD is already recorded for this shipment. Contact the office.'),{retryable:false});
          }else{
            if(!binding.current||binding.sales_order!==current.binding.sales_order||binding.shipment_number!==current.binding.shipment_number||binding.shipment_total!==current.binding.shipment_total)throw Object.assign(Error('Shipment changed. Contact the office before retrying.'),{retryable:false});
            if(binding.submission?.id&&binding.submission.id!==current.submissionId)throw Object.assign(Error('Another submission is in progress. Contact the office.'),{retryable:false});
            const form=new FormData();form.set('bindingId',binding.id);form.set('submissionId',current.submissionId);form.set('reviewed','true');
            current.pages.forEach((p,i)=>{form.append('original',p.original,`original-${i}`);form.append('page',p.blob,`page-${i}.jpg`);});
            const receipt=await(await request(form,controller.signal)).json();if(!active(gen))return;
            if(receipt.state!=='received'||receipt.id!==current.submissionId)throw Error('Receipt not confirmed. The saved scan will be checked before retrying.');
          }
          current=await queue().write(partition,{...current,status:'received',retryAt:0,message:'Server receipt confirmed. Email disabled.'},current.revision);
        }catch(e){if(!active(gen))return;
          current=await queue().write(partition,{...current,status:e.retryable===false||current.attempts>=3?'attention':'queued',retryAt:Date.now()+window.atlasRoutingPodCore.retryDelay(current.attempts),message:e.retryable===false?e.message:current.attempts>=3?'Sending paused after three attempts. Check your connection, then retry.':'Connection interrupted. Saved for retry.'},current.revision);
        }finally{clearTimeout(timeout);}
        if(!active(gen))return;await refreshDrafts(gen);
        if(draft?.binding.id===current.binding.id){draft=current;if(current.status==='received'){release();view='list';}}
        if(current.status==='received'){const match=shipments.find(s=>s.id===current.binding.id);if(match)match.submission={id:current.submissionId,state:'received'};}
      };
      if(navigator.locks)await navigator.locks.request(`atlas-pod-send:${partition.userId}:${partition.warehouse}`,{ifAvailable:true},lock=>{if(lock)return run();contended=true;});else await run();
    }catch(e){if(e.code==='DRAFT_CONFLICT')contended=true;else if(active(gen))error=e.message;}
    finally{if(active(gen)){syncing=false;render();const pending=drafts.filter(d=>d.status==='queued'&&d.attempts<3);if(pending.length&&!contended)timer=setTimeout(()=>void drain(),Math.max(1000,Math.min(...pending.map(d=>d.retryAt))-Date.now()));}}
  }
  function mount(container,day){root=container;date=day;render();
    root.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||busy||syncing)return;const gen=generation;
      try{
        if(button.dataset.podScan||button.dataset.podResume){
          const id=button.dataset.podScan||button.dataset.podResume;await refreshDrafts(gen);if(!active(gen))return;
          const saved=drafts.find(d=>d.binding.id===id);if(saved)showDraft(saved);else{release();selected=shipments.find(s=>s.id===id);window.atlasRoutingPodCore.naming(selected.sales_order,selected.shipment_number,selected.shipment_total);view='capture';error='';render();}
        }else if(button.dataset.podDownload){
          busy=true;const response=await request({action:'download',bindingId:button.dataset.podDownload});const blob=await response.blob();if(!active(gen))return;
          const s=shipments.find(s=>s.id===button.dataset.podDownload),url=URL.createObjectURL(blob);urls.add(url);const a=document.createElement('a');a.href=url;a.download=window.atlasRoutingPodCore.naming(s.sales_order,s.shipment_number,s.shipment_total).filename;a.click();busy=false;
        }else if(button.dataset.podRotate!==undefined){
          if(draft?.submissionId)return;const i=Number(button.dataset.podRotate),page=pages[i];busy=true;
          const replacement=await transform(page.original,(page.rotation+90)%360);if(!active(gen)){URL.revokeObjectURL(replacement.url);urls.delete(replacement.url);return;}
          URL.revokeObjectURL(page.url);urls.delete(page.url);pages[i]=replacement;await saveCapture();busy=false;render();
        }else if(button.dataset.podRemove!==undefined){
          if(draft?.submissionId||!confirm('Remove this page from the saved scan?'))return;
          const [page]=pages.splice(Number(button.dataset.podRemove),1);URL.revokeObjectURL(page.url);urls.delete(page.url);busy=true;await saveCapture();busy=false;render();
        }else if(button.dataset.podAction==='photo')root.querySelector('[data-pod-file]').click();
        else if(button.dataset.podAction==='submit')await submit();
        else if(button.dataset.podAction==='save'){busy=true;await saveCapture();busy=false;render();}
        else if(button.dataset.podAction==='refresh')await load();
        else if(button.dataset.podAction==='remove-copy'&&draft?.status==='received'&&confirm('Remove this device’s saved copy? The received server POD will remain.')){await queue().remove(scope(),draft.binding.id,draft.revision);if(!active(gen))return;release();view='list';await load();}
      }catch(e){if(active(gen)){error=e.message;busy=false;render();}}
    });
    root.addEventListener('change',async event=>{
      if(!event.target.matches('[data-pod-file]')||busy||syncing||draft?.submissionId)return;const file=event.target.files[0];if(!file)return;const gen=generation;busy=true;error='';
      try{
        if(!['image/jpeg','image/png'].includes(file.type)||file.size>15_000_000)throw Error('Choose a JPEG or PNG photo smaller than 15 MB.');
        const page=await transform(file);if(!active(gen)){URL.revokeObjectURL(page.url);urls.delete(page.url);return;}
        pages.push(page);await saveCapture();
      }catch(e){if(active(gen))error=e.message;}finally{if(active(gen)){busy=false;render();}}
    });
  }
  window.addEventListener('atlas-auth-changed',event=>{if(owner&&event.detail?.session?.user?.id===owner){void drain();return;}reset();});
  window.addEventListener('storage',event=>{if(/warehouse/i.test(event.key||''))reset();});
  window.addEventListener('online',()=>void drain());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void drain();});
  window.addEventListener('beforeunload',event=>{if(dirty||busy){event.preventDefault();event.returnValue='';}});
  window.atlasRoutingPOD=Object.freeze({configure:config=>{enabled=config.enabled===true;reset();},mount,load,reset,hasPending:()=>dirty||busy});
})();
