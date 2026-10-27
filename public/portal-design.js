/* Presentation layer for the shared portal. Demo mode never changes authentication. */
window.portalPreviewMode = sessionStorage.getItem('globaltex-preview-mode') === 'hotel' ? 'hotel' : 'company';
const designLink=document.createElement('link');designLink.rel='stylesheet';designLink.href='/assets/portal-design.css';document.head.append(designLink);
const iconPaths={home:'M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7',hotels:'M4 21V5h10v16M14 10h6v11M2 21h20M8 9h2M8 13h2M8 17h2M17 14h1M17 18h1',tagging:'m3 3 8 0 10 10-8 8L3 11V3ZM7 7h.01',transfers:'M3 6h12v12H3zM15 10h4l3 4v4h-7M7 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',stock:'M5 7h14l1 14H4L5 7ZM8 7V5a4 4 0 0 1 8 0v2',products:'m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7 5l10 6',locations:'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',care:'M4 3h16v18H4zM4 8h16M8 5h.01M11 5h.01M12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',devices:'M4 9a12 12 0 0 1 16 0M7 12a8 8 0 0 1 10 0M10 15a3 3 0 0 1 4 0M12 19h.01'};
const uiIcon=(name)=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPaths[name]??iconPaths.home}"/></svg>`;
document.querySelector('.brand').insertAdjacentHTML('beforeend','<div class="brand-copy"><strong>GLOBALTEX</strong><small>Inventory operations</small></div><button id="mobile-nav-toggle" type="button" aria-label="Open navigation" aria-expanded="false">☰</button>');
$('mobile-nav-toggle').onclick=()=>{const open=document.body.classList.toggle('nav-open');$('mobile-nav-toggle').setAttribute('aria-expanded',String(open));};
document.addEventListener('click',e=>{if(e.target.closest('[data-page],[data-go]')){document.body.classList.remove('nav-open');$('mobile-nav-toggle').setAttribute('aria-expanded','false');}});
const tools=document.querySelector('header .tools');
tools.insertAdjacentHTML('afterbegin','<label id="preview-control" hidden><span>TEST WORKSPACE</span><select id="preview-workspace" aria-label="Test workspace"><option value="company">Globaltex Head Office</option><option value="hotel">Hotel portal · demo</option></select></label>');
document.querySelector('main').insertAdjacentHTML('afterbegin','<div id="preview-banner" hidden role="status"><span class="demo-dot"></span><strong>HOTEL PREVIEW</strong><span>Sample data · viewing only</span><button type="button" id="exit-preview">Back to company ↗</button></div>');
const switchPreview=mode=>{sessionStorage.setItem('globaltex-preview-mode',mode);location.assign('/dashboard/control#home');};
$('preview-workspace').onchange=e=>switchPreview(e.target.value);$('exit-preview').onclick=()=>switchPreview('company');
fetch('/v1/admin/preview',{credentials:'same-origin'}).then(r=>r.ok?r.json():{enabled:false}).then(config=>{
 $('preview-control').hidden=!config.enabled;
 if(!config.enabled&&window.portalPreviewMode==='hotel'){sessionStorage.removeItem('globaltex-preview-mode');location.replace('/dashboard/control');return;}
 $('preview-workspace').value=window.portalPreviewMode;
 $('preview-banner').hidden=!(config.enabled&&window.portalPreviewMode==='hotel');
 document.body.classList.toggle('preview-mode',config.enabled&&window.portalPreviewMode==='hotel');
}).catch(()=>{$('preview-control').hidden=true;});

const designRenderWorkflow=renderWorkflow;
renderWorkflow=function(){
 designRenderWorkflow();
 document.body.classList.add('refined-portal');
 document.body.classList.toggle('company-portal',isAdmin());
 for(const button of document.querySelectorAll('nav [data-page]')){
   const title=button.textContent.replace(/^\d+\.\s*/,''),number=button.textContent.match(/^\d+/)?.[0];
   button.innerHTML=`${uiIcon(button.dataset.page)}<span>${esc(title)}</span>${number?`<small>${number}</small>`:''}`;
 }
 const heading=$('welcome-title');heading.innerHTML=isAdmin()?'Every item.<br><em>In the right place.</em>':'Your hotel.<br><em>Everything accounted for.</em>';
 $('welcome-copy').textContent=isAdmin()?'Prepare your products. Connect your warehouses. Deliver with confidence.':'A clear view of your linen, from delivery to the next clean return.';
 $('welcome-label').textContent=isAdmin()?'GLOBALTEX / OPERATIONS':'HOTEL / INVENTORY';
 const primary=document.querySelector('#page-home .hero [data-go]');primary.dataset.go=isAdmin()?'tagging':'transfers';primary.innerHTML=`${uiIcon(isAdmin()?'tagging':'transfers')} ${isAdmin()?'Tag products':'Receive a delivery'}`;
 if(!$('hero-secondary'))primary.insertAdjacentHTML('afterend','<button id="hero-secondary" class="button" data-go="transfers">Create transfer ↗</button>');
 $('hero-secondary').dataset.go=isAdmin()?'transfers':'care';$('hero-secondary').textContent=isAdmin()?'Create transfer ↗':'Track a location ↗';
 if(!$('network-dashboard'))document.querySelector('#page-home .cards').insertAdjacentHTML('afterend','<div id="network-dashboard"></div>');
 if(isAdmin())renderCompanyNetwork();else renderHotelSnapshot();
 for(const button of document.querySelectorAll('#workflow-steps .step-card')){
   const page=button.dataset.go;
   if(!button.querySelector('svg'))button.insertAdjacentHTML('afterbegin',uiIcon(page));
   if(!button.querySelector('.step-arrow'))button.insertAdjacentHTML('beforeend','<i class="step-arrow">↗</i>');
 }
 const metricLabels=[['metric-total','Tagged inventory'],['metric-available',isAdmin()?'Ready to dispatch':'Available to use'],['metric-requests',isAdmin()?'Open hotel orders':'Open requests'],['metric-transit','In transit']];
 for(const [id,label]of metricLabels)$(id).closest('.card').querySelector('small').textContent=label;
 const refresh=$('refresh');refresh.innerHTML='<span aria-hidden="true">↻</span> Refresh';
 $('updated').textContent=`Updated ${new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})} · ${window.portalPreviewMode==='hotel'?'Demo data':isAdmin()?'Company workspace':'Private hotel workspace'}`;
 if(isAdmin()&&['houston','miami'].every(id=>workflowData.facilities.some(f=>f.facilityId===id)))$('setup-warehouses').hidden=true;
 if(window.portalPreviewMode==='hotel'){
   $('preview-banner').hidden=false;
   for(const button of document.querySelectorAll('form [type="submit"]')){button.disabled=true;button.setAttribute('title','Read-only demo. Changes are disabled.');}
 }
};

