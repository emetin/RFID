import { SqliteStore } from '../core/sqlite-store.js';
import { provisionWorkflowLocation } from '../core/supply-workflow.js';
import { changeHotelContact } from '../core/hotel-contacts.js';

if(process.env.NODE_ENV==='production')throw new Error('Demo data cannot be created in production.');
const store=new SqliteStore(process.env.SQLITE_PATH??'data/runtime/rfid.db');
const root=process.env.ADMIN_TENANT_ID??'globaltex-local';
const definitions=[
 ['demo-bayview-miami','Bayview Grand Hotel · Demo','Miami','FL','America/New_York',[['Olivia Carter','Hotel Manager'],['Ethan Brooks','Housekeeping Manager'],['Maya Bennett','Purchasing Coordinator']]],
 ['demo-magnolia-houston','Magnolia Park Hotel · Demo','Houston','TX','America/Chicago',[['Lucas Hayes','Hotel Manager'],['Sofia Reed','Laundry Supervisor'],['Noah Parker','Purchasing Manager']]],
 ['demo-coral-miami','Coral Haven Resort · Demo','Miami','FL','America/New_York',[['Amelia Foster','Operations Manager'],['Liam Collins','Housekeeping Supervisor'],['Chloe Turner','Receiving Coordinator']]],
 ['demo-cedar-houston','Cedar Heights Suites · Demo','Houston','TX','America/Chicago',[['Isabella Morgan','Hotel Manager'],['James Walker','Linen Coordinator'],['Ava Mitchell','Accounts Coordinator']]],
 ['demo-riverstone-austin','Riverstone Hotel · Demo','Austin','TX','America/Chicago',[['Benjamin Scott','Operations Manager'],['Charlotte Adams','Housekeeping Manager'],['Henry Cooper','Purchasing Coordinator']]],
 ['demo-palm-orlando','Palm Terrace Resort · Demo','Orlando','FL','America/New_York',[['Grace Wilson','Hotel Manager'],['Oliver Evans','Laundry Supervisor'],['Ella Thompson','Receiving Coordinator']]]
];
let hotelsAdded=0,contactsAdded=0;
try{
 for(const [tenantId,name,city,state,timezone,people]of definitions){
  const existing=store.operationsFor(root).hotels.find(h=>h.tenantId===tenantId);
  if(!existing){
   await provisionWorkflowLocation(store,tenantId,{facilityId:'main',name,facilityType:'hotel',timezone},[['storage','Storage','storage'],['washing','Washing','in_wash'],['drying','Drying','drying'],['distribution','Distribution','distribution'],['in-use','In Use','in_use']]);
  }
  store.updateOperations(root,s=>{
   let h=s.hotels.find(h=>h.tenantId===tenantId);
   if(!h){h={tenantId,name,city,state,country:'US',timezone,contact:people[0][0],email:tenantId+'@example.com',notes:'Fictional demonstration hotel. Contacts and locations are sample data. No physical RFID inventory or login accounts have been created.',demo:true,createdAt:new Date().toISOString()};s.hotels.push(h);hotelsAdded++;}
   for(const [name,role]of people){const email=name.toLowerCase().replaceAll(' ','.')+'@example.com';if((h.contacts??[]).some(c=>c.email===email))continue;changeHotelContact(h,{name,role,email,notes:'Fictional contact for product demonstrations.'},'demo-seed');contactsAdded++;}
  });
 }
 console.log(JSON.stringify({hotelsAdded,contactsAdded,demoHotels:definitions.length,loginAccountsCreated:0,rfidAssetsCreated:0},null,2));
}finally{store.close();}
