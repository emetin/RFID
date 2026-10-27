import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryStore } from '../src/core/inventory-store.js';
import { SqliteStore } from '../src/core/sqlite-store.js';
import { setupWarehouses,provisionWorkflowLocation } from '../src/core/supply-workflow.js';
import { buildReports,reportCsv,reportFilters } from '../src/core/reports.js';
import { createApp } from '../src/api/app.js';
const day=86400000;
const company={role:'chain_admin',actorId:'company',tenantId:'company',tenantIds:['company','hotel-a']};
const hotel={role:'hotel_admin',actorId:'hotel',tenantId:'hotel-a',tenantIds:['hotel-a']};
async function fixture(store){
 const at=Date.now();await setupWarehouses(store,'company');
 await provisionWorkflowLocation(store,'hotel-a',{facilityId:'main',name:'Hotel A',facilityType:'hotel'},[['private-room','PRIVATE ROOM','in_room']]);
 const products=[{sku:'A',name:'Company towel',unitsPerBox:1,boxesPerPallet:1},{sku:'B',name:'Company sheet',unitsPerBox:1,boxesPerPallet:1}];
 store.upsertProducts('company',products);store.upsertProducts('hotel-a',[products[0],{sku:'PRIVATE-SKU',name:'Private hotel linen',unitsPerBox:1,boxesPerPallet:1}]);
 const groups=[['houston','houston-stock',[{epc:'AA00000000000001',sku:'A'},{epc:'AA00000000000002',sku:'A'}]],['miami','miami-stock',[{epc:'BB00000000000001',sku:'B'}]]];
 for(const [facilityId,zoneId,assets]of groups){store.registerAssets('company',assets);store.ingest({tenantId:'company',facilityId,zoneId,readerId:'workflow-'+zoneId,events:assets.map((a,i)=>({epc:a.epc,eventId:facilityId+i,observedAt:new Date(at-10*day).toISOString()}))});}
 store.registerAssets('hotel-a',[{epc:'CC00000000000001',sku:'PRIVATE-SKU',washCount:77},{epc:'CC00000000000002',sku:'PRIVATE-SKU',washCount:77}]);
 store.ingest({tenantId:'hotel-a',facilityId:'main',zoneId:'private-room',readerId:'workflow-private-room',events:['CC00000000000001','CC00000000000002'].map((epc,i)=>({epc,eventId:'private'+i,observedAt:new Date(at-day).toISOString()}))});
 store.updateOperations('company',s=>s.hotels.push({tenantId:'hotel-a',name:'=HYPERLINK("private.example")'}));
 store.updateOperations('hotel-a',s=>{s.requests.push({requestId:'r1',tenantId:'hotel-a',sku:'A',quantity:10,status:'submitted',createdAt:new Date(at-day).toISOString(),availableAtRequest:77777,history:[{note:'PRIVATE ROOM history'}]});s.policies.push({sku:'PRIVATE-SKU',minimum:3,target:10,automatic:true});});
 store.createShipment({tenantId:'company',customerTenantId:'hotel-a',destinationFacilityId:'main',reference:'Test delivery',epcs:['AA00000000000001']});
 return at+1000;
}
for(const backend of ['memory','sqlite'])test(`${backend}: reports reconcile inventory/transit, separate snapshots from periods and preserve hotel privacy`,async()=>{
 const store=backend==='sqlite'?new SqliteStore(':memory:'):new InventoryStore();
 try{
  const at=await fixture(store),report=await buildReports(store,company,{},at);
  assert.equal(report.metrics.registered,3);assert.equal(report.metrics.available,2);assert.equal(report.metrics.inTransit,1);assert.equal(report.metrics.requests,1);assert.equal(report.metrics.requestedUnits,10);assert.equal(report.metrics.dispatchedUnits,1);
  assert.equal(report.datasets.inventory.rows.length,3);assert.equal(report.datasets.movements.rows.length,3);
  assert.equal(report.datasets.deliveries.rows[0].dispatched,1);assert.equal(report.datasets.deliveries.rows[0].pending,1);assert.equal('usage' in report.datasets,false);
  assert.equal('stock' in report.datasets,false);assert.equal('stage' in report.distributions,false);assert.equal('lifetimeWashes' in report.metrics,false);
  for(const secret of ['PRIVATE-SKU','PRIVATE ROOM','77777','availableAtRequest'])assert.equal(JSON.stringify(report).includes(secret),false,secret+' must stay inside the hotel boundary');
  const csv=reportCsv(report,'customers');assert.equal(csv.charCodeAt(0),0xfeff);assert.ok(csv.includes("'=HYPERLINK"),'spreadsheet formulas are neutralized');assert.equal(csv.includes('PRIVATE ROOM'),false);
  const sku=await buildReports(store,company,{sku:'A',facilityId:'miami'},at);assert.equal(sku.metrics.registered,0);assert.equal(sku.metrics.dispatchedUnits,1,'facility filtering does not pretend to identify historical shipment source');
  const past=await buildReports(store,company,{from:new Date(at-60*day).toISOString().slice(0,10),to:new Date(at-31*day).toISOString().slice(0,10)},at);assert.equal(past.metrics.registered,3,'past dates do not fabricate past stock balances');assert.equal(past.metrics.movements,0);assert.equal(past.metrics.requests,0);
  const privateReport=await buildReports(store,hotel,{},at);assert.equal(privateReport.metrics.registered,2);assert.equal(privateReport.metrics.lifetimeWashes,154);assert.equal(privateReport.datasets.stock.rows[0].available,2);assert.equal(privateReport.datasets.stock.rows[0].shortage,1);assert.equal(privateReport.datasets.stock.rows[0].suggestedRequest,8);assert.equal(privateReport.options.customers.length,0);assert.equal('customers' in privateReport.datasets,false);
  const filtered=reportCsv(report,'inventory',{search:'Company sheet'});assert.equal(filtered.split('\r\n').length,2);assert.ok(filtered.includes('BB00000000000001'));
  assert.throws(()=>reportCsv(report,'stock'),/available report/);assert.throws(()=>reportCsv(report,'__proto__'),/available report/);
 }finally{store.close?.();}
});