function renderCompanyNetwork(){
 const facilities=workflowData.facilities.filter(f=>['houston','miami'].includes(f.facilityId)&&f.active!==false);
 const site=f=>{const items=workflowData.assets.filter(a=>a.facilityId===f.facilityId);return `<div class="network-site"><div class="site-top"><span class="site-icon">${uiIcon('products')}</span><span class="site-status"><i></i> Active facility</span></div><small>${f.facilityId==='houston'?'TEXAS / CENTRAL':'FLORIDA / EASTERN'}</small><h3>${f.facilityId==='houston'?'Houston':'Miami'}<span>${f.facilityId==='houston'?'TX':'FL'}</span></h3><p>${esc(f.timezone)}</p><div class="site-bottom"><strong>${items.filter(a=>a.assetStatus==='active'&&!a.inTransit).length}<small>available items</small></strong><button class="text-action" data-warehouse="${esc(f.facilityId)}">Open warehouse ↗</button></div></div>`;};
 const recent=[...workflowData.shipments].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,3);
 const outside=workflowData.assets.filter(a=>!['houston','miami'].includes(a.facilityId)).length;
 $('network-dashboard').innerHTML=`<div class="network-main panel"><div class="panel-head"><div><div class="eyebrow">YOUR DISTRIBUTION NETWORK</div><h2>${facilities.length===2?'Two warehouses. One clear view.':'Your warehouse network.'}</h2></div><span class="subtle-count">${facilities.length} US facilities</span></div><div class="network-sites">${facilities.length?facilities.map(site).join('<div class="route-connector" aria-hidden="true"><span></span>⇄<span></span></div>'):'<div class="empty">Set up Houston and Miami in Warehouses & transfers.</div>'}</div><div class="network-foot"><span>${outside?`${outside} tagged items at other receiving locations`:'Ready for your first warehouse receipt'}</span><button class="text-action" data-go="transfers">Manage transfers ↗</button></div></div><div class="dispatch-panel panel"><div class="panel-head"><div><div class="eyebrow">ON THE MOVE</div><h2>Delivery activity</h2></div>${uiIcon('transfers')}</div><div class="dispatch-list">${recent.length?recent.map(s=>`<div class="dispatch-row"><span class="dispatch-marker ${s.status==='received'?'done':''}"></span><div><strong>${esc(s.reference||'Warehouse transfer')}</strong><small>${s.assetCount} items · ${s.acceptedAssetCount} received</small></div><span class="dispatch-state">${s.status==='received'?'Received':s.status==='partially_received'?'Partial':'In transit'}</span></div>`).join(''):'<div class="empty">Your next delivery starts here.</div>'}</div><button class="dispatch-link" data-go="stock">View customer orders <span>↗</span></button></div>`;
}
function renderHotelSnapshot(){
 const stages=[['clean','Storage','#9baf9d'],['in_wash','Washing','#9cabbc'],['drying','Drying','#b6a5bf'],['distribution','Distribution','#bca16c'],['in_room','In Use','#d1b2a5']];
 const total=workflowData.assets.length||1;
 $('network-dashboard').innerHTML=`<div class="hotel-stage-panel panel"><div class="panel-head"><div><div class="eyebrow">YOUR LINEN CYCLE</div><h2>From Use Back to Ready.</h2></div><button class="text-action" data-go="care">View locations ↗</button></div><div class="stage-bar">${stages.map(([stage,label,color])=>{const count=workflowData.assets.filter(a=>a.stage===stage).length;return `<div style="flex:${Math.max(count,0.1)};background:${color}" title="${label}: ${count}"></div>`;}).join('')}</div><div class="stage-legend">${stages.map(([stage,label,color])=>`<div><small><i style="background:${color}"></i>${label}</small><strong>${workflowData.assets.filter(a=>a.stage===stage).length}</strong></div>`).join('')}</div><div class="network-foot"><span>Only your hotel can see its internal inventory.</span><button class="text-action" data-go="care">Track a movement ↗</button></div></div><div class="dispatch-panel panel"><div class="panel-head"><div><div class="eyebrow">KEEP THINGS MOVING</div><h2>Your next step</h2></div></div><div class="hotel-next"><strong>${workflowData.shipments.filter(s=>s.status!=='received').length} incoming deliveries</strong><p>Check arriving items and confirm what reached your hotel.</p><button class="button primary" data-go="transfers">Receive delivery ↗</button><button class="text-action" data-go="stock">Request more stock ↗</button></div></div>`;
}

document.addEventListener('click',e=>{
 const target=e.target.closest('[data-warehouse]');if(!target||!isAdmin())return;
 const id=target.dataset.warehouse,facility=workflowData.facilities.find(f=>f.facilityId===id);if(!facility)return;
 go('transfers');$('transfer-source').value=id;
 if(!$('warehouse-inspector'))$('warehouse-summary').insertAdjacentHTML('afterend','<div id="warehouse-inspector" class="panel"></div>');
 const items=workflowData.assets.filter(a=>a.facilityId===id);
 $('warehouse-inspector').innerHTML=`<div class="panel-head"><div><div class="eyebrow">WAREHOUSE INVENTORY</div><h2>${esc(facility.name)}</h2></div><span class="subtle-count">${items.length} tagged items</span></div>${items.length?table(['Product','EPC','Status','Location'],items.map(a=>`<tr><td>${esc(productName(a.sku))}</td><td><code>${esc(a.epc)}</code></td><td>${badge(a.inTransit?'In transit':a.assetStatus)}</td><td>${esc(zoneName(a.zoneId))}</td></tr>`)):'<div class="empty">No tagged products have been received at this warehouse yet. Receive a transfer to add stock.</div>'}`;
 $('warehouse-inspector').scrollIntoView({behavior:'smooth',block:'start'});
});

// Feedback remains visible even when a form is below the page's initial viewport.
let feedbackVersion=0,lastFeedback='',feedbackTimer;
document.body.insertAdjacentHTML('beforeend','<div id="feedback-toast" hidden role="status" aria-live="polite" aria-atomic="true"><span class="feedback-icon" aria-hidden="true">✓</span><div><strong id="feedback-title">Saved successfully</strong><p id="feedback-message"></p></div><button type="button" id="feedback-dismiss" aria-label="Dismiss notification">×</button></div>');
$('feedback-dismiss').onclick=()=>{$('feedback-toast').hidden=true;clearTimeout(feedbackTimer);};
notify=function(message,type='success'){
 feedbackVersion++;lastFeedback=message;
 $('notice').hidden=true;
 const toast=$('feedback-toast');toast.className=type==='error'?'feedback-error':'feedback-success';
 toast.setAttribute('role',type==='error'?'alert':'status');
 toast.querySelector('.feedback-icon').textContent=type==='error'?'!':type==='info'?'i':'✓';
 $('feedback-title').textContent=type==='error'?'Could not save changes':type==='info'?'Please note':'Saved successfully';
 $('feedback-message').textContent=message;toast.hidden=false;
 clearTimeout(feedbackTimer);feedbackTimer=setTimeout(()=>{toast.hidden=true;},10000);
};
function inlineFeedback(element,message,error=false){
 if(!element)return;element.className='form-feedback '+(error?'is-error':'is-success');element.setAttribute('role',error?'alert':'status');element.textContent=message;
}
async function saveWithFeedback(event,formId,run,dialogId=null){
 event.preventDefault();const form=event.target,button=form.querySelector('[type="submit"]');
 if(form.dataset.saving==='true')return;
 const original=button.dataset.originalLabel||button.textContent;button.dataset.originalLabel=original;
 form.dataset.saving='true';form.setAttribute('aria-busy','true');button.disabled=true;button.textContent='Saving…';
 const feedback=dialogId?$(dialogId+'-error'):$(formId+'-error'),version=feedbackVersion;
 if(feedback){feedback.textContent='';feedback.className='form-feedback';}
 let saved=false;
 try{
   await run();saved=true;
   if(feedbackVersion===version)notify('Changes saved successfully.');
   inlineFeedback(feedback,lastFeedback);
   if(dialogId)$(dialogId+'-dialog').close();
   await load();
   if(formId==='product-form')$('tag-sku').value=$('create-sku').value.trim();
 }catch(error){inlineFeedback(feedback,error.message,true);notify(error.message,'error');}
 finally{
   form.dataset.saving='false';form.removeAttribute('aria-busy');
   button.disabled=window.portalPreviewMode==='hotel';button.textContent=saved?'✓ Saved':original;
   if(saved)setTimeout(()=>{if(form.dataset.saving!=='true')button.textContent=original;},3000);
 }
}
runForm=(event,formId,run)=>saveWithFeedback(event,formId,run);
submitForm=(event,id,run)=>saveWithFeedback(event,id+'-form',run,id);
$('product-form').onsubmit=e=>runForm(e,'product-form',async()=>{
 const sku=$('create-sku').value.trim(),name=$('create-name').value.trim();
 await send('/v1/admin/workflow/product','POST',{sku,name,unitsPerBox:Number($('create-box').value),boxesPerPallet:Number($('create-pallet').value)});
 notify(`Product “${name}” (${sku}) saved. It is ready for RFID tagging.`);
});

