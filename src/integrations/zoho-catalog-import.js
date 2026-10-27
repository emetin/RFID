// Import product definitions only. ERP stock quantities are never RFID observations.
export async function importZohoCatalog(store,tenantId,report){
 const records=report.catalog??report.eligible??[];
 const existing=await store.productsFor(tenantId),known=new Set(existing.map(p=>p.sku.toUpperCase()));
 const missing=[];
 for(const p of records){
  const sku=String(p.sku??'').trim();
  if(!sku||!p.name||known.has(sku.toUpperCase())||p.reasons?.includes('duplicate_sku'))continue;
  if(p.productType&&p.productType!=='goods')continue;
  if(p.itemType&&p.itemType!=='inventory')continue;
  if(p.trackInventory===false)continue;
  known.add(sku.toUpperCase());missing.push({sku,name:p.name,category:'Zoho Inventory',unitsPerBox:1,boxesPerPallet:1,active:p.status!=='inactive'});
 }
 if(missing.length)await store.upsertProducts(tenantId,missing);
 return{imported:missing.length,activeImported:missing.filter(p=>p.active).length,archivedImported:missing.filter(p=>!p.active).length,sourceGeneratedAt:report.generatedAt,totalProducts:existing.length+missing.length};
}
