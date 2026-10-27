import { linenStage } from './linen-cycle.js';
import { managedHotels } from './hotel-operations.js';
import { commercialRequest } from './portal-access.js';

const day=86400000;
const countBy=(rows,key)=>rows.reduce((out,row)=>{const k=String(key(row)??'Unknown');out[k]=(out[k]??0)+1;return out;},Object.create(null));
const sum=(rows,key)=>rows.reduce((n,r)=>n+Number(key(r)||0),0);
const utc=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():'';
const bucket=value=>utc(value).slice(0,10);
function dateValue(value,fallback){
 const text=value||fallback;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(Date.parse(text+'T00:00:00Z'))||new Date(text+'T00:00:00Z').toISOString().slice(0,10)!==text)throw new Error('Use valid dates in YYYY-MM-DD format.');
 return text;
}
export function reportFilters(query={},at=Date.now()){
 const to=dateValue(query.to,new Date(at).toISOString().slice(0,10));
 const from=dateValue(query.from,new Date(Date.parse(to)-29*day).toISOString().slice(0,10));
 const start=Date.parse(from+'T00:00:00Z'),end=Date.parse(to+'T00:00:00Z')+day;
 if(start>=end||end-start>366*day)throw new Error('Choose a date range of 1–366 days, with the start before the end.');
 return {from,to,start,end,sku:String(query.sku??''),facilityId:String(query.facilityId??''),hotelId:String(query.hotelId??''),timezone:'UTC'};
}
function dataset(title,columns,rows,scope='period'){return{title,columns:columns.map(([key,label])=>({key,label})),rows,count:rows.length,scope};}