// Hotel-owned locations are managed separately from deliveries and supplier setup.
const areaTypes={warehouse:'Storage',receiving:'Receiving / hotel stock',in_room:'Guest room',soiled:'Soiled collection',in_wash:'Laundry',clean_return:'Clean return',waiting:'Waiting area',clean_stock:'Clean stock'};
document.querySelector('main').insertAdjacentHTML('beforeend',`<section id="page-areas" hidden><div class="hero"><div><div class="eyebrow">YOUR HOTEL / LOCATIONS</div><h1>Give every area a place.</h1><p class="muted">Create your storage rooms, laundry, waiting areas and guest rooms. Then select them when scanning products.</p></div><button class="button primary" data-open-location>+ Add location</button></div><div class="panel"><div class="panel-head"><h2>Your locations</h2><span id="area-count" class="subtle-count"></span></div><div id="areas-list"></div></div></section>`);
$('page-care').querySelector('.hero').insertAdjacentHTML('beforeend','<button class="button" data-go="areas">Manage locations ↗</button>');
$('page-locations').querySelector('.hero').insertAdjacentHTML('beforeend','<button class="button" data-go="areas">Manage locations ↗</button>');
$('new-location-type').insertAdjacentHTML('beforeend','<option value="waiting">Waiting area</option>');
$('new-location-name').maxLength=120;$('new-location-name').placeholder='e.g. Main laundry, Linen store, Waiting area';
$('location-form').querySelector('.panel-body').insertAdjacentHTML('afterbegin','<p class="hint">Add an area inside your own facility. Its type determines how scans are classified; a waiting area does not count as a wash or use.</p>');
function openLocation(){
 $('location-form').reset();$('location-error').textContent='';$('location-error').className='form-feedback';
 if(workflowData.facilities.filter(f=>f.active!==false).length===1)$('new-location-facility').value=workflowData.facilities.find(f=>f.active!==false).facilityId;
 $('location-form').querySelector('[type="submit"]').disabled=window.portalPreviewMode==='hotel';
 $('location-dialog').showModal();
}
$('location-open').onclick=openLocation;
document.addEventListener('click',e=>{if(e.target.closest('[data-open-location]')&&canSet())openLocation();});
$('location-form').onsubmit=e=>submitForm(e,'location',async()=>{
 const created=await send('/v1/admin/workflow/location','POST',{facilityId:$('new-location-facility').value,name:$('new-location-name').value.trim(),zoneType:$('new-location-type').value});
 notify(`Location “${created.name}” created. It is now available in your scan locations.`);
});
const areasRenderWorkflow=renderWorkflow;
renderWorkflow=function(){
 areasRenderWorkflow();
 if(!isAdmin()){
   const nav=document.querySelector('nav');
   if(!nav.querySelector('[data-page="areas"]'))nav.insertAdjacentHTML('beforeend',`<button data-page="areas">${uiIcon('hotels')}<span>Manage locations</span></button>`);
 }
 $('page-areas').querySelector('[data-open-location]').hidden=!canSet();
 const active=workflowData.zones.filter(z=>z.active!==false);$('area-count').textContent=`${active.length} locations`;
 $('areas-list').innerHTML=table(['Location','Type','Facility','Items'],active.map(z=>`<tr><td><strong>${esc(z.name)}</strong></td><td>${esc(areaTypes[z.zoneType]??z.zoneType)}</td><td>${esc(workflowData.facilities.find(f=>f.facilityId===z.facilityId)?.name??z.facilityId)}</td><td>${workflowData.assets.filter(a=>a.zoneId===z.zoneId&&!a.inTransit).length}</td></tr>`));
};
document.querySelector('main').append($('updated'));

// Removing master records archives them; operational history remains recoverable.
$('page-products').querySelector('.hero').insertAdjacentHTML('afterend','<div id="catalog-management" class="panel"><div class="panel-head"><div><h2>Product catalog</h2><span class="hint">Archive removes unused products from active choices. History is kept.</span></div><label class="check archive-toggle"><input id="show-archived-products" type="checkbox">Show archived</label></div><div id="catalog-management-list"></div></div>');
$('page-tagging').querySelector('.hero').insertAdjacentHTML('beforeend','<button class="button" data-go="products">Manage products ↗</button>');
$('warehouse-summary').insertAdjacentHTML('beforebegin','<div id="warehouse-management" class="panel"><div class="panel-head"><div><h2>Warehouse directory</h2><span class="hint">Empty warehouses can be archived and restored.</span></div><label class="check archive-toggle"><input id="show-archived-warehouses" type="checkbox">Show archived</label></div><div id="warehouse-management-list"></div></div>');
$('page-areas').querySelector('.panel-head').insertAdjacentHTML('beforeend','<label class="check archive-toggle"><input id="show-archived-locations" type="checkbox">Show archived</label>');
const resourceAction=(kind,id,name,active)=>`<button class="button ${active?'danger':''}" data-resource-kind="${kind}" data-resource-id="${esc(id)}" data-resource-name="${esc(name)}" data-resource-active="${active?'false':'true'}" ${window.portalPreviewMode==='hotel'?'disabled title="Read-only demo"':''}>${active?'Archive':'Restore'}</button>`;
function renderResourceManagement(){
 if(!workflowData)return;
 $('catalog-management').hidden=!isAdmin();$('warehouse-management').hidden=!isAdmin();
 if(isAdmin()){
  $('catalog-management-list').innerHTML=table(['Product','SKU','Status','Action'],workflowData.products.filter(p=>p.active!==false||$('show-archived-products').checked).map(p=>`<tr><td><button type="button" class="catalog-product-link" data-product-detail="${esc(p.sku)}">${esc(p.name)} ↗</button></td><td>${esc(p.sku)}</td><td>${badge(p.active===false?'Archived':'Active')}</td><td>${resourceAction('product',p.sku,p.name,p.active!==false)}</td></tr>`));
  $('warehouse-management-list').innerHTML=table(['Warehouse','Time zone','Status','Action'],workflowData.facilities.filter(f=>f.facilityType==='warehouse'&&(f.active!==false||$('show-archived-warehouses').checked)).map(f=>`<tr><td><strong>${esc(f.name)}</strong></td><td>${esc(f.timezone)}</td><td>${badge(f.active===false?'Archived':'Active')}</td><td>${resourceAction('warehouse',f.facilityId,f.name,f.active!==false)}</td></tr>`));
 }
 const zones=workflowData.zones.filter(z=>z.active!==false||$('show-archived-locations').checked);
 $('area-count').textContent=`${zones.length} locations`;
 $('areas-list').innerHTML=table(['Location','Type','Items','Status','Action'],zones.map(z=>`<tr><td><strong>${esc(z.name)}</strong><small>${esc(workflowData.facilities.find(f=>f.facilityId===z.facilityId)?.name??z.facilityId)}</small></td><td>${esc(areaTypes[z.zoneType]??z.zoneType)}</td><td>${workflowData.assets.filter(a=>a.zoneId===z.zoneId).length}</td><td>${badge(z.active===false?'Archived':'Active')}</td><td>${canSet()?resourceAction('location',z.zoneId,z.name,z.active!==false):'<span class="hint">Manager access required</span>'}</td></tr>`));
 if(window.portalPreviewMode==='hotel')document.querySelectorAll('[data-request]').forEach(b=>{b.disabled=true;b.title='Read-only demo';});
}
const resourceRenderWorkflow=renderWorkflow;
renderWorkflow=function(){resourceRenderWorkflow();renderResourceManagement();};
for(const id of ['show-archived-products','show-archived-warehouses','show-archived-locations'])$(id).onchange=renderResourceManagement;
document.addEventListener('click',async e=>{
 const button=e.target.closest('[data-resource-kind]');if(!button||button.disabled)return;
 const active=button.dataset.resourceActive==='true',name=button.dataset.resourceName;
 if(!await confirmAction(active?`Restore “${name}” to active choices?`:`Archive “${name}”? It will disappear from active choices. Its history is kept and it can be restored. Records with stock or open operations cannot be archived.`))return;
 button.disabled=true;
 button.textContent=active?'Restoring…':'Archiving…';
 try{
   const result=await send('/v1/admin/workflow/resource-state','POST',{kind:button.dataset.resourceKind,id:button.dataset.resourceId,active});
   $('warehouse-inspector')?.remove();
   notify(`“${result.name}” ${active?'restored':'archived'}. ${active?'It is available again.':'Select Show archived to restore it later.'}`);
   await load();
 }catch(error){notify(error.message,'error');}finally{button.disabled=false;button.textContent=active?'Restore':'Archive';}
});
$('request-form').querySelector('.panel-body').insertAdjacentHTML('afterbegin','<p class="note">You can cancel within 30 minutes of creating a request, while it is still awaiting Globaltex approval. After approval, contact Globaltex for changes.</p>');

