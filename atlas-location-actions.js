(() => {
  const code = entry => entry?.querySelector('.location-badge')?.textContent?.trim() || '';
  const mount = card => {
    const selected = card.querySelector('.location-entry.selected');
    const list = card.querySelector('.location-list');
    const existing = card.querySelector('.atlas-location-actions');
    if (!selected || !list) {
      existing?.remove();
      return;
    }
    const location = code(selected); if (!location) return;

    // Keep this enhancement idempotent. Replacing the panel on every mutation
    // caused the observer below to trigger itself forever and freeze ATLAS as
    // soon as a SKU result with a selected location was rendered.
    if (
      existing?.dataset.location === location &&
      selected.nextElementSibling === existing
    ) return;

    const panel = existing || document.createElement('section');
    panel.className='atlas-location-actions';
    panel.dataset.location=location;
    panel.innerHTML=`<h3>LOCATION ACTIONS · ${location}</h3><p>${location} is selected as the source location.</p><div class="atlas-location-actions-grid"><button data-action="primary"><span>★</span>Make Primary</button><button class="pick" data-action="pick"><span>⚑</span>Set Pick First</button><button class="move" data-action="move"><span>↔</span>Move From ${location}</button><button class="empty" data-action="empty"><span>▣</span>Mark ${location} Empty</button></div>`;
    selected.insertAdjacentElement('afterend',panel);
  };
  const refresh=()=>document.querySelectorAll('.result-card').forEach(mount);
  let refreshQueued=false;
  const queueRefresh=()=>{
    if(refreshQueued)return;
    refreshQueued=true;
    window.requestAnimationFrame(()=>{refreshQueued=false;refresh();});
  };
  new MutationObserver(queueRefresh).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  document.addEventListener('click',e=>{ const b=e.target instanceof Element ? e.target.closest('.atlas-location-actions button') : null; if(!b)return; const card=b.closest('.result-card'); const action=b.dataset.action; if(action==='move') card.querySelector('.atlas-quick-action-move')?.click(); else if(action==='empty') card.querySelector('.atlas-quick-action-clear')?.click(); else if(action==='primary') alert('This location is already selected. Primary Location will be saved when you confirm this action.'); else alert('Use Manage Pick First to set this selected location as Pick First.'); });
  window.addEventListener('DOMContentLoaded',refresh);
  if(document.readyState!=='loading')queueRefresh();
})();
