import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore } from '../src/core/inventory-store.js';
import { SqliteStore } from '../src/core/sqlite-store.js';
import { setupWarehouses } from '../src/core/supply-workflow.js';
import { setResourceActive } from '../src/core/resource-archive.js';
import { requestCancellation,transitionRequest,evaluateStock,REQUEST_CANCEL_WINDOW_MS } from '../src/core/hotel-operations.js';
import { createApp } from '../src/api/app.js';

const principal={tenantId:'company',tenantIds:['company','hotel-a'],role:'chain_admin',actorId:'company-admin'};
const product=sku=>({sku,name:sku+' linen',unitsPerBox:12,boxesPerPallet:20});
for(const backend of ['memory','sqlite']){
 test(`${backend}: archives preserve records, restore settings and reject RFID, receiving, order and warehouse dependencies`,async()=>{
  const store=backend==='sqlite'?new SqliteStore(':memory:'):new InventoryStore();
  try{
   await setupWarehouses(store,'company');
   store.upsertProducts('company',['UNUSED','USED','QUEUE','DRAFT','ORDER','HISTORICAL'].map(product));
   store.registerAssets('company',[{epc:'AB00000000000088',sku:'HISTORICAL',status:'retired'}]);
   store.registerAssets('company',[{epc:'AB00000000000001',sku:'USED'}]);
   store.createEncodingBatch('company',{sku:'QUEUE',requestedQuantity:1});
   store.createReceivingBatch({tenantId:'company',sku:'DRAFT',expectedQuantity:1,facilityId:'houston',zoneId:'houston-stock'});
   store.updateOperations('hotel-a',s=>s.requests.push({requestId:'order-1',sku:'ORDER',status:'submitted',createdAt:new Date().toISOString(),history:[]}));
   const archive=(kind,id,active=false)=>setResourceActive(store,principal,{kind,id,active});
   await archive('product','UNUSED');let unused=store.productsFor('company').find(p=>p.sku==='UNUSED');assert.equal(unused.active,false);assert.equal(unused.unitsPerBox,12);
   assert.throws(()=>store.registerAssets('company',[{epc:'AB00000000000099',sku:'UNUSED'}]));
   assert.throws(()=>store.createEncodingBatch('company',{sku:'UNUSED',requestedQuantity:1}));
   await archive('product','UNUSED',true);assert.equal(store.productsFor('company').find(p=>p.sku==='UNUSED').active,true);
   await archive('product','HISTORICAL');assert.equal(store.productsFor('company').find(p=>p.sku==='HISTORICAL').active,false,'retired history is retained without blocking catalog archive');
   for(const [sku,reason]of [['USED',/registered RFID/],['QUEUE',/encoding/],['DRAFT',/receiving/],['ORDER',/open order/]])await assert.rejects(()=>archive('product',sku),reason);
   await archive('warehouse','miami');assert.equal(store.facilitiesFor('company').find(f=>f.facilityId==='miami').active,false);
   assert.equal(store.validateReaderContext({tenantId:'company',readerId:'workflow-miami-stock',required:true}).valid,false);
   await archive('warehouse','miami',true);
   store.createShipment({tenantId:'company',customerTenantId:'company',destinationFacilityId:'miami',reference:'Incoming',epcs:['AB00000000000001']});
   await assert.rejects(()=>archive('warehouse','miami'),/incoming transfer/);
   store.registerAssets('company',[{epc:'AB00000000000002',sku:'USED'}]);
   store.ingest({tenantId:'company',readerId:'workflow-houston-stock',facilityId:'houston',zoneId:'houston-stock',events:[{epc:'AB00000000000002',eventId:'stock',observedAt:new Date().toISOString()}]});
   await assert.rejects(()=>archive('warehouse','houston'),/registered items/);
   await assert.rejects(()=>archive('location','houston-stock'),/registered items/);
   store.upsertZone('company',{zoneId:'empty',facilityId:'houston',name:'Empty area',zoneType:'waiting'});
   await archive('location','empty');assert.equal(store.zonesFor('company').find(z=>z.zoneId==='empty').active,false);
   await archive('location','empty',true);assert.equal(store.zonesFor('company').find(z=>z.zoneId==='empty').zoneType,'waiting');
   await assert.rejects(()=>setResourceActive(store,{...principal,role:'hotel_admin'},{kind:'product',id:'UNUSED',active:false}),/Only Globaltex/);
  }finally{store.close?.();}
 });
 test(`${backend}: cancelling a manual request does not immediately recreate it automatically`,async()=>{
  const store=backend==='sqlite'?new SqliteStore(':memory:'):new InventoryStore();
  try{
   store.upsertProducts('hotel-a',[product('TOWEL')]);
   store.updateOperations('hotel-a',s=>{s.policies.push({sku:'TOWEL',minimum:2,target:10,automatic:true,triggered:false});s.requests.push({requestId:'manual-1',sku:'TOWEL',quantity:10,status:'submitted',source:'manual',createdAt:new Date().toISOString(),history:[]});});
   store.updateOperations('hotel-a',s=>transitionRequest(s,'manual-1','cancelled',{role:'hotel_admin',actorId:'manager'}));
   await evaluateStock(store,'hotel-a');assert.equal(store.operationsFor('hotel-a').requests.length,1);assert.equal(store.operationsFor('hotel-a').requests[0].status,'cancelled');
  }finally{store.close?.();}
 });
}