/* Compact, local vector guides: illustrative only, never device status. */
const guideDefinitions={
 tagging:['Encoding workflow','Connect a writer and place one tag in its writing area.',[['products','Choose product'],['tagging','Write one tag'],['devices','Verify & receive']]],
 devices:['Reader connection','Illustrated setup · check the diagnostics below for live status.',[['devices','Connect device'],['locations','Select connection'],['products','Test a read']]],
 transfers:['Delivery workflow','Dispatch creates an in-transit record. Receiving confirms arrival.',[['products','Select items'],['transfers','Dispatch'],['locations','Verify arrival']]],
 care:['Your linen cycle','Scan at each location to keep the last confirmed position up to date.',[['hotels','Guest room'],['care','Laundry'],['products','Clean stock']]],
 areas:['Organize your hotel','Create recognizable areas, then assign readers or scans to them.',[['hotels','Create area'],['devices','Assign scans'],['locations','Track items']]]
};
function renderProcessGuides(){
 for(const [page,[title,note,steps]] of Object.entries(guideDefinitions)){
  const section=$('page-'+page);if(!section||section.querySelector('.process-guide'))continue;
  const content=page==='transfers'&&!isAdmin()?['Receiving workflow','Match the delivery, scan arriving tags and confirm what was received.',[['transfers','Select delivery'],['devices','Scan items'],['products','Confirm receipt']]]:[title,note,steps];
  section.querySelector('.hero')?.insertAdjacentHTML('afterend',`<figure class="process-guide"><figcaption><strong>${esc(content[0])}</strong><span>${esc(content[1])}</span></figcaption><ol>${content[2].map(([icon,label],i)=>`<li><span class="process-icon">${uiIcon(icon)}</span><span>${esc(label)}</span>${i<2?'<span class="process-arrow" aria-hidden="true">→</span>':''}</li>`).join('')}</ol></figure>`);
 }
}
const guideRenderWorkflow=renderWorkflow;
renderWorkflow=function(){guideRenderWorkflow();renderProcessGuides();};

