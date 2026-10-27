import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryStore } from "../src/core/inventory-store.js";
import { SqliteStore } from "../src/core/sqlite-store.js";
import { setupWarehouses, provisionWorkflowLocation, dispatchTransfer, receiveTransfer, workflowSnapshot, workflowScan, saveLifespan, hotelDetails } from "../src/core/supply-workflow.js";
import { evaluateStock, saveStockPolicy } from "../src/core/hotel-operations.js";
import { createApp } from "../src/api/app.js";

const epcs=["AAAAAAAA00000001","AAAAAAAA00000002"];
async function initialStock(store){
  await setupWarehouses(store,"supplier");
  await store.upsertProducts("supplier",[{sku:"TOWEL",name:"Bath Towel",unitsPerBox:10,boxesPerPallet:20}]);
  await store.registerAssets("supplier",epcs.map(epc=>({epc,sku:"TOWEL"})));
  const session=await store.startSession({tenantId:"supplier",facilityId:"houston",zoneId:"houston-stock"});
  await store.ingest({tenantId:"supplier",facilityId:"houston",zoneId:"houston-stock",readerId:"workflow-houston-stock",sessionId:session.sessionId,events:epcs.map((epc,i)=>({epc,eventId:"initial-"+i,observedAt:"2026-01-01T12:00:00.000Z"}))});
}
for(const backend of ["memory","sqlite"]){
 test(`${backend}: Houston to Miami to hotel, partial receipts, usage, washes, retirement and replenishment`,async()=>{
  const store=backend==="sqlite"?new SqliteStore(":memory:"):new InventoryStore();
  try{
   await initialStock(store);
   const value={operationId:"houston-miami-0001",sourceFacilityId:"houston",customerTenantId:"supplier",destinationFacilityId:"miami",reference:"Warehouse transfer",epcs};
   const transfer=await dispatchTransfer(store,"supplier",value,"operator");
   assert.equal((await workflowSnapshot(store,"supplier")).metrics.available,0);
   assert.equal((await workflowSnapshot(store,"supplier")).metrics.inTransit,2);
   assert.equal((await dispatchTransfer(store,"supplier",value,"operator")).shipmentId,transfer.shipmentId,"dispatch retries do not duplicate transfers");
   await assert.rejects(()=>dispatchTransfer(store,"supplier",{...value,operationId:"duplicate-0001"},"operator"),/available/);
   await assert.rejects(()=>receiveTransfer(store,"supplier",transfer.shipmentId,{epcs:["BBBBBBBB00000001"],zoneId:"miami-stock"},"operator"),/Unexpected/);
   assert.equal((await store.inventoryFor("supplier")).length,2,"unexpected receipt has no inventory effects");
   let result=await receiveTransfer(store,"supplier",transfer.shipmentId,{epcs:[epcs[0]],zoneId:"miami-stock"},"operator");
   assert.equal(result.shipment.status,"partially_received");
   assert.equal((await workflowSnapshot(store,"supplier")).metrics.available,1);
   await receiveTransfer(store,"supplier",transfer.shipmentId,{epcs,zoneId:"miami-stock"},"operator");
   const miami=await workflowSnapshot(store,"supplier");
   assert.equal(miami.metrics.inTransit,0);assert.ok(miami.assets.every(a=>a.facilityId==="miami"));
   await provisionWorkflowLocation(store,"hotel-a",{facilityId:"main",name:"Hotel A",facilityType:"hotel"},[["receiving","Stock","receiving"],["room-1","Room 1","in_room"],["room-2","Room 2","in_room"],["soiled","Soiled","soiled"],["laundry","Laundry","in_wash"],["clean","Clean stock","clean_return"]]);
   const hotelTransfer=await dispatchTransfer(store,"supplier",{operationId:"hotel-transfer-0001",sourceFacilityId:"miami",customerTenantId:"hotel-a",destinationFacilityId:"main",reference:"Order 102",epcs},"operator");
   await receiveTransfer(store,"hotel-a",hotelTransfer.shipmentId,{epcs,zoneId:"receiving"},"hotel-manager");
   assert.equal((await workflowSnapshot(store,"supplier")).metrics.registered,0);
   assert.equal((await workflowSnapshot(store,"hotel-a")).metrics.available,2);
   await store.updateOperations("hotel-a",s=>saveStockPolicy(s,{sku:"TOWEL",minimum:2,target:5,automatic:true},"manager"));
   await saveLifespan(store,"hotel-a",{sku:"TOWEL",maxWashes:1,maxUses:0,autoRetire:true},"manager");
   const move=zoneId=>workflowScan(store,"hotel-a",{epcs:[epcs[0]],facilityId:"main",zoneId},"operator");
   await move("room-1");await move("room-1");await move("room-2");
   let item=(await store.inventoryFor("hotel-a")).find(a=>a.epc===epcs[0]);
   assert.equal(item.useCount,1,"repeat reads and room-to-room moves do not add uses");
   assert.equal(item.washCount,0);
   await move("clean");
   assert.equal((await store.inventoryFor("hotel-a")).find(a=>a.epc===epcs[0]).washCount,0,"a clean area alone is not a wash");
   await move("soiled");await move("laundry");await move("laundry");await move("clean");
   item=(await store.inventoryFor("hotel-a")).find(a=>a.epc===epcs[0]);
   assert.equal(item.washCount,1);assert.equal(item.assetStatus,"retired");
   const state=await evaluateStock(store,"hotel-a");
   assert.equal(state.policies[0].available,1);assert.equal(state.requests[0].quantity,4);
   await evaluateStock(store,"hotel-a");assert.equal((await store.operationsFor("hotel-a")).requests.length,1);
   await assert.rejects(()=>move("room-1"),/Retired/);
  }finally{await store.close?.();}
 });
}