test('hotel cancellation has an exact 30-minute deadline; approval and dispatch close cancellation immediately',()=>{
 const created=Date.parse('2026-10-27T12:00:00Z');
 const request=()=>({requestId:'r',sku:'TOWEL',quantity:1,status:'submitted',createdAt:new Date(created).toISOString(),history:[]});
 assert.equal(requestCancellation(request(),'hotel_admin',created+REQUEST_CANCEL_WINDOW_MS-1).canCancel,true);
 assert.equal(requestCancellation(request(),'hotel_admin',created+REQUEST_CANCEL_WINDOW_MS).canCancel,false);
 const state={requests:[request()],policies:[]};
 assert.throws(()=>transitionRequest(state,'r','cancelled',{role:'hotel_admin',actorId:'hotel'},{now:created+REQUEST_CANCEL_WINDOW_MS}),/30-minute/);assert.equal(state.requests[0].status,'submitted');
 state.requests[0].status='approved';assert.throws(()=>transitionRequest(state,'r','cancelled',{role:'hotel_admin'},{now:created+1000}));
 state.requests[0].status='submitted';state.requests[0].dispatch={shipmentId:'s'};assert.throws(()=>transitionRequest(state,'r','cancelled',{role:'hotel_admin'},{now:created+1000}),/linked/);
 delete state.requests[0].dispatch;assert.throws(()=>transitionRequest(state,'r','cancelled',{role:'viewer'},{now:created+1000}),/Only hotel/);
 transitionRequest(state,'r','cancelled',{role:'chain_admin',actorId:'company'},{now:created+REQUEST_CANCEL_WINDOW_MS*2});assert.equal(state.requests[0].status,'cancelled');assert.equal(state.requests[0].history[0].actorId,'company');
});

test('SQLite archive and restore survive restart without deleting identities or settings',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rfid-archive-')),path=join(dir,'test.db');let store=new SqliteStore(path);
 try{
  await setupWarehouses(store,'company');store.upsertProducts('company',[product('EMPTY')]);
  await setResourceActive(store,principal,{kind:'product',id:'EMPTY',active:false});
  await setResourceActive(store,principal,{kind:'warehouse',id:'miami',active:false});
  await setResourceActive(store,principal,{kind:'location',id:'houston-stock',active:false});
  store.close();store=new SqliteStore(path);
  assert.equal(store.productsFor('company')[0].active,false);assert.equal(store.facilitiesFor('company').find(f=>f.facilityId==='miami').active,false);assert.equal(store.zonesFor('company').find(z=>z.zoneId==='houston-stock').active,false);
  await setResourceActive(store,principal,{kind:'product',id:'EMPTY',active:true});await setResourceActive(store,principal,{kind:'warehouse',id:'miami',active:true});await setResourceActive(store,principal,{kind:'location',id:'houston-stock',active:true});
  assert.equal(store.productsFor('company')[0].unitsPerBox,12);assert.equal(store.facilitiesFor('company').find(f=>f.facilityId==='miami').timezone,'America/New_York');assert.equal(store.zonesFor('company').find(z=>z.zoneId==='houston-stock').zoneType,'warehouse');
 }finally{store.close();rmSync(dir,{recursive:true});}
});

test('HTTP cancellation uses server time and current approval state; hotel cannot archive supplier products',async()=>{
 const store=new InventoryStore(),at=Date.now();
 store.updateOperations('hotel-a',s=>{for(const [id,age]of [['expired',31],['fresh',1],['approved',1]])s.requests.push({requestId:id,sku:'TOWEL',quantity:1,status:'submitted',createdAt:new Date(at-age*60000).toISOString(),history:[]});});
 const app=createApp({store,now:()=>at,credentials:{r:{tenantId:'company',readerId:'r',secret:'secret'}},admin:{identities:{company:{role:'chain_admin',actorId:'company',tenantIds:['company','hotel-a']},hotel:{role:'hotel_admin',actorId:'hotel',tenantIds:['hotel-a']}}}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 const call=(path,method='GET',body,identity='hotel')=>fetch(base+path,{method,headers:{authorization:`Basic ${Buffer.from('admin:'+identity).toString('base64')}`,'x-tenant-id':'hotel-a','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const list=await(await call('/v1/admin/stock')).json();assert.equal(list.cancellationWindowMinutes,30);assert.equal(list.requests.find(r=>r.requestId==='expired').canCancel,false);
  assert.equal((await call('/v1/admin/stock/requests/expired','PUT',{status:'cancelled'})).status,422);
  assert.equal((await call('/v1/admin/stock/requests/fresh','PUT',{status:'cancelled'})).status,200);
  assert.equal((await call('/v1/admin/stock/requests/approved','PUT',{status:'approved'},'company')).status,200);
  assert.equal((await call('/v1/admin/stock/requests/approved','PUT',{status:'cancelled'})).status,422);
  assert.equal((await call('/v1/admin/workflow/resource-state','POST',{kind:'product',id:'TOWEL',active:false})).status,403);
 }finally{await new Promise(r=>app.close(r));}
});
