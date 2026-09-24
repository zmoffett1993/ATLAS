/* Native POD capture with account/warehouse-scoped recovery. Disabled until activation. */
(() => {
  'use strict';
  const endpoint='https://dwrrbpiprcmajfyronlf.supabase.co/functions/v1/delivery-pod';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let enabled=false,root=null,date=()=>'',owner=null,generation=0,controller=null,shipments=[],selected=null,pages=[],draft=null,drafts=[],busy=false,error='',view='list',dirty=false,syncing=false,timer=null;
  let capability=null,emailEnabled=false,management=null,assigning=false;
  let driverTab='today',driverTrip=null,driverStop=0,loadedDay='';
  const isDriver=()=>root?.closest('[data-driver-mode="true"]')!=null;
  const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({today:'<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16m-11 5h2"/>',stops:'<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M8 5h8a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h8"/>',documents:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8m-8 4h5"/>',truck:'<path d="M3 5h11v12H3zm11 5h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',arrow:'<path d="m9 5 7 7-7 7"/>',check:'<path d="m5 12 4 4L19 6"/>',camera:'<path d="m8 5 1-2h6l1 2h4a2 2 0 0 1 2 2v12H2V7a2 2 0 0 1 2-2z"/><circle cx="12" cy="12" r="4"/>'})[name]||''}</svg>`;
  const urls=new Set(),queue=()=>window.atlasRoutingPodQueue;
  let screenKey='';
  const glyph=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>',pin:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',box:'<path d="m3 7 9-5 9 5v10l-9 5-9-5Zm0 0 9 5 9-5M12 12v10M7 4.8l9 5"/>',warning:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6zM12 7v6m0 4h.01"/>'})[name]||''}</svg>`;
  const quantity=(n,unit)=>`${n} ${unit}${Number(n)===1?'':unit==='box'?'es':'s'}`;
  function driverHero(trip,stops,index=0){
    const saved=stops.filter(s=>s.submission?.state==='received').length;
    const vehicle=stops[0]?.source_assignment?.split(':')[1];
    return `<section class="atlas-driver-hero"><small>YOUR ROUTE</small><div class="atlas-driver-hero-title"><h2>Trip ${trip+1}</h2><span class="atlas-driver-badge">${stops.every(s=>['complete','exception'].includes(s.status))?'Trip complete':saved===stops.length?'PODs saved':'Assigned'}</span></div><p>${icon('truck')}${vehicle==='truck'?'Box Truck':vehicle==='van2'?'Cargo Van 2':'Cargo Van 1'} · ${quantity(stops.length,'stop')} · ${quantity(stops.reduce((n,s)=>n+Number(s.source_shipment?.palletSpaces||0),0),'pallet')}</p><progress value="${saved}" max="${stops.length}" aria-label="Trip ${trip+1} PODs saved"></progress><div class="atlas-driver-hero-progress"><span>STOP ${index+1} OF ${stops.length}</span><span>${saved} PODs saved</span></div></section>`;
  }
  function driverStopCard(s,i){
    const received=s.submission?.state==='received',details=s.delivery||{},boxes=s.source_shipment?.boxAllocation||[];
    const pallets=Number(s.source_shipment?.palletSpaces||0),count=boxes.reduce((n,l)=>n+Number(l.boxes||0),0);
    const next=shipments.find(x=>x.trip_index===s.trip_index&&x.submission?.state!=='received');
    return `${s.is_test?'<p class="atlas-driver-check">TEST MODE · Do not load or deliver</p>':''}<section class="atlas-driver-trip"><ol class="atlas-driver-stops"><li class="atlas-driver-stop ${received?'is-received':''}"><div class="atlas-driver-stop-eyebrow">${received?'POD SAVED':next?.id===s.id?'NEXT POD TO CAPTURE':'SELECTED STOP'}</div><div class="atlas-driver-stop-heading"><div><h4>${esc(s.customer)}</h4><p>${esc(s.sales_order)}</p></div><strong class="atlas-driver-pallets">${pallets}<small>${pallets===1?'PALLET':'PALLETS'}</small></strong></div><p class="atlas-driver-address">${glyph('pin')}<span>${esc(s.address)}</span></p><div class="atlas-driver-tiles">${details.timeWindow?`<div class="atlas-driver-tile atlas-driver-hours">${glyph('clock')}<div><strong>Customer hours</strong><span>${esc(details.timeWindow)}</span></div></div>`:''}<div class="atlas-driver-tile">${icon('documents')}<div><strong>POD status</strong><span>${received?'Saved':s.current?'Not yet saved':'Shipment changed'}</span></div></div></div>${details.checkOnDelivery?'<p class="atlas-driver-check">CHECK ON DELIVERY</p>':''}${details.notes?`<div class="atlas-driver-notes atlas-driver-banner ${/\b(test|synthetic)\b/i.test(details.notes)?'is-warning':'is-note'}">${glyph('warning')}<p>${esc(details.notes)}</p></div>`:''}${s.shipment_total>1?`<div class="atlas-driver-banner atlas-driver-split">${glyph('warning')}<div><strong>SHIPMENT ${s.shipment_number} OF ${s.shipment_total} — SPLIT SHIPMENT</strong><p>Load only the pallet count assigned to this shipment. Confirm SKU and box allocation before loading.</p><p>${s.shipment_number<s.shipment_total?`Remaining pallets for this customer are allocated to the other shipments, including Shipment ${s.shipment_number+1} of ${s.shipment_total}.`:'This is the final shipment; earlier pallets are allocated to the preceding shipments.'}</p></div></div>`:''}<details class="atlas-driver-boxes"><summary aria-expanded="false" aria-controls="atlasDriverLoad${i}">${glyph('box')}<span>Load details<small>${quantity(pallets,'pallet')} · ${quantity(count,'box')} assigned</small></span>${icon('arrow')}</summary><div id="atlasDriverLoad${i}">${boxes.map(l=>`<p><span>${esc(l.sku)}</span><b>${quantity(Number(l.boxes),'box')}</b></p>`).join('')}</div></details><p class="atlas-driver-status">${received?esc(emailLabel(s.submission)):s.current?'Scan the signed delivery document after unloading.':'Shipment changed · ask the office'}</p><div class="atlas-driver-stop-actions">${s.is_test ? '<span class="atlas-route-button" aria-disabled="true">Test address · Maps unavailable</span>' : `<a class="atlas-route-button" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}" target="_blank" rel="noopener noreferrer">${glyph('pin')}Open in Maps</a>`}${received?`<button type="button" class="atlas-route-button" data-pod-download="${esc(s.id)}" ${busy||syncing?'disabled':''}>${icon('documents')}Download PDF</button>`:`<button type="button" class="atlas-route-button atlas-route-primary" data-pod-scan="${esc(s.id)}" ${!s.current||busy||syncing?'disabled':''}>${icon('camera')}${drafts.some(d=>d.binding.id===s.id)?'Resume scan':'Scan POD'}</button>`}</div>${s.workflow==='assigned-trip'?`<div class="atlas-driver-stop-operations"><p>${esc(s.status==='exception'?s.exception:s.status)}</p>${!['complete','exception'].includes(s.status)?`<button type="button" class="atlas-route-button" data-driver-arrived="${esc(s.id)}">Mark Arrived</button><label>Recipient name<input data-driver-recipient="${esc(s.id)}" maxlength="160" value="${esc(s.recipient||'')}"/></label>${details.signatureRequired?`<label><input type="checkbox" data-driver-signature="${esc(s.id)}"/> Recipient signature is visible on the POD</label>`:''}${details.checkOnDelivery?`<label><input type="checkbox" data-driver-collected="${esc(s.id)}"/> Check collected</label>`:''}<button type="button" class="atlas-route-button atlas-route-primary" data-driver-complete="${esc(s.id)}" ${received?'':'disabled'}>Complete Stop</button><button type="button" class="atlas-route-button" data-driver-problem="${esc(s.id)}">Report a Problem</button>`:''}</div>`:''}</li></ol></section>`;
  }
  function driverHeader(){
    const stops=shipments.filter(s=>s.trip_index===driverTrip);
    const context=view==='capture'?'Proof of delivery':driverTab==='stops'&&stops.length?`Trip ${driverTrip+1} · Stop ${driverStop+1} of ${stops.length}`:driverTab==='documents'?'Your documents':'My deliveries';
    return `<div class="atlas-pod-heading atlas-driver-shell"><div class="atlas-driver-shell-row"><button type="button" class="atlas-driver-menu" data-route-host-menu aria-label="Open ATLAS menu">${glyph('menu')}</button><img class="atlas-driver-brand" src="./atlas-brand-landscape-dark.svg?v=128" alt="ATLAS"/><button type="button" class="atlas-route-button atlas-driver-refresh" data-pod-action="refresh" aria-label="${view==='list'?'Refresh route':'Done'}" ${busy||syncing||assigning?'disabled':''}>${view==='list'?glyph('refresh'):'Done'}</button></div><div class="atlas-driver-shell-context"><span>${esc(context)}</span>${view==='list'?`<label class="atlas-driver-date">${icon('today')}<input type="date" data-pod-day aria-label="Delivery day" value="${esc(date())}" ${busy||syncing?'disabled':''}/></label>`:''}</div></div>`;
  }
  // These RPCs authorize current sessions on the server. The UI never grants roles.
  async function driverRPC(action,payload={}){
    const ownerId=window.AtlasAuth?.getSession()?.user?.id;
    const session=await window.AtlasAuth?.getValidSession();
    const config=window.atlasSupabaseConfig;
    if(!ownerId||session?.user?.id!==ownerId||!config?.key)throw Error('Sign into ATLAS again.');
    const response=await fetch(`https://dwrrbpiprcmajfyronlf.supabase.co/rest/v1/rpc/atlas_pod_${action}`,{method:'POST',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),headers:{apikey:config.key,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(window.AtlasAuth?.getSession()?.user?.id!==ownerId)throw Error('The ATLAS account changed. Reopen Delivery Routing.');
    const result=await response.json();
    if(window.AtlasAuth?.getSession()?.user?.id!==ownerId)throw Error('The ATLAS account changed. Reopen Delivery Routing.');
    if(!response.ok){
      const messages={SAVED_DAY_CHANGED:'This day changed. Refresh assignments before continuing.',COMPLETE_SHIPMENT_ALLOCATION_REQUIRED:'This split order has pallets still waiting. Finish its shipment allocation before assigning POD access.',POD_TRIP_ALREADY_ASSIGNED:'This trip already has a driver. Refresh to see the assignment.',POD_ASSIGNMENT_CHANGED:'A linked shipment changed. Contact the office before assigning it.',APPROVED_DRIVER_REQUIRED:'Choose an active CA warehouse worker.',POD_OFFICE_REQUIRED:'Only an authorized administrator can assign deliveries.'};
      throw Error(messages[result.message]||'Driver access is unavailable. Reconnect and refresh, or contact your supervisor.');
    }
    return result;
  }
  async function access(){return enabled?driverRPC('driver_access'):null;}
  // Routing and its server list are currently CA-only. Never infer warehouse from user-editable metadata.
  const scope=()=>({userId:owner,warehouse:'CA'});
  const active=gen=>gen===generation && owner===window.AtlasAuth?.getSession()?.user?.id;
  function release(){urls.forEach(url=>URL.revokeObjectURL(url));urls.clear();pages=[];selected=null;draft=null;dirty=false;}
  function reset(){generation++;clearTimeout(timer);controller?.abort();controller=null;release();shipments=[];drafts=[];capability=null;emailEnabled=false;management=null;assigning=false;owner=null;busy=false;syncing=false;error='';view='list';driverTab='today';driverTrip=null;driverStop=0;loadedDay='';render();}
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
    const navigation=owner===session.user.id&&loadedDay===date()?{tab:driverTab,trip:driverTrip,stop:driverStop}:null;
    reset();owner=session.user.id;loadedDay=date();if(navigation){driverTab=navigation.tab;driverTrip=navigation.trip;driverStop=navigation.stop;}busy=true;const gen=generation;controller=new AbortController();render();
    try{await refreshDrafts(gen);if(!active(gen))return;
      if(navigator.onLine){const result=await(await request({action:'list',date:date(),driverOnly:isDriver()},controller.signal)).json();if(!active(gen))return;
        if(result.warehouse&&result.warehouse!=='CA')throw Error('Unexpected warehouse. Reopen Delivery Routing.');shipments=result.shipments||[];capability=result.capability;emailEnabled=result.email_enabled===true;
      }else error='Offline. Saved scans are available below.';
    }catch(e){if(active(gen)&&e.name!=='AbortError')error=e.message;}
    finally{if(active(gen)){busy=false;render();void drain();}}
  }
  const label=d=>d.status==='received'?'POD received':d.status==='queued'?(d.attempts>=3?'Saved · Retry needed':'Saved · Waiting to send'):d.status==='attention'?'Saved · Needs attention':'Saved draft · Not submitted';
  function emailLabel(s){
    if(s.email_status==='disabled')return 'POD received · Email disabled';
    if(!emailEnabled)return 'POD received · Email disabled';
    if(s.email_status==='sent')return `Sent${s.email_sent_at?' · '+new Date(s.email_sent_at).toLocaleString():''}`;
    if(s.email_error_code==='SEND_OUTCOME_UNKNOWN')return 'Pending review · Check the recipient inbox before resending';
    if(s.email_status==='sending')return 'Email sending · Refresh to check status';
    if(s.email_status==='failed')return 'Email failed · POD saved. Management can retry.';
    return 'Email pending · POD saved';
  }
  function emailControls(s){
    if(s.is_test===true||!emailEnabled||capability!=='office'||s.submission?.state!=='received')return '';
    const sub=s.submission,uncertain=sub.email_error_code==='SEND_OUTCOME_UNKNOWN',sending=sub.email_status==='sending';
    const mode=sub.email_status==='sent'||uncertain||sending?'resend':'retry';
    const cooling=Date.now()-Date.parse(sub.email_attempted_at||0)<(sending?300000:30000);
    return `<button type="button" class="atlas-route-button" data-pod-email="${esc(sub.id)}" data-pod-email-mode="${mode}" ${busy||syncing||cooling?'disabled':''}>${mode==='resend'?'Resend Email':'Retry Email'}</button>`;
  }
  async function sendEmail(podId,mode='send'){
    return (await request({action:'send-email',podId,mode,requestId:crypto.randomUUID()},controller?.signal)).json();
  }
  function tripCards(tripFilter=null,stopFilter=null){
    if(isDriver()&&tripFilter!==null&&stopFilter!==null){const stops=shipments.filter(s=>s.trip_index===tripFilter);return stops[stopFilter]?driverStopCard(stops[stopFilter],stopFilter):'';}
    const trips=new Map();
    for(const s of shipments){if(!trips.has(s.trip_index))trips.set(s.trip_index,[]);trips.get(s.trip_index).push(s);}
    return [...trips].sort(([a],[b])=>a-b).filter(([trip])=>tripFilter===null||trip===tripFilter).map(([trip,stops])=>{
      const pallets=stops.reduce((sum,s)=>sum+Number(s.source_shipment?.palletSpaces||0),0);
      const vehicle=stops[0].source_assignment?.split(':')[1];
      const complete=stops.filter(s=>s.submission?.state==='received').length;
      return `<section class="atlas-driver-trip"><header><div><small>TRIP ${trip+1} · ${esc(stops[0].driver_name||'Assigned driver')}</small><h3>${vehicle==='truck'?'Box Truck':vehicle==='van2'?'Cargo Van 2':'Cargo Van 1'}</h3></div><span class="atlas-driver-progress">${complete} / ${stops.length} PODs saved</span></header><div class="atlas-driver-metrics"><span><b>${stops.length}</b> stops</span><span><b>${pallets}</b> pallets</span><span>Shipment documents</span></div><ol class="atlas-driver-stops">${stops.map((s,i)=>{
        if(stopFilter!==null&&i!==stopFilter)return '';
        const received=s.submission?.state==='received',details=s.delivery||{},boxes=s.source_shipment?.boxAllocation||[];
        return `<li class="atlas-driver-stop ${received?'is-received':''}"><div class="atlas-driver-stop-heading"><span class="atlas-driver-stop-number">${i+1}</span><div><h4>${esc(s.customer)}</h4><p>${esc(s.sales_order)}${s.shipment_total>1?` · Shipment ${s.shipment_number} of ${s.shipment_total}`:''}</p></div><strong class="atlas-driver-pallets">${Number(s.source_shipment?.palletSpaces||0)}<small>pallets</small></strong></div><p class="atlas-driver-address">${esc(s.address)}</p>${details.timeWindow?`<p class="atlas-driver-hours"><strong>Customer hours</strong> ${esc(details.timeWindow)}</p>`:''}${details.checkOnDelivery?'<p class="atlas-driver-check">CHECK ON DELIVERY</p>':''}${details.notes?`<p class="atlas-driver-notes">${esc(details.notes)}</p>`:''}<details class="atlas-driver-boxes"><summary>Load details · ${boxes.reduce((n,l)=>n+Number(l.boxes||0),0)} boxes</summary>${boxes.map(l=>`<p><span>${esc(l.sku)}</span><b>${Number(l.boxes)} boxes</b></p>`).join('')}</details><p class="atlas-driver-status">${received?esc(emailLabel(s.submission)):s.current?'POD not yet saved':'Shipment changed · ask the office'}</p><div class="atlas-driver-stop-actions"><a class="atlas-route-button" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}" target="_blank" rel="noopener noreferrer">Open in Maps</a>${received?`<button type="button" class="atlas-route-button" data-pod-download="${esc(s.id)}" ${busy||syncing?'disabled':''}>Download PDF</button>`:capability==='viewer'?'':`<button type="button" class="atlas-route-button atlas-route-primary" data-pod-scan="${esc(s.id)}" ${!s.current||busy||syncing?'disabled':''}>${drafts.some(d=>d.binding.id===s.id)?'Resume scan':'Scan POD'}</button>`}${emailControls(s)}</div></li>`;
      }).join('')}</ol></section>`;
    }).join('');
  }
  function driverNavigation(){
    return `<nav class="atlas-driver-nav" aria-label="My Deliveries">${['today','stops','documents'].map(tab=>`<button type="button" data-pod-tab="${tab}" aria-current="${driverTab===tab?'page':'false'}">${icon(tab)}<span>${tab==='today'?'Today':tab==='stops'?'Stops':'Documents'}</span></button>`).join('')}</nav>`;
  }
  function driverHome(){
    const groups=[...new Set(shipments.map(s=>s.trip_index))].sort((a,b)=>a-b);
    const name=shipments[0]?.driver_name||window.AtlasAuth?.getSession()?.user?.user_metadata?.display_name||'';
    const received=shipments.filter(s=>s.submission?.state==='received');
    const dayLabel=new Date(date()+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    const empty='<div class="atlas-driver-empty">'+icon('truck')+'<h3>No assigned trips</h3><p>Your deliveries will appear here once an administrator assigns a trip. Tap Refresh to check again.</p></div>';
    let content='';
    if(driverTab==='today'){
      content=`${shipments.some(s=>s.is_test)?'<p class="atlas-driver-check">TEST MODE · Do not load or deliver</p>':''}<div class="atlas-driver-intro"><small>YOUR DELIVERY DAY</small><h2>${name?`Hello, ${esc(name)}`:'Your deliveries'}</h2><p>${esc(dayLabel)}</p></div><div class="atlas-driver-day-stats"><div><strong>${groups.length}</strong><span>Trips</span></div><div><strong>${shipments.length}</strong><span>Stops</span></div><div><strong>${received.length}</strong><span>PODs saved</span></div></div>`;
      content+='<div class="atlas-driver-trip-grid">'+(groups.map(trip=>{
        const stops=shipments.filter(s=>s.trip_index===trip),done=stops.filter(s=>s.submission?.state==='received').length;
        const next=Math.max(0,stops.findIndex(s=>s.submission?.state!=='received'));
        return `<article class="atlas-driver-overview">${driverHero(trip,stops,next)}<button type="button" class="atlas-driver-next" data-pod-trip="${trip}" data-pod-stop="${next}"><span>${icon(stops[next].submission?.state==='received'?'check':'stops')}</span><div><small>${done===stops.length?'View trip stops':'Next POD to capture'}</small><strong>${esc(stops[next].customer)}</strong><span>${esc(stops[next].sales_order)}</span></div>${icon('arrow')}</button><button type="button" class="atlas-route-button atlas-route-primary" data-pod-trip="${trip}" data-pod-stop="${next}">View stops ${icon('arrow')}</button></article>`;
      }).join('')||empty)+'</div>';
      if(drafts.some(d=>d.status!=='received'))content+=`<button type="button" class="atlas-driver-draft-link" data-pod-tab="documents">${icon('documents')} ${drafts.filter(d=>d.status!=='received').length} saved scan(s) need attention ${icon('arrow')}</button>`;
    }else if(driverTab==='stops'){
      if(groups.length&&!groups.includes(driverTrip))driverTrip=groups[0];
      const stops=shipments.filter(s=>s.trip_index===driverTrip);if(stops.length)driverStop=Math.min(driverStop,stops.length-1);
      content=stops.length?driverHero(driverTrip,stops,driverStop):empty;
      if(stops.length)content+=`<div class="atlas-driver-trip-select" aria-label="Select trip">${groups.map(t=>`<button type="button" data-pod-trip="${t}" data-pod-stop="0" aria-pressed="${t===driverTrip}">Trip ${t+1}</button>`).join('')}</div>${tripCards(driverTrip,driverStop)}${stops.length>1?`<h3 class="atlas-driver-section-label">All stops · in route order</h3><nav class="atlas-driver-stepper" aria-label="Select stop">${stops.map((s,i)=>`<button type="button" data-pod-trip="${driverTrip}" data-pod-stop="${i}" aria-label="Stop ${i+1}: ${esc(s.customer)}" aria-current="${i===driverStop?'step':'false'}" class="${s.submission?.state==='received'?'is-saved':''}"><span class="atlas-driver-timeline-number">${s.submission?.state==='received'?icon('check'):i+1}</span><span><strong>${esc(s.customer)}</strong><small>${esc(s.sales_order)} · ${quantity(Number(s.source_shipment?.palletSpaces||0),'pallet')}${s.submission?.state==='received'?' · POD saved':''}</small></span>${icon('arrow')}</button>`).join('')}</nav>`:''}`;
    }else{
      content=`<div class="atlas-driver-intro"><small>PROOF OF DELIVERY</small><h2>Your documents</h2><p>Received PODs and scans saved on this device.</p></div>`;
      if(drafts.length)content+=`<h3 class="atlas-driver-section-label">On this device · all days</h3>${drafts.map(d=>`<article class="atlas-driver-document">${icon('documents')}<div><strong>${esc(d.binding.customer)}</strong><p>${esc(d.binding.sales_order)} · ${esc(d.date)}</p><small>${label(d)}</small></div><button type="button" class="atlas-route-button" data-pod-resume="${esc(d.binding.id)}">${d.status==='received'?'View':'Resume'}</button></article>`).join('')}`;
      content+=received.length?`<h3 class="atlas-driver-section-label">Received · ${esc(dayLabel)}</h3>${received.map(s=>`<article class="atlas-driver-document">${icon('check')}<div><strong>${esc(s.customer)}</strong><p>${esc(s.sales_order)}${s.shipment_total>1?` · ${s.shipment_number} of ${s.shipment_total}`:''}</p><small>${esc(emailLabel(s.submission))}</small></div><button type="button" class="atlas-route-button" data-pod-download="${esc(s.id)}">PDF</button></article>`).join('')}`:drafts.length?'':'<div class="atlas-driver-empty">'+icon('documents')+'<h3>No documents yet</h3><p>Scan a signed POD from a stop. Its saved copy will appear here.</p></div>';
    }
    return `<div class="atlas-driver-tab-content" data-pod-tab-view="${driverTab}">${content}</div>`+driverNavigation();
  }
  function assignmentPanel(){
    if(!management)return '';
    return `<section class="atlas-driver-assign"><h3>Assign a delivery driver</h3><p>Choose who will make each saved, sent-out trip. Backup drivers receive access only to their assigned stops. Planning times keep the original driver schedule.</p>${management.trips.length?management.trips.map(t=>`<form data-pod-assign-trip="${t.index}"><div><strong>Trip ${t.index+1}</strong><small>${t.stops} stops · ${t.pallets} pallets</small></div>${t.driver_name?`<strong>${esc(t.driver_name)}</strong>`:`<label><span>Driver</span><select name="driver" required ${assigning?'disabled':''}><option value="">Choose warehouse worker</option>${management.drivers.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><button class="atlas-route-button atlas-route-primary" type="submit" ${assigning?'disabled':''}>Assign Trip</button>`}</form>`).join(''):'<p>Save a sent-out trip first, then return here to assign its driver.</p>'}<button type="button" class="atlas-route-button" data-pod-action="close-assign">Done</button></section>`;
  }
  function capturePanel(){
    const frozen=!!draft?.submissionId,received=draft?.status==='received';
    const queued=draft?.status==='queued',attention=draft?.status==='attention'||dirty;
    const filename=window.atlasRoutingPodCore.naming(selected.sales_order,selected.shipment_number,selected.shipment_total,selected.is_test===true).filename;
    const stop=shipments.find(s=>s.id===selected.id);
    const next=isDriver()?shipments.find(s=>s.trip_index===selected.trip_index&&s.id!==selected.id&&s.current&&s.submission?.state!=='received'):null;
    const nextIndex=next?shipments.filter(s=>s.trip_index===next.trip_index).indexOf(next):0;
    const status=dirty?'Not saved — keep this page open and retry saving.':draft?`${label(draft)}. ${draft.message||''}`:'Take a photo to begin. Submit becomes available after a page is added.';
    return `<div class="atlas-pod-workflow ${received?'is-received':''}" data-pod-state="${received?'received':attention?'attention':queued?'queued':pages.length?'review':'capture'}">
      <header class="atlas-pod-workflow-title"><span class="atlas-pod-stage-icon">${icon(received?'check':pages.length?'documents':'camera')}</span><div><small>PROOF OF DELIVERY</small><h2>${isDriver()?(received?'POD received':pages.length?'Review POD':'Scan POD'):(received?'POD received':pages.length?'Review your POD':'Scan signed POD')}</h2><p>${received?'Your document is securely saved.':pages.length?'Check the signature and all four edges.':'Photograph the full signed page.'}</p></div></header>
      <div class="atlas-pod-customer"><span>${icon('stops')}</span><div><strong>${esc(selected.customer)}</strong><p>${esc(selected.sales_order)}</p></div><span class="atlas-pod-page-count">${pages.length} ${pages.length===1?'page':'pages'}</span></div>
      ${selected.shipment_total>1?`<p class="atlas-pod-split">Shipment ${selected.shipment_number} of ${selected.shipment_total} · Split shipment</p>`:''}
      ${received?`<section class="atlas-pod-receipt" role="status"><span class="atlas-pod-receipt-check">${icon('check')}</span><h3>Document saved</h3><p>${esc(stop?.submission?emailLabel(stop.submission):draft.message||'Server receipt confirmed.')}</p><div class="atlas-pod-receipt-file">${icon('documents')}<span>${esc(filename)}</span></div></section>`:''}
      <div class="atlas-pod-review-layout">${received?'<details class="atlas-pod-receipt-preview"><summary>View submitted pages</summary>':''}<div class="atlas-pod-pages">${pages.map((p,i)=>`<figure><div class="atlas-pod-paper"><img src="${p.url}" alt="POD page ${i+1}"/></div><figcaption><strong>Page ${i+1}</strong>${p.lowResolution?'<span class="atlas-pod-quality">Low resolution · check readability</span>':''}</figcaption><div class="atlas-pod-page-actions"><button type="button" class="atlas-route-button" data-pod-rotate="${i}" ${busy||syncing||frozen?'disabled':''}>Rotate</button><button type="button" class="atlas-route-button" data-pod-remove="${i}" ${busy||syncing||frozen?'disabled':''}>Remove</button></div></figure>`).join('')||`<div class="atlas-pod-camera-empty">${icon('camera')}<h3>Ready for the signed POD</h3><p>Use your phone camera, or choose a photo on this device.</p><button type="button" class="atlas-route-button atlas-route-primary" data-pod-action="photo" ${busy||syncing?'disabled':''}>${icon('camera')}Take Photo</button></div>`}</div>${received?'</details>':''}
      <aside class="atlas-pod-review-actions"><input data-pod-file type="file" accept="image/jpeg,image/png" capture="environment" hidden/>
      ${received?`<button type="button" class="atlas-route-button atlas-route-primary" ${next?`data-pod-next="${next.trip_index}" data-pod-stop="${nextIndex}"`:'data-pod-action="refresh"'}>${next?'Next stop':'Back to deliveries'}${icon('arrow')}</button>${stop?`<button type="button" class="atlas-route-button" data-pod-download="${esc(selected.id)}">${icon('documents')}Download PDF</button>`:''}`:`${pages.length?`<button type="button" class="atlas-route-button" data-pod-action="photo" ${busy||syncing||frozen||pages.length>=10?'disabled':''}>${icon('camera')}Add Page</button>`:''}<button type="button" class="atlas-route-button atlas-route-primary" data-pod-action="submit" aria-describedby="atlasPodCaptureStatus" ${busy||syncing||!pages.length?'disabled':''}>${icon('check')}${syncing?'Submitting…':frozen?'Retry saved POD':'Submit POD'}</button>`}
      ${dirty?'<button type="button" class="atlas-route-button" data-pod-action="save">Retry saving</button>':''}
      <p id="atlasPodCaptureStatus" role="status" class="atlas-pod-save-state ${attention?'needs-attention':queued?'is-queued':''}">${esc(status)}</p>
      ${!received?'<button type="button" class="atlas-route-button atlas-pod-back" data-pod-action="back-stop">Back to stop</button>':''}
      <details class="atlas-pod-storage-help"><summary>About saved scans</summary><p>Saved scans stay on this device for this account. Keep ATLAS open to finish sending. Do not clear site data before receipt; phone storage cleanup can remove local scans.${emailEnabled?'':' Email sending is disabled.'}</p>${received?'<button type="button" class="atlas-route-button" data-pod-action="remove-copy">Remove saved copy</button>':''}</details></aside></div></div>`;
  }
  function render(){
    if(!root)return;
    root.classList.toggle('atlas-driver-surface',isDriver());
    if(!enabled){root.innerHTML='<h2>Delivery documents</h2><p>POD storage is awaiting activation.</p><p>Driver access and private storage must be verified before real PODs can be submitted. No emails are being sent.</p>';return;}
    root.dataset.podView=view;
    if(isDriver()){
      const nextKey=[view,driverTab,driverTrip,driverStop,view==='capture'?(draft?.status==='received'?'received':pages.length?'review':'capture'):''].join(':');
      if(nextKey!==screenKey){screenKey=nextKey;requestAnimationFrame(()=>{if(isDriver()){window.scrollTo({top:0,behavior:'instant'});root.closest('.atlas-route')?.scrollTo({top:0,behavior:'instant'});}});}
    }
    root.innerHTML=`<div class="atlas-pod-heading">${isDriver()?'<img class="atlas-driver-brand" src="./atlas-brand-landscape-light.svg" alt="ATLAS"/>':`<div><small>CHUBBY GORILLA · DELIVERY ROUTING</small><h2>${view==='list'?'Delivery documents':'Shipment document'}</h2><p>${view==='list'?'Signed PODs, saved scans and driver assignments.':'Capture, review and save the signed POD.'}</p></div>`}<div class="atlas-route-card-tools">${view==='list'&&capability==='office'?'<button type="button" class="atlas-route-button" data-pod-action="assign">Assign Drivers</button>':''}<button type="button" class="atlas-route-button atlas-driver-refresh" data-pod-action="refresh" ${busy||syncing||assigning?'disabled':''}>${view==='list'?'Refresh':'Done'}</button></div></div>${error?`<p role="alert" class="atlas-route-planning-review">${esc(error)}</p>`:''}${busy?'<p role="status">Loading or saving… Keep this page open.</p>':syncing?'<p role="status">Submitting POD…</p>':''}`;
    if(isDriver()){
      root.querySelector('.atlas-pod-heading').outerHTML=driverHeader();
      if(!navigator.onLine)root.insertAdjacentHTML('beforeend','<p class="atlas-driver-offline" role="status">Offline · saved scans stay on this device until received.</p>');
    }
    if(view==='list'){
      if(isDriver()){
        root.insertAdjacentHTML('beforeend',driverHome());return;
      }
      if(drafts.length&&capability!=='viewer')root.insertAdjacentHTML('beforeend',`<h3>Saved on this device</h3>${drafts.map(d=>`<article class="atlas-pod-delivery"><div><strong>${esc(d.binding.customer)}</strong><p>${esc(d.binding.sales_order)} · ${esc(d.date)}</p><small>${label(d)}</small></div><button type="button" class="atlas-route-button" data-pod-resume="${esc(d.binding.id)}" ${busy||syncing?'disabled':''}>${d.status==='received'?'View saved copy':'Resume'}</button></article>`).join('')}`);
      root.insertAdjacentHTML('beforeend',assignmentPanel()+(shipments.length?tripCards():'<div class="atlas-route-plan-empty"><strong>No assigned deliveries for this day</strong><p>Your administrator can assign a trip when you are needed. Then tap Refresh. Saved scans above remain available.</p></div>'));
    }else if(selected){
      root.insertAdjacentHTML('beforeend',capturePanel());
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
    if(capability==='viewer')return;
    if(busy||syncing||!pages.length||!selected)return;busy=true;error='';const gen=generation;render();
    try{if(dirty||!draft)await saveCapture();if(!active(gen)||dirty)return;
      draft=await queue().write(scope(),{...draft,status:'queued',submissionId:draft.submissionId||crypto.randomUUID(),attempts:0,retryAt:0,message:''},draft.revision);
      if(!active(gen))return;await refreshDrafts(gen);
    }catch(e){if(active(gen))error=e.message;}
    finally{if(active(gen)){busy=false;render();void drain();}}
  }
  async function drain(){
    if(capability==='viewer')return;
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
          const result=await(await request({action:'list',date:current.date,driverOnly:isDriver()},controller.signal)).json();if(!active(gen))return;
          const binding=result.shipments?.find(b=>b.id===current.binding.id);
          if(!binding||binding.warehouse_id!==current.binding.warehouse_id)throw Object.assign(Error('Shipment access changed. Contact the office.'),{retryable:false});
          if(binding.submission?.state==='received'){
            if(binding.submission.id!==current.submissionId)throw Object.assign(Error('Another POD is already recorded for this shipment. Contact the office.'),{retryable:false});
          }else{
            if(!binding.current||binding.sales_order!==current.binding.sales_order||binding.shipment_number!==current.binding.shipment_number||binding.shipment_total!==current.binding.shipment_total)throw Object.assign(Error('Shipment changed. Contact the office before retrying.'),{retryable:false});
            if(binding.submission?.id&&binding.submission.id!==current.submissionId)throw Object.assign(Error('Another submission is in progress. Contact the office.'),{retryable:false});
            const form=new FormData();form.set('bindingId',binding.id);form.set('submissionId',current.submissionId);form.set('reviewed','true');if(binding.workflow==='assigned-trip'){form.set('workflow','assigned-trip');form.set('tripVersion',String(binding.trip_version));}
            current.pages.forEach((p,i)=>{form.append('original',p.original,`original-${i}`);form.append('page',p.blob,`page-${i}.jpg`);});
            const receipt=await(await request(form,controller.signal)).json();if(!active(gen))return;
            if(receipt.state!=='received'||receipt.id!==current.submissionId)throw Error('Receipt not confirmed. The saved scan will be checked before retrying.');
          }
          // The PDF receipt is durable even if the separate email call is interrupted.
          let mail={email_status:'disabled'};
          if(result.email_enabled===true && binding.is_test!==true){
            try{mail=await sendEmail(current.submissionId);}catch{mail={email_status:'pending'};}
            if(!active(gen))return;
          }
          const message=mail.email_status==='sent'?'POD SUBMITTED ✓':mail.email_status==='disabled'?'Server receipt confirmed. Email disabled.':'POD saved — email pending. Management can retry.';
          current=await queue().write(partition,{...current,status:'received',retryAt:0,message},current.revision);
          if(active(gen)){error=message;const match=shipments.find(s=>s.id===current.binding.id);if(match)match.submission={id:current.submissionId,state:'received',...mail};}
        }catch(e){if(!active(gen))return;
          current=await queue().write(partition,{...current,status:e.retryable===false||current.attempts>=3?'attention':'queued',retryAt:Date.now()+window.atlasRoutingPodCore.retryDelay(current.attempts),message:e.retryable===false?e.message:current.attempts>=3?'Sending paused after three attempts. Check your connection, then retry.':'Connection interrupted. Saved for retry.'},current.revision);
        }finally{clearTimeout(timeout);}
        if(!active(gen))return;await refreshDrafts(gen);
        if(draft?.binding.id===current.binding.id){draft=current;if(current.status==='received')error='';}
        if(current.status==='received'){const match=shipments.find(s=>s.id===current.binding.id);if(match)match.submission={...match.submission,id:current.submissionId,state:'received'};}
      };
      if(navigator.locks)await navigator.locks.request(`atlas-pod-send:${partition.userId}:${partition.warehouse}`,{ifAvailable:true},lock=>{if(lock)return run();contended=true;});else await run();
    }catch(e){if(e.code==='DRAFT_CONFLICT')contended=true;else if(active(gen))error=e.message;}
    finally{if(active(gen)){syncing=false;render();const pending=drafts.filter(d=>d.status==='queued'&&d.attempts<3);if(pending.length&&!contended)timer=setTimeout(()=>void drain(),Math.max(1000,Math.min(...pending.map(d=>d.retryAt))-Date.now()));}}
  }
  function mount(container,day){root=container;date=day;render();
    root.addEventListener('submit',async event=>{
      const form=event.target.closest('[data-pod-assign-trip]');if(!form)return;event.preventDefault();
      if(capability!=='office'||assigning||busy||!management)return;
      const gen=generation,dayValue=date(),driver=form.elements.driver.value,trip=Number(form.dataset.podAssignTrip),revision=management.revision;
      if(!driver)return;assigning=true;error='';render();
      try{await driverRPC('assign_trip',{p_day:dayValue,p_revision:revision,p_trip:trip,p_driver:driver});if(!active(gen)||date()!==dayValue)return;
        assigning=false;await load();
      }catch(e){if(active(gen)){assigning=false;error=e.message;render();}}
    });
    root.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||busy||syncing)return;const gen=generation;
      try{
        if(button.dataset.driverArrived||button.dataset.driverComplete||button.dataset.driverProblem){
          const id=button.dataset.driverArrived||button.dataset.driverComplete||button.dataset.driverProblem,s=shipments.find(s=>s.id===id);if(!s)return;
          const action=button.dataset.driverArrived?'arrived':button.dataset.driverComplete?'complete':'exception';
          const details=action==='complete'?{recipient:root.querySelector('[data-driver-recipient="'+id+'"]')?.value||'',signatureConfirmed:!!root.querySelector('[data-driver-signature="'+id+'"]')?.checked,collectionAck:!!root.querySelector('[data-driver-collected="'+id+'"]')?.checked}:action==='exception'?{reason:window.prompt('Customer unavailable, Rejected, Unable to deliver, or Other','Customer unavailable')}:{};
          if(action==='exception'&&!details.reason)return;await window.atlasRoutingAssignment.request('stop_action',{p_stop:id,p_version:s.trip_version,p_action:action,p_details:details});await load();
        }else if(button.dataset.podNext!==undefined){
          if(!isDriver()||draft?.status!=='received')return;
          driverTrip=Number(button.dataset.podNext);driverStop=Number(button.dataset.podStop||0);driverTab='stops';await load();
        }else if(button.dataset.podTab){
          if(!isDriver()||view!=='list')return;driverTab=button.dataset.podTab;render();root.querySelector(`[data-pod-tab="${driverTab}"]`)?.focus({preventScroll:true});
        }else if(button.dataset.podTrip!==undefined){
          if(!isDriver()||view!=='list')return;driverTrip=Number(button.dataset.podTrip);driverStop=Number(button.dataset.podStop||0);driverTab='stops';render();
        }else if(button.dataset.podScan||button.dataset.podResume){
          const id=button.dataset.podScan||button.dataset.podResume;await refreshDrafts(gen);if(!active(gen))return;
          const saved=drafts.find(d=>d.binding.id===id);if(saved)showDraft(saved);else{release();selected=shipments.find(s=>s.id===id);window.atlasRoutingPodCore.naming(selected.sales_order,selected.shipment_number,selected.shipment_total,selected.is_test===true);view='capture';error='';render();}
        }else if(button.dataset.podEmail){
          const mode=button.dataset.podEmailMode;
          if(mode==='resend'&&!confirm('Check the recipient inbox first. Resending may create another copy of this email. Send again?'))return;
          busy=true;error='';controller=new AbortController();render();
          const mail=await sendEmail(button.dataset.podEmail,mode);if(!active(gen))return;
          const shipment=shipments.find(s=>s.submission?.id===button.dataset.podEmail);if(shipment)Object.assign(shipment.submission,mail);
          busy=false;error=mail.email_status==='sent'?'POD email sent.':mail.email_status==='disabled'?'Email sending is not activated.':'POD saved. '+emailLabel(mail);render();
        }else if(button.dataset.podDownload){
          busy=true;const response=await request({action:'download',bindingId:button.dataset.podDownload,workflow:shipments.find(s=>s.id===button.dataset.podDownload)?.workflow});const blob=await response.blob();if(!active(gen))return;
          const s=shipments.find(s=>s.id===button.dataset.podDownload),url=URL.createObjectURL(blob);urls.add(url);const a=document.createElement('a');a.href=url;a.download=window.atlasRoutingPodCore.naming(s.sales_order,s.shipment_number,s.shipment_total,s.is_test===true).filename;a.click();busy=false;
        }else if(button.dataset.podRotate!==undefined){
          if(draft?.submissionId)return;const i=Number(button.dataset.podRotate),page=pages[i];busy=true;
          const replacement=await transform(page.original,(page.rotation+90)%360);if(!active(gen)){URL.revokeObjectURL(replacement.url);urls.delete(replacement.url);return;}
          URL.revokeObjectURL(page.url);urls.delete(page.url);pages[i]=replacement;await saveCapture();busy=false;render();
        }else if(button.dataset.podRemove!==undefined){
          if(draft?.submissionId||!confirm('Remove this page from the saved scan?'))return;
          const [page]=pages.splice(Number(button.dataset.podRemove),1);URL.revokeObjectURL(page.url);urls.delete(page.url);busy=true;await saveCapture();busy=false;render();
        }else if(button.dataset.podAction==='assign'){
          if(capability!=='office'||assigning)return;
          if(window.atlasDriverWorkspace){await window.atlasDriverWorkspace.manage(date());return;}busy=true;render();
          const result=await driverRPC('driver_roster',{p_day:date()});if(!active(gen))return;
          management=result;busy=false;render();
        }else if(button.dataset.podAction==='close-assign'){management=null;render();
        }else if(button.dataset.podAction==='photo')root.querySelector('[data-pod-file]').click();
        else if(button.dataset.podAction==='submit')await submit();
        else if(button.dataset.podAction==='save'){busy=true;await saveCapture();busy=false;render();}
        else if(button.dataset.podAction==='back-stop'){
          if(isDriver()&&selected){const stops=shipments.filter(s=>s.trip_index===selected.trip_index),index=stops.findIndex(s=>s.id===selected.id);driverTrip=selected.trip_index;driverStop=Math.max(0,index);driverTab=index<0?'documents':'stops';}await load();
        }else if(button.dataset.podAction==='refresh')await load();
        else if(button.dataset.podAction==='remove-copy'&&draft?.status==='received'&&confirm('Remove this device’s saved copy? The received server POD will remain.')){await queue().remove(scope(),draft.binding.id,draft.revision);if(!active(gen))return;release();view='list';await load();}
      }catch(e){if(active(gen)){if(e.status===403&&isDriver()){reset();window.AtlasNavigation?.open('home');return;}error=e.message;busy=false;render();}}
    });
    root.addEventListener('toggle',event=>{
      if(event.target.matches('.atlas-driver-boxes'))event.target.querySelector('summary')?.setAttribute('aria-expanded',String(event.target.open));
    },true);
    root.addEventListener('change',async event=>{
      if(event.target.matches('[data-pod-day]')){
        const input=root.closest('.atlas-route')?.querySelector('[data-route-date]');
        if(input){input.value=event.target.value;input.dispatchEvent(new Event('change',{bubbles:true}));event.target.value=input.value;}return;
      }
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
  const foreground=()=>{if(root?.isConnected&&!document.hidden&&view==='list'&&!busy&&!syncing&&!dirty)void load();else void drain();};
  window.addEventListener('online',foreground);
  window.addEventListener('focus',foreground);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)foreground();});
  window.addEventListener('beforeunload',event=>{if(dirty||busy){event.preventDefault();event.returnValue='';}});
  window.atlasRoutingPOD=Object.freeze({configure:config=>{enabled=config.enabled===true;reset();},mount,load,reset,access,hasPending:()=>dirty||busy||assigning});
})();
