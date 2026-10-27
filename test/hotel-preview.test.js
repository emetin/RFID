import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.js";
import { InventoryStore } from "../src/core/inventory-store.js";

async function withPreview(enabled, run) {
  const store=new InventoryStore();
  store.upsertProducts('company',[{sku:'REAL-ITEM',name:'Real inventory',unitsPerBox:1,boxesPerPallet:1}]);
  store.registerAssets('company',[{sku:'REAL-ITEM',epc:'AAAAAAAA00000001'}]);
  store.ingest({tenantId:'company',readerId:'r',facilityId:'warehouse',zoneId:'stock',events:[{epc:'AAAAAAAA00000001',eventId:'real-initial',observedAt:new Date().toISOString()}]});
  const server=createApp({store,enableHotelPreview:enabled,credentials:{reader:{tenantId:'company',readerId:'r',secret:'device-secret'}},admin:{identities:{company:{actorId:'company',role:'chain_admin',tenantIds:['company','real-hotel']},hotel:{actorId:'hotel',role:'hotel_admin',tenantIds:['real-hotel']}}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,{preview=false,method='GET',body,identity='company',tenant}={})=>fetch(base+path,{method,headers:{authorization:`Basic ${Buffer.from('admin:'+identity).toString('base64')}`,...(preview?{'x-preview-mode':'hotel'}:{}),...(tenant?{'x-tenant-id':tenant}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try { await run(call,store); } finally { await new Promise(r=>server.close(r)); }
}

test('local hotel preview is isolated, read-only and does not change real company permissions',async()=>{
 await withPreview(true,async(call,store)=>{
  assert.equal((await(await call('/v1/admin/preview')).json()).enabled,true);
  const me=await(await call('/v1/admin/me',{preview:true,tenant:'real-hotel'})).json();
  assert.equal(me.role,'hotel_admin');assert.equal(me.tenantId,'demo-hotel-preview');
  const snapshot=await(await call('/v1/admin/workflow',{preview:true,tenant:me.tenantId})).json();
  assert.equal(snapshot.assets.length,36);
  assert.ok(snapshot.assets.every(a=>a.sku.startsWith('DEMO-')));
  assert.equal(JSON.stringify(snapshot).includes('REAL-ITEM'),false);
  for(const path of ['/v1/admin/workflow/tag','/v1/admin/stock/requests','/v1/admin/stock/policies','/v1/admin/users']){
   const response=await call(path,{preview:true,method:'POST',body:{quantity:1}});
   assert.equal(response.status,403);assert.equal((await response.json()).error,'preview_read_only');
  }
  assert.equal((await call('/v1/admin/encoding/batches',{preview:true})).status,403);
  assert.equal((await call('/v1/admin/workflow',{tenant:'real-hotel'})).status,403,'preview does not authorize real customer access');
  const real=await(await call('/v1/admin/workflow')).json();assert.equal(real.assets[0].sku,'REAL-ITEM');assert.equal(real.assets.length,1);
  assert.equal(store.inventoryFor('company').length,1);assert.equal(store.inventoryFor('demo-hotel-preview').length,0);
  assert.equal((await call('/v1/admin/workflow',{preview:true,identity:'hotel'})).status,403,'hotel users cannot enable the company test switch');
  const page=await(await call('/dashboard')).text();assert.match(page,/portal-design.js\?v=/);
  assert.equal((await call('/assets/portal-design.css')).status,200);
 });
});

test('hotel preview is unavailable unless explicitly enabled',async()=>{
 await withPreview(false,async call=>{
  assert.equal((await(await call('/v1/admin/preview')).json()).enabled,false);
  assert.equal((await call('/v1/admin/workflow',{preview:true})).status,403);
 });
});

test('production disables hotel preview even when explicitly requested in app options',async()=>{
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';
 try{await withPreview(true,async call=>{
  assert.equal((await(await call('/v1/admin/preview')).json()).enabled,false);
  assert.equal((await call('/v1/admin/me',{preview:true})).status,403);
 });}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});
