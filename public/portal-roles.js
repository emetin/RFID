// Keep company sales operations and hotel-owned inventory visibly separate.
const roleRenderWorkflow = renderWorkflow;
const companySteps = flowSteps.filter(s => s[0] !== 'care').map((s,i)=>[s[0],String(i+1).padStart(2,'0'),s[0]==='stock'?'Hotel orders':s[2],s[0]==='stock'?'Review customer requests and fulfill deliveries.':s[3]]);
const hotelSteps = [
 ['transfers','01','Receive deliveries','Scan and accept products sent to your hotel.'],
 ['care','02','Locations & laundry','Track operational areas, use cycles, washes and item condition.'],
 ['stock','03','Request stock','Place a stock request or configure automatic requests.']
];
renderWorkflow=function(){
 roleRenderWorkflow();
 const steps=isAdmin()?companySteps:hotelSteps;
 document.querySelector('nav').innerHTML=`<button data-page="home" class="active">${isAdmin()?'Company overview':'My hotel overview'}</button>${steps.map(([page,n,title])=>`<button data-page="${page}">${n}. ${title}</button>`).join('')}<span class="nav-caption">INVENTORY</span><button data-page="products">${isAdmin()?'Warehouse inventory':'My products'}</button><button data-page="locations">Find an item</button>${isAdmin()?'<button data-page="devices">Reader connection</button>':''}`;
 $('workflow-steps').innerHTML=steps.map(([page,n,title,copy])=>`<button class="step-card" data-go="${page}"><b>${n}</b><strong>${title}</strong><span>${copy}</span></button>`).join('');
 $('page-care').hidden=isAdmin()||activePage!=='care';
 $('page-tagging').hidden=!isAdmin()||activePage!=='tagging';
 $('welcome-title').textContent=isAdmin()?'From our warehouses to your customers.':'Your hotel. Your inventory.';
 $('welcome-copy').textContent=isAdmin()?'Manage hotels, encode products, dispatch deliveries and fulfill hotel orders. Hotel usage, laundry and internal stock data stay private.':'Receive your products, track locations and laundry, and request stock from Globaltex.';
 document.querySelector('#page-home .flow-note').textContent=isAdmin()?'Globaltex manages its own stock and deliveries. After receipt, hotel inventory and internal movements belong to the hotel. Only customer requests and delivery confirmations return to Globaltex.':'Your inventory and internal movements are visible to your hotel account. Globaltex receives your stock requests and delivery confirmations.';
 $('stock-title').textContent=isAdmin()?'Hotel orders and delivery progress.':'Request the stock your hotel needs.';
 $('stock-copy').textContent=isAdmin()?'Approve customer requests and prepare deliveries. Hotel stock balances and usage and laundry data are private.':'Request products manually, track deliveries or configure minimum-stock rules.';
 $('stock-rules-panel').hidden=isAdmin();$('policy-open').hidden=isAdmin()||!canSet();
 $('manual-request-open').hidden=isAdmin()||!canAct();
 $('lifespan-form').hidden=isAdmin();
 $('receive-form').closest('.panel').hidden=isAdmin()&&!workflowData.shipments.some(s=>s.customerTenantId===selectedTenant&&s.status!=='received');
 $('warehouse-summary').hidden=!isAdmin();
 if(isAdmin())document.querySelectorAll('[data-receive-workflow]').forEach(b=>{if(b.dataset.destinationTenant!==selectedTenant)b.replaceWith(document.createTextNode('Awaiting hotel receipt'));});
 const transferTitle=$('page-transfers').querySelector('h1');transferTitle.textContent=isAdmin()?'Warehouses, dispatch and delivery status.':'Receive your hotel deliveries.';
 $('page-transfers').querySelector('.hero p').textContent=isAdmin()?'Move your stock between Houston and Miami, then send orders to customers. Hotel users confirm their own receipt.':'Select an incoming shipment, scan the received products and confirm delivery to your hotel stock.';
 $('metric-retired').closest('.card').hidden=isAdmin();
 $('metric-low').closest('.card').hidden=isAdmin();
 if(isAdmin())$('attention').innerHTML=`<div class="list-item"><div><strong>Customer requests</strong><p>Review and fulfill requests submitted by hotels.</p></div><button class="button" data-go="stock">Hotel orders</button></div><div class="list-item"><div><strong>Hotel accounts</strong><p>Maintain customer details and assigned users.</p></div><button class="button" data-go="hotels">Hotels & users</button></div>`;
 if(!isAdmin())for(const prefix of ['care','receive']){
   updateOptions(prefix+'-mode','<option value="gateway">My hotel RFID reader gateway · last 60 seconds</option><option value="manual">Scanner input / confirmed physical count</option>');
   $(prefix+'-manual').hidden=$(prefix+'-mode').value!=='manual';
 }
 document.querySelector('.aside-foot').firstChild.textContent=isAdmin()?'Products → Warehouses → Customers':'Receive → Track → Request stock';
 if(!isAdmin())$('workflow-batches').innerHTML='';
 updateOptions('manual-request-product',optionList(products.filter(p=>p.active!==false),p=>p.sku,p=>`${p.name} · ${p.sku}`,'Select product'));
};

const roleRenderHotels=renderHotels;
renderHotels=function(){roleRenderHotels();document.querySelectorAll('#hotels-table [data-switch]').forEach(b=>b.remove());};
const roleRenderRequests=renderRequests;
renderRequests=function(){roleRenderRequests();if(isAdmin())$('requests-title').textContent='Customer stock requests';};
$('requests-title').closest('.panel-head').insertAdjacentHTML('beforeend','<button id="manual-request-open" class="button primary" hidden>+ Request stock</button>');
document.body.insertAdjacentHTML('beforeend',`<dialog id="request-dialog"><form id="request-form"><div class="panel-head"><h2>Request stock from Globaltex</h2><button class="close" type="button" data-close="request-dialog" aria-label="Close">×</button></div><div class="panel-body"><label>Product<select id="manual-request-product" required></select></label><label>Quantity<input id="manual-request-quantity" type="number" min="1" max="1000000" step="1" required></label><p class="hint">Globaltex receives the product and requested quantity. Your internal usage, laundry and stock records are not shared.</p><p id="request-error" class="danger" role="alert"></p><button class="button primary" type="submit">Send stock request</button></div></form></dialog>`);
$('manual-request-open').onclick=()=>{$('request-error').textContent='';$('request-dialog').showModal();};
$('request-form').onsubmit=e=>submitForm(e,'request',async()=>{await send('/v1/admin/stock/requests','POST',{sku:$('manual-request-product').value,quantity:Number($('manual-request-quantity').value)});notify('Stock request sent to Globaltex. You can follow its status here.');});
