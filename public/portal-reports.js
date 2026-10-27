// Reports are fetched under the same authenticated workspace and privacy boundary.
let reportsData=null,reportsWorkspace='',reportsDataset='products',reportsPage=1,reportsSort='',reportsSortDesc=false,reportsVersion=0;
const reportsDay=86400000;
document.querySelector('main').insertAdjacentHTML('beforeend',`<section id="page-reports" hidden>
 <div class="hero"><div><div class="eyebrow">OPERATIONS / REPORTS</div><h1>Know the numbers.<br><em>See the whole picture.</em></h1><p class="muted" id="reports-intro">Inventory, activity and delivery performance for your workspace.</p></div><button class="button primary" id="report-export" type="button" disabled>↓ Export CSV</button></div>
 <div class="panel report-filter-panel"><form id="report-filters" class="panel-body report-filters"><label>From (UTC)<input type="date" id="report-from" required></label><label>To (UTC)<input type="date" id="report-to" required></label><label>Product<select id="report-product"><option value="">All products</option></select></label><label>Facility<select id="report-facility"><option value="">All facilities</option></select></label><label id="report-customer-field" hidden>Customer<select id="report-customer"><option value="">All customers</option></select></label><button class="button primary" id="report-apply" type="button">Apply filters</button></form><div class="report-filter-note">Dates use UTC. Date filters apply to activity, orders and transfers; stock and lifetime counters are current snapshots.</div></div>
 <p id="report-status" class="hint" role="status" aria-live="polite"></p><p id="report-error" class="form-feedback is-error" role="alert" hidden></p>
 <div id="report-metrics" class="report-metrics"></div>
 <div class="report-visuals"><div class="panel"><div class="panel-head"><div><div class="eyebrow">SELECTED PERIOD</div><h2>Daily activity</h2></div><span id="report-chart-legend" class="hint"></span></div><div id="report-trend" class="report-chart"></div></div><div class="panel"><div class="panel-head"><div><div class="eyebrow">CURRENT SNAPSHOT</div><h2>Inventory condition</h2></div></div><div id="report-condition" class="report-condition"></div></div></div>
 <div class="panel"><div class="panel-head report-data-head"><div><h2 id="report-dataset-title">Item inventory</h2><span id="report-scope" class="hint"></span></div><label>Report<select id="report-dataset" aria-label="Report dataset"></select></label></div><div class="toolbar"><input id="report-search" type="search" placeholder="Search this report…" aria-label="Search report"><label class="report-page-size">Rows per page<select id="report-size"><option>25</option><option>50</option><option>100</option></select></label></div><div id="report-table"></div><div class="report-pagination"><span id="report-row-count"></span><div><button class="button" id="report-prev" type="button">← Previous</button><button class="button" id="report-next" type="button">Next →</button></div></div></div>
 <details class="report-definitions"><summary>How to read these reports</summary><div id="report-definitions"></div></details>
</section>`);
document.querySelector('main').append($('updated'));
document.querySelector('.report-data-head').closest('.panel').outerHTML='<details class="report-detail-panel"><summary>Explore detailed records & CSV exports</summary><p class="hint">Optional source records behind the charts. Item inventory is a current item list for reconciliation.</p>'+document.querySelector('.report-data-head').closest('.panel').outerHTML+'</details>';
document.querySelector('.report-visuals').insertAdjacentHTML('beforebegin','<div id="report-business-charts" class="report-business-charts"></div>');
const reportsRenderWorkflow=renderWorkflow;
renderWorkflow=function(){
 reportsRenderWorkflow();
 document.querySelector('nav').insertAdjacentHTML('beforeend',`<button data-page="reports">${uiIcon('products')}<span>Reports</span></button>`);
 const workspace=`${me.role}:${selectedTenant}:${window.portalPreviewMode}`;
 if(reportsWorkspace!==workspace){reportsWorkspace=workspace;reportsData=null;reportsDataset='products';reportsVersion++;$('report-table').innerHTML='';$('report-metrics').innerHTML='';$('report-error').hidden=true;$('report-export').disabled=true;}
 $('report-customer-field').hidden=!isAdmin();
 $('reports-intro').textContent=isAdmin()?'Your warehouse stock, transfers and customer orders. Customer internal inventory is excluded.':'Your private inventory, usage and laundry activity, service life and stock coverage.';
 document.querySelector('.report-filter-note').textContent=isAdmin()?'UTC dates filter activity, orders and transfers. Facility filters apply to stock and location events; customer filters apply to orders and transfers. Inventory is a current snapshot.':'UTC dates filter activity, requests and deliveries. Facility filters apply to stock and location events; stock rules remain hotel-wide. Inventory and lifetime counters are current snapshots.';
};
const reportsGo=go;
go=function(page,resetScroll=true){reportsGo(page,resetScroll);if(activePage==='reports'&&!reportsData)loadReports();};
const today=new Date().toISOString().slice(0,10);$('report-to').value=today;$('report-from').value=new Date(Date.parse(today)-29*reportsDay).toISOString().slice(0,10);
function reportParams(){return{from:$('report-from').value,to:$('report-to').value,sku:$('report-product').value,facilityId:$('report-facility').value,hotelId:isAdmin()?$('report-customer').value:''};}
async function loadReports(){
 const version=++reportsVersion;$('report-apply').disabled=true;$('report-export').disabled=true;$('report-apply').textContent='Loading…';$('report-error').hidden=true;$('report-status').textContent='Generating your report…';
 try{
  const data=await api('/v1/admin/reports?'+new URLSearchParams(reportParams()));if(version!==reportsVersion)return;
  reportsData=data;reportsPage=1;reportsSort='';
  updateOptions('report-product','<option value="">All products</option>'+data.options.products.map(p=>`<option value="${esc(p.sku)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join(''));
  updateOptions('report-facility','<option value="">All facilities</option>'+data.options.facilities.map(f=>`<option value="${esc(f.facilityId)}">${esc(f.name)}</option>`).join(''));
  updateOptions('report-customer','<option value="">All customers</option>'+data.options.customers.map(h=>`<option value="${esc(h.tenantId)}">${esc(h.name)}</option>`).join(''));
  if(!data.datasets[reportsDataset])reportsDataset='products';
  $('report-dataset').innerHTML=Object.entries(data.datasets).map(([key,value])=>`<option value="${key}">${esc(value.title)} (${value.count})</option>`).join('');$('report-dataset').value=reportsDataset;
  $('report-status').textContent=`Generated ${data.generatedAt.replace('T',' ').slice(0,19)} UTC · ${data.filters.from} to ${data.filters.to} · ${window.portalPreviewMode==='hotel'?'Sample data':data.mode==='company'?'Company workspace':'Private hotel workspace'}`;
  $('report-definitions').innerHTML=Object.values(data.definitions).filter(Boolean).map(text=>`<p>${esc(text)}</p>`).join('');
  renderReportMetrics();renderReportVisuals();renderBusinessCharts();renderReportTable();$('report-export').disabled=false;
 }catch(error){if(version===reportsVersion){$('report-error').textContent=error.message;$('report-error').hidden=false;$('report-status').textContent='Report could not be generated. Check the filters and try again.';notify(error.message,'error');}}
 finally{if(version===reportsVersion){$('report-apply').disabled=false;$('report-apply').textContent='Apply filters';}}
}
function renderReportMetrics(){
 const m=reportsData.metrics;
 const metrics=[['Registered items',m.registered,'Current snapshot'],['Available stock',m.available,'Active, outside transit'],[isAdmin()?'Dispatched items':'Inbound items dispatched',m.dispatchedUnits,'Selected period'],[isAdmin()?'Confirmed receipts':'Received items',m.receivedUnits,'Selected period'],['Requests created',m.requests,'Selected period'],['Attention flags',m.attentionFlags,'Current snapshot'],...(!isAdmin()?[['Lifetime uses',m.lifetimeUses,'Current owned items'],['Lifetime washes',m.lifetimeWashes,'Current owned items'],['Low stock products',m.lowStockProducts,'Hotel-wide rules']]:[['Cancelled requests',m.cancelledRequests,'Created in selected period']])];
 $('report-metrics').innerHTML=metrics.map(([label,value,scope])=>`<div class="report-metric"><small>${esc(label)}</small><strong>${number.format(value)}</strong><span>${esc(scope)}</span></div>`).join('');
}
function dailyChart(rows,key,label,unit,color){
 const raw=Math.max(0,...rows.map(r=>Number(r[key])||0)),step=Math.max(1,Math.ceil(raw/4)),top=step*4,w=window.innerWidth<760?440:720,h=250,left=62,right=w-25,baseline=194,plot=144,p=(right-left)/rows.length,bw=Math.min(24,Math.max(.6,p*.65));
 const ticks=[...new Set([0,Math.floor((rows.length-1)/4),Math.floor((rows.length-1)/2),Math.floor((rows.length-1)*3/4),rows.length-1])];
 return `<section class="daily-series"><h3><i style="background:${color}"></i>${esc(label)}</h3><p class="hint">Y: ${esc(unit)} · X: Calendar date (UTC)</p><div class="daily-svg-scroll"><svg viewBox="0 0 ${w} ${h}" role="group" aria-label="${esc(label)} by UTC date"><text x="${left}" y="19" class="chart-axis-title">${esc(unit)}</text>${[0,1,2,3,4].map(i=>{const value=i*step,y=baseline-value/top*plot;return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="chart-gridline"/><text x="${left-10}" y="${y+4}" text-anchor="end" class="chart-axis-text">${value}</text>`;}).join('')}${rows.map((r,i)=>{const value=Number(r[key])||0,x=left+i*p+p/2,barHeight=value/top*plot,detail=`${r.date} UTC · ${label}: ${value} ${unit.toLowerCase()}`;return `<g tabindex="0" role="button" aria-label="${esc(detail)}" data-chart-day="${i}" class="daily-point"><title>${esc(detail)}</title><rect x="${x-p/2}" y="35" width="${p}" height="${baseline-35}" fill="transparent"/><rect x="${x-bw/2}" y="${baseline-barHeight}" width="${bw}" height="${barHeight}" fill="${color}" pointer-events="none"/>${value&&rows.length<=35?`<text x="${x}" y="${baseline-barHeight-7}" text-anchor="middle" class="chart-value">${value}</text>`:''}</g>`;}).join('')}${ticks.map(i=>`<text x="${left+i*p+p/2}" y="216" text-anchor="${i===0?'start':i===rows.length-1?'end':'middle'}" class="chart-axis-text">${rows[i].date.slice(5)}</text>`).join('')}<text x="${(left+right)/2}" y="241" text-anchor="middle" class="chart-axis-title">Date (UTC) · ${rows[0].date} — ${rows.at(-1).date}</text></svg></div></section>`;
}
function inspectReportDay(index){
 const row=reportsData?.datasets.trend.rows[index];if(!row)return;
 const company=isAdmin();$('daily-date').value=row.date;
 $('daily-detail').innerHTML=`<strong>${esc(row.date)} · UTC</strong><span>${company?'Items dispatched':'Location observations'}: <b>${row[company?'dispatchedItems':'movements']}</b> ${company?'items':'events'}</span><span>${company?'Items received':'Stock requests created'}: <b>${row[company?'receivedItems':'orders']}</b> ${company?'items':'requests'}</span>`;
}
function renderReportVisuals(){
 const rows=reportsData.datasets.trend.rows,company=isAdmin();
 $('report-chart-legend').textContent='Hover, focus or tap a day to inspect exact values.';
 $('report-trend').innerHTML=`<p class="chart-explanation">${company?'Each chart counts individual items dispatched or accepted per UTC day. A receipt can occur on a later day than its dispatch.':'Location observations include first sightings and confirmed location changes, not unique products or completed uses. Stock requests count requests, not requested units. These are separate measures.'}</p><div class="daily-series-grid">${dailyChart(rows,company?'dispatchedItems':'movements',company?'Items Dispatched':'Location Observations',company?'Items':'Events','#ad9054')}${dailyChart(rows,company?'receivedItems':'orders',company?'Items Received':'Stock Requests Created',company?'Items':'Requests','#658977')}</div><div class="daily-inspector"><label>Inspect Date (UTC)<input type="date" id="daily-date" min="${rows[0].date}" max="${rows.at(-1).date}"></label><div id="daily-detail" role="status" aria-live="polite"></div></div>`;
 $('daily-date').onchange=e=>{const i=rows.findIndex(r=>r.date===e.target.value);if(i>=0)inspectReportDay(i);};
 const latest=rows.findLastIndex(r=>r[company?'dispatchedItems':'movements']||r[company?'receivedItems':'orders']);inspectReportDay(latest<0?rows.length-1:latest);
 const conditions=Object.entries(reportsData.distributions.condition),total=Math.max(1,reportsData.metrics.registered);
 $('report-condition').innerHTML=conditions.length?conditions.map(([status,count])=>`<div tabindex="0" class="chart-detail-target" data-chart-detail="${esc(status)}: ${count} items · ${Math.round(count/total*100)}% of registered inventory"><span>${esc(status.replaceAll('_',' '))}</span><strong>${number.format(count)} <small>items</small></strong><div class="condition-track"><i style="width:${count/total*100}%"></i></div><small>${Math.round(count/total*100)}% of ${reportsData.metrics.registered} registered items</small></div>`).join(''):empty('No registered inventory in this selection.');
}
for(const event of ['pointerover','focusin','click'])document.addEventListener(event,e=>{const point=e.target.closest('[data-chart-day]');if(point)inspectReportDay(Number(point.dataset.chartDay));});
document.addEventListener('keydown',e=>{const point=e.target.closest('[data-chart-day]');if(point&&['Enter',' '].includes(e.key)){e.preventDefault();inspectReportDay(Number(point.dataset.chartDay));}});
function reportBars(title,note,rows,label,series){
 const max=Math.max(1,...rows.flatMap(r=>series.map(s=>Number(r[s[0]])||0)));
 const active=rows.filter(r=>series.some(s=>Number(r[s[0]])>0));
 return `<div class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2><p class="hint">${esc(note)}</p></div></div><div class="report-business-body">${active.length?active.map(r=>`<div class="report-bar-group"><strong>${esc(r[label])}</strong>${series.map(([key,name],i)=>`<div class="report-bar-line chart-detail-target" tabindex="0" data-chart-detail="${esc(r[label])} · ${esc(name)}: ${number.format(r[key]||0)}${name.includes('/day')?' events per day':name==='Requests'?' requests':' items'}"><span>${esc(name)}</span><div class="report-bar-track"><i style="width:${Math.max(0,Number(r[key])||0)/max*100}%;background:${['#ad9054','#658977','#748ba6'][i%3]}"></i></div><b>${number.format(r[key]||0)}</b></div>`).join('')}</div>`).join(''):empty('No recorded activity for these filters. Try a different date range.')}</div></div>`;
}
function renderBusinessCharts(){
 const d=reportsData.datasets;
 $('report-business-charts').innerHTML=isAdmin()?
 reportBars('Products sent to each hotel','Dispatches created in the selected period; receipts show their current outcome.',d.deliveries.rows,'hotel',[['dispatched','Sent'],['received','Received'],['pending','Awaiting receipt']])+
 reportBars('Product demand & dispatch','Selected period · units by product',d.activity.rows,'product',[['requested','Requested'],['dispatched','Sent']])+
 reportBars('Customer order status','Requests created in the selected period · current status',Object.entries(reportsData.distributions.orderStatus).map(([status,count])=>({status,count})),'status',[['count','Requests']]):
 reportBars('Usage intensity','General-use entry events per day, not units consumed. Repeat entries can occur.',d.usage.rows,'product',[['roomEntriesPerDay','Use entries/day'],['washReturnsPerDay','Clean returns/day']])+
 reportBars('Stock replenishment needs','Current hotel-wide rules · reusable linen is not consumed on each use.',d.stock.rows,'product',[['available','Available'],['minimum','Minimum'],['suggestedRequest','Suggested order']])+
 reportBars('Where your linen is now','Current snapshot · units per linen stage',Object.entries(reportsData.distributions.stage).map(([stage,count])=>({stage:stage==='in_room'?'In Use':stage.replaceAll('_',' '),count})),'stage',[['count','Items']]);
}
function reportCell(value,key){
 if(value===null||value===undefined||value==='')return '—';
 if(typeof value==='number')return number.format(value);
 if(/At$/.test(key)&&Number.isFinite(Date.parse(value)))return new Date(value).toISOString().slice(0,16).replace('T',' ')+' UTC';
 return String(value);
}
function renderReportTable(){
 if(!reportsData)return;
 const data=reportsData.datasets[reportsDataset],query=$('report-search').value.trim().toLocaleLowerCase('en-US'),size=Number($('report-size').value);
 let rows=data.rows.filter(row=>!query||data.columns.some(c=>String(row[c.key]??'').toLocaleLowerCase('en-US').includes(query)));
 if(reportsSort)rows=[...rows].sort((a,b)=>{const x=a[reportsSort]??'',y=b[reportsSort]??'';const diff=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'en',{numeric:true});return reportsSortDesc?-diff:diff;});
 const pages=Math.max(1,Math.ceil(rows.length/size));reportsPage=Math.min(Math.max(1,reportsPage),pages);
 const page=rows.slice((reportsPage-1)*size,reportsPage*size);
 $('report-dataset-title').textContent=data.title;$('report-scope').textContent=data.scope==='snapshot'?'Current snapshot · not a historical stock balance':'Activity in the selected date range';
 $('report-table').innerHTML=page.length?`<div class="table-wrap"><table><thead><tr>${data.columns.map(c=>`<th><button type="button" class="report-sort" data-report-sort="${c.key}">${esc(c.label)} ${reportsSort===c.key?(reportsSortDesc?'↓':'↑'):'↕'}</button></th>`).join('')}</tr></thead><tbody>${page.map(r=>`<tr>${data.columns.map(c=>`<td data-label="${esc(c.label)}">${esc(reportCell(r[c.key],c.key))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty(query?'No matching records.':'No records for this report and filter selection.');
 $('report-row-count').textContent=`${rows.length?((reportsPage-1)*size+1):0}–${Math.min(rows.length,reportsPage*size)} of ${rows.length} records · Page ${reportsPage}/${pages}`;
 $('report-prev').disabled=reportsPage<=1;$('report-next').disabled=reportsPage>=pages;
}
$('report-filters').onsubmit=e=>{e.preventDefault();if(e.target.reportValidity())loadReports();};
$('report-apply').onclick=()=>{if($('report-filters').reportValidity())loadReports();};
$('report-dataset').onchange=e=>{reportsDataset=e.target.value;reportsPage=1;reportsSort='';renderReportTable();};
$('report-search').oninput=()=>{reportsPage=1;renderReportTable();};$('report-size').onchange=()=>{reportsPage=1;renderReportTable();};
$('report-prev').onclick=()=>{reportsPage--;renderReportTable();};$('report-next').onclick=()=>{reportsPage++;renderReportTable();};
document.addEventListener('click',e=>{const b=e.target.closest('[data-report-sort]');if(!b)return;reportsSortDesc=reportsSort===b.dataset.reportSort?!reportsSortDesc:false;reportsSort=b.dataset.reportSort;renderReportTable();});
$('refresh').addEventListener('click',()=>{if(activePage==='reports')loadReports();});
$('report-export').onclick=async()=>{
 if(!reportsData)return;const button=$('report-export');button.disabled=true;button.textContent='Exporting…';
 try{
  const params=new URLSearchParams({...reportsData.filters,dataset:reportsDataset,search:$('report-search').value});
  const response=await fetch('/v1/admin/reports/export?'+params,{credentials:'same-origin',headers:{'x-tenant-id':selectedTenant,...(window.portalPreviewMode==='hotel'?{'x-preview-mode':'hotel'}:{})}});
  if(!response.ok){const error=await response.json();throw new Error(error.message??'Report export failed.');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??'globaltex-report.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('CSV exported. The file contains all filtered records in this dataset, including records beyond the visible page.','info');
 }catch(error){notify(error.message,'error');}finally{button.disabled=false;button.textContent='↓ Export CSV';}
};
$('report-search').maxLength=200;
$('report-apply').insertAdjacentHTML('afterend','<button type="button" class="button" id="report-reset">Reset filters</button>');
$('report-reset').onclick=()=>{const end=new Date().toISOString().slice(0,10);$('report-to').value=end;$('report-from').value=new Date(Date.parse(end)-29*reportsDay).toISOString().slice(0,10);for(const id of ['report-product','report-facility','report-customer','report-search'])$(id).value='';loadReports();};

const reportHover=document.createElement('div');reportHover.className='report-hover-detail';reportHover.hidden=true;reportHover.setAttribute('role','tooltip');document.body.append(reportHover);
function showReportHover(e){
 const point=e.target.closest('[data-chart-day]');if(!point)return;
 const row=reportsData?.datasets.trend.rows[Number(point.dataset.chartDay)];if(!row)return;
 const company=isAdmin();reportHover.textContent=`${row.date} UTC\n${company?'Items dispatched':'Location observations'}: ${row[company?'dispatchedItems':'movements']} ${company?'items':'events'}\n${company?'Items received':'Stock requests created'}: ${row[company?'receivedItems':'orders']} ${company?'items':'requests'}`;
 const rect=point.getBoundingClientRect(),x=Number.isFinite(e.clientX)?e.clientX:rect.left,y=Number.isFinite(e.clientY)?e.clientY:rect.top;
 reportHover.style.left=Math.max(8,Math.min(window.innerWidth-280,x+12))+'px';reportHover.style.top=Math.max(8,Math.min(window.innerHeight-110,y-100))+'px';reportHover.hidden=false;
}
for(const name of ['pointerover','pointermove','focusin'])document.addEventListener(name,showReportHover);
for(const name of ['pointerout','focusout'])document.addEventListener(name,e=>{if(e.target.closest('[data-chart-day]'))reportHover.hidden=true;});

// Export belongs beside the dataset being inspected as well as in the page header.
$('report-dataset').closest('label').insertAdjacentHTML('afterend','<button type="button" class="button primary" id="report-export-detail" disabled>↓ Export Selected Report CSV</button>');
document.querySelector('.report-data-head').insertAdjacentHTML('afterend','<p class="report-export-note">CSV includes all matching rows in the selected report using the applied filters and current search, across every page.</p>');
$('report-export-detail').onclick=()=>$('report-export').click();
const exportDetailObserver=new MutationObserver(()=>{$('report-export-detail').disabled=$('report-export').disabled;$('report-export-detail').textContent=$('report-export').textContent==='Exporting…'?'Exporting…':'↓ Export Selected Report CSV';});
exportDetailObserver.observe($('report-export'),{attributes:true,attributeFilter:['disabled'],childList:true});