test("SQLite transfer reservations and lifecycle counters survive reopening",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"supply-workflow-")),path=join(dir,"test.db");let store=new SqliteStore(path);
 try{await initialStock(store);await dispatchTransfer(store,"supplier",{operationId:"restart-transfer-0001",sourceFacilityId:"houston",customerTenantId:"supplier",destinationFacilityId:"miami",reference:"Restart",epcs},"operator");store.close();store=new SqliteStore(path);assert.equal((await workflowSnapshot(store,"supplier")).metrics.inTransit,2);await receiveTransfer(store,"supplier","restart-transfer-0001",{epcs,zoneId:"miami-stock"},"operator");store.close();store=new SqliteStore(path);assert.equal((await workflowSnapshot(store,"supplier")).metrics.available,2);assert.ok((await store.inventoryFor("supplier")).every(a=>a.facilityId==="miami"));}finally{store.close();rmSync(dir,{recursive:true});}
});

test("hotel details validate email, timezone and preserve existing information",()=>{
 const h=hotelDetails({name:"Hotel A",email:"manager@hotel.test",address:"100 Main St",timezone:"America/Chicago"});
 assert.equal(hotelDetails({phone:"+1 555 0100"},h).address,"100 Main St");
 assert.throws(()=>hotelDetails({...h,email:"invalid"}),/email/);assert.throws(()=>hotelDetails({...h,timezone:"invalid"}),/time zone/);
});

