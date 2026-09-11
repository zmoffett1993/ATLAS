(function(){
  "use strict";

  const Delivery=window.AtlasCocDelivery;
  const Catalog=window.AtlasCocCaseQuantities;
  const References=window.AtlasCocReferences;
  const root=document.getElementById("receiver-root");
  const PAGE_SIZE=8;
  const PERIOD_FETCH_PAGE_SIZE=50;
  const SORT_OPTIONS=[
    ["newest","Newest first"],["oldest","Oldest first"],
    ["customer-asc","Customer A–Z"],
  ];
  const PERIOD_OPTIONS=[
    ["today","Today"],["week","This Week"],["month","This Month"],
    ["7d","Last 7 Days"],["30d","Last 30 Days"],["all","All Time"],
  ];
  const SORT_VALUES=new Set(SORT_OPTIONS.map(([value])=>value));
  const PERIOD_VALUES=new Set(PERIOD_OPTIONS.map(([value])=>value));
  let credentials=null,activeDeliveries=[],completedDeliveries=[],selected=null,preview=false;
  let branchContext=null;
  let previewState={status:"idle",html:"",error:"",id:""};
  let revisionState=freshRevision();
  const workbookCache=new Map();
  let connection="reconnecting",pairing=null,pollTimer=null,subscription=null,lastSynced=null;
  const savedSort=readPreference("sort");
  let screen="inbox",search="",sort=SORT_VALUES.has(savedSort)?savedSort:"newest",period="today",page=1,total=0;
  let reportingDayKey="";
  let metrics={awaiting:0,receivedToday:0,completedToday:0},selectedIds=new Set(),openMenu=null,bulkMenu=false;
  let dialog=null,notice=null,loading=true,searchTimer=null,loadSequence=0;
  let signInState={loading:false,error:""},receiverAuthSequence=0;

  const esc=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  const plural=(count,word)=>`${Number(count||0).toLocaleString()} ${word}${Number(count)===1?"":word==="box"?"es":"s"}`;
  const snapshot=(record)=>{const source=record?.report_snapshot||{};return References?.normalizeSnapshot?.(source)||source};
  const recordById=(id)=>[selected,...activeDeliveries,...completedDeliveries].find((record)=>record?.id===id)||null;
  const officialFileName=(record,fallback="Official COC.xlsx")=>{const snap=snapshot(record),generated=snap.customerName&&snap.invoiceNumber&&snap.ifNumber?window.AtlasCocExcel?.outputFileName?.(snap.customerName,snap.invoiceNumber,snap.ifNumber):"";return generated||String(record?.workbook_file_name||fallback).replace(/_+/g," ").replace(/\s+/g," ").trim()};
  const submitterName=(record)=>record?.submitted_by_display_name||snapshot(record).employeeDisplayName||snapshot(record).employee||"—";
  const recordTotals=(record)=>{const pallets=snapshot(record).pallets||[];return{pallets:pallets.length,boxes:pallets.reduce((sum,pallet)=>sum+(pallet.lots||[]).reduce((n,lot)=>n+Number(lot.cases||0),0),0)}};
  const time=(value)=>value?new Date(value).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"—";
  const dateTime=(value)=>value?`${new Date(value).toLocaleDateString([],{month:"short",day:"numeric"})} · ${time(value)}`:"—";
  const dayStart=()=>{const date=new Date();date.setHours(0,0,0,0);return date.toISOString()};
  const warehouseTimeZone=()=>branchContext?.selectedWarehouse?.time_zone||branchContext?.warehouse?.time_zone||(branchCode()==="TX"?"America/Chicago":"America/Los_Angeles");
  const zonedDateParts=(date,timeZone,includeTime=false)=>{const options=includeTime?{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}:{timeZone,year:"numeric",month:"2-digit",day:"2-digit"},parts=new Intl.DateTimeFormat("en-CA",options).formatToParts(date),values=Object.fromEntries(parts.map((part)=>[part.type,part.value]));return{year:Number(values.year),month:Number(values.month),day:Number(values.day),hour:Number(values.hour||0),minute:Number(values.minute||0),second:Number(values.second||0)}};
  const shiftCalendarDate=(parts,days)=>{const shifted=new Date(Date.UTC(parts.year,parts.month-1,parts.day+days));return{year:shifted.getUTCFullYear(),month:shifted.getUTCMonth()+1,day:shifted.getUTCDate()}};
  const zonedMidnightUtc=(parts,timeZone)=>{const target=Date.UTC(parts.year,parts.month-1,parts.day,0,0,0);let guess=target;for(let attempt=0;attempt<4;attempt+=1){const actual=zonedDateParts(new Date(guess),timeZone,true),actualAsUtc=Date.UTC(actual.year,actual.month-1,actual.day,actual.hour,actual.minute,actual.second),adjustment=target-actualAsUtc;guess+=adjustment;if(!adjustment)break}return guess};
  const reportingDateKey=(date=new Date())=>{const parts=zonedDateParts(date,warehouseTimeZone());return`${parts.year}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")}`};
  function reportingPeriodBounds(selectedPeriod=period,date=new Date()){const timeZone=warehouseTimeZone(),today=zonedDateParts(date,timeZone);let startParts=null;if(selectedPeriod==="today")startParts=today;else if(selectedPeriod==="week"){const weekday=new Date(Date.UTC(today.year,today.month-1,today.day)).getUTCDay();startParts=shiftCalendarDate(today,-((weekday+6)%7))}else if(selectedPeriod==="month")startParts={year:today.year,month:today.month,day:1};else if(selectedPeriod==="7d")startParts=shiftCalendarDate(today,-6);else if(selectedPeriod==="30d")startParts=shiftCalendarDate(today,-29);return startParts?{periodStart:new Date(zonedMidnightUtc(startParts,timeZone)).toISOString(),periodEnd:new Date(zonedMidnightUtc(shiftCalendarDate(today,1),timeZone)).toISOString()}:{periodStart:"",periodEnd:""}}
  function resetReportingPeriodAtMidnight(date=new Date()){const current=reportingDateKey(date);if(!reportingDayKey){reportingDayKey=current;return false}if(reportingDayKey===current)return false;reportingDayKey=current;period="today";search="";page=1;selectedIds.clear();openMenu=null;bulkMenu=false;return true}
  const selectedOnPage=()=>completedDeliveries.filter((item)=>selectedIds.has(item.id));
  function freshRevision(){return{step:"preview",loading:false,error:"",editor:null,filePreviewHtml:"",generatedBytes:null,candidate:null,currentRevision:null,revisions:[]}}
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

  function pairingQrMarkup(){
    const svg=String(pairing?.qrSvg||"").trim();
    if(!/^<svg(?:\s|>)/i.test(svg))return '<span class="receiver-qr-fallback">Use the six-digit code above.</span>';
    return svg.replace(/^<svg\b/i,'<svg class="receiver-qr-symbol" role="img" aria-label="Pairing QR code"');
  }

  function branchCode(){return branchContext?.selectedWarehouse?.code||branchContext?.warehouse?.code||credentials?.warehouseCode||"CA"}
  function branchName(){return branchContext?.selectedWarehouse?.display_name||branchContext?.warehouse?.display_name||`${branchCode()} Warehouse`}
  function header(){return `<header class="receiver-head"><div class="receiver-atlas-lockup" aria-label="ATLAS Warehouse Management"><img src="../atlas-brand-mark-dark.svg?v=97" alt="" aria-hidden="true"><span><b>ATLAS</b><small>WAREHOUSE MANAGEMENT</small></span></div><div class="receiver-brand-title"><h1>${esc(branchCode())} COC RECEIVER</h1><p>${esc(branchName())}</p></div><div class="receiver-status ${connection==="connected"?"":"is-offline"}"><strong>● ${connection==="connected"?"CONNECTED · READY":connection==="reconnecting"?"RECONNECTING…":"OFFLINE"}</strong><small>Last synced ${lastSynced?time(lastSynced):"—"}</small></div></header>`}
  function pairingMarkup(){
    if(!Delivery.getAuthSession())return `<section class="receiver-pair receiver-sign-in"><span class="receiver-eyebrow">OFFICE COC STATION</span><h1>Sign in to the COC Receiver</h1><p>Use the name and password assigned to this office station.</p><form data-receiver-sign-in><label><span>ATLAS name</span><input name="login_name" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Enter station name" required ${signInState.loading?"disabled":""}></label><label><span>Password</span><input name="password" type="password" autocomplete="current-password" placeholder="Enter password" required ${signInState.loading?"disabled":""}></label><p class="receiver-sign-in-error" role="alert">${esc(signInState.error)}</p><button class="receiver-primary" type="submit" ${signInState.loading?"disabled":""}>${signInState.loading?"SIGNING IN…":"SIGN IN"}</button></form></section>`;
    if(!pairing)return `<section class="receiver-pair"><span class="receiver-eyebrow">OFFICE COC STATION</span><h1>Pair this computer</h1><p>This browser needs supervisor approval before it can receive compliance reports.</p><button class="receiver-primary" data-action="start-pairing">Create Pairing Code</button></section>`;
    return `<section class="receiver-pair"><span class="receiver-eyebrow">PAIRING REQUEST</span><h1>Approve on a warehouse phone</h1><p>Workflows → Office COC Receiver</p><div class="receiver-code">${esc(pairing.pairingCode)}</div><div class="receiver-qr">${pairingQrMarkup()}</div><p>Expires ${time(pairing.expiresAt)}</p><p>${esc(pairing.status||"Waiting for supervisor approval…")}</p></section>`;
  }
  function metricCard(kind,label,value,copy=""){return `<article class="receiver-metric is-${kind}"><i>${icon(kind==="awaiting"?"clipboard":kind==="received"?"inbox":"check")}</i><span><small>${label}</small><strong>${Number(value||0).toLocaleString()}</strong>${copy?`<b>${copy}</b>`:""}</span></article>`}
  function metricsMarkup(){return `<section class="receiver-metrics" aria-label="COC summary">${metricCard("awaiting","AWAITING",metrics.awaiting,"Requires office review")}${metricCard("received","RECEIVED TODAY",metrics.receivedToday)}${metricCard("completed","COMPLETED TODAY",metrics.completedToday)}</section>`}
  function incomingCard(record){const snap=snapshot(record),totals=recordTotals(record);return `<article class="receiver-incoming-card"><button type="button" class="receiver-open-report" data-action="open" data-id="${esc(record.id)}">OPEN REPORT <span>→</span></button><span class="receiver-new">NEW</span><dl><div><dt>Customer Name</dt><dd>${esc(snap.customerName||"—")}</dd></div><div><dt>IF NUMBER</dt><dd>${esc(snap.ifNumber||"—")}</dd></div><div><dt>INV Number</dt><dd>${esc(snap.invoiceNumber||"—")}</dd></div><div><dt>Sales Order</dt><dd>${esc(snap.salesOrderNumber||"—")}</dd></div></dl><div class="receiver-incoming-meta"><p class="receiver-incoming-summary">${icon("clipboard")} ${plural(totals.pallets,"pallet")} <b>·</b> ${plural(totals.boxes,"box")}</p><p class="receiver-incoming-submitter">${esc(submitterName(record))} <b>·</b> ${time(record.sent_at)}</p></div></article>`}
  function incomingMarkup(){return `<section class="receiver-incoming"><h2>INCOMING COCs</h2>${activeDeliveries.length?activeDeliveries.map(incomingCard).join(""):`<div class="receiver-ready-strip"><span>${icon("check")}</span><div><strong>No COCs are waiting</strong><small>The receiver is connected and ready for the next warehouse report.</small></div></div>`}</section>`}
  function sortOptions(){return SORT_OPTIONS.map(([value,label])=>`<option value="${value}" ${sort===value?"selected":""}>${label}</option>`).join("")}
  function periodOptions(){return PERIOD_OPTIONS.map(([value,label])=>`<option value="${value}" ${period===value?"selected":""}>${label}</option>`).join("")}
  function periodLabel(){return PERIOD_OPTIONS.find(([value])=>value===period)?.[1]||"Today"}
  function backButton(action,label,extraClass=""){return `<button type="button" class="receiver-nav-back ${extraClass}" data-action="${esc(action)}"><span class="receiver-nav-back-icon" aria-hidden="true">←</span><span>${esc(label)}</span></button>`}
  function toolbarMarkup({archive=false}={}){const count=selectedIds.size;return `<div class="receiver-toolbar ${archive?"is-archive":""}"><label class="receiver-search">${icon("search")}<input type="search" data-receiver-search value="${esc(search)}" placeholder="Search customer, invoice, IF, or sales order" autocomplete="off"></label>${archive?"":`<label class="receiver-period"><span class="sr-only">Reporting period</span><select data-receiver-period aria-label="Reporting period">${periodOptions()}</select></label>`}<label class="receiver-sort"><span class="sr-only">Sort reports</span><select data-receiver-sort>${sortOptions()}</select></label><div class="receiver-toolbar-actions">${archive?backButton("show-inbox","Back to COC Receiver","receiver-toolbar-back"):`<button type="button" class="receiver-outline" data-action="show-archive">VIEW ARCHIVE</button>`}<button type="button" class="receiver-outline ${archive?"is-restore":""}" data-action="${archive?"restore-selected":"archive-selected"}" ${count?"":"disabled"}>${archive?"RESTORE":"ARCHIVE"} SELECTED${count?` (${count})`:""}</button>${archive?"":`<div class="receiver-bulk-menu"><button type="button" class="receiver-icon-button" data-action="toggle-bulk-menu" aria-label="More archive actions" aria-expanded="${bulkMenu}">•••</button>${bulkMenu?`<div class="receiver-menu"><button type="button" data-action="archive-all">Archive all completed COCs</button></div>`:""}</div>`}</div></div>`}
  function rowMarkup(record,{archive=false}={}){const snap=snapshot(record),totals=recordTotals(record),checked=selectedIds.has(record.id),menu=openMenu===record.id;return `<tr class="${checked?"is-selected":""}"><td><input type="checkbox" data-select-id="${esc(record.id)}" aria-label="Select ${esc(snap.invoiceNumber||"COC")}" ${checked?"checked":""}></td><td data-label="Date completed"><span class="receiver-date-check">✓</span>${dateTime(record.office_completed_at)}${archive&&record.receiver_archived_at?`<small>Archived ${dateTime(record.receiver_archived_at)}</small>`:""}</td><td data-label="Customer"><strong>${esc(snap.customerName||"—")}</strong></td><td data-label="Invoice">${esc(snap.invoiceNumber||"—")}</td><td data-label="IF Number">${esc(snap.ifNumber||"—")}</td><td data-label="Sales order">${esc(snap.salesOrderNumber||"—")}</td><td data-label="Pallets / boxes">${plural(totals.pallets,"pallet")} · ${plural(totals.boxes,"box")}</td><td data-label="Actions"><div class="receiver-row-actions"><button type="button" class="receiver-view" data-action="open" data-id="${esc(record.id)}">VIEW</button><button type="button" class="receiver-small-action" data-action="download" data-id="${esc(record.id)}" aria-label="Download ${esc(snap.invoiceNumber||"COC")}">${icon("download")}</button><div class="receiver-row-menu"><button type="button" class="receiver-small-action" data-action="toggle-row-menu" data-id="${esc(record.id)}" aria-label="More actions" aria-expanded="${menu}">•••</button>${menu?`<div class="receiver-menu"><button type="button" data-action="${archive?"restore-one":"archive-one"}" data-id="${esc(record.id)}">${icon(archive?"restore":"archive")} ${archive?"Restore to Completed":"Archive COC"}</button></div>`:""}</div></div></td></tr>`}
  function pageButtons(){const pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),start=Math.max(1,Math.min(page-2,pages-4)),end=Math.min(pages,start+4);let items=`<button type="button" data-action="page" data-page="${page-1}" ${page<=1?"disabled":""} aria-label="Previous page">‹</button>`;for(let number=start;number<=end;number+=1)items+=`<button type="button" data-action="page" data-page="${number}" class="${number===page?"is-active":""}">${number}</button>`;if(end<pages)items+=`<span>…</span>`;items+=`<button type="button" data-action="page" data-page="${page+1}" ${page>=pages?"disabled":""} aria-label="Next page">›</button>`;return items}
  function reportsPanel({archive=false}={}){const from=total?((page-1)*PAGE_SIZE)+1:0,to=Math.min(page*PAGE_SIZE,total),allChecked=completedDeliveries.length&&completedDeliveries.every((item)=>selectedIds.has(item.id)),dateHeading=sort==="oldest"?"DATE COMPLETED ↑":sort==="newest"?"DATE COMPLETED ↓":"DATE COMPLETED",emptyMessage=search?`No ${archive?"archived":"completed"} COCs match this search${archive?"":` for ${periodLabel().toLowerCase()}`}.`:archive?"No COCs have been archived.":`No completed COCs for ${periodLabel().toLowerCase()}.`;return `<section class="receiver-report-panel"><div class="receiver-panel-title"><div><span class="receiver-eyebrow">${archive?"SECURE RECORD STORAGE":"OFFICE HISTORY"}</span><h2>${archive?"COC ARCHIVE":"COMPLETED COCs"}</h2><p>${archive?"Archived reports remain securely stored, downloadable, and restorable.":"Completed reports stay available here and can be filtered by date."}</p></div></div>${toolbarMarkup({archive})}<div class="receiver-table-wrap"><table><thead><tr><th><input type="checkbox" data-select-page aria-label="Select all reports on this page" ${allChecked?"checked":""}></th><th>${dateHeading}</th><th>CUSTOMER</th><th>INVOICE</th><th>IF NUMBER</th><th>SALES ORDER</th><th>PALLETS / BOXES</th><th>ACTIONS</th></tr></thead><tbody>${completedDeliveries.length?completedDeliveries.map((item)=>rowMarkup(item,{archive})).join(""):`<tr><td colspan="8"><div class="receiver-table-empty">${emptyMessage}</div></td></tr>`}</tbody></table></div><footer class="receiver-pagination"><span>Showing ${from}–${to} of ${total.toLocaleString()} ${archive?"archived":`${periodLabel().toLowerCase()} completed`} COCs</span><nav aria-label="Report pages">${pageButtons()}</nav></footer></section>`}
  function inboxMarkup(){return `<div class="receiver-shell">${header()}${metricsMarkup()}${incomingMarkup()}${reportsPanel()}</div>`}
  function archiveMarkup(){return `<div class="receiver-shell">${header()}<div class="receiver-archive-head">${backButton("show-inbox","Back to COC Receiver")}<div><span class="receiver-eyebrow">RETAINED RECORDS</span><h1>COC Archive</h1><p>Search, download, or restore any archived compliance report.</p></div></div>${reportsPanel({archive:true})}</div>`}
  function palletMarkup(record){return (snapshot(record).pallets||[]).map((pallet)=>`<section class="receiver-pallet"><h3>PALLET ${pallet.number}</h3>${(pallet.lots||[]).map((lot)=>`<div class="receiver-lot"><span><strong>${esc(lot.model)}</strong><small><i>LOT</i><b>${esc(lot.lot)}</b></small></span><b>${plural(Number(lot.cases||0),"box")} · ${(Number(lot.cases||0)*Number(lot.caseQuantity||0)).toLocaleString()} units</b></div>`).join("")}</section>`).join("")}
  function revisionProgress(step){const active={edit:2,review:3}[step]||1,labels=["Review","Edit","Check Changes","Save"];return `<ol class="receiver-revision-progress" aria-label="Official COC final review progress">${labels.map((label,index)=>`<li class="${index+1===active?"is-active":""} ${index+1<active?"is-complete":""}"><span>${index+1<active?"✓":index+1}</span><b>${label}</b></li>`).join("")}</ol>`}
  function revisionHeader(eyebrow,title,copy,badge=""){const snap=snapshot(selected);return `<section class="receiver-revision-head"><div><span class="receiver-eyebrow">${esc(eyebrow)}</span><h1>${esc(title)}</h1><p>${esc(copy||`${snap.customerName||"—"} · ${snap.invoiceNumber||"—"}`)}</p></div>${badge?`<strong>${esc(badge)}</strong>`:""}</section>`}
  function nativeEditorGroups(){const groups=new Map();(revisionState.editor?.lines||[]).forEach((line,index)=>{const pallet=Math.max(1,Number(line.palletNumber)||1);if(!groups.has(pallet))groups.set(pallet,[]);groups.get(pallet).push({...line,index})});return [...groups.entries()].sort((left,right)=>left[0]-right[0])}
  function normalizedSku(value){return Catalog?.normalize?.(value)||String(value||"").trim().toUpperCase()}
  function hasColorSelection(value){const model=normalizedSku(value);return model.split("-").filter(Boolean).length>=3}
  function completeSkuRecord(value){const model=normalizedSku(value);if(!model||!hasColorSelection(model))return null;const exact=(Catalog?.suggestionList?.()||[]).find((item)=>normalizedSku(item.modelNumber)===model);if(!exact)return null;const resolved=Catalog?.resolve?.(model);return{...exact,...resolved,modelNumber:model,caseQuantity:Number(resolved?.caseQuantity||exact.caseQuantity||0)||null}}
  function receiverSkuMatches(value){const query=normalizedSku(value);if(query.length<2)return[];return (Catalog?.suggest?.(query,{limit:18})||[]).filter((item)=>hasColorSelection(item.modelNumber)).slice(0,8)}
  function newEditorLine(palletNumber){return{palletNumber,model:"",lot:"",quantity:"",quantityAuto:false,isNew:true,boxCount:0,unitsPerBox:0,catalogUnitsPerBox:0,boxApplied:false}}
  function nativePalletTotal(lines){return lines.reduce((sum,line)=>sum+(Number(line.quantity)||0),0)}
  function nativeEditorLineMarkup(line,pallet){
    const listId=`receiver-sku-list-${line.index}`,selectedSku=completeSkuRecord(line.model)?.modelNumber||"",isNew=line.isNew===true,boxCount=Math.max(0,Math.round(Number(line.boxCount)||0)),unitsPerBox=Math.max(0,Math.round(Number(line.unitsPerBox)||0)),catalogUnitsPerBox=Math.max(0,Math.round(Number(line.catalogUnitsPerBox)||unitsPerBox)),boxApplied=isNew&&line.boxApplied===true,total=boxCount*unitsPerBox,boxOpen=isNew&&!boxApplied&&Boolean(selectedSku)&&Boolean(String(line.lot||"").trim());
    return `<article class="receiver-edit-sheet-row ${boxOpen?"has-box-counter":""}" data-native-line data-line-index="${line.index}" data-selected-sku="${esc(selectedSku)}" data-quantity-auto="${line.quantityAuto?"true":"false"}" data-is-new="${isNew?"true":"false"}" data-box-count="${boxCount}" data-units-per-box="${unitsPerBox}" data-catalog-units-per-box="${catalogUnitsPerBox}" data-box-applied="${boxApplied?"true":"false"}"><input type="hidden" name="palletNumber" value="${pallet}"><div class="receiver-edit-cell receiver-edit-model-cell"><span class="sr-only">Complete model number with color</span><input name="model" maxlength="100" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(line.model)}" placeholder="Select complete SKU" aria-label="Complete model number with color on pallet ${pallet}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" data-receiver-sku-input required><i class="receiver-sku-chevron" aria-hidden="true">⌄</i><div id="${listId}" class="receiver-sku-suggestions" role="listbox" hidden></div></div><label class="receiver-edit-cell receiver-edit-lot-cell"><span class="sr-only">Lot number</span><input name="lot" maxlength="160" autocomplete="off" autocapitalize="characters" value="${esc(line.lot)}" placeholder="Enter lot number" aria-label="Lot number on pallet ${pallet}" required></label><label class="receiver-edit-cell receiver-edit-quantity-cell ${isNew?"is-box-calculated":""}"><span class="sr-only">Quantity</span><input name="quantity" type="number" inputmode="numeric" min="1" step="1" value="${Number(line.quantity)||(boxApplied?total:"")}" placeholder="${isNew&&!boxApplied?"COUNT BOXES":"0"}" aria-label="${isNew?"Calculated quantity; select to edit boxes":"Quantity"} for ${esc(line.model||`pallet ${pallet}`)}" ${isNew?'readonly data-action="native-edit-boxes" data-box-quantity-trigger':""} required></label><button type="button" class="receiver-native-remove" data-action="native-remove-line" data-index="${line.index}" aria-label="Remove this COC row" title="Remove row">×</button>${isNew?`<div class="receiver-box-counter" data-box-counter ${boxOpen?"":"hidden"}><div class="receiver-box-counter-title"><span>BOX CALCULATOR</span><small>ATLAS calculates the unit total</small></div><div class="receiver-box-stepper"><button type="button" data-action="native-box-minus" aria-label="Remove one box">−</button><label><span>BOXES</span><input type="number" inputmode="numeric" min="0" step="1" value="${boxCount}" data-box-count-input aria-label="Number of boxes"></label><button type="button" data-action="native-box-plus" aria-label="Add one box">+</button></div><div class="receiver-box-equation" aria-live="polite"><span><small>UNITS / BOX</small><b data-box-units>${unitsPerBox?unitsPerBox.toLocaleString():"—"}</b></span><i>×</i><span><small>TOTAL QUANTITY</small><b data-box-total>${total?total.toLocaleString():"0"}</b></span></div><button type="button" class="receiver-box-apply" data-action="native-apply-boxes" ${selectedSku&&String(line.lot||"").trim()&&boxCount>0&&unitsPerBox>0?"":"disabled"}>APPLY TO ROW</button></div>`:line.quantityAuto?`<small class="receiver-native-autofill">ATLAS quantity · editable</small>`:""}</article>`}
  function nativeEditorPalletMarkup(pallet,lines){return `<section class="receiver-edit-pallet" data-native-pallet="${pallet}"><header><strong>PALLET ${pallet}</strong><button type="button" data-action="native-add-line" data-pallet="${pallet}">+ ADD ROW</button></header>${lines.map((line)=>nativeEditorLineMarkup(line,pallet)).join("")}<footer><span aria-hidden="true"></span><strong>TOTAL QTY</strong><b data-native-pallet-total>${nativePalletTotal(lines).toLocaleString()}</b></footer></section>`}
  function nativeEditorMarkup(){const editor=revisionState.editor||{customerName:"",invoiceNumber:"",ifNumber:"",lines:[]};return `<div class="receiver-shell">${header()}${backButton("revision-cancel","Back to COC Review")}${revisionProgress("edit")}${revisionHeader("EDITING OFFICIAL COC","Edit the spreadsheet","Select any white field in the COC below, make the correction, then finish editing to check the locked workbook before approval.","ORIGINAL PRESERVED")}<form class="receiver-native-editor receiver-sheet-editor" data-native-editor><div class="receiver-edit-workbook" aria-label="Editable Certificate of Compliance spreadsheet"><h2>Certificate of Compliance Information Form</h2><section class="receiver-edit-header"><div><strong>CUSTOMER NAME</strong><label><span class="sr-only">Customer name</span><input name="customerName" maxlength="160" value="${esc(editor.customerName)}" required></label><small>(PLEASE INPUT<br>FULL CUSTOMER<br>NAME)</small></div><div><strong>INV-NUMBER</strong><label><span class="sr-only">Invoice number</span><input name="invoiceNumber" maxlength="100" value="${esc(editor.invoiceNumber)}" required></label><small>(PLEASE INPUT<br>FULL<br>INFORMATION)</small></div><div><strong>IF-NUMBER</strong><label><span class="sr-only">IF number</span><input name="ifNumber" maxlength="100" value="${esc(editor.ifNumber)}" required></label><small aria-hidden="true"></small></div></section><div class="receiver-edit-column-head"><strong>MODEL NUMBER</strong><strong>LOT NUMBER<br><small>(Please list pallet # for each model #)</small></strong><strong>QUANTITY</strong></div><div class="receiver-native-pallets">${nativeEditorGroups().map(([pallet,lines])=>nativeEditorPalletMarkup(pallet,lines)).join("")}</div></div><button type="button" class="receiver-native-add-pallet" data-action="native-add-pallet">+ ADD PALLET</button><p class="receiver-revision-note"><strong>The original remains protected.</strong> Finish Editing & Review creates a locked preview of this corrected workbook. You will still approve it separately.</p><p class="receiver-revision-error" data-revision-error role="alert">${esc(revisionState.error)}</p><div class="receiver-revision-actions"><button class="receiver-outline" type="button" data-action="revision-cancel">CANCEL EDIT</button><button class="receiver-primary" type="submit" ${revisionState.loading?"disabled":""}>${revisionState.loading?"GENERATING LOCKED REVIEW…":"FINISH EDITING & REVIEW"}</button></div></form></div>`}
  function displayRevisionValue(value){const clean=String(value??"").trim();return /^\d+$/.test(clean)?Number(clean).toLocaleString():clean}
  function simpleRevisionChange(change){const reference=String(change?.reference||"").toUpperCase(),before=String(change?.before||"").trim(),after=String(change?.after||"").trim(),column=reference.match(/^([ABC])\d+$/)?.[1];if(reference==="B2")return{title:"Customer name updated",detail:`${before||"Blank"} → ${after||"Blank"}`};if(reference==="B3")return{title:"Invoice number updated",detail:`${before||"Blank"} → ${after||"Blank"}`};if(reference==="B4")return{title:"IF updated",detail:`${before||"Blank"} → ${after||"Blank"}`};if(column==="B"&&/^PALLET\s+\d+$/i.test(after))return{title:`${after.toUpperCase()} was added`,detail:"A new pallet section now appears on the COC."};if(column==="A")return{title:before?"SKU updated":"SKU added",detail:before?`${before} → ${after||"Blank"}`:after||"Blank"};if(column==="B")return{title:before?"Lot number updated":"Lot number added",detail:before?`${before} → ${after||"Blank"}`:after||"Blank"};if(column==="C")return{title:before?"Quantity updated":"Quantity added",detail:before?`${displayRevisionValue(before)} → ${displayRevisionValue(after||"0")} units`:`${displayRevisionValue(after||"0")} units`};return{title:"COC information updated",detail:before?`${before} → ${after||"Blank"}`:after||"Updated"}}
  function revisionEditorRowLayout(){
    const pallets=new Map();(revisionState.editor?.lines||[]).forEach((line)=>{const pallet=Math.max(1,Number(line.palletNumber)||1),model=normalizedSku(line.model),key=model.replace(/[^A-Z0-9]/g,"");if(!pallets.has(pallet))pallets.set(pallet,new Map());const models=pallets.get(pallet);if(!models.has(key))models.set(key,{model,lines:[]});models.get(key).lines.push(line)});
    const layout=new Map();let row=7;[...pallets.entries()].sort((left,right)=>left[0]-right[0]).forEach(([pallet,models])=>models.forEach((block)=>{layout.set(row++,{type:"model",pallet,model:block.model});block.lines.forEach((line)=>layout.set(row++,{type:"lot",pallet,model:block.model,lot:String(line.lot||"").trim().toUpperCase(),quantity:Number(line.quantity)||0}));layout.set(row++,{type:"total",pallet,model:block.model});layout.set(row++,{type:"spacer",pallet,model:block.model})}));return layout
  }
  function revisionChangeGroups(){
    const changes=Array.isArray(revisionState.candidate?.changes)?revisionState.candidate.changes:[],headers=[],byRow=new Map(),other=[];
    changes.forEach((change)=>{const reference=String(change?.reference||"").toUpperCase();if(["B2","B3","B4"].includes(reference)){const item=simpleRevisionChange(change);headers.push(`${item.title.replace(" updated","")}: ${item.detail}`);return}const match=reference.match(/^([ABC])(\d+)$/);if(!match){const item=simpleRevisionChange(change);other.push(`${item.title}: ${item.detail}`);return}const row=Number(match[2]);if(!byRow.has(row))byRow.set(row,[]);byRow.get(row).push({...change,column:match[1]})});
    const layout=revisionEditorRowLayout(),palletDetails=new Map(),palletModels=new Map();
    const addPalletDetail=(context,detail)=>{if(!palletDetails.has(context.pallet))palletDetails.set(context.pallet,[]);if(!palletModels.has(context.pallet))palletModels.set(context.pallet,new Set());palletModels.get(context.pallet).add(context.model);const details=palletDetails.get(context.pallet);if(detail&&!details.includes(detail))details.push(detail)};
    byRow.forEach((rowChanges,row)=>{const context=layout.get(row);if(!context){rowChanges.forEach((change)=>{const item=simpleRevisionChange(change);other.push(`${item.title}: ${item.detail}`)});return}if(context.type==="total"||context.type==="spacer")return;const modelChange=rowChanges.find((change)=>change.column==="A"),lotChange=rowChanges.find((change)=>change.column==="B"&&!/^PALLET\s+\d+$/i.test(String(change.after||""))),quantityChange=rowChanges.find((change)=>change.column==="C");if(context.type==="model"){const before=String(modelChange?.before||"").trim(),after=String(modelChange?.after||context.model).trim();addPalletDetail(context,modelChange?(before?`SKU ${before} → ${after}`:`SKU ${after} added`):`${context.model} section updated`);return}const parts=[context.model];if(lotChange){const before=String(lotChange.before||"").trim(),after=String(lotChange.after||context.lot||"Blank").trim();parts.push(before?`Lot ${before} → ${after}`:`Lot ${after} added`)}else if(context.lot)parts.push(`Lot ${context.lot}`);if(quantityChange){const before=String(quantityChange.before||"").trim(),after=String(quantityChange.after||context.quantity||0).trim();parts.push(before?`${displayRevisionValue(before)} → ${displayRevisionValue(after)} units`:`${displayRevisionValue(after)} units added`)}addPalletDetail(context,parts.join(" · "))});
    const groups=[];if(headers.length)groups.push({title:"COC information updated",summary:plural(headers.length,"field"),details:headers});
    if(palletDetails.size){const numbers=[...palletDetails.keys()].sort((a,b)=>a-b),models=numbers.reduce((sum,pallet)=>sum+(palletModels.get(pallet)?.size||0),0),details=numbers.flatMap((pallet)=>palletDetails.get(pallet).map((detail)=>`Pallet ${pallet} — ${detail}`));groups.push({title:`${plural(numbers.length,"pallet")} updated`,summary:`${plural(models,"SKU")} · exact details available`,details})}
    if(other.length)groups.push({title:"Other spreadsheet updates",summary:plural(other.length,"change"),details:other});return groups
  }
  function revisionChanges(groups,rawCount){return `<div class="receiver-revision-changes"><p class="receiver-revision-group-note">${plural(rawCount,"spreadsheet change")} grouped for easier review. Select an area for exact details.</p>${groups.map((group)=>`<details class="receiver-revision-change-group"><summary><i aria-hidden="true">✓</i><span><strong>${esc(group.title)}</strong><small>${esc(group.summary)}</small></span><b aria-hidden="true">⌄</b></summary><ul>${group.details.map((detail)=>`<li>${esc(detail)}</li>`).join("")}</ul></details>`).join("")}</div>`}
  function revisionReviewMarkup(){const candidate=revisionState.candidate,changes=Array.isArray(candidate?.changes)?candidate.changes:[],groups=revisionChangeGroups(),reviewer=Delivery.currentUser()?.user_metadata?.display_name||Delivery.currentUser()?.email||"Signed-in ATLAS user";return `<div class="receiver-shell">${header()}<button type="button" class="receiver-nav-back" data-action="revision-step" data-step="edit"><span class="receiver-nav-back-icon" aria-hidden="true">←</span><span>Back to Edit</span></button>${revisionProgress("review")}${revisionHeader("FINAL CHECK","Review and approve","Check the corrections below. If everything looks right, save the revised COC.","READY TO APPROVE")}<div class="receiver-revision-review"><div>${revisionState.filePreviewHtml}</div><aside><span class="receiver-eyebrow">WHAT CHANGED</span><h2>${plural(groups.length,"area")} updated</h2>${revisionChanges(groups,changes.length)}<p class="receiver-revision-reviewed-by"><strong>Reviewed by</strong><span>${esc(reviewer)}</span></p><p class="receiver-revision-preserved"><i aria-hidden="true">✓</i><span><strong>Original COC remains saved</strong><small>Management can review the edit history later.</small></span></p></aside></div>${revisionState.error?`<p class="receiver-revision-error">${esc(revisionState.error)}</p>`:""}<div class="receiver-revision-actions"><button class="receiver-outline" type="button" data-action="revision-step" data-step="edit">BACK TO EDIT</button><button class="receiver-primary" type="button" data-action="revision-approve" ${revisionState.loading?"disabled":""}>${revisionState.loading?"SAVING OFFICIAL COC…":"APPROVE & SAVE OFFICIAL COC"}</button></div></div>`}
  function approvalCompleteMarkup(){const snap=snapshot(selected);return `<div class="receiver-shell">${header()}${backButton("back-detail","Back to COC Overview")}<section class="receiver-approval-complete"><div class="receiver-revision-success"><i aria-hidden="true">✓</i><span class="receiver-eyebrow">OFFICE REVIEW COMPLETE</span><h1>Official COC Approved</h1><p>${esc(snap.customerName||"—")} · ${esc(snap.invoiceNumber||"—")}</p></div><div class="receiver-complete-actions"><button class="receiver-outline" type="button" data-action="revision-return">VIEW OFFICIAL COC</button><button class="receiver-primary receiver-download" type="button" data-action="download" data-id="${esc(selected.id)}">SAVE COC &amp; E-MAIL</button></div></section></div>`}
  function officialPreviewMarkup(){if(revisionState.step==="edit")return nativeEditorMarkup();if(revisionState.step==="review")return revisionReviewMarkup();if(revisionState.step==="complete")return approvalCompleteMarkup();const snap=snapshot(selected),approved=selected.status==="OFFICE_COMPLETED",body=previewState.status==="ready"&&previewState.id===selected.id?previewState.html:previewState.status==="error"?`<div class="receiver-preview-status is-error"><strong>Preview unavailable</strong><p>${esc(previewState.error)}</p><button type="button" class="receiver-outline" data-action="view-official" data-id="${esc(selected.id)}">TRY AGAIN</button></div>`:`<div class="receiver-preview-status"><span class="receiver-preview-spinner" aria-hidden="true"></span><strong>Opening the COC review…</strong><p>ATLAS is reading the actual XLSX workbook.</p></div>`;return `<div class="receiver-shell">${header()}${backButton("back-detail","Back to COC Overview")}<section class="receiver-preview-head"><span class="receiver-eyebrow">${approved?"OFFICIAL COC · APPROVED":"OFFICE FINAL REVIEW"}</span><h1>${approved?"Official COC":"Review COC Before Approval"}</h1><p>${esc(snap.customerName||"—")} · ${esc(snap.invoiceNumber||"—")}${snap.salesOrderNumber?` · ${esc(snap.salesOrderNumber)}`:""}</p></section>${body}${revisionState.error?`<p class="receiver-revision-error">COC editing is unavailable: ${esc(revisionState.error)}</p>`:""}<div class="receiver-preview-download"><button class="receiver-primary receiver-download" data-action="revision-begin" data-id="${esc(selected.id)}">EDIT COC</button>${approved?`<button class="receiver-primary receiver-download" data-action="download" data-id="${esc(selected.id)}">SAVE COC &amp; E-MAIL</button>`:`<button class="receiver-primary receiver-download receiver-complete" data-action="approve-existing" data-id="${esc(selected.id)}">APPROVE &amp; SAVE COC</button>`}</div></div>`}
  function dialogMarkup(){if(!dialog)return"";const restore=dialog.type.startsWith("restore"),all=dialog.type==="archive-all",count=all?total:dialog.ids.length;return `<div class="receiver-dialog-backdrop" role="presentation"><section class="receiver-dialog" role="dialog" aria-modal="true" aria-labelledby="receiver-dialog-title"><span class="receiver-dialog-icon">${icon(restore?"restore":"archive")}</span><span class="receiver-eyebrow">${restore?"RESTORE COC":"ARCHIVE CONFIRMATION"}</span><h2 id="receiver-dialog-title">${restore?`Restore ${plural(count,"report")}?`:all?"Archive all completed COCs?":`Archive ${plural(count,"report")}?`}</h2><p>${restore?"The selected COC will return to the Completed COCs workspace.":"Archived COCs leave the active workspace but remain securely stored, downloadable, and restorable. Nothing is deleted."}</p><div><button type="button" class="receiver-dialog-cancel" data-action="close-dialog">Cancel</button><button type="button" class="receiver-primary" data-action="confirm-dialog">${restore?"RESTORE":"ARCHIVE"}</button></div></section></div>`}
  function noticeMarkup(){return notice?`<div class="receiver-notice is-${notice.tone||"success"}" role="status">${esc(notice.text)}</div>`:""}
  function retentionMarkup(){return credentials&&!selected?`<div class="receiver-retention">${icon("shield")}<span>COC records are retained securely. Archiving removes them from this workspace without deleting company records.</span></div>`:""}
  function render(){root.innerHTML=(!credentials?pairingMarkup():selected?officialPreviewMarkup():screen==="archive"?archiveMarkup():inboxMarkup())+retentionMarkup()+dialogMarkup()+noticeMarkup();window.requestAnimationFrame?.(()=>window.AtlasCocExcel?.fitOfficialWorkbookPreviews?.(root))}
  function positionOfficialPreview(){
    const place=()=>{if(!selected||!preview||revisionState.step!=="preview")return;const back=root.querySelector('.receiver-nav-back[data-action="back-detail"]');if(!back)return;const current=window.scrollY||document.scrollingElement?.scrollTop||0;const top=Math.max(0,current+back.getBoundingClientRect().top-16);window.scrollTo({top,left:0,behavior:"auto"})};
    window.requestAnimationFrame?.(()=>window.requestAnimationFrame?.(place));
    window.setTimeout(place,140);
  }
  function renderBackgroundUpdate(){if(!(selected&&preview&&previewState.status==="ready"))render()}

  function sortCompletedRecords(records){return [...records].sort((left,right)=>{const leftTime=new Date(left?.office_completed_at||0).valueOf()||0,rightTime=new Date(right?.office_completed_at||0).valueOf()||0;if(sort==="oldest")return leftTime-rightTime;if(sort==="customer-asc"){const customerOrder=String(snapshot(left).customerName||"").localeCompare(String(snapshot(right).customerName||""),undefined,{sensitivity:"base"});return customerOrder||rightTime-leftTime}return rightTime-leftTime})}
  async function loadReportList(section){
    if(section==="archive"||period==="all")return Delivery.receiverInbox(credentials,{section,withMeta:true,page,pageSize:PAGE_SIZE,search,sort});
    const bounds=reportingPeriodBounds(),start=new Date(bounds.periodStart).valueOf(),end=new Date(bounds.periodEnd).valueOf(),records=[];
    let remotePage=1;
    while(true){
      const result=await Delivery.receiverInbox(credentials,{section,withMeta:true,page:remotePage,pageSize:PERIOD_FETCH_PAGE_SIZE,search,sort:"newest"}),batch=Array.isArray(result.deliveries)?result.deliveries:[];
      batch.forEach((record)=>{const completedAt=new Date(record?.office_completed_at||0).valueOf();if(Number.isFinite(completedAt)&&completedAt>=start&&completedAt<end)records.push(record)});
      const reachedStart=batch.some((record)=>{const completedAt=new Date(record?.office_completed_at||0).valueOf();return Number.isFinite(completedAt)&&completedAt<start});
      if(reachedStart||batch.length<PERIOD_FETCH_PAGE_SIZE||remotePage*PERIOD_FETCH_PAGE_SIZE>=Number(result.total||0))break;
      remotePage+=1;
    }
    const ordered=sortCompletedRecords(records),offset=(page-1)*PAGE_SIZE;
    return{deliveries:ordered.slice(offset,offset+PAGE_SIZE),total:ordered.length,page,pageSize:PAGE_SIZE};
  }

  async function loadInbox(){
    if(!credentials)return;const sequence=++loadSequence;loading=true;
    try{
      resetReportingPeriodAtMidnight();
      const section=screen==="archive"?"archive":"completed";
      const todayBounds=reportingPeriodBounds("today");
      let [activeResult,listResult,metricResult]=await Promise.all([
        screen==="archive"?Promise.resolve({deliveries:[]}):Delivery.receiverInbox(credentials,{section:"active",withMeta:true}),
        loadReportList(section),
        Delivery.receiverInbox(credentials,{section:"metrics",withMeta:true,dayStart:todayBounds.periodStart||dayStart()}),
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
  async function startPairing(){try{branchContext=await Delivery.warehouseContext();pairing=await Delivery.createPairing();render();pollPairing()}catch(error){pairing={status:error.message||"Pairing could not start."};render()}}
  async function pollPairing(){if(!pairing?.pairingSessionId)return;for(let attempt=0;attempt<120&&!credentials;attempt+=1){await new Promise((resolve)=>setTimeout(resolve,2500));try{const result=await Delivery.pairingStatus(pairing.pairingSessionId);pairing={...pairing,...result};if(result.status==="PAIRED"){credentials=result.credentials;render();connect();return}render()}catch(error){pairing={...pairing,status:error.message};render();return}}}
  function syncReceiverConnection(){Delivery.heartbeat(credentials).then((result)=>{connection="connected";lastSynced=new Date(result?.at||Date.now());renderBackgroundUpdate()}).catch(()=>{connection=navigator.onLine?"reconnecting":"offline";renderBackgroundUpdate()});loadInbox()}
  function connect(){clearInterval(pollTimer);subscription?.close?.();subscription=Delivery.subscribeToDeliveries({onChange:loadInbox,onState:(state)=>{connection=state;renderBackgroundUpdate()}});pollTimer=setInterval(syncReceiverConnection,10000);syncReceiverConnection()}
  function setScreen(next){screen=next;selected=null;preview=false;previewState={status:"idle",html:"",error:"",id:""};revisionState=freshRevision();selectedIds.clear();openMenu=null;bulkMenu=false;search="";page=1;render();loadInbox()}
  function showNotice(text,tone="success"){notice={text,tone};render();setTimeout(()=>{notice=null;render()},2600)}
  function openConfirmation(type,ids=[]){dialog={type,ids};openMenu=null;bulkMenu=false;render()}
  async function confirmDialog(){const pending=dialog;if(!pending)return;dialog=null;render();try{let result;if(pending.type.startsWith("restore"))result=await Delivery.restoreOfficeArchived(pending.ids,credentials);else result=await Delivery.archiveOfficeCompleted(pending.ids,credentials,{all:pending.type==="archive-all"});selected=null;selectedIds.clear();await loadInbox();showNotice(`${plural(result.updated||pending.ids.length,"COC")} ${pending.type.startsWith("restore")?"restored":"archived"}.`)}catch(error){showNotice(error?.message||"The archive could not be updated.","error")}}
  async function loadWorkbook(id){if(workbookCache.has(id))return workbookCache.get(id);const workbook=await Delivery.downloadOfficeWorkbook(id,credentials);workbook.fileName=officialFileName(recordById(id),workbook.fileName);workbookCache.set(id,workbook);return workbook}
  async function loadRevisionStatus(id){try{const result=await Delivery.cocWorkbookRevision("status",{deliveryId:id},branchCode());if(!selected||selected.id!==id)return;revisionState.currentRevision=result.currentRevision||null;revisionState.revisions=Array.isArray(result.revisions)?result.revisions:[];revisionState.error=""}catch(error){if(selected?.id===id)revisionState.error=revisionError(error,"Workbook revision history is unavailable.")}}
  async function openOfficialPreview(id){const recordId=id||selected?.id;if(!recordId)return;preview=true;revisionState=freshRevision();previewState={status:"loading",html:"",error:"",id:recordId};render();positionOfficialPreview();try{const [workbook]=await Promise.all([loadWorkbook(recordId),loadRevisionStatus(recordId)]);const html=await window.AtlasCocExcel.renderOfficialWorkbookPreview(workbook.blob);if(!selected||selected.id!==recordId||!preview)return;previewState={status:"ready",html,error:"",id:recordId}}catch(error){previewState={status:"error",html:"",error:error?.message||"The Official COC could not be opened.",id:recordId}}render();positionOfficialPreview()}
  function revisionError(error,fallback="The workbook revision could not be completed."){const raw=String(error?.message||error||"");const map=[[/ATLAS_AUTH_REQUIRED/i,"Sign in to ATLAS before revising an Official COC."],[/WAREHOUSE_ACCESS_DENIED/i,"This account cannot revise COCs from another warehouse."],[/COC_REVISION_HAS_NO_CHANGES/i,"No changes were made. Return to the COC review and choose Approve & Save Official COC."],[/COC_REVISION_REASON_REQUIRED/i,"ATLAS could not create the required correction record."],[/COC_REVISION_STATUS_NOT_EDITABLE/i,"Only a received or completed COC can be revised."],[/COC_REVISION_(?:XLSX_REQUIRED|XLSX_INVALID|FILE_INVALID)/i,"ATLAS could not generate a valid Official COC workbook."],[/COC_REVISION_(?:FILE_TOO_LARGE|WORKBOOK_TOO_COMPLEX)/i,"The corrected workbook is too large or complex to approve safely."],[/COC_REVISION_(?:TEMPLATE_STRUCTURE_MISSING|TEMPLATE_LAYOUT_CHANGED|OFFICIAL_SHEET_REQUIRED)/i,"The Official COC template is unavailable or invalid. Reopen the current COC and try again."],[/COC_REVISION_HEADER_FIELDS_REQUIRED/i,"Customer, invoice, and IF must remain populated."],[/COC_REVISION_DETAIL_ROWS_REQUIRED/i,"The revised workbook must contain at least one COC detail row."],[/COC_REVISION_EXTERNAL_CONTENT_NOT_ALLOWED/i,"External links, connections, and macros are not allowed."],[/COC_REVISION_NOT_PENDING/i,"This revision was already processed. Reopen the current Official COC."],[/Request failed \(404\)|COC_REQUEST_FAILED_404/i,"The Official COC revision service is not available yet."]];return map.find(([pattern])=>pattern.test(raw))?.[1]||fallback}
  async function blobToBase64(blob){const bytes=blob instanceof Uint8Array?blob:new Uint8Array(await blob.arrayBuffer()),parts=[];for(let offset=0;offset<bytes.length;offset+=0x8000)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));return btoa(parts.join(""))}
  function syncNativeEditor(){const form=root.querySelector("[data-native-editor]");if(!form||!revisionState.editor)return;revisionState.editor={customerName:form.elements.customerName.value.trim(),invoiceNumber:form.elements.invoiceNumber.value.trim(),ifNumber:form.elements.ifNumber.value.trim(),lines:[...form.querySelectorAll("[data-native-line]")].map((row)=>({palletNumber:Math.max(1,Number(row.querySelector('[name="palletNumber"]').value)||1),model:row.querySelector('[name="model"]').value.trim().toUpperCase(),lot:row.querySelector('[name="lot"]').value.trim().toUpperCase(),quantity:Math.max(0,Math.round(Number(row.querySelector('[name="quantity"]').value)||0)),quantityAuto:row.dataset.quantityAuto==="true",isNew:row.dataset.isNew==="true",boxCount:Math.max(0,Math.round(Number(row.dataset.boxCount)||0)),unitsPerBox:Math.max(0,Math.round(Number(row.dataset.unitsPerBox)||0)),catalogUnitsPerBox:Math.max(0,Math.round(Number(row.dataset.catalogUnitsPerBox)||0)),boxApplied:row.dataset.boxApplied==="true"}))}}
  function updateNativePalletTotal(row){const pallet=row?.closest?.("[data-native-pallet]"),output=pallet?.querySelector?.("[data-native-pallet-total]");if(!output)return;const total=[...pallet.querySelectorAll('[name="quantity"]')].reduce((sum,input)=>sum+(Number(input.value)||0),0);output.textContent=total.toLocaleString()}
  function updateNativeBoxControls(row,{open}={}){
    if(!row||row.dataset.isNew!=="true")return false;
    const panel=row.querySelector("[data-box-counter]"),model=row.querySelector('[name="model"]'),lot=row.querySelector('[name="lot"]'),quantity=row.querySelector('[name="quantity"]'),boxInput=row.querySelector("[data-box-count-input]"),record=completeSkuRecord(model?.value),selected=Boolean(record&&normalizedSku(model.value)===row.dataset.selectedSku),hasLot=Boolean(String(lot?.value||"").trim()),count=Math.max(0,Math.round(Number(boxInput?.value??row.dataset.boxCount)||0)),units=Math.max(0,Math.round(Number(row.dataset.unitsPerBox)||0)),total=count*units,ready=selected&&hasLot&&units>0;
    row.dataset.boxCount=String(count);if(boxInput)boxInput.value=String(count);if(row.dataset.boxApplied!=="true"&&quantity)quantity.value=total>0?String(total):"";
    row.querySelector("[data-box-units]")?.replaceChildren(document.createTextNode(units?units.toLocaleString():"—"));row.querySelector("[data-box-total]")?.replaceChildren(document.createTextNode(total.toLocaleString()));
    const apply=row.querySelector('[data-action="native-apply-boxes"]');if(apply)apply.disabled=!(ready&&count>0);
    const shouldOpen=open===true||(open!==false&&!panel?.hidden);if(panel){panel.hidden=!shouldOpen;row.classList.toggle("has-box-counter",shouldOpen)}
    if(quantity)quantity.placeholder=shouldOpen&&row.dataset.boxApplied!=="true"?"COUNT BOXES":"0";
    updateNativePalletTotal(row);return ready&&count>0;
  }
  function setNativeBoxCount(row,value){const input=row?.querySelector?.("[data-box-count-input]");if(!input)return;input.value=String(Math.max(0,Math.round(Number(value)||0)));row.dataset.boxApplied="false";clearReceiverFieldError(input);updateNativeBoxControls(row,{open:true})}
  function revealNativeBoxCounter(row){if(!row||row.dataset.isNew!=="true")return;row.dataset.boxApplied="false";updateNativeBoxControls(row,{open:true});window.setTimeout(()=>row.querySelector("[data-box-count-input]")?.focus({preventScroll:true}),0)}
  function applyNativeBoxCount(row){
    if(!row)return;const model=row.querySelector('[name="model"]'),lot=row.querySelector('[name="lot"]'),boxInput=row.querySelector("[data-box-count-input]"),quantity=row.querySelector('[name="quantity"]'),record=completeSkuRecord(model?.value),count=Math.max(0,Math.round(Number(boxInput?.value)||0)),units=Math.max(0,Math.round(Number(row.dataset.unitsPerBox)||0));
    if(!record){markReceiverFieldError(model,"Select a complete ATLAS SKU with its color designation.");revealReceiverField(model);return}
    if(!String(lot?.value||"").trim()){markReceiverFieldError(lot,"Lot number is required.");revealReceiverField(lot);return}
    if(!count||!units){markReceiverFieldError(boxInput,"Select at least one box before applying this row.");revealReceiverField(boxInput);return}
    row.dataset.boxCount=String(count);row.dataset.boxApplied="true";row.dataset.quantityAuto="true";quantity.value=String(count*units);clearReceiverFieldError(boxInput);clearReceiverFieldError(quantity);const panel=row.querySelector("[data-box-counter]");if(panel)panel.hidden=true;row.classList.remove("has-box-counter");quantity.placeholder="0";updateNativePalletTotal(row);quantity.focus?.({preventScroll:true});
  }
  function closeReceiverSkuSuggestions(input){const list=input?.closest?.(".receiver-edit-model-cell")?.querySelector?.(".receiver-sku-suggestions");if(list){list.hidden=true;list.innerHTML=""}input?.setAttribute?.("aria-expanded","false");input?.removeAttribute?.("aria-activedescendant")}
  function showReceiverSkuSuggestions(input){
    const list=input?.closest?.(".receiver-edit-model-cell")?.querySelector?.(".receiver-sku-suggestions");
    if(!list)return;
    const matches=receiverSkuMatches(input.value);
    if(normalizedSku(input.value).length<2){closeReceiverSkuSuggestions(input);return}
    list.innerHTML=`<header><span>ATLAS SKU MATCHES</span></header>${matches.length?matches.map((item,index)=>`<button type="button" id="${list.id}-option-${index}" role="option" tabindex="-1" data-action="select-receiver-sku" data-model="${esc(item.modelNumber)}"><span><strong>${esc(item.modelNumber)}</strong></span><b>${item.caseQuantity?`${Number(item.caseQuantity).toLocaleString()}<small>units/box</small>`:"<small>Enter quantity</small>"}</b></button>`).join(""):`<p>No SKUs match. Keep typing or verify the model.</p>`}`;
    list.hidden=false;
    input.setAttribute("aria-expanded","true");
  }
  function activateReceiverSkuSuggestion(input,direction){const list=input?.closest?.(".receiver-edit-model-cell")?.querySelector?.(".receiver-sku-suggestions"),options=[...(list?.querySelectorAll?.("button[role='option']")||[])];if(!options.length)return;const current=options.findIndex((option)=>option.classList.contains("is-active")),next=direction===0?Math.max(0,current):(current+direction+options.length)%options.length;options.forEach((option,index)=>{option.classList.toggle("is-active",index===next);option.setAttribute("aria-selected",index===next?"true":"false")});input.setAttribute("aria-activedescendant",options[next].id);options[next].scrollIntoView?.({block:"nearest"})}
  function clearReceiverFieldError(input){
    if(!input)return;
    input.setCustomValidity("");
    input.removeAttribute("aria-invalid");
    input.classList.remove("is-invalid");
    input.closest(".receiver-box-counter, .receiver-edit-cell, label")?.classList.remove("is-invalid");
  }
  function markReceiverFieldError(input,message){
    input.setCustomValidity(message);
    input.setAttribute("aria-invalid","true");
    input.classList.add("is-invalid");
    input.closest(".receiver-box-counter, .receiver-edit-cell, label")?.classList.add("is-invalid");
  }
  function revealReceiverField(input){
    const row=input.closest?.("[data-native-line]");if(input.matches?.("[data-box-count-input]")&&row)updateNativeBoxControls(row,{open:true});
    const target=input.closest(".receiver-box-counter, .receiver-edit-cell, label")||input;
    target.scrollIntoView?.({behavior:"smooth",block:"center",inline:"center"});
    window.setTimeout(()=>{input.focus?.({preventScroll:true});if(input.matches("[data-receiver-sku-input]"))showReceiverSkuSuggestions(input);input.reportValidity?.()},360);
  }
  function validateNativeEditor(form){
    const fields=[
      [form.elements.customerName,"Customer name is required."],
      [form.elements.invoiceNumber,"Invoice number is required."],
      [form.elements.ifNumber,"IF number is required."],
    ];
    form.querySelectorAll("[data-native-line]").forEach((row)=>{
      fields.push(
        [row.querySelector('[name="model"]'),"Select a complete ATLAS SKU with its color designation.","sku"],
        [row.querySelector('[name="lot"]'),"Lot number is required."],
        row.dataset.isNew==="true"?[row.querySelector("[data-box-count-input]"),"Select the box count, then choose Apply to Row.","boxed",row]:[row.querySelector('[name="quantity"]'),"Enter a whole-number quantity greater than zero.","quantity"],
      );
    });
    let firstInvalid=null;
    fields.forEach(([input,message,type,row])=>{
      if(!input)return;
      const value=String(input.value||"").trim();
      const count=type==="boxed"?Math.max(0,Math.round(Number(row?.dataset.boxCount)||0)):0,units=type==="boxed"?Math.max(0,Math.round(Number(row?.dataset.unitsPerBox)||0)):0,quantity=type==="boxed"?Number(row?.querySelector('[name="quantity"]')?.value||0):0;
      const invalid=!value||(type==="sku"&&!completeSkuRecord(value))||(type==="quantity"&&(!Number.isSafeInteger(Number(value))||Number(value)<=0))||(type==="boxed"&&(row?.dataset.boxApplied!=="true"||count<1||units<1||quantity!==count*units));
      if(invalid){markReceiverFieldError(input,message);if(!firstInvalid)firstInvalid=input;return}
      clearReceiverFieldError(input);
      if(type==="sku"){
        const record=completeSkuRecord(value);
        input.value=record.modelNumber;
        input.closest("[data-native-line]").dataset.selectedSku=record.modelNumber;
      }
    });
    if(!firstInvalid)return true;
    revealReceiverField(firstInvalid);
    return false;
  }
  function selectReceiverSku(input,value){const record=completeSkuRecord(value),row=input?.closest?.("[data-native-line]");if(!record||!row)return false;input.value=record.modelNumber;clearReceiverFieldError(input);row.dataset.selectedSku=record.modelNumber;closeReceiverSkuSuggestions(input);const quantity=row.querySelector('[name="quantity"]');if(row.dataset.isNew==="true"){row.dataset.catalogUnitsPerBox=String(record.caseQuantity||0);row.dataset.unitsPerBox=String(record.caseQuantity||0);row.dataset.boxCount="0";row.dataset.boxApplied="false";row.dataset.quantityAuto="false";if(quantity)quantity.value="";updateNativeBoxControls(row,{open:Boolean(row.querySelector('[name="lot"]')?.value.trim())})}else if(quantity&&record.caseQuantity){quantity.value=String(record.caseQuantity);clearReceiverFieldError(quantity);row.dataset.quantityAuto="true";row.querySelector(".receiver-native-autofill")?.remove();row.insertAdjacentHTML("beforeend",'<small class="receiver-native-autofill">ATLAS VERIFIED · quantity added</small>')}updateNativePalletTotal(row);row.querySelector('[name="lot"]')?.focus();return true}
  function nativeWorkbookData(){const editor=revisionState.editor;if(!editor?.customerName||!editor.invoiceNumber||!editor.ifNumber)throw new Error("COC_REVISION_HEADER_FIELDS_REQUIRED");if(!editor.lines?.length)throw new Error("COC_REVISION_DETAIL_ROWS_REQUIRED");const pallets=new Map();editor.lines.forEach((line)=>{const palletNumber=Math.max(1,Number(line.palletNumber)||1),sku=completeSkuRecord(line.model),model=sku?.modelNumber||"",lot=String(line.lot||"").trim().toUpperCase(),quantity=Number(line.quantity),boxCount=Math.max(0,Math.round(Number(line.boxCount)||0)),unitsPerBox=Math.max(0,Math.round(Number(line.unitsPerBox)||0));if(!sku)throw new Error("COC_NATIVE_EDITOR_SKU_INCOMPLETE");if(line.isNew&&(line.boxApplied!==true||boxCount<1||unitsPerBox<1||quantity!==boxCount*unitsPerBox))throw new Error("COC_NATIVE_EDITOR_BOX_COUNT_REQUIRED");if(!lot||!Number.isSafeInteger(quantity)||quantity<=0)throw new Error("COC_NATIVE_EDITOR_LINE_INVALID");if(!pallets.has(palletNumber))pallets.set(palletNumber,new Map());const models=pallets.get(palletNumber),key=model.replace(/[^A-Z0-9]/g,"");if(!models.has(key))models.set(key,{modelNumber:model,lots:[]});models.get(key).lots.push({model,cleanLot:lot,quantity})});return{customerName:editor.customerName.toUpperCase(),invoiceNumber:editor.invoiceNumber,ifNumber:editor.ifNumber,pallets:[...pallets.entries()].sort((left,right)=>left[0]-right[0]).map(([palletNumber,models])=>({palletNumber,modelBlocks:[...models.values()].map((block)=>({...block,totalQuantity:block.lots.reduce((sum,lot)=>sum+lot.quantity,0)}))}))}}
  async function beginNativeRevision(){if(revisionState.loading)return;revisionState.loading=true;revisionState.error="";render();try{const [workbook]=await Promise.all([loadWorkbook(selected.id),Promise.resolve(Catalog?.loadRemote?.()).catch(()=>null)]),editor=await window.AtlasCocExcel.readOfficialWorkbookData(workbook.blob);revisionState={...revisionState,step:"edit",loading:false,error:"",editor:{...editor,lines:(editor.lines||[]).map((line)=>({...line,quantityAuto:false,isNew:false,boxCount:0,unitsPerBox:0,catalogUnitsPerBox:0,boxApplied:true}))},candidate:null,filePreviewHtml:"",generatedBytes:null};render();window.scrollTo({top:0,left:0,behavior:"auto"})}catch(error){revisionState.loading=false;revisionState.error=revisionError(error,"ATLAS could not open this COC for editing.");render()}}
  async function stageNativeRevision(form){const errorNode=form.querySelector("[data-revision-error]"),submit=form.querySelector('button[type="submit"]');syncNativeEditor();revisionState.loading=true;revisionState.error="";if(submit){submit.disabled=true;submit.textContent="GENERATING LOCKED REVIEW…"}try{const data=nativeWorkbookData(),workbook=await loadWorkbook(selected.id),templateBytes=new Uint8Array(await workbook.blob.arrayBuffer()),bytes=await window.AtlasCocExcel.populateOfficialTemplate({templateBytes,data}),fileName=window.AtlasCocExcel.outputFileName(data.customerName,data.invoiceNumber,data.ifNumber),previewHtml=await window.AtlasCocExcel.renderOfficialWorkbookPreview(bytes),result=await Delivery.cocWorkbookRevision("stage-revision",{deliveryId:selected.id,fileName,workbookBase64:await blobToBase64(bytes),reason:"Office final review correction"},branchCode());revisionState={...revisionState,step:"review",loading:false,error:"",candidate:result.candidate||null,filePreviewHtml:previewHtml,generatedBytes:bytes};render();window.scrollTo({top:0,left:0,behavior:"auto"})}catch(error){const raw=String(error?.message||"");revisionState.loading=false;revisionState.error=/COC_NATIVE_EDITOR_SKU_INCOMPLETE/.test(raw)?"Every COC row must use a complete ATLAS SKU with its color designation.":/COC_NATIVE_EDITOR_BOX_COUNT_REQUIRED/.test(raw)?"Every new row must have an applied box count.":revisionError(error,/COC_NATIVE_EDITOR_LINE_INVALID/.test(raw)?"Every COC row requires a lot number and whole-number quantity greater than zero.":"The corrected COC could not be generated.");if(errorNode)errorNode.textContent=revisionState.error;if(submit){submit.disabled=false;submit.textContent="FINISH EDITING & REVIEW"}}}
  async function approveRevision(){const candidate=revisionState.candidate;if(!candidate?.id||revisionState.loading)return;revisionState.loading=true;revisionState.error="";render();try{const editor=revisionState.editor,result=await Delivery.cocWorkbookRevision("approve-revision",{deliveryId:selected.id,revisionId:candidate.id},branchCode());if(selected.status!=="OFFICE_COMPLETED"){await Delivery.markOfficeCompleted(selected.id,credentials);selected.status="OFFICE_COMPLETED";selected.office_completed_at=new Date().toISOString()}selected.report_snapshot=References?.normalizeSnapshot?.({...snapshot(selected),customerName:editor?.customerName||snapshot(selected).customerName,invoiceNumber:editor?.invoiceNumber||snapshot(selected).invoiceNumber,ifNumber:editor?.ifNumber||snapshot(selected).ifNumber})||{...snapshot(selected),customerName:editor?.customerName||snapshot(selected).customerName,invoiceNumber:editor?.invoiceNumber||snapshot(selected).invoiceNumber,ifNumber:editor?.ifNumber||snapshot(selected).ifNumber};workbookCache.delete(selected.id);const workbook=await loadWorkbook(selected.id),html=await window.AtlasCocExcel.renderOfficialWorkbookPreview(workbook.blob);previewState={status:"ready",html,error:"",id:selected.id};revisionState={...freshRevision(),step:"preview",currentRevision:result.approved||candidate};notice={tone:"success",text:"Official COC updated and saved."};void loadInbox();render();positionOfficialPreview();setTimeout(()=>{notice=null;render()},2600)}catch(error){revisionState.loading=false;revisionState.error=revisionError(error,"The corrected COC could not be approved.");render()}}
  async function approveExisting(){if(!selected||revisionState.loading)return;revisionState.loading=true;revisionState.error="";render();try{if(selected.status!=="OFFICE_COMPLETED"){await Delivery.markOfficeCompleted(selected.id,credentials);selected.status="OFFICE_COMPLETED";selected.office_completed_at=new Date().toISOString()}revisionState={...freshRevision(),step:"complete"};notice={tone:"success",text:"Official COC approved and saved."};void loadInbox();render();setTimeout(()=>{notice=null;render()},2600);window.scrollTo({top:0,left:0,behavior:"auto"})}catch(error){revisionState.loading=false;revisionState.error=error?.message||"The Official COC could not be approved.";render()}}
  async function download(button){
    button.disabled=true;
    try{
      const id=button.dataset.id;
      const suggestedName=officialFileName(recordById(id));
      let fileHandle=null;
      if(typeof window.showSaveFilePicker==="function"){
        try{
          fileHandle=await window.showSaveFilePicker({
            suggestedName,
            startIn:"desktop",
            types:[{
              description:"Excel Workbook",
              accept:{"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":[".xlsx"]},
            }],
            excludeAcceptAllOption:true,
          });
        }catch(error){
          if(error?.name==="AbortError")return;
        }
      }
      const workbook=await loadWorkbook(id);
      if(fileHandle){
        const writable=await fileHandle.createWritable();
        await writable.write(workbook.blob);
        await writable.close();
        showNotice("Official COC saved.");
      }else{
        window.AtlasCocStorage?.downloadBlob(workbook.blob,workbook.fileName);
      }
      return true;
    }catch(error){
      showNotice(error?.message||"The official COC could not be saved.","error");return false;
    }finally{
      button.disabled=false;
    }
  }

  root.addEventListener("click",async(event)=>{
    const button=event.target.closest("[data-action]");if(!button)return;const action=button.dataset.action,id=button.dataset.id;
    if(action==="start-pairing")startPairing();
    if(action==="open"){selected=[...activeDeliveries,...completedDeliveries].find((item)=>item.id===id)||null;previewState={status:"idle",html:"",error:"",id:""};revisionState=freshRevision();openMenu=null;if(selected)await openOfficialPreview(selected.id);else render()}
    if(action==="back"){selected=null;preview=false;previewState={status:"idle",html:"",error:"",id:""};revisionState=freshRevision();render()}
    if(action==="view-official")await openOfficialPreview(id);
    if(action==="back-detail"){selected=null;preview=false;previewState={status:"idle",html:"",error:"",id:""};revisionState=freshRevision();render();window.scrollTo({top:0,left:0,behavior:"auto"})}
    if(action==="revision-begin")await beginNativeRevision();
    if(action==="revision-cancel"){revisionState={...revisionState,step:"preview",loading:false,error:"",editor:null,candidate:null,filePreviewHtml:"",generatedBytes:null};render();positionOfficialPreview()}
    if(action==="revision-step"){revisionState={...revisionState,step:button.dataset.step||"preview",loading:false,error:""};render();window.scrollTo({top:0,left:0,behavior:"auto"})}
    if(action==="native-add-line"){syncNativeEditor();const pallet=Math.max(1,Number(button.dataset.pallet)||1);revisionState.editor.lines.push(newEditorLine(pallet));revisionState.error="";render()}
    if(action==="native-remove-line"){syncNativeEditor();if(revisionState.editor.lines.length<=1){revisionState.error="The COC must contain at least one line."}else{revisionState.editor.lines.splice(Math.max(0,Number(button.dataset.index)||0),1);revisionState.error=""}render()}
    if(action==="native-add-pallet"){syncNativeEditor();const next=Math.max(0,...revisionState.editor.lines.map((line)=>Number(line.palletNumber)||0))+1;revisionState.editor.lines.push(newEditorLine(next));revisionState.error="";render();window.scrollTo({top:document.body.scrollHeight,left:0,behavior:"smooth"})}
    if(action==="select-receiver-sku"){const row=button.closest("[data-native-line]");selectReceiverSku(row?.querySelector("[data-receiver-sku-input]"),button.dataset.model)}
    if(action==="native-box-minus"){const row=button.closest("[data-native-line]"),input=row?.querySelector("[data-box-count-input]");setNativeBoxCount(row,(Number(input?.value)||0)-1)}
    if(action==="native-box-plus"){const row=button.closest("[data-native-line]"),input=row?.querySelector("[data-box-count-input]");setNativeBoxCount(row,(Number(input?.value)||0)+1)}
    if(action==="native-apply-boxes")applyNativeBoxCount(button.closest("[data-native-line]"));
    if(action==="native-edit-boxes")revealNativeBoxCounter(button.closest("[data-native-line]"));
    if(action==="revision-approve")await approveRevision();
    if(action==="approve-existing")await approveExisting();
    if(action==="revision-return"){revisionState={...revisionState,step:"preview",loading:false,error:"",editor:null,candidate:null,filePreviewHtml:"",generatedBytes:null};render();positionOfficialPreview()}
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
  });
  root.addEventListener("input",(event)=>{
    const input=event.target;
    if(input.matches("[data-receiver-search]")){search=input.value;page=1;selectedIds.clear();clearTimeout(searchTimer);searchTimer=setTimeout(loadInbox,260);return}
    if(!input.closest?.("[data-native-editor]"))return;
    clearReceiverFieldError(input);
    const row=input.closest?.("[data-native-line]");
    if(!row)return;
    if(input.matches("[data-box-count-input]")){setNativeBoxCount(row,input.value);return}
    if(input.matches('[name="model"]')){
      const start=input.selectionStart,end=input.selectionEnd;
      input.value=input.value.toUpperCase();
      if(start!==null)input.setSelectionRange?.(start,end);
      if(normalizedSku(input.value)!==row.dataset.selectedSku){
        row.dataset.selectedSku="";
        row.dataset.quantityAuto="false";
        if(row.dataset.isNew==="true"){row.dataset.boxCount="0";row.dataset.unitsPerBox="0";row.dataset.catalogUnitsPerBox="0";row.dataset.boxApplied="false"}
        const quantity=row.querySelector('[name="quantity"]');
        if(quantity){quantity.value="";clearReceiverFieldError(quantity)}
        row.querySelector(".receiver-native-autofill")?.remove();
        if(row.dataset.isNew==="true")updateNativeBoxControls(row,{open:false});
        updateNativePalletTotal(row);
      }
      showReceiverSkuSuggestions(input);
      return;
    }
    if(input.matches('[name="lot"]')&&row.dataset.isNew==="true"){row.dataset.boxApplied="false";updateNativeBoxControls(row,{open:Boolean(input.value.trim()&&row.dataset.selectedSku)});return}
    if(input.matches('[name="quantity"]')){
      row.dataset.quantityAuto="false";
      row.querySelector(".receiver-native-autofill")?.remove();
      updateNativePalletTotal(row);
    }
  });
  root.addEventListener("focusin",(event)=>{if(event.target.matches?.("[data-receiver-sku-input]"))showReceiverSkuSuggestions(event.target)});
  root.addEventListener("focusout",(event)=>{
    if(!event.target.matches?.("[data-receiver-sku-input]"))return;
    const input=event.target;
    window.setTimeout(()=>{if(!input.closest(".receiver-edit-model-cell")?.contains(document.activeElement))closeReceiverSkuSuggestions(input)},120);
  });
  root.addEventListener("keydown",(event)=>{
    const input=event.target;
    if(input.matches?.("[data-box-quantity-trigger]")&&(event.key==="Enter"||event.key===" ")){event.preventDefault();revealNativeBoxCounter(input.closest("[data-native-line]"));return}
    if(!input.matches?.("[data-receiver-sku-input]"))return;
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();
      if(input.getAttribute("aria-expanded")!=="true")showReceiverSkuSuggestions(input);
      activateReceiverSkuSuggestion(input,event.key==="ArrowDown"?1:-1);
      return;
    }
    if(event.key==="Enter"&&input.getAttribute("aria-expanded")==="true"){
      const active=input.closest(".receiver-edit-model-cell")?.querySelector(".receiver-sku-suggestions .is-active");
      if(active){event.preventDefault();selectReceiverSku(input,active.dataset.model)}
      return;
    }
    if(event.key==="Escape"){event.preventDefault();closeReceiverSkuSuggestions(input)}
  });
  root.addEventListener("change",(event)=>{
    if(event.target.matches("[data-receiver-period]")){period=PERIOD_VALUES.has(event.target.value)?event.target.value:"today";reportingDayKey=reportingDateKey();page=1;selectedIds.clear();openMenu=null;bulkMenu=false;render();loadInbox();return}
    if(event.target.matches("[data-receiver-sort]")){sort=event.target.value;writePreference("sort",sort);page=1;selectedIds.clear();render();loadInbox();return}
    if(event.target.matches("[data-select-id]")){event.target.checked?selectedIds.add(event.target.dataset.selectId):selectedIds.delete(event.target.dataset.selectId);render();return}
    if(event.target.matches("[data-select-page]")){if(event.target.checked)completedDeliveries.forEach((item)=>selectedIds.add(item.id));else completedDeliveries.forEach((item)=>selectedIds.delete(item.id));render()}
  });
  root.addEventListener("submit",async(event)=>{
    if(event.target.matches("[data-receiver-sign-in]")){
      event.preventDefault();if(!event.target.reportValidity()||signInState.loading)return;
      const form=event.target,loginName=form.elements.login_name.value,password=form.elements.password.value;
      signInState={loading:true,error:""};render();
      try{await window.AtlasAuth.signIn(loginName,password);signInState={loading:false,error:""}}
      catch(error){signInState={loading:false,error:error?.message||"Sign in failed."};render()}
      return;
    }
    if(!event.target.matches("[data-native-editor]"))return;event.preventDefault();if(!validateNativeEditor(event.target))return;stageNativeRevision(event.target)
  });
  async function refreshReceiverAuth(){const sequence=++receiverAuthSequence;credentials=null;branchContext=await Delivery.warehouseContext({force:true}).catch(()=>null);const verified=await Delivery.verifyReceiver().catch(()=>({paired:false}));if(sequence!==receiverAuthSequence)return;credentials=verified.paired?verified.credentials:null;if(verified.warehouse)branchContext={...(branchContext||{}),warehouse:verified.warehouse};signInState={loading:false,error:""};render();if(credentials)connect()}
  window.addEventListener("atlas-auth-changed",()=>{void refreshReceiverAuth()});
  window.addEventListener("online",connect);window.addEventListener("offline",()=>{connection="offline";renderBackgroundUpdate()});
  (async()=>{branchContext=await Delivery.warehouseContext().catch(()=>null);const verified=await Delivery.verifyReceiver().catch(()=>({paired:false}));credentials=verified.paired?verified.credentials:null;if(verified.warehouse)branchContext={...(branchContext||{}),warehouse:verified.warehouse};render();if(credentials)connect()})();
})();