/* Bounded list views keep only the current page mounted. Existing action delegation is preserved. */
const managedLists=new Map();
function installManagedLists(){
 const names={'catalog-management-list':'Product Catalog','products-table':'Stock Summary','hotels-table':'Hotels','users-table':'Users','areas-list':'Locations','warehouse-management-list':'Warehouses','requests-table':'Requests','shipments-table':'Deliveries','workflow-transfers':'Transfers','workflow-batches':'Encoding Batches','assets-table':'Tagged Items','policies-table':'Stock Rules'};
 for(const [id,name] of Object.entries(names)){
  const host=$(id);if(!host||managedLists.has(id))continue;
  const state={host,name,rows:[],headers:[],page:1,size:10,query:'',status:'',sort:0,desc:false,workspace:''};
  const controls=document.createElement('div');controls.className='list-controls';
  controls.innerHTML=`<label class="list-search">Search ${esc(name)}<input type="search" placeholder="Search name, SKU or reference…" aria-label="Search ${esc(name)}" maxlength="200"></label><label>Status<select aria-label="Filter ${esc(name)} by status"><option value="">All Statuses</option></select></label><label>Sort By<select aria-label="Sort ${esc(name)}"></select></label><button type="button" class="button list-direction" aria-label="Reverse ${esc(name)} sort order">${id==="catalog-management-list"?"A → Z":"↑ Ascending"}</button>`;
  const footer=document.createElement('div');footer.className='list-footer';footer.innerHTML=`<span role="status" aria-live="polite"></span><label>Per Page<select aria-label="${esc(name)} rows per page"><option>10</option><option>25</option><option>50</option></select></label><div><button type="button" class="button" data-list-prev>← Previous</button><button type="button" class="button" data-list-next>Next →</button></div>`;
  host.before(controls);host.after(footer);host.classList.add('managed-list');
  Object.assign(state,{controls,footer});managedLists.set(id,state);
  controls.querySelector('input').oninput=e=>{state.query=e.target.value.toLocaleLowerCase('en-US').trim();state.page=1;paintManagedList(state);};
  const selects=controls.querySelectorAll('select');selects[0].onchange=e=>{state.status=e.target.value;state.page=1;paintManagedList(state);};selects[1].onchange=e=>{state.sort=Number(e.target.value);state.sortLabel=e.target.selectedOptions[0]?.textContent;state.page=1;paintManagedList(state);};
  controls.querySelector('button').onclick=e=>{state.desc=!state.desc;e.currentTarget.textContent=id==='catalog-management-list'?(state.desc?'Z → A':'A → Z'):(state.desc?'↓ Descending':'↑ Ascending');paintManagedList(state);};
  footer.querySelector('select').onchange=e=>{state.size=Number(e.target.value);state.page=1;paintManagedList(state);};
  footer.querySelector('[data-list-prev]').onclick=()=>{state.page--;paintManagedList(state);};footer.querySelector('[data-list-next]').onclick=()=>{state.page++;paintManagedList(state);};
  state.observer=new MutationObserver(()=>captureManagedList(state));state.observer.observe(host,{childList:true});captureManagedList(state);
 }
}
function captureManagedList(state){
 const table=state.host.querySelector('table');
 if(!table){state.controls.hidden=true;state.footer.hidden=true;state.rows=[];return;}
 state.controls.hidden=false;state.footer.hidden=false;
 const workspace=`${selectedTenant}:${window.portalPreviewMode}`;
 if(state.workspace!==workspace){state.workspace=workspace;state.page=1;state.query='';state.status='';state.controls.querySelector('input').value='';}
 state.table=table;state.headers=[...table.querySelectorAll('thead th')].map(h=>h.textContent.trim());
 state.rows=[...table.querySelectorAll('tbody tr')].map(row=>({row,cells:[...row.cells].map(c=>c.textContent.trim()),text:row.textContent.toLocaleLowerCase('en-US'),status:[...row.querySelectorAll('.badge')].map(b=>b.textContent.trim())}));
 const status=state.controls.querySelectorAll('select')[0],sortSelect=state.controls.querySelectorAll('select')[1];
 const statuses=[...new Set([...state.rows.flatMap(r=>r.status),...(state.status?[state.status]:[])])].sort();
 const statusSignature=JSON.stringify(statuses);
 if(state.statusSignature!==statusSignature){status.innerHTML='<option value="">All Statuses</option>'+statuses.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');state.statusSignature=statusSignature;}
 status.value=state.status;status.closest('label').hidden=!statuses.length;
 const sortable=state.headers.map((h,i)=>({label:h,index:i})).filter(h=>h.label&&!/action|next step/i.test(h.label));
 const signature=JSON.stringify(sortable);
 if(state.sortSignature!==signature){
  const preferred=state.sortLabel??sortSelect.selectedOptions[0]?.textContent;
  sortSelect.innerHTML=sortable.map(h=>`<option value="${h.index}">${esc(h.label)}</option>`).join('');
  state.sort=sortable.find(h=>h.label===preferred)?.index??sortable.find(h=>h.index===state.sort)?.index??sortable[0]?.index??0;
  state.sortSignature=signature;
 }
 sortSelect.value=String(state.sort);state.sortLabel=sortSelect.selectedOptions[0]?.textContent;
 paintManagedList(state);
}
function paintManagedList(state){
 if(!state.table)return;
 const matched=state.rows.filter(r=>(!state.query||r.text.includes(state.query))&&(!state.status||r.status.includes(state.status))&&(!state.predicate||state.predicate(r)));
 matched.sort((a,b)=>{const x=a.cells[state.sort]??'',y=b.cells[state.sort]??'';return x.localeCompare(y,'en',{numeric:true,sensitivity:'base'})*(state.desc?-1:1);});
 const pages=Math.max(1,Math.ceil(matched.length/state.size));state.page=Math.max(1,Math.min(pages,state.page));
 const page=matched.slice((state.page-1)*state.size,state.page*state.size),body=state.table.querySelector('tbody');
 body.replaceChildren(...page.map(r=>r.row));
 if(!page.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=Math.max(1,state.headers.length);cell.className='list-no-results';cell.textContent='No matching records. Clear your search or change the filters.';row.append(cell);body.append(row);}
 for(const r of page){[...r.row.cells].forEach((cell,i)=>{cell.dataset.label=state.headers[i]||'Action';});}
 state.footer.querySelector('[role=status]').textContent=`${matched.length?(state.page-1)*state.size+1:0}–${Math.min(state.page*state.size,matched.length)} of ${matched.length} · Page ${state.page}/${pages}`;
 state.footer.querySelector('[data-list-prev]').disabled=state.page<=1;state.footer.querySelector('[data-list-next]').disabled=state.page>=pages;
}
const listRenderWorkflow=renderWorkflow;
renderWorkflow=function(){listRenderWorkflow();installManagedLists();};

// The managed search replaces the old unpaged search; keep existing location/condition filters.
$('product-search').closest('.toolbar').hidden=true;
$('asset-search').hidden=true;

// Product catalog entries open an operational overview, scoped to this workspace.
document.body.insertAdjacentHTML('beforeend','<dialog id="catalog-product-dialog"><div class="panel-head"><h2>Product Overview</h2><button type="button" class="close" aria-label="Close product overview">×</button></div><div class="panel-body" id="catalog-product-detail"></div></dialog>');
$('catalog-product-dialog').querySelector('.close').onclick=()=>$('catalog-product-dialog').close();
document.addEventListener('click',e=>{
 const entry=e.target.closest('[data-product-detail]');if(!entry)return;
 const p=workflowData.products.find(p=>p.sku===entry.dataset.productDetail);if(!p)return;
 const items=workflowData.assets.filter(a=>a.sku===p.sku),available=items.filter(a=>a.assetStatus==='active'&&!a.inTransit).length;
 const places=new Map();for(const a of items){const key=a.inTransit?'In Transit':workflowData.zones.find(z=>z.zoneId===a.zoneId)?.name??'Unknown Location';places.set(key,(places.get(key)||0)+1);}
 $('catalog-product-detail').innerHTML=`<h3>${esc(p.name)}</h3><p class="hint">SKU: ${esc(p.sku)} · ${p.active===false?'Archived':'Active'}</p><div class="product-detail-metrics"><div><strong>${items.length}</strong><span>Registered</span></div><div><strong>${available}</strong><span>Available</span></div><div><strong>${items.filter(a=>a.inTransit).length}</strong><span>In Transit</span></div></div><p class="hint">${esc(p.unitsPerBox??1)} units per box · ${esc(p.boxesPerPallet??1)} boxes per pallet</p><h4>Current Locations</h4>${places.size?'<ul class="product-place-list">'+[...places].map(([name,count])=>`<li><span>${esc(name)}</span><strong>${count}</strong></li>`).join('')+'</ul>':'<p class="hint">No confirmed inventory yet. Encoding a product alone does not confirm a physical position.</p>'}<div class="product-detail-actions"><button type="button" class="button" data-product-operation="locations" data-sku="${esc(p.sku)}">Find Tagged Items</button>${p.active!==false?`<button type="button" class="button primary" data-product-operation="tagging" data-sku="${esc(p.sku)}">Tag & Receive This Product</button>`:''}<button type="button" class="button" data-product-operation="reports" data-sku="${esc(p.sku)}">Product Reports</button></div><p class="hint">Transfers require selecting physical RFID items and a destination in Warehouses & Transfers.</p>`;
 $('catalog-product-dialog').showModal();
});
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-product-operation]');if(!b)return;
 $('catalog-product-dialog').close();const sku=b.dataset.sku;
 if(b.dataset.productOperation==='locations'){$('asset-search').value=sku;const state=managedLists.get('assets-table');if(state){state.query='';state.controls.querySelector('input').value='';}renderAssets();go('locations');}
 if(b.dataset.productOperation==='tagging'){go('tagging');$('tag-sku').value=sku;$('tag-sku').dispatchEvent(new Event('change'));}
 if(b.dataset.productOperation==='reports'){go('reports');if(!reportsData)await loadReports();$('report-product').value=sku;await loadReports();}
});

$('catalog-management').querySelector('.panel-head').insertAdjacentHTML('beforeend','<button type="button" class="button" id="import-zoho-catalog">Import Saved Zoho Catalog</button>');
$('import-zoho-catalog').onclick=async()=>{
 const b=$('import-zoho-catalog');b.disabled=true;b.textContent='Importing…';
 try{const r=await send('/v1/admin/zoho/catalog/import','POST',{});notify(`${r.imported} product definitions imported (${r.archivedImported} archived). Existing products preserved. Source snapshot: ${r.sourceGeneratedAt?.slice(0,10)??'unknown'}. RFID stock unchanged.`);await load();}catch(e){notify(e.message,'error');}finally{b.disabled=false;b.textContent='Import Saved Zoho Catalog';}
};