test("workflow HTTP routes enforce hotel isolation, role boundaries and confirmed manual counts",async()=>{
 const store=new InventoryStore();await initialStock(store);
 const app=createApp({store,credentials:{local:{tenantId:"supplier",readerId:"r",secret:"test-device-secret"}},admin:{token:"test-secret",tenantId:"supplier",role:"chain_admin"}});
 await new Promise(r=>app.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${app.address().port}`,auth={authorization:`Basic ${Buffer.from("admin:test-secret").toString("base64")}`};
 const call=(path,method="GET",body,headers=auth)=>fetch(base+path,{method,headers:{...headers,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const created=await call("/v1/admin/hotels","POST",{name:"Hotel A",city:"Miami",address:"100 Ocean Drive"});assert.equal(created.status,201);const hotel=await created.json();
  const edit=await call("/v1/admin/hotels/"+hotel.tenantId,"PUT",{phone:"+1 555 0100"});assert.equal(edit.status,200);assert.equal((await edit.json()).address,"100 Ocean Drive");
  await call("/v1/admin/users","POST",{username:"hotel.manager",password:"test-password-123",displayName:"Hotel manager",role:"hotel_admin",tenantIds:[hotel.tenantId],defaultTenantId:hotel.tenantId});
  const login=await call("/v1/auth/login","POST",{username:"hotel.manager",password:"test-password-123"},{});const cookie={cookie:login.headers.get("set-cookie").split(";")[0]};
  assert.equal((await call("/v1/admin/workflow/setup","POST",{},cookie)).status,403);
  assert.equal((await call("/v1/admin/workflow","GET",null,{...cookie,"x-tenant-id":"supplier"})).status,403);
  assert.equal((await call("/v1/admin/workflow/scan","POST",{readMode:"manual",epcs,facilityId:"main",zoneId:"receiving"},cookie)).status,422);
  assert.equal((await call("/v1/admin/workflow","GET",null,cookie)).status,200);
  for (const path of ["/v1/admin/me","/v1/admin/assets","/v1/admin/workflow","/v1/admin/linen-operations","/v1/admin/zones","/v1/admin/readers/health","/v1/admin/stock","/v1/admin/catalog","/v1/admin/audit"]) {
    assert.equal((await call(path,"GET",null,{...auth,"x-tenant-id":hotel.tenantId})).status,403,`company cannot access hotel ${path}`);
  }
  assert.equal((await call("/v1/admin/workflow/scan","POST",{confirmed:true,reason:"count",epcs,facilityId:"main",zoneId:"receiving"},{...auth,"x-tenant-id":hotel.tenantId})).status,403);
  assert.equal((await call("/v1/admin/workflow/lifespan","POST",{sku:"TOWEL",maxWashes:1,autoRetire:true},auth)).status,403,"company cannot operate hotel service-life rules");
  for (const path of ["/v1/admin/encoding/batches","/v1/admin/hardware/rru9809/status","/v1/admin/zoho/catalog"]) assert.equal((await call(path,"GET",null,cookie)).status,403,"hotel has no manufacturing or supplier integration screens");
  assert.equal((await call("/v1/admin/workflow/read","POST",{},cookie)).status,403,"hotel cannot read the supplier server's physical reader");
  assert.equal((await call("/v1/admin/workflow/scan","POST",{readMode:"device",zoneId:"receiving",facilityId:"main"},cookie)).status,403);
  assert.equal((await call("/v1/admin/workflow/scan","POST",{readMode:"gateway",zoneId:"receiving",facilityId:"main"},cookie)).status,422,"gateway mode needs recent reads from that hotel, not the supplier");
  store.upsertProducts(hotel.tenantId,[{sku:"TOWEL",name:"Bath Towel",unitsPerBox:1,boxesPerPallet:1}]);
  const order=await call("/v1/admin/stock/requests","POST",{sku:"TOWEL",quantity:5},cookie);
  assert.equal(order.status,201);const submitted=await order.json();
  assert.equal((await call("/v1/admin/stock/requests","POST",{sku:"TOWEL",quantity:5},cookie)).status,422,"one open product request prevents accidental duplicates");
  await store.updateOperations(hotel.tenantId,s=>{s.requests[0].availableAtRequest=42;s.requests[0].history.push({privateNote:"Room 808 private count"});});
  const commercial=await(await call("/v1/admin/stock/overview")).json();
  assert.equal(commercial.requests[0].requestId,submitted.requestId);
  assert.equal(commercial.requests[0].quantity,5);
  assert.equal("availableAtRequest" in commercial.requests[0],false);
  assert.equal("history" in commercial.requests[0],false);
  assert.equal(JSON.stringify(commercial).includes("Room 808"),false);
  assert.equal((await call("/v1/admin/users","POST",{username:"company.pivot",password:"test-password-123",displayName:"Company user",role:"chain_admin",tenantIds:[hotel.tenantId],defaultTenantId:hotel.tenantId})).status,422,"company accounts cannot reassign their root to a hotel");
  const summary=await(await call("/v1/admin/chain/summary")).json();assert.equal(summary.tenantCount,1);
  assert.equal((await call("/assets/workflow.js")).status,200);
 }finally{await new Promise(r=>app.close(r));}
});

test("tagging verifies the allocated EPC and only then adds stock; writer failure adds nothing",async()=>{
 const store=new SqliteStore(":memory:");await setupWarehouses(store,"supplier");
 store.upsertProducts("supplier",[{sku:"TOWEL",name:"Bath Towel",unitsPerBox:1,boxesPerPallet:1}]);
 // An existing queue must not cause the single-tag form to claim another batch.
 store.createEncodingBatch("supplier",{sku:"TOWEL",requestedQuantity:2});
 let fail=false;
 const app=createApp({store,credentials:{local:{tenantId:"supplier",readerId:"r",secret:"device-secret"}},admin:{token:"test-secret",tenantId:"supplier",role:"chain_admin"},rfidWriter:async({epc})=>{if(fail)throw new Error("Writer disconnected");return{epc,previousEpc:"BBBBBBBB00000001",verified:true};}});
 await new Promise(r=>app.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${app.address().port}`;
 const tag=()=>fetch(base+"/v1/admin/workflow/tag",{method:"POST",headers:{authorization:`Basic ${Buffer.from("admin:test-secret").toString("base64")}`,"content-type":"application/json"},body:JSON.stringify({sku:"TOWEL",facilityId:"houston",zoneId:"houston-stock",confirmed:true})});
 try{let response=await tag();assert.equal(response.status,201,await response.clone().text());const first=await response.json();assert.equal(first.verified,true);assert.equal(store.inventoryFor("supplier").length,1);assert.equal(store.inventoryFor("supplier")[0].epc,first.epc);fail=true;response=await tag();assert.equal(response.status,422);assert.equal(store.inventoryFor("supplier").length,1,"failed writes are never stock");assert.ok(store.encodingBatchesFor("supplier").some(b=>b.failed>0));}finally{await new Promise(r=>app.close(r));store.close();}
});