export async function buildReports(store,principal,query={},at=Date.now()){
 const company=principal.role==='chain_admin',tenantId=principal.tenantId;
 if(company&&tenantId!==principal.tenantIds[0])throw new Error('Company reports cannot access hotel operations.');
 const filters=reportFilters(query,at),inPeriod=value=>{const t=Date.parse(value);return t>=filters.start&&t<filters.end;};
 const [raw,products,facilities,zones,allShipments,allMovements,operations]=await Promise.all([
  store.inventoryFor(tenantId),store.productsFor(tenantId),store.facilitiesFor(tenantId),store.zonesFor(tenantId),store.shipmentsFor(tenantId),store.movementsFor(tenantId),store.operationsFor(tenantId)
 ]);
 if(filters.sku&&!products.some(p=>p.sku===filters.sku))throw new Error('Select a product from this workspace.');
 if(filters.facilityId&&!facilities.some(f=>f.facilityId===filters.facilityId))throw new Error('Select a facility from this workspace.');
 if(!company&&filters.hotelId)throw new Error('Hotel reports are restricted to the signed-in hotel.');
 const names=new Map((company?await managedHotels(store,[tenantId]):[]).map(h=>[h.tenantId,h.name]));
 const customerIds=company?[...new Set([...principal.tenantIds.slice(1),...allShipments.map(s=>s.customerTenantId).filter(id=>id!==tenantId)])]:[];
 if(filters.hotelId&&!customerIds.includes(filters.hotelId))throw new Error('Select a customer associated with your company.');
 const productMap=new Map(products.map(p=>[p.sku,p])),facilityName=id=>facilities.find(f=>f.facilityId===id)?.name??id??'Unknown',zoneName=id=>zones.find(z=>z.zoneId===id)?.name??id??'Unknown';
 const owned=raw.filter(a=>a.sku&&(!filters.sku||a.sku===filters.sku)&&(!filters.facilityId||a.facilityId===filters.facilityId));
 const inventory=owned.map(a=>({epc:a.epc,sku:a.sku,product:productMap.get(a.sku)?.name??a.sku,facility:facilityName(a.facilityId),location:zoneName(a.zoneId),status:a.assetStatus,availability:a.inTransit?'In transit':a.assetStatus==='active'?'Available':'Unavailable',lastSeenAt:utc(a.lastSeenAt),
  ...(!company?{stage:linenStage(zones.find(z=>z.zoneId===a.zoneId)?.zoneType),uses:a.useCount??0,washes:a.washCount??0}: {})}));
 const productRows=products.filter(p=>(!filters.sku||p.sku===filters.sku)).map(p=>{
  const items=owned.filter(a=>a.sku===p.sku);
  return {sku:p.sku,product:p.name,catalogStatus:p.active===false?'Archived':'Active',registered:items.length,available:items.filter(a=>a.assetStatus==='active'&&!a.inTransit).length,inTransit:items.filter(a=>a.inTransit).length,damaged:items.filter(a=>a.assetStatus==='damaged').length,quarantined:items.filter(a=>a.assetStatus==='quarantined').length,lost:items.filter(a=>a.assetStatus==='lost').length,retired:items.filter(a=>a.assetStatus==='retired').length,...(!company?{totalUses:sum(items,a=>a.useCount),totalWashes:sum(items,a=>a.washCount),averageWashes:items.length?Math.round(sum(items,a=>a.washCount)/items.length*10)/10:0}:{})};
 });
 const locationRows=zones.filter(z=>!filters.facilityId||z.facilityId===filters.facilityId).map(z=>{
  const items=owned.filter(a=>a.zoneId===z.zoneId);
  return{location:z.name,facility:facilityName(z.facilityId),type:z.zoneType,recordStatus:z.active===false?'Archived':'Active',registered:items.length,available:items.filter(a=>a.assetStatus==='active'&&!a.inTransit).length,inTransit:items.filter(a=>a.inTransit).length,stale:items.filter(a=>at-Date.parse(a.lastSeenAt)>=30*day).length};
 });
 const epcSku=new Map(raw.filter(a=>a.sku).map(a=>[a.epc,a.sku]));
 for(const shipment of allShipments)for(const a of shipment.assets??[])if(a.sku&&!epcSku.has(a.epc))epcSku.set(a.epc,a.sku);
 const movements=allMovements.filter(m=>inPeriod(m.observedAt)&&(!filters.sku||epcSku.get(m.epc)===filters.sku)&&(!filters.facilityId||m.fromFacilityId===filters.facilityId||m.toFacilityId===filters.facilityId)).map(m=>({observedAt:m.observedAt,type:m.fromZoneId?'Movement':'Initial observation',epc:m.epc,sku:epcSku.get(m.epc)??'Unregistered',fromFacility:facilityName(m.fromFacilityId),fromLocation:zoneName(m.fromZoneId),toFacility:facilityName(m.toFacilityId),toLocation:zoneName(m.toZoneId),reader:m.readerId})).sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
 let requests=[];
 if(company){for(const id of principal.tenantIds.slice(1))requests.push(...(await store.operationsFor(id)).requests.map(r=>({...commercialRequest(r),tenantId:id})));}
 else requests=operations.requests.map(commercialRequest);
 const orders=requests.filter(r=>inPeriod(r.createdAt)&&(!filters.sku||r.sku===filters.sku)&&(!filters.hotelId||r.tenantId===filters.hotelId)).map(r=>({requestId:r.requestId,hotelId:r.tenantId,hotel:company?(names.get(r.tenantId)??r.tenantId):facilityName(facilities[0]?.facilityId),sku:r.sku,quantity:r.quantity,received:r.receivedQuantity??0,status:r.status,createdAt:r.createdAt,updatedAt:r.updatedAt??'',shipmentId:r.shipmentId??r.dispatch?.shipmentId??''})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const eligibleShipments=allShipments.filter(s=>(company||s.customerTenantId===tenantId)&&(!filters.hotelId||s.customerTenantId===filters.hotelId));
 const selectedAssets=s=>(s.assets??[]).filter(a=>!filters.sku||a.sku===filters.sku);
 const shipments=eligibleShipments.filter(s=>inPeriod(s.createdAt)&&(!filters.sku||selectedAssets(s).length)).map(s=>({shipmentId:s.shipmentId,reference:s.reference??'',destination:company?(s.customerTenantId===tenantId?facilityName(s.destinationFacilityId):names.get(s.customerTenantId)??s.customerTenantId):facilityName(s.destinationFacilityId),direction:s.supplierTenantId===tenantId?(s.customerTenantId===tenantId?'Internal transfer':'Outbound'):'Inbound',status:s.status,items:selectedAssets(s).length,received:selectedAssets(s).filter(a=>a.acceptedAt).length,missing:selectedAssets(s).filter(a=>!a.acceptedAt).length,createdAt:s.createdAt,acceptedAt:s.acceptedAt??'',receiptHours:s.acceptedAt?Math.round((Date.parse(s.acceptedAt)-Date.parse(s.createdAt))/3600000*10)/10:''})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const risks=[];
 for(const a of owned){
  const base={epc:a.epc,sku:a.sku,location:zoneName(a.zoneId),lastSeenAt:a.lastSeenAt};
  if(a.assetStatus!=='retired'&&at-Date.parse(a.lastSeenAt)>=30*day)risks.push({...base,type:'Not seen for 30 days',severity:'Warning'});
  if(['damaged','lost','quarantined'].includes(a.assetStatus))risks.push({...base,type:a.assetStatus,severity:a.assetStatus==='lost'?'High':'Warning'});
  if(!company&&a.assetStatus!=='retired'){
   const rule=(operations.lifespanPolicies??[]).find(p=>p.sku===a.sku);
   if(a.inspectionRequired||(rule?.maxWashes&&a.washCount>=rule.maxWashes)||(rule?.maxUses&&a.useCount>=rule.maxUses))risks.push({...base,type:'Service-life inspection',severity:'Warning'});
  }
 }
 const sold=new Set(allShipments.filter(s=>s.supplierTenantId===tenantId&&s.customerTenantId!==tenantId).flatMap(s=>(s.assets??[]).filter(a=>a.acceptedAt).map(a=>a.epc)));
 if(!filters.sku)for(const a of raw.filter(a=>!a.sku&&!sold.has(a.epc)&&(!filters.facilityId||a.facilityId===filters.facilityId)))risks.push({epc:a.epc,sku:'Unregistered',location:zoneName(a.zoneId),lastSeenAt:a.lastSeenAt,type:'Unregistered tag',severity:'High'});
 const stockRows=company?[]:operations.policies.filter(p=>!filters.sku||p.sku===filters.sku).map(p=>{
  // Rules cover all hotel locations; facility filtering must not fabricate a shortage.
  const available=raw.filter(a=>a.sku===p.sku&&a.assetStatus==='active'&&!a.inTransit).length;
  return{sku:p.sku,product:productMap.get(p.sku)?.name??p.sku,available,minimum:p.minimum,target:p.target,shortage:Math.max(0,p.minimum-available),suggestedRequest:available<p.minimum?Math.max(0,p.target-available):0,automatic:p.automatic?'Enabled':'Disabled',openRequests:operations.requests.filter(r=>r.sku===p.sku&&['submitted','approved','shipped'].includes(r.status)).length};
 });
 const daily=new Map();
 for(let t=filters.start;t<filters.end;t+=day){const date=new Date(t).toISOString().slice(0,10);daily.set(date,{date,movements:0,orders:0,dispatchedItems:0,receivedItems:0});}
 for(const m of movements){const row=daily.get(bucket(m.observedAt));if(row)row.movements++;}
 for(const order of orders){const row=daily.get(bucket(order.createdAt));if(row)row.orders++;}
 for(const shipment of eligibleShipments){
  const items=selectedAssets(shipment),sent=daily.get(bucket(shipment.createdAt));
  if(sent&&(!company||shipment.supplierTenantId===tenantId))sent.dispatchedItems+=items.length;
  for(const a of items){const received=daily.get(bucket(a.acceptedAt));if(received)received.receivedItems++;}
 }
 const trend=[...daily.values()];
 const datasets={
  inventory:dataset('Item inventory',[['epc','EPC'],['sku','SKU'],['product','Product'],['facility','Facility'],['location','Location'],['status','Condition'],['availability','Availability'],...(!company?[['stage','Linen stage'],['uses','Lifetime uses'],['washes','Lifetime washes']]:[]),['lastSeenAt','Last seen UTC']],inventory,'snapshot'),
  products:dataset('Product summary',[['sku','SKU'],['product','Product'],['catalogStatus','Catalog'],['registered','Registered'],['available','Available'],['inTransit','In transit'],['damaged','Damaged'],['quarantined','Quarantined'],['lost','Lost'],['retired','Retired'],...(!company?[['totalUses','Lifetime uses'],['totalWashes','Lifetime washes'],['averageWashes','Average washes']]:[])],productRows,'snapshot'),
  locations:dataset('Location summary',[['facility','Facility'],['location','Location'],['type','Type'],['recordStatus','Record status'],['registered','Registered'],['available','Available'],['inTransit','In transit'],['stale','Not seen 30 days']],locationRows,'snapshot'),
  movements:dataset('Confirmed location events',[['observedAt','Observed UTC'],['type','Event'],['epc','EPC'],['sku','SKU'],['fromFacility','From facility'],['fromLocation','From location'],['toFacility','To facility'],['toLocation','To location'],['reader','Reader']],movements),
  orders:dataset(company?'Customer orders':'My stock requests',[['requestId','Request ID'],['hotel','Hotel'],['sku','SKU'],['quantity','Requested'],['received','Received'],['status','Status'],['createdAt','Created UTC'],['updatedAt','Updated UTC'],['shipmentId','Shipment ID']],orders),
  shipments:dataset('Transfers and receiving',[['shipmentId','Shipment ID'],['reference','Reference'],['direction','Direction'],['destination','Destination'],['status','Shipment status'],['items','Selected items'],['received','Selected items received'],['missing','Awaiting receipt'],['createdAt','Created UTC'],['acceptedAt','Accepted UTC'],['receiptHours','Hours to full receipt']],shipments),
  risks:dataset('Attention flags',[['severity','Severity'],['type','Issue'],['epc','EPC'],['sku','SKU'],['location','Last location'],['lastSeenAt','Last seen UTC']],risks,'snapshot'),
  trend:dataset('Daily activity',[['date','Date UTC'],['movements','Confirmed movements'],['orders','Requests created'],['dispatchedItems','Items dispatched'],['receivedItems','Items received']],trend)
 };
 const activity=products.filter(p=>!filters.sku||p.sku===filters.sku).map(p=>({sku:p.sku,product:p.name,requested:sum(orders.filter(r=>r.sku===p.sku),r=>r.quantity),dispatched:eligibleShipments.filter(s=>(!company||s.supplierTenantId===tenantId)&&inPeriod(s.createdAt)).reduce((n,s)=>n+(s.assets??[]).filter(a=>a.sku===p.sku).length,0),received:eligibleShipments.reduce((n,s)=>n+(s.assets??[]).filter(a=>a.sku===p.sku&&a.acceptedAt&&inPeriod(a.acceptedAt)).length,0)}));
 datasets.activity=dataset('Product activity',[['sku','SKU'],['product','Product'],['requested','Units requested'],['dispatched','Units dispatched'],['received','Units received']],activity);
 if(company)datasets.customers=dataset('Customer order performance',[['hotel','Hotel'],['requests','Requests created'],['requested','Units requested'],['received','Units received on linked requests'],['fulfilled','Fulfilled requests'],['cancelled','Cancelled requests']],customerIds.filter(id=>!filters.hotelId||id===filters.hotelId).map(id=>{const rows=orders.filter(r=>r.hotelId===id);return{hotel:names.get(id)??id,requests:rows.length,requested:sum(rows,r=>r.quantity),received:sum(rows,r=>r.received),fulfilled:rows.filter(r=>r.status==='fulfilled').length,cancelled:rows.filter(r=>r.status==='cancelled').length};}));
 if(!company)datasets.stock=dataset('Stock coverage',[['sku','SKU'],['product','Product'],['available','Hotel-wide available'],['minimum','Minimum'],['target','Target'],['shortage','Below minimum by'],['suggestedRequest','Suggested quantity'],['automatic','Automatic requests'],['openRequests','Open requests']],stockRows,'snapshot');
 if(company)datasets.deliveries=dataset('Deliveries by hotel',[['hotel','Hotel'],['dispatched','Units dispatched'],['received','Received from these dispatches'],['pending','Awaiting receipt']],customerIds.filter(id=>!filters.hotelId||id===filters.hotelId).map(id=>{const items=eligibleShipments.filter(s=>s.supplierTenantId===tenantId&&s.customerTenantId===id&&inPeriod(s.createdAt)).flatMap(selectedAssets);const received=items.filter(a=>a.acceptedAt).length;return{hotel:names.get(id)??id,dispatched:items.length,received,pending:items.length-received};}));
 if(!company){
  const days=(filters.end-filters.start)/day;
  const usage=products.filter(p=>!filters.sku||p.sku===filters.sku).map(p=>{
   const events=allMovements.filter(m=>inPeriod(m.observedAt)&&epcSku.get(m.epc)===p.sku&&(!filters.facilityId||m.fromFacilityId===filters.facilityId||m.toFacilityId===filters.facilityId));
   const transitions=(from,to)=>events.filter(m=>m.fromZoneId&&from(linenStage(zones.find(z=>z.zoneId===m.fromZoneId)?.zoneType))&&linenStage(zones.find(z=>z.zoneId===m.toZoneId)?.zoneType)===to).length;
   const roomEntries=transitions(s=>s!=='in_room','in_room'),washReturns=transitions(s=>s==='in_wash'||s==='drying','clean');
   return{sku:p.sku,product:p.name,roomEntries,washReturns,roomEntriesPerDay:Math.round(roomEntries/days*100)/100,washReturnsPerDay:Math.round(washReturns/days*100)/100};
  });
  datasets.usage=dataset('Usage and laundry flow',[['sku','SKU'],['product','Product'],['roomEntries','General-use entry events'],['washReturns','Laundry-to-clean events'],['roomEntriesPerDay','Use entries per day'],['washReturnsPerDay','Clean returns per day']],usage);
 }
 return{mode:company?'company':'hotel',generatedAt:new Date(at).toISOString(),filters:{from:filters.from,to:filters.to,sku:filters.sku,facilityId:filters.facilityId,hotelId:filters.hotelId,timezone:'UTC'},
  definitions:{snapshot:'Inventory, location, risks and stock coverage are current snapshots, not historical balances. Use/wash counters are lifetime totals.',period:'Dates filter movement observations and request/shipment creation. Daily receipts use each item acceptance time. All date boundaries are UTC.',facility:'Facility filters apply to inventory, locations, risks and movements. Orders, transfers and hotel-wide stock rules are not filtered by facility.',customer:company?'Customer filters apply only to commercial orders and transfers; customer internal inventory is never included.':null},
  options:{products:products.map(p=>({sku:p.sku,name:p.name})),facilities:facilities.map(f=>({facilityId:f.facilityId,name:f.name})),customers:customerIds.map(id=>({tenantId:id,name:names.get(id)??id}))},
  metrics:{registered:inventory.length,available:inventory.filter(a=>a.availability==='Available').length,inTransit:inventory.filter(a=>a.availability==='In transit').length,attentionFlags:risks.length,movements:movements.length,requests:orders.length,requestedUnits:sum(orders,r=>r.quantity),fulfilledRequests:orders.filter(r=>r.status==='fulfilled').length,cancelledRequests:orders.filter(r=>r.status==='cancelled').length,dispatchedUnits:sum(trend,r=>r.dispatchedItems),receivedUnits:sum(trend,r=>r.receivedItems),staleItems:owned.filter(a=>a.assetStatus!=='retired'&&at-Date.parse(a.lastSeenAt)>=30*day).length,...(!company?{lifetimeUses:sum(owned,a=>a.useCount),lifetimeWashes:sum(owned,a=>a.washCount),lowStockProducts:stockRows.filter(r=>r.shortage>0).length}:{})},
  distributions:{condition:countBy(inventory,a=>a.status),location:countBy(inventory,a=>a.location),orderStatus:countBy(orders,r=>r.status),...(!company?{stage:countBy(inventory,a=>a.stage)}:{})},datasets};
}

export function reportCsv(report,key,{search=''}={}){
 const data=Object.hasOwn(report.datasets,key)?report.datasets[key]:null;if(!data)throw new Error('Select an available report dataset.');
 const escape=value=>{
  let text=String(value??'');
  if(typeof value==='string'&&/^[\s]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
 };
 const query=String(search).trim().toLocaleLowerCase('en-US');
 if(query.length>200)throw new Error('Report searches must be 200 characters or fewer.');
 const rows=data.rows.filter(r=>!query||data.columns.some(c=>String(r[c.key]??'').toLocaleLowerCase('en-US').includes(query)));
 return '\uFEFF'+[data.columns.map(c=>escape(c.label)).join(','),...rows.map(r=>data.columns.map(c=>escape(r[c.key])).join(','))].join('\r\n');
}
