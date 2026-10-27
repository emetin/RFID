import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/core/sqlite-store.js';
import { createApp } from '../src/api/app.js';
import { provisionWorkflowLocation,workflowScan } from '../src/core/supply-workflow.js';

test('hotel managers create private storage, laundry and waiting areas; role limits and names are enforced',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rfid-locations-')),path=join(dir,'test.db');let store=new SqliteStore(path);
 await provisionWorkflowLocation(store,'hotel-a',{facilityId:'main',name:'Hotel A',facilityType:'hotel'},[['stock','Hotel stock','receiving'],['clean','Clean return','clean_return'],['room','Room 101','in_room']]);
 const app=createApp({store,credentials:{r:{tenantId:'company',readerId:'r',secret:'test-device'}},admin:{identities:{company:{actorId:'company',role:'chain_admin',tenantIds:['company','hotel-a']},manager:{actorId:'manager',role:'hotel_admin',tenantIds:['hotel-a']},operator:{actorId:'operator',role:'operator',tenantIds:['hotel-a']},viewer:{actorId:'viewer',role:'viewer',tenantIds:['hotel-a']}}}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 const post=(value,identity='manager',tenant='hotel-a')=>fetch(base+'/v1/admin/workflow/location',{method:'POST',headers:{authorization:`Basic ${Buffer.from('admin:'+identity).toString('base64')}`,'content-type':'application/json','x-tenant-id':tenant},body:JSON.stringify(value)});
 const value={facilityId:'main',name:'Waiting area',zoneType:'waiting'};
 let waitingId,laundryId;
 try{
  const waiting=await post(value);assert.equal(waiting.status,201);const data=await waiting.json();assert.equal(data.name,'Waiting area');assert.equal(data.zoneType,'waiting');waitingId=data.zoneId;
  assert.equal((await post({...value,name:'WAITING AREA'})).status,422,'duplicate names are rejected rather than silently creating another area');
  assert.equal((await post({...value,name:'Linen store',zoneType:'warehouse'})).status,201);
  const laundry=await post({...value,name:'Main laundry',zoneType:'in_wash'});assert.equal(laundry.status,201);laundryId=(await laundry.json()).zoneId;
  for(const identity of ['operator','viewer','company'])assert.equal((await post({...value,name:'Forbidden '+identity},identity)).status,403);
  assert.equal((await post({...value,name:'Cross tenant'},'manager','company')).status,403);
  assert.equal((await post({...value,name:'x'.repeat(121)})).status,422);
  assert.equal((await post({...value,name:'Unknown',zoneType:'invalid'})).status,422);
  assert.equal(store.zonesFor('company').length,0);
  const epc='ABCDEF0000000001';store.upsertProducts('hotel-a',[{sku:'TOWEL',name:'Bath Towel',unitsPerBox:1,boxesPerPallet:1}]);store.registerAssets('hotel-a',[{epc,sku:'TOWEL'}]);
  store.ingest({tenantId:'hotel-a',facilityId:'main',zoneId:'stock',readerId:'workflow-stock',events:[{epc,eventId:'initial',observedAt:'2026-01-01T00:00:00.000Z'}]});
  const move=zoneId=>workflowScan(store,'hotel-a',{epcs:[epc],facilityId:'main',zoneId},'manager');
  await move(waitingId);await move('clean');let item=store.inventoryFor('hotel-a')[0];assert.equal(item.washCount,0);assert.equal(item.useCount,0,'waiting alone is neither a use nor a wash');
  await move('room');await move(waitingId);await move(laundryId);await move(waitingId);await move('clean');
  item=store.inventoryFor('hotel-a')[0];assert.equal(item.useCount,1);assert.equal(item.washCount,1,'a waiting area preserves an actual laundry cycle without double-counting');
 }finally{await new Promise(r=>app.close(r));store.close();}
 try{store=new SqliteStore(path);assert.equal(store.zonesFor('hotel-a').find(z=>z.zoneId===waitingId).name,'Waiting area');assert.equal(store.inventoryFor('hotel-a')[0].washCount,1);}finally{store.close();rmSync(dir,{recursive:true});}
});