test('hotel usage intensity counts transitions rather than initial observations or lifetime totals',async()=>{
 const store=new InventoryStore();
 store.upsertProducts('hotel-a',[{sku:'A',name:'Towel',unitsPerBox:1,boxesPerPallet:1}]);
 store.zonesFor=()=>[{zoneId:'room',zoneType:'in_room'},{zoneId:'wash',zoneType:'laundry'},{zoneId:'clean',zoneType:'clean'}];
 store.movementsFor=()=>[
  {epc:'AA',fromZoneId:null,toZoneId:'room',observedAt:'2026-10-27T08:00:00Z'},
  {epc:'AA',fromZoneId:'clean',toZoneId:'room',observedAt:'2026-10-27T09:00:00Z'},
  {epc:'AA',fromZoneId:'wash',toZoneId:'clean',observedAt:'2026-10-27T10:00:00Z'}];
 store.inventoryFor=()=>[{epc:'AA',sku:'A',assetStatus:'active',zoneId:'clean',useCount:99,washCount:50}];
 const report=await buildReports(store,hotel,{from:'2026-10-26',to:'2026-10-27'});
 const row=report.datasets.usage.rows[0];assert.equal(row.roomEntries,1);assert.equal(row.washReturns,1);assert.equal(row.roomEntriesPerDay,0.5);assert.equal(row.washReturnsPerDay,0.5);assert.equal('deliveries' in report.datasets,false);
});

test('report dates are strict, inclusive UTC days and ranges are bounded',()=>{
 for(const query of [{from:'2026-02-30',to:'2026-03-02'},{from:'2026-11-01',to:'2026-10-01'},{from:'2020-01-01',to:'2026-01-01'}])assert.throws(()=>reportFilters(query));
 const one=reportFilters({from:'2026-10-27',to:'2026-10-27'});assert.equal(one.end-one.start,day);assert.equal(one.start,Date.parse('2026-10-27T00:00:00Z'));
});

