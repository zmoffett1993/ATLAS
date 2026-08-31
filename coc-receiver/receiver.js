(function(){
  "use strict";

  const Delivery=window.AtlasCocDelivery;
  const root=document.getElementById("receiver-root");
  const PAGE_SIZE=8;
  const SORT_OPTIONS=[
    ["newest","Newest first"],["oldest","Oldest first"],
    ["customer-asc","Customer A–Z"],
  ];
  const SORT_VALUES=new Set(SORT_OPTIONS.map(([value])=>value));
  let credentials=null,activeDeliveries=[],completedDeliveries=[],selected=null,preview=false;
  let previewState={status:"idle",html:"",error:"",id:""};
  const workbookCache=new Map();
  let connection="reconnecting",pairing=null,pollTimer=null,subscription=null,lastSynced=null;
  const savedSort=readPreference("sort");
  let screen="inbox",search="",sort=SORT_VALUES.has(savedSort)?savedSort:"newest",page=1,total=0;
  let metrics={awaiting:0,receivedToday:0,completedToday:0},selectedIds=new Set(),openMenu=null,bulkMenu=false;
  let dialog=null,notice=null,loading=true,searchTimer=null,loadSequence=0;

  const esc=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  const plural=(count,word)=>`${Number(count||0).toLocaleString()} ${word}${Number(count)===1?"":word==="box"?"es":"s"}`;
  const snapshot=(record)=>record?.report_snapshot||{};
  const recordById=(id)=>[selected,...activeDeliveries,...completedDeliveries].find((record)=>record?.id===id)||null;
  const officialFileName=(record,fallback="Official COC.xlsx")=>{const snap=snapshot(record);return window.AtlasCocExcel?.outputFileName?.(snap.customerName,snap.invoiceNumber,snap.ifNumber)||fallback};
  const submitterName=(record)=>record?.submitted_by_display_name||snapshot(record).employeeDisplayName||snapshot(record).employee||"—";
  const recordTotals=(record)=>{const pallets=snapshot(record).pallets||[];return{pallets:pallets.length,boxes:pallets.reduce((sum,pallet)=>sum+(pallet.lots||[]).reduce((n,lot)=>n+Number(lot.cases||0),0),0)}};
  const time=(value)=>value?new Date(value).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"—";
  const dateTime=(value)=>value?`${new Date(value).toLocaleDateString([],{month:"short",day:"numeric"})} · ${time(value)}`:"—";
  const dayStart=()=>{const date=new Date();date.setHours(0,0,0,0);return date.toISOString()};
  const selectedOnPage=()=>completedDeliveries.filter((item)=>selectedIds.has(item.id));
  function readPreference(key){try{return localStorage.getItem(`atlas-coc-receiver-${key}`)||""}catch{return""}}
  function writePreference(key,value){try{localStorage.setItem(`atlas-coc-receiver-${key}`,String(value))}catch{}}
  function icon(name){const paths={
    clipboard:'<path d="M9 5h6M9 9h6M9 13h4"/><path d="M9 3h6v3H9z"/><rect x="5" y="4" width="14" height="17" rx="2"/>',
    inbox:'<path d="M4 14h4l2 3h4l2-3h4"/><path d="M6 4h12l2 10v6H4v-6z"/>',
    check:'<path d="m6 12 4 4 8-9"/><circle cx="12" cy="12" r="9"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
    download:'<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
    archive:'<path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6"/>',
    restore:'<path d="M4 8v6h6"/><path d="M6 15a7 7 0 1 0 1-8l-3 3"/>',
    shield:'<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  };return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]||""}</svg>`}

  function header(){return `<header class="receiver-head"><div class="receiver-atlas-lockup" aria-label="ATLAS Warehouse Management"><img src="../atlas-brand-mark-dark.svg?v=97" alt="" aria-hidden="true"><span><b>ATLAS</b><small>WAREHOUSE MANAGEMENT</small></span></div><div class="receiver-brand-title"><h1>COC RECEIVER</h1><p>Office COC Station</p></div><div class="receiver-status ${connection==="connected"?"":"is-offline"}"><strong>● ${connection==="connected"?"CONNECTED · READY":connection==="reconnecting"?"RECONNECTING…":"OFFLINE"}</strong><small>Last synced ${lastSynced?time(lastSynced):"—"}</small></div></header>`}
  function pairingMarkup(){
    if(!Delivery.getAuthSession())return `<section class="receiver-pair"><span class="receiver-eyebrow">OFFICE COC STATION</span><h1>ATLAS sign-in required</h1><p>Use the name and password assigned to this office station.</p><button class="receiver-primary" data-action="sign-in">SIGN IN</button></section>`;
    if(!pairing)return `<section class="receiver-pair"><span class="receiver-eyebrow">OFFICE COC STATION</span><h1>Pair this computer</h1><p>This browser needs supervisor approval before it can receive compliance reports.</p><button class="receiver-primary" data-action="start-pairing">Create Pairing Code</button></section>`;
    return `<section class="receiver-pair"><span class="receiver-eyebrow">PAIRING REQUEST</span><h1>Approve on a warehouse phone</h1><p>Workflows → Office COC Receiver</p><div class="receiver-code">${esc(pairing.pairingCode)}</div><div class="receiver-qr">${pairing.qrSvg||"QR token ready"}</div><p>Expires ${time(pairing.expiresAt)}</p><p>${esc(pairing.status||"Waiting for supervisor approval…")}</p></section>`;
  }
  function metricCard(kind,label,value,copy=""){return `<article class="receiver-metric is-${kind}"><i>${icon(kind==="awaiting"?"clipboard":kind==="received"?"inbox":"check")}</i><span><small>${label}</small><strong>${Number(value||0).toLocaleString()}</strong>${copy?`<b>${copy}</b>`:""}</span></article>`}
  function metricsMarkup(){return `<section class="receiver-metrics" aria-label="COC summary">${metricCard("awaiting","AWAITING",metrics.awaiting,"Requires office review")}${metricCard("received","RECEIVED TODAY",metrics.receivedToday)}${metricCard("completed","COMPLETED TODAY",metrics.completedToday)}</section>`}
  function incomingCard(record){const snap=snapshot(record),totals=recordTotals(record);return `<article class="receiver-incoming-card"><span class="receiver-new">NEW</span><dl><div><dt>Invoice</dt><dd>${esc(snap.invoiceNumber||"—")}</dd></div><div><dt>Customer</dt><dd>${esc(snap.customerName||"—")}</dd></div><div><dt>IF number</dt><dd>${esc(snap.ifNumber||"—")}</dd></div></dl><p>${icon("clipboard")} ${plural(totals.pallets,"pallet")} <b>·</b> ${plural(totals.boxes,"box")}</p><p>${esc(submitterName(record))} <b>·</b> ${time(record.sent_at)}</p><button type="button" class="receiver-open-report" data-action="open" data-id="${esc(record.id)}">OPEN REPORT <span>→</span></button></article>`}
  function incomingMarkup(){return `<section class="receiver-incoming"><h2>INCOMING COCs</h2>${activeDeliveries.length?activeDeliveries.map(incomingCard).join(""):`<div class="receiver-ready-strip"><span>${icon("check")}</span><div><strong>No COCs are waiting</strong><small>The receiver is connected and ready for the next warehouse report.</small></div></div>`}</section>`}
  function sortOptions(){return SORT_OPTIONS.map(([value,label])=>`<option value="${value}" ${sort===value?"selected":""}>${label}</option>`).join("")}
  function backButton(action,label,extraClass=""){return `<button type="button" class="receiver-nav-back ${extraClass}" data-action="${esc(action)}"><span class="receiver-nav-back-icon" aria-hidden="true">←</span><span>${esc(label)}</span></button>`}
  function toolbarMarkup({archive=false}={}){const count=selectedIds.size;return `<div class="receiver-toolbar"><label class="receiver-search">${icon("search")}<input type="search" data-receiver-search value="${esc(search)}" placeholder="Search customer, invoice, or IF number" autocomplete="off"></label><label class="receiver-sort"><span class="sr-only">Sort reports</span><select data-receiver-sort>${sortOptions()}</select></label><div class="receiver-toolbar-actions">${archive?backButton("show-inbox","Back to COC Receiver","receiver-toolbar-back"):`<button type="button" class="receiver-outline" data-action="show-archive">VIEW ARCHIVE</button>`}<button type="button" class="receiver-outline ${archive?"is-restore":""}" data-action="${archive?"restore-selected":"archive-selected"}" ${count?"":"disabled"}>${archive?"RESTORE":"ARCHIVE"} SELECTED${count?` (${count})`:""}</button>${archive?"":`<div class="receiver-bulk-menu"><button type="button" class="receiver-icon-button" data-action="toggle-bulk-menu" aria-label="More archive actions" aria-expanded="${bulkMenu}">•••</button>${bulkMenu?`<div class="receiver-menu"><button type="button" data-action="archive-all">Archive all completed COCs</button></div>`:""}</div>`}</div></div>`}
  function rowMarkup(record,{archive=false}={}){const snap=snapshot(record),totals=recordTotals(record),checked=selectedIds.has(record.id),menu=openMenu===record.id;return `<tr class="${checked?"is-selected":""}"><td><input type="checkbox" data-select-id="${esc(record.id)}" aria-label="Select ${esc(snap.invoiceNumber||"COC")}" ${checked?"checked":""}></td><td data-label="Date completed"><span class="receiver-date-check">✓</span>${dateTime(record.office_completed_at)}${archive&&record.receiver_archived_at?`<small>Archived ${dateTime(record.receiver_archived_at)}</small>`:""}</td><td data-label="Customer"><strong>${esc(snap.customerName||"—")}</strong></td><td data-label="Invoice">${esc(snap.invoiceNumber||"—")}</td><td data-label="IF number">${esc(snap.ifNumber||"—")}</td><td data-label="Pallets / boxes">${plural(totals.pallets,"pallet")} · ${plural(totals.boxes,"box")}</td><td data-label="Actions"><div class="receiver-row-actions"><button type="button" class="receiver-view" data-action="open" data-id="${esc(record.id)}">VIEW</button><button type="button" class="receiver-small-action" data-action="download" data-id="${esc(record.id)}" aria-label="Download ${esc(snap.invoiceNumber||"COC")}">${icon("download")}</button><div class="receiver-row-menu"><button type="button" class="receiver-small-action" data-action="toggle-row-menu" data-id="${esc(record.id)}" aria-label="More actions" aria-expanded="${menu}">•••</button>${menu?`<div class="receiver-menu"><button type="button" data-action="${archive?"restore-one":"archive-one"}" data-id="${esc(record.id)}">${icon(archive?"restore":"archive")} ${archive?"Restore to Completed":"Archive COC"}</button></div>`:""}</div></div></td></tr>`}
  function pageButtons(){const pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),start=Math.max(1,Math.min(page-2,pages-4)),end=Math.min(pages,start+4);let items=`<button type="button" data-action="page" data-page="${page-1}" ${page<=1?"disabled":""} aria-label="Previous page">‹</button>`;for(let number=start;number<=end;number+=1)items+=`<button type="button" data-action="page" data-page="${number}" class="${number===page?"is-active":""}">${number}</button>`;if(end<pages)items+=`<span>…</span>`;items+=`<button type="button" data-action="page" data-page="${page+1}" ${page>=pages?"disabled":""} aria-label="Next page">›</button>`;return items}
  function reportsPanel({archive=false}={}){const from=total?((page-1)*PAGE_SIZE)+1:0,to=Math.min(page*PAGE_SIZE,total),allChecked=completedDeliveries.length&&completedDeliveries.every((item)=>selectedIds.has(item.id)),dateHeading=sort==="oldest"?"DATE COMPLETED ↑":sort==="newest"?"DATE COMPLETED ↓":"DATE COMPLETED";return `<section class="receiver-report-panel"><div class="receiver-panel-title"><div><span class="receiver-eyebrow">${archive?"SECURE RECORD STORAGE":"OFFICE HISTORY"}</span><h2>${archive?"COC ARCHIVE":"COMPLETED COCs"}</h2><p>${archive?"Archived reports remain securely stored, downloadable, and restorable.":"Completed reports remain available until archived."}</p></div></div>${toolbarMarkup({archive})}<div class="receiver-table-wrap"><table><thead><tr><th><input type="checkbox" data-select-page aria-label="Select all reports on this page" ${allChecked?"checked":""}></th><th>${dateHeading}</th><th>CUSTOMER</th><th>INVOICE</th><th>IF NUMBER</th><th>PALLETS / BOXES</th><th>ACTIONS</th></tr></thead><tbody>${completedDeliveries.length?completedDeliveries.map((item)=>rowMarkup(item,{archive})).join(""):`<tr><td colspan="7"><div class="receiver-table-empty">${search?"No reports match this search.":archive?"No COCs have been archived.":"No completed COCs yet."}</div></td></tr>`}</tbody></table></div><footer class="receiver-pagination"><span>Showing ${from}–${to} of ${total.toLocaleString()} ${archive?"archived":"completed"} COCs</span><nav aria-label="Report pages">${pageButtons()}</nav></footer></section>`}
  function inboxMarkup(){return `<div class="receiver-shell">${header()}${metricsMarkup()}${incomingMarkup()}${reportsPanel()}</div>`}
  function archiveMarkup(){return `<div class="receiver-shell">${header()}<div class="receiver-archive-head">${backButton("show-inbox","Back to COC Receiver")}<div><span class="receiver-eyebrow">RETAINED RECORDS</span><h1>COC Archive</h1><p>Search, download, or restore any archived compliance report.</p></div></div>${reportsPanel({archive:true})}</div>`}
  function palletMarkup(record){return (snapshot(record).pallets||[]).map((pallet)=>`<section class="receiver-pallet"><h3>PALLET ${pallet.number}</h3>${(pallet.lots||[]).map((lot)=>`<div class="receiver-lot"><span><strong>${esc(lot.model)}</strong><small><i>LOT</i><b>${esc(lot.lot)}</b></small></span><b>${plural(Number(lot.cases||0),"box")} · ${(Number(lot.cases||0)*Number(lot.caseQuantity||0)).toLocaleString()} units</b></div>`).join("")}</section>`).join("")}
  function officialPreviewMarkup(){const snap=snapshot(selected),body=previewState.status==="ready"&&previewState.id===selected.id?previewState.html:previewState.status==="error"?`<div class="receiver-preview-status is-error"><strong>Preview unavailable</strong><p>${esc(previewState.error)}</p><button type="button" class="receiver-outline" data-action="view-official" data-id="${esc(selected.id)}">TRY AGAIN</button></div>`:`<div class="receiver-preview-status"><span class="receiver-preview-spinner" aria-hidden="true"></span><strong>Opening the Official COC…</strong><p>ATLAS is reading the actual XLSX workbook.</p></div>`;return `<div class="receiver-shell">${header()}${backButton("back-detail","Back to COC Overview")}<section class="receiver-preview-head"><span class="receiver-eyebrow">ACTUAL WORKBOOK · READ ONLY</span><h1>Official COC</h1><p>${esc(snap.customerName||"—")} · ${esc(snap.invoiceNumber||"—")}</p></section>${body}<div class="receiver-preview-download"><button class="receiver-primary receiver-download" data-action="download" data-id="${esc(selected.id)}">DOWNLOAD OFFICIAL COC</button></div></div>`}
  function detailMarkup(){const record=selected,snap=snapshot(record),archived=Boolean(record.receiver_archived_at);return `<div class="receiver-shell">${header()}${backButton("back",screen==="archive"?"Back to COC Archive":"Back to COC Receiver")}<section class="receiver-detail"><div class="receiver-detail-head"><span class="receiver-eyebrow ${archived?"is-archived":""}">${archived?"ARCHIVED":record.status==="OFFICE_COMPLETED"?"COMPLETED":"RECEIVED"}</span><h1>${esc(snap.customerName||"—")}</h1><p>${esc(snap.invoiceNumber||"—")}</p></div><dl><div><dt>Invoice</dt><dd>${esc(snap.invoiceNumber||"—")}</dd></div><div><dt>IF Number</dt><dd>${esc(snap.ifNumber||"—")}</dd></div><div><dt>Sent by</dt><dd>${esc(submitterName(record))} · ${time(record.sent_at)}</dd></div><div><dt>Received</dt><dd>${dateTime(record.received_at)}</dd></div></dl>${palletMarkup(record)}<div class="receiver-actions"><div class="receiver-official-actions"><button class="receiver-view-official" data-action="view-official" data-id="${esc(record.id)}">VIEW OFFICIAL COC</button><button class="receiver-primary receiver-download" data-action="download" data-id="${esc(record.id)}">DOWNLOAD OFFICIAL COC</button></div>${record.status!=="OFFICE_COMPLETED"?`<button class="receiver-primary receiver-complete" data-action="complete" data-id="${esc(record.id)}">MARK COMPLETED ✓</button>`:archived?`<button class="receiver-primary receiver-restore" data-action="restore-one" data-id="${esc(record.id)}">RESTORE TO COMPLETED</button>`:`<button class="receiver-primary receiver-archive-action" data-action="archive-one" data-id="${esc(record.id)}">ARCHIVE COC</button>`}</div></section></div>`}
  function dialogMarkup(){if(!dialog)return"";const restore=dialog.type.startsWith("restore"),all=dialog.type==="archive-all",count=all?total:dialog.ids.length;return `<div class="receiver-dialog-backdrop" role="presentation"><section class="receiver-dialog" role="dialog" aria-modal="true" aria-labelledby="receiver-dialog-title"><span class="receiver-dialog-icon">${icon(restore?"restore":"archive")}</span><span class="receiver-eyebrow">${restore?"RESTORE COC":"ARCHIVE CONFIRMATION"}</span><h2 id="receiver-dialog-title">${restore?`Restore ${plural(count,"report")}?`:all?"Archive all completed COCs?":`Archive ${plural(count,"report")}?`}</h2><p>${restore?"The selected COC will return to the Completed COCs workspace.":"Archived COCs leave the active workspace but remain securely stored, downloadable, and restorable. Nothing is deleted."}</p><div><button type="button" class="receiver-dialog-cancel" data-action="close-dialog">Cancel</button><button type="button" class="receiver-primary" data-action="confirm-dialog">${restore?"RESTORE":"ARCHIVE"}</button></div></section></div>`}
  function noticeMarkup(){return notice?`<div class="receiver-notice is-${notice.tone||"success"}" role="status">${esc(notice.text)}</div>`:""}
  function retentionMarkup(){return credentials&&!selected?`<div class="receiver-retention">${icon("shield")}<span>COC records are retained securely. Archiving removes them from this workspace without deleting company records.</span></div>`:""}
  function render(){root.innerHTML=(!credentials?pairingMarkup():selected&&preview?officialPreviewMarkup():selected?detailMarkup():screen==="archive"?archiveMarkup():inboxMarkup())+retentionMarkup()+dialogMarkup()+noticeMarkup();window.requestAnimationFrame?.(()=>window.AtlasCocExcel?.fitOfficialWorkbookPreviews?.(root))}
  function renderBackgroundUpdate(){if(!(selected&&preview&&previewState.status==="ready"))render()}

  async function loadInbox(){
    if(!credentials)return;const sequence=++loadSequence;loading=true;
    try{
      const section=screen==="archive"?"archive":"completed";
      let [activeResult,listResult,metricResult]=await Promise.all([
        screen==="archive"?Promise.resolve({deliveries:[]}):Delivery.receiverInbox(credentials,{section:"active",withMeta:true}),
        Delivery.receiverInbox(credentials,{section,withMeta:true,page,pageSize:PAGE_SIZE,search,sort}),
        Delivery.receiverInbox(credentials,{section:"metrics",withMeta:true,dayStart:dayStart()}),
      ]);
      if(sequence!==loadSequence)return;
      const sent=(activeResult.deliveries||[]).filter((item)=>item.status==="SENT");
      if(sent.length){await Promise.all(sent.map((item)=>Delivery.acknowledgeDelivery(item.id,credentials)));activeResult=await Delivery.receiverInbox(credentials,{section:"active",withMeta:true})}
      activeDeliveries=activeResult.deliveries||[];completedDeliveries=listResult.deliveries||[];total=Number(listResult.total||0);
      metrics={awaiting:Number(metricResult.awaiting||activeDeliveries.length),receivedToday:Number(metricResult.receivedToday||0),completedToday:Number(metricResult.completedToday||0)};
      const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));if(page>pages){page=pages;return loadInbox()}
      connection=navigator.onLine?"connected":"offline";lastSynced=new Date();selectedIds=new Set([...selectedIds].filter((id)=>completedDeliveries.some((item)=>item.id===id)));renderBackgroundUpdate();
    }catch(error){connection=navigator.onLine?"reconnecting":"offline";notice={tone:"error",text:error?.message||"The COC Receiver could not refresh."};renderBackgroundUpdate()}
    finally{loading=false}
  }
  async function startPairing(){try{pairing=await Delivery.createPairing();render();pollPairing()}catch(error){pairing={status:error.message||"Pairing could not start."};render()}}
  async function pollPairing(){if(!pairing?.pairingSessionId)return;for(let attempt=0;attempt<120&&!credentials;attempt+=1){await new Promise((resolve)=>setTimeout(resolve,2500));try{const result=await Delivery.pairingStatus(pairing.pairingSessionId);pairing={...pairing,...result};if(result.status==="PAIRED"){credentials=result.credentials;render();connect();return}render()}catch(error){pairing={...pairing,status:error.message};render();return}}}
  function connect(){clearInterval(pollTimer);subscription?.close?.();subscription=Delivery.subscribeToDeliveries({onChange:loadInbox,onState:(state)=>{connection=state;renderBackgroundUpdate()}});pollTimer=setInterval(()=>{Delivery.heartbeat(credentials).catch(()=>{});loadInbox()},15000);loadInbox()}
  function setScreen(next){screen=next;selected=null;preview=false;previewState={status:"idle",html:"",error:"",id:""};selectedIds.clear();openMenu=null;bulkMenu=false;search="";page=1;render();loadInbox()}
  function showNotice(text,tone="success"){notice={text,tone};render();setTimeout(()=>{notice=null;render()},2600)}
  function openConfirmation(type,ids=[]){dialog={type,ids};openMenu=null;bulkMenu=false;render()}
  async function confirmDialog(){const pending=dialog;if(!pending)return;dialog=null;render();try{let result;if(pending.type.startsWith("restore"))result=await Delivery.restoreOfficeArchived(pending.ids,credentials);else result=await Delivery.archiveOfficeCompleted(pending.ids,credentials,{all:pending.type==="archive-all"});selected=null;selectedIds.clear();await loadInbox();showNotice(`${plural(result.updated||pending.ids.length,"COC")} ${pending.type.startsWith("restore")?"restored":"archived"}.`)}catch(error){showNotice(error?.message||"The archive could not be updated.","error")}}
  async function loadWorkbook(id){if(workbookCache.has(id))return workbookCache.get(id);const workbook=await Delivery.downloadOfficeWorkbook(id,credentials);workbook.fileName=officialFileName(recordById(id),workbook.fileName);workbookCache.set(id,workbook);return workbook}
  async function openOfficialPreview(id){const recordId=id||selected?.id;if(!recordId)return;preview=true;previewState={status:"loading",html:"",error:"",id:recordId};render();try{const workbook=await loadWorkbook(recordId);const html=await window.AtlasCocExcel.renderOfficialWorkbookPreview(workbook.blob);if(!selected||selected.id!==recordId||!preview)return;previewState={status:"ready",html,error:"",id:recordId}}catch(error){previewState={status:"error",html:"",error:error?.message||"The Official COC could not be opened.",id:recordId}}render()}
  async function download(button){button.disabled=true;try{const workbook=await loadWorkbook(button.dataset.id);window.AtlasCocStorage?.downloadBlob(workbook.blob,workbook.fileName)}catch(error){showNotice(error?.message||"The official COC could not be downloaded.","error")}finally{button.disabled=false}}

  root.addEventListener("click",async(event)=>{
    const button=event.target.closest("[data-action]");if(!button)return;const action=button.dataset.action,id=button.dataset.id;
    if(action==="sign-in")window.AtlasAuth?.open?.();
    if(action==="start-pairing")startPairing();
    if(action==="open"){selected=[...activeDeliveries,...completedDeliveries].find((item)=>item.id===id)||null;preview=false;previewState={status:"idle",html:"",error:"",id:""};openMenu=null;render()}
    if(action==="back"){selected=null;preview=false;previewState={status:"idle",html:"",error:"",id:""};render()}
    if(action==="view-official")await openOfficialPreview(id);
    if(action==="back-detail"){preview=false;render()}
    if(action==="show-archive")setScreen("archive");
    if(action==="show-inbox")setScreen("inbox");
    if(action==="toggle-row-menu"){openMenu=openMenu===id?null:id;bulkMenu=false;render()}
    if(action==="toggle-bulk-menu"){bulkMenu=!bulkMenu;openMenu=null;render()}
    if(action==="archive-one")openConfirmation("archive-one",[id]);
    if(action==="restore-one")openConfirmation("restore-one",[id]);
    if(action==="archive-selected")openConfirmation("archive-selected",[...selectedIds]);
    if(action==="restore-selected")openConfirmation("restore-selected",[...selectedIds]);
    if(action==="archive-all")openConfirmation("archive-all",[]);
    if(action==="close-dialog"){dialog=null;render()}
    if(action==="confirm-dialog")confirmDialog();
    if(action==="page"){page=Math.max(1,Number(button.dataset.page||1));selectedIds.clear();render();loadInbox()}
    if(action==="download")download(button);
    if(action==="complete"){button.disabled=true;try{await Delivery.markOfficeCompleted(id,credentials);selected=null;await loadInbox();showNotice("COC marked completed.")}catch(error){button.disabled=false;showNotice(error?.message||"The report could not be completed.","error")}}
  });
  root.addEventListener("input",(event)=>{if(!event.target.matches("[data-receiver-search]"))return;search=event.target.value;page=1;selectedIds.clear();clearTimeout(searchTimer);searchTimer=setTimeout(loadInbox,260)});
  root.addEventListener("change",(event)=>{
    if(event.target.matches("[data-receiver-sort]")){sort=event.target.value;writePreference("sort",sort);page=1;selectedIds.clear();render();loadInbox();return}
    if(event.target.matches("[data-select-id]")){event.target.checked?selectedIds.add(event.target.dataset.selectId):selectedIds.delete(event.target.dataset.selectId);render();return}
    if(event.target.matches("[data-select-page]")){if(event.target.checked)completedDeliveries.forEach((item)=>selectedIds.add(item.id));else completedDeliveries.forEach((item)=>selectedIds.delete(item.id));render()}
  });
  window.addEventListener("atlas-auth-changed",async()=>{credentials=null;const verified=await Delivery.verifyReceiver().catch(()=>({paired:false}));credentials=verified.paired?verified.credentials:null;render();if(credentials)connect()});
  window.addEventListener("online",connect);window.addEventListener("offline",()=>{connection="offline";renderBackgroundUpdate()});
  (async()=>{const verified=await Delivery.verifyReceiver().catch(()=>({paired:false}));credentials=verified.paired?verified.credentials:null;render();if(credentials)connect()})();
})();