// One company product directory: definition, available stock and favorites together.
function favoriteKey(){return `globaltex-favorites:${selectedTenant}:${me.actorId??me.username??me.role}`;}
function productFavorites(){try{return new Set(JSON.parse(localStorage.getItem(favoriteKey())??'[]'));}catch{return new Set();}}
const unifiedResourceRender=renderResourceManagement;
renderResourceManagement=function(){
 unifiedResourceRender();
 $('products-table').closest('.panel').hidden=isAdmin();
 if(!isAdmin())return;
 const favorites=productFavorites(),counts=new Map();for(const a of workflowData.assets){const c=counts.get(a.sku)??{total:0,available:0};c.total++;if(a.assetStatus==='active'&&!a.inTransit)c.available++;counts.set(a.sku,c);}
 $('catalog-management-list').innerHTML=table(['Product','SKU','Available / Total','Status','Actions'],workflowData.products.filter(p=>p.active!==false||$('show-archived-products').checked).sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'base',numeric:true})).map(p=>{const c=counts.get(p.sku)??{total:0,available:0};return `<tr data-stock="${c.available}" data-favorite="${favorites.has(p.sku)}"><td><button type="button" class="catalog-product-link" data-product-detail="${esc(p.sku)}">${esc(p.name)} ↗</button></td><td>${esc(p.sku)}</td><td>${c.available} / ${c.total}</td><td>${badge(p.active===false?'Archived':'Active')}</td><td><div class="row-actions"><button type="button" class="button product-favorite" data-favorite-sku="${esc(p.sku)}" aria-label="${favorites.has(p.sku)?'Remove favorite':'Add favorite'} ${esc(p.name)}" aria-pressed="${favorites.has(p.sku)}">${favorites.has(p.sku)?'★':'☆'}</button>${resourceAction('product',p.sku,p.name,p.active!==false)}</div></td></tr>`;}));
 const state=managedLists.get('catalog-management-list');if(state&&!$('catalog-quick-filter')){
  state.controls.insertAdjacentHTML('beforeend','<label>Show<select id="catalog-quick-filter"><option value="all">All Products</option><option value="favorites">Favorites</option><option value="stock">In Stock</option><option value="empty">No Available Stock</option></select></label>');
  state.predicate=r=>{const mode=$('catalog-quick-filter').value;return mode==='all'||mode==='favorites'&&r.row.dataset.favorite==='true'||mode==='stock'&&Number(r.row.dataset.stock)>0||mode==='empty'&&Number(r.row.dataset.stock)===0;};
  $('catalog-quick-filter').onchange=()=>{state.page=1;paintManagedList(state);};
 }
};
document.addEventListener('click',e=>{const b=e.target.closest('[data-favorite-sku]');if(!b)return;const favorites=productFavorites();favorites.has(b.dataset.favoriteSku)?favorites.delete(b.dataset.favoriteSku):favorites.add(b.dataset.favoriteSku);localStorage.setItem(favoriteKey(),JSON.stringify([...favorites]));renderResourceManagement();});
function nextProductLetter(options,currentIndex,letter){
 const key=letter.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('en-US');
 const matches=options.map((o,i)=>({o,i})).filter(({o})=>o.value&&o.text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('en-US').startsWith(key)).map(({i})=>i);
 return matches.find(i=>i>currentIndex)??matches[0]??currentIndex;
}
for(const id of ['tag-sku','existing-sku']){
 const select=$(id);
 const alphabetize=()=>{const value=select.value;const ps=workflowData.products.filter(p=>p.active!==false).sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'base',numeric:true}));select.innerHTML='<option value="">Select Product</option>'+ps.map(p=>`<option value="${esc(p.sku)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('');if(ps.some(p=>p.sku===value))select.value=value;};
 select.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey||!/^\p{L}$/u.test(e.key))return;e.preventDefault();const next=nextProductLetter([...select.options].map(o=>({value:o.value,text:o.text})),select.selectedIndex,e.key);if(next!==select.selectedIndex){select.selectedIndex=next;select.dispatchEvent(new Event('change',{bubbles:true}));}});
 const original=renderWorkflow;renderWorkflow=function(){original();alphabetize();};
}
const unifiedListWorkflow=renderWorkflow;
renderWorkflow=function(){unifiedListWorkflow();if(isAdmin())renderResourceManagement();};
$('show-archived-products').onchange=()=>renderResourceManagement();

// Controlled product list avoids the OS select popup's buffered prefix search.
for(const id of ['tag-sku','existing-sku']){
 const select=$(id),root=document.createElement('div');root.className='product-picker';
 root.innerHTML=`<button type="button" class="product-picker-trigger" role="combobox" aria-label="Product" aria-haspopup="listbox" aria-controls="${id}-listbox" aria-expanded="false"></button><div class="product-picker-menu" id="${id}-listbox" role="listbox" aria-label="Products" hidden></div>`;
 select.after(root);select.hidden=true;select.tabIndex=-1;
 const trigger=root.querySelector('button'),menu=root.querySelector('[role=listbox]');let open=false;
 function sync(){
  trigger.textContent=(select.selectedOptions[0]?.text??'Select Product')+' ▾';
  menu.innerHTML=[...select.options].map((o,i)=>`<div role="option" id="${id}-option-${i}" data-picker-index="${i}" aria-selected="${i===select.selectedIndex}">${esc(o.text)}</div>`).join('');
  if(open){trigger.setAttribute('aria-activedescendant',`${id}-option-${select.selectedIndex}`);menu.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});}
 }
 function show(value){open=value;menu.hidden=!open;trigger.setAttribute('aria-expanded',String(open));if(!open)trigger.removeAttribute('aria-activedescendant');else sync();}
 function choose(index){if(index<0||index>=select.options.length)return;select.selectedIndex=index;select.dispatchEvent(new Event('change',{bubbles:true}));sync();}
 trigger.onclick=()=>show(!open);
 trigger.addEventListener('keydown',e=>{
  if(e.ctrlKey||e.altKey||e.metaKey)return;
  if(/^\p{L}$/u.test(e.key)){e.preventDefault();choose(nextProductLetter([...select.options].map(o=>({value:o.value,text:o.text})),select.selectedIndex,e.key));return;}
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();if(!open)show(true);choose(e.key==='Home'?0:e.key==='End'?select.options.length-1:Math.max(0,Math.min(select.options.length-1,select.selectedIndex+(e.key==='ArrowDown'?1:-1))));}
  if(e.key==='Enter'||e.key===' '){e.preventDefault();show(!open);}
  if(e.key==='Escape'){e.preventDefault();show(false);}
  if(e.key==='Tab')show(false);
 });
 menu.addEventListener('mousedown',e=>e.preventDefault());
 menu.onclick=e=>{const option=e.target.closest('[data-picker-index]');if(!option)return;choose(Number(option.dataset.pickerIndex));show(false);trigger.focus();};
 document.addEventListener('click',e=>{if(!root.contains(e.target))show(false);});
 select.addEventListener('change',sync);new MutationObserver(sync).observe(select,{childList:true});
 sync();
}

// Batch encoding is a deliberate one-tag-at-a-time station workflow, not blanket RF writing.
$('tag-form').insertAdjacentHTML('afterbegin',`<div class="encoding-mode-panel"><label>Encoding Mode<select id="encoding-mode"><option value="single">Single Tag</option><option value="batch">Batch · One Tag At A Time</option></select></label><div id="encoding-batch-controls" hidden><p class="hint">Choose product and receiving location below, set a target, then create a batch. Place only one blank tag on the writer for each write.</p><label>Planned Tags<input id="encoding-target" type="number" min="1" max="500" value="10"></label><button type="button" class="button" id="encoding-create">Create Batch</button><label>Resume A Batch<select id="encoding-resume"><option value="">Select Batch</option></select></label><button type="button" class="button" id="encoding-use-batch">Resume Selected Batch</button><div id="encoding-progress" role="status" aria-live="polite"></div><button type="button" class="button" id="encoding-leave" hidden>Leave Batch View</button></div><p class="hint">Requires a connected writer. Verification must succeed before stock is added. Batch progress counts encoding results; physical stock is confirmed separately.</p></div>`);
let activeEncodingBatch=null,encodingBusy=false;
async function refreshEncodingBatches(){
 if(!isAdmin())return;
 const data=await api('/v1/admin/encoding/batches');const current=$('encoding-resume').value;
 $('encoding-resume').innerHTML='<option value="">Select Batch</option>'+data.batches.filter(b=>b.queued||b.leased||b.failed).map(b=>`<option value="${esc(b.batchId)}">${esc(b.sku)} · ${b.verified}/${b.requestedQuantity} verified · ${b.failed} failed · ${b.queued} queued</option>`).join('');$('encoding-resume').value=current;
 if(activeEncodingBatch){const b=await api('/v1/admin/encoding/batches/'+encodeURIComponent(activeEncodingBatch.batchId));activeEncodingBatch=b;$('encoding-progress').innerHTML=`<strong>${esc(b.sku)} · ${b.verified} / ${b.requestedQuantity} Verified</strong><progress max="${b.requestedQuantity}" value="${b.verified}" aria-label="Verified tags"></progress><span>${b.queued} Queued · ${b.leased} In Progress · ${b.failed} Failed</span><p class="hint">${b.queued?'Remove the previous tag. Place one new blank tag and confirm before writing the next.':'No queued tags remain. Failed tags require inspection; do not automatically rewrite a tag after an uncertain result.'}</p>`;}
 $('encoding-leave').hidden=!activeEncodingBatch;
 $('tag-form').querySelector('[type=submit]').textContent=activeEncodingBatch?'Write & Verify Next Tag':'Write & Verify One Tag';
}
$('encoding-mode').onchange=()=>{$('encoding-batch-controls').hidden=$('encoding-mode').value!=='batch';if($('encoding-mode').value==='single'){activeEncodingBatch=null;$('encoding-progress').innerHTML='';}refreshEncodingBatches().catch(e=>notify(e.message,'error'));};
$('encoding-create').onclick=async()=>{
 if(encodingBusy)return;
 if(!$('tag-sku').value||!$('tag-facility').value||!$('tag-zone').value){notify('Select a product, facility and receiving location first.','error');return;}
 if(!$('encoding-target').reportValidity())return;
 const b=$('encoding-create');b.disabled=true;
 try{activeEncodingBatch=await send('/v1/admin/encoding/batches','POST',{sku:$('tag-sku').value,requestedQuantity:Number($('encoding-target').value)});await refreshEncodingBatches();notify('Batch created. Place one blank tag, confirm, then write the next tag.');}catch(e){notify(e.message,'error');}finally{b.disabled=false;}
};
$('encoding-use-batch').onclick=async()=>{if(encodingBusy||!$('encoding-resume').value)return;try{activeEncodingBatch=await api('/v1/admin/encoding/batches/'+encodeURIComponent($('encoding-resume').value));$('tag-sku').value=activeEncodingBatch.sku;$('tag-sku').dispatchEvent(new Event('change',{bubbles:true}));await refreshEncodingBatches();notify('Batch loaded. Check the physical receiving location before writing.','info');}catch(e){notify(e.message,'error');}};
$('encoding-leave').onclick=()=>{if(encodingBusy)return;activeEncodingBatch=null;$('encoding-progress').innerHTML='';refreshEncodingBatches().catch(e=>notify(e.message,'error'));};
$('tag-form').onsubmit=e=>{
 if(encodingBusy){e.preventDefault();return;}
 return runForm(e,'tag-form',async()=>{
  if($('encoding-mode').value==='batch'&&!activeEncodingBatch)throw new Error('Create or resume a batch first.');
  if(activeEncodingBatch&&$('tag-sku').value!==activeEncodingBatch.sku)throw new Error('Selected product differs from the batch. Restore the batch product or leave this batch.');
  encodingBusy=true;
  try{const result=await send('/v1/admin/workflow/tag','POST',{sku:$('tag-sku').value,facilityId:$('tag-facility').value,zoneId:$('tag-zone').value,confirmed:$('tag-confirm').checked,...(activeEncodingBatch?{batchId:activeEncodingBatch.batchId}:{})});$('tag-result').hidden=false;$('tag-result').textContent=`Verified & received: ${result.epc}. Remove this tag before placing another.`;notify('One tag verified and added to stock.');}
  finally{encodingBusy=false;$('tag-confirm').checked=false;if(activeEncodingBatch)await refreshEncodingBatches();}
 });
};
$('tag-form').querySelector('[type=submit]').textContent='Write & Verify One Tag';

// Hotel details owns its contact directory and access accounts.
let detailHotelId=null,contactPage=1,accountPage=1,editingContactId=null;
document.body.insertAdjacentHTML('beforeend',`<dialog id="hotel-details-dialog" class="hotel-details-dialog"><div class="panel-head"><h2 id="hotel-details-title">Hotel Details</h2><button type="button" class="close" data-close="hotel-details-dialog" aria-label="Close hotel details">×</button></div><div class="panel-body"><p id="hotel-details-summary" class="hint"></p><div class="row-actions"><button type="button" class="button" id="detail-edit-hotel">Edit Hotel</button><button type="button" class="button primary" id="detail-add-contact">Add Contact</button><button type="button" class="button" id="detail-add-account">Add Login Account</button></div><h3>Contacts</h3><p class="hint">People to contact at this hotel. A contact record does not grant login access.</p><label>Find Contacts<input type="search" id="detail-contact-search" placeholder="Search by name, role, email or phone"></label><label class="check"><input type="checkbox" id="detail-removed">Show Removed Contacts</label><div id="detail-contacts"></div><div class="row-actions"><button type="button" class="button" id="contact-prev">← Previous</button><span id="contact-count"></span><button type="button" class="button" id="contact-next">Next →</button></div><h3>Login Accounts</h3><p class="hint">Accounts assigned to this hotel. Disable access to remove sign-in permission while preserving history.</p><label>Find Accounts<input type="search" id="detail-account-search" placeholder="Search by name or username"></label><div id="detail-accounts"></div><div class="row-actions"><button type="button" class="button" id="account-prev">← Previous</button><span id="account-count"></span><button type="button" class="button" id="account-next">Next →</button></div></div></dialog><dialog id="hotel-contact-dialog"><form id="hotel-contact-form"><div class="panel-head"><h2 id="contact-form-title">Add Contact</h2><button type="button" class="close" data-close="hotel-contact-dialog" aria-label="Close contact form">×</button></div><div class="panel-body"><label>Name<input id="contact-person-name" required minlength="2" maxlength="200"></label><label>Role / Department<input id="contact-person-role" maxlength="200"></label><label>Email<input id="contact-person-email" type="email" maxlength="200"></label><label>Phone<input id="contact-person-phone" maxlength="200"></label><label>Notes<textarea id="contact-person-notes" maxlength="1000"></textarea></label><p id="contact-save-error" role="alert" class="danger"></p><button type="submit" class="button primary">Save Contact</button></div></form></dialog>`);
$('users-table').closest('.panel').hidden=true;
function renderHotelDetailLists(){
 const h=hotels.find(h=>h.tenantId===detailHotelId);if(!h)return;
 $('hotel-details-title').textContent=h.name;$('hotel-details-summary').textContent=[h.address,h.city,h.state,h.country,h.email,h.phone].filter(Boolean).join(' · ')||'No address or primary contact details have been added.';
 const cq=$('detail-contact-search').value.trim().toLowerCase(),uq=$('detail-account-search').value.trim().toLowerCase();
 const contacts=(h.contacts??[]).filter(c=>($('detail-removed').checked||c.active!==false)&&(!cq||[c.name,c.role,c.email,c.phone].join(' ').toLowerCase().includes(cq))).sort((a,b)=>a.name.localeCompare(b.name));
 const accounts=users.filter(u=>u.role!=='chain_admin'&&u.tenantIds.includes(detailHotelId)&&(!uq||[u.displayName,u.username].join(' ').toLowerCase().includes(uq))).sort((a,b)=>a.displayName.localeCompare(b.displayName));
 function page(rows,key,current){const pages=Math.max(1,Math.ceil(rows.length/10)),n=Math.max(1,Math.min(current,pages));$(key+'-count').textContent=`${rows.length} records · Page ${n}/${pages}`;$(key+'-prev').disabled=n===1;$(key+'-next').disabled=n===pages;return{n,rows:rows.slice((n-1)*10,n*10)};}
 const c=page(contacts,'contact',contactPage);contactPage=c.n;const u=page(accounts,'account',accountPage);accountPage=u.n;
 $('detail-contacts').innerHTML=c.rows.length?c.rows.map(c=>`<div class="hotel-person"><div><strong>${esc(c.name)}</strong><span>${esc([c.role,c.email,c.phone].filter(Boolean).join(' · '))}</span>${c.active===false?badge('Removed'):''}</div><div class="row-actions"><button type="button" class="button" data-contact-edit="${esc(c.contactId)}">Edit</button><button type="button" class="button" data-contact-state="${esc(c.contactId)}" data-active="${c.active===false}">${c.active===false?'Restore':'Remove'}</button></div></div>`).join(''):empty('No matching contacts.');
 $('detail-accounts').innerHTML=u.rows.length?u.rows.map(u=>`<div class="hotel-person"><div><strong>${esc(u.displayName)}</strong><span>${esc(u.username)} · ${esc(u.role.replaceAll('_',' '))}</span>${badge(u.active?'Active':'Disabled')}</div><div class="row-actions"><button type="button" class="button" data-user-edit="${esc(u.userId)}">Edit</button><button type="button" class="button" data-user-toggle="${esc(u.userId)}">${u.active?'Disable Access':'Enable Access'}</button></div></div>`).join(''):empty('No matching login accounts.');
}
renderHotels=function(){const rows=hotels.filter(h=>h.tenantId!==me.tenantIds[0]);$('hotels-table').innerHTML=table(['Hotel','City / Primary Contact','Contacts / Accounts','Action'],rows.map(h=>`<tr><td><button type="button" class="catalog-product-link" data-hotel-details="${esc(h.tenantId)}">${esc(h.name)} ↗</button></td><td>${esc([h.city,h.contact].filter(Boolean).join(' · ')||'Not provided')}</td><td>${(h.contacts??[]).filter(c=>c.active!==false).length} contacts · ${users.filter(u=>u.role!=='chain_admin'&&u.tenantIds.includes(h.tenantId)).length} accounts</td><td><button type="button" class="button" data-hotel-details="${esc(h.tenantId)}">Hotel Details</button></td></tr>`));};
renderUsers=function(){$('users-table').closest('.panel').hidden=true;if($('hotel-details-dialog').open)renderHotelDetailLists();};
for(const id of ['detail-contact-search','detail-account-search','detail-removed'])$(id).addEventListener(id==='detail-removed'?'change':'input',()=>{contactPage=1;accountPage=1;renderHotelDetailLists();});
for(const key of ['contact','account'])for(const dir of ['prev','next'])$(key+'-'+dir).onclick=()=>{if(key==='contact')contactPage+=dir==='prev'?-1:1;else accountPage+=dir==='prev'?-1:1;renderHotelDetailLists();};
function openHotelContact(id=null){editingContactId=id;const c=hotels.find(h=>h.tenantId===detailHotelId)?.contacts?.find(c=>c.contactId===id)??{};$('hotel-contact-form').reset();for(const key of ['name','role','email','phone','notes'])$('contact-person-'+key).value=c[key]??'';$('contact-save-error').textContent='';$('contact-form-title').textContent=id?'Edit Contact':'Add Contact';$('hotel-contact-dialog').showModal();}
$('detail-edit-hotel').onclick=()=>openHotel(detailHotelId);$('detail-add-contact').onclick=()=>openHotelContact();$('detail-add-account').onclick=()=>openUser(null,detailHotelId);
$('hotel-contact-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('[type=submit]');b.disabled=true;try{const value={};for(const key of ['name','role','email','phone','notes'])value[key]=$('contact-person-'+key).value;await send('/v1/admin/hotels/'+encodeURIComponent(detailHotelId)+'/contacts'+(editingContactId?'/'+encodeURIComponent(editingContactId):''),editingContactId?'PUT':'POST',value);$('hotel-contact-dialog').close();await load();renderHotelDetailLists();notify('Contact saved.');}catch(error){$('contact-save-error').textContent=error.message;}finally{b.disabled=false;}};
document.addEventListener('click',async e=>{
 const detail=e.target.closest('[data-hotel-details]');if(detail){detailHotelId=detail.dataset.hotelDetails;contactPage=1;accountPage=1;$('detail-contact-search').value='';$('detail-account-search').value='';$('detail-removed').checked=false;renderHotelDetailLists();$('hotel-details-dialog').showModal();}
 const edit=e.target.closest('[data-contact-edit]');if(edit)openHotelContact(edit.dataset.contactEdit);
 const state=e.target.closest('[data-contact-state]');if(state){if(!await confirmAction(state.dataset.active==='true'?'Restore this contact?':'Remove this contact? You can restore it using Show Removed Contacts.'))return;state.disabled=true;try{await send('/v1/admin/hotels/'+encodeURIComponent(detailHotelId)+'/contacts/'+encodeURIComponent(state.dataset.contactState),'PUT',{active:state.dataset.active==='true'});await load();renderHotelDetailLists();notify('Contact updated.');}catch(error){notify(error.message,'error');}finally{state.disabled=false;}}
});
Object.assign(areaTypes,{storage:'Storage',drying:'Drying',distribution:'Distribution',in_use:'In Use',in_wash:'Washing',in_room:'In Use (Legacy)',clean_return:'Clean Storage'});
$('new-location-type').innerHTML=['storage','in_wash','drying','distribution','in_use','soiled','waiting'].map(t=>`<option value="${t}">${areaTypes[t]}</option>`).join('');
$('page-areas').querySelector('.hero .muted').textContent='Manage storage, washing, drying, distribution and general-use areas. Tracking does not require guest-room locations.';
guideDefinitions.care=['Hotel Linen Flow','Track linen through operational areas without guest-room tracking.',[['products','Storage'],['care','Wash & Dry'],['locations','Distribute & Use']]];
const areaWorkflow=renderWorkflow;
renderWorkflow=function(){areaWorkflow();if(!isAdmin()){
 $('page-care').querySelector('.hero .muted').textContent='Scan products through storage, washing, drying, distribution and general use.';
 const legend=document.querySelector('.hotel-stage-panel .stage-legend');if(legend){const stages=[['clean','Storage'],['in_wash','Washing'],['drying','Drying'],['distribution','Distribution'],['in_room','In Use']];legend.innerHTML=stages.map(([stage,name])=>`<div><small>${name}</small><strong>${workflowData.assets.filter(a=>a.stage===stage).length}</strong></div>`).join('');document.querySelector('.hotel-stage-panel h2').textContent='Storage, Laundry & General Use';}
 }for(const input of document.querySelectorAll('.list-search input')){const name=input.getAttribute('aria-label')??'';if(name.includes('Hotels'))input.placeholder='Search by hotel name, city or contact';if(name.includes('Users'))input.placeholder='Search by name or username';}};