test('UTC-offset observations are counted in the correct daily bucket',async()=>{
 const store=new InventoryStore();store.upsertProducts('hotel-a',[{sku:'A',name:'Towel',unitsPerBox:1,boxesPerPallet:1}]);store.registerAssets('hotel-a',[{epc:'AA00000000000001',sku:'A'}]);
 store.ingest({tenantId:'hotel-a',facilityId:'main',zoneId:'stock',readerId:'r',events:[{epc:'AA00000000000001',eventId:'offset',observedAt:'2026-10-28T00:30:00+03:00'}]});
 const report=await buildReports(store,hotel,{from:'2026-10-27',to:'2026-10-27'},Date.parse('2026-10-28T00:00:00Z'));assert.equal(report.datasets.movements.count,1);assert.equal(report.datasets.trend.rows[0].movements,1);assert.equal(report.datasets.inventory.rows[0].lastSeenAt,'2026-10-27T21:30:00.000Z');
});

test('a receipt counts in its acceptance period even when dispatch preceded the selected dates',async()=>{
 const store=new InventoryStore();store.upsertProducts('company',[{sku:'A',name:'Towel',unitsPerBox:1,boxesPerPallet:1}]);
 store.shipmentsFor=()=>[{shipmentId:'old-shipment',supplierTenantId:'company',customerTenantId:'hotel-a',destinationFacilityId:'main',createdAt:'2026-09-01T10:00:00Z',status:'received',acceptedAt:'2026-10-27T10:00:00Z',assets:[{epc:'AA00000000000001',sku:'A',acceptedAt:'2026-10-27T10:00:00Z'}]}];
 const report=await buildReports(store,company,{from:'2026-10-27',to:'2026-10-27'},Date.parse('2026-10-27T12:00:00Z'));
 assert.equal(report.datasets.shipments.count,0);assert.equal(report.metrics.dispatchedUnits,0);assert.equal(report.metrics.receivedUnits,1);assert.equal(report.datasets.activity.rows[0].received,1);
});

test('report JSON and CSV enforce role boundaries and expose only role-appropriate datasets',async()=>{
 const store=new InventoryStore();const at=await fixture(store);
 const app=createApp({store,now:()=>at,credentials:{r:{tenantId:'company',readerId:'r',secret:'secret'}},admin:{identities:{company:{...company},hotel:{...hotel},viewer:{...hotel,role:'viewer'}}}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 const get=(path,identity='company',tenant)=>fetch(base+path,{headers:{authorization:'Basic '+Buffer.from('admin:'+identity).toString('base64'),...(tenant?{'x-tenant-id':tenant}:{})}});
 try{
  for(const path of ['/v1/admin/reports','/v1/admin/reports/export?dataset=inventory']){
   assert.equal((await get(path,'company','hotel-a')).status,403);assert.equal((await get(path,'hotel','company')).status,403);
  }
  const report=await get('/v1/admin/reports');assert.equal(report.status,200);assert.equal(report.headers.get('cache-control'),'private, no-store');
  const exportResponse=await get('/v1/admin/reports/export?dataset=customers');assert.equal(exportResponse.status,200);assert.match(exportResponse.headers.get('content-type'),/text\/csv/);assert.match(exportResponse.headers.get('content-disposition'),/attachment/);assert.equal((await exportResponse.text()).includes('77777'),false);
  assert.equal((await get('/v1/admin/reports/export?dataset=stock')).status,422);
  const viewer=await get('/v1/admin/reports','viewer');assert.equal(viewer.status,200);assert.equal((await viewer.json()).metrics.registered,2);
  assert.equal((await get('/v1/admin/reports?hotelId=unknown')).status,422);
  assert.equal((await get('/v1/admin/reports?sku=PRIVATE-SKU')).status,422);
 }finally{await new Promise(r=>app.close(r));}
});
