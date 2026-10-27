import test from 'node:test';import assert from 'node:assert/strict';
import {InventoryStore} from '../src/core/inventory-store.js';import {SqliteStore} from '../src/core/sqlite-store.js';import {importZohoCatalog} from '../src/integrations/zoho-catalog-import.js';
for(const type of ['memory','sqlite'])test(type+': catalog import preserves products, excludes invalid records and never creates stock',async()=>{
 const s=type==='memory'?new InventoryStore():new SqliteStore(':memory:');try{
 await s.upsertProducts('t',[{sku:'OLD',name:'Keep me',unitsPerBox:8,boxesPerPallet:3,active:true}]);
 const report={generatedAt:'2026-07-21',catalog:[{sku:'old',name:'Overwrite'},{sku:'NEW',name:'New towel',status:'active',zohoStockOnHand:500},{sku:'OFF',name:'Old towel',status:'inactive'},{sku:'BAD',name:'Service',productType:'service'},{sku:'',name:'Missing SKU'}]};
 const first=await importZohoCatalog(s,'t',report);assert.equal(first.imported,2);assert.equal(first.archivedImported,1);assert.equal((await s.productsFor('t')).find(p=>p.sku==='OLD').unitsPerBox,8);assert.equal((await s.inventoryFor('t')).length,0);assert.equal((await importZohoCatalog(s,'t',report)).imported,0);
 }finally{s.close?.();}
});
