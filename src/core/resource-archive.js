const openRequest = r => ['submitted','approved','shipped'].includes(r.status);

export async function setResourceActive(store, principal, { kind, id, active }) {
  if (typeof active !== 'boolean' || !['product','warehouse','location'].includes(kind) || !id) throw new Error('Select a record and an archive or restore action.');
  if (kind !== 'location' && principal.role !== 'chain_admin') throw new Error('Only Globaltex can manage product and warehouse records.');
  if (kind === 'location' && !['chain_admin','hotel_admin'].includes(principal.role)) throw new Error('Only a hotel manager can manage hotel locations.');
  const tenantId=principal.tenantId;
  if(kind==='product'){
    const product=(await store.productsFor(tenantId)).find(p=>p.sku===id);
    if(!product)throw new Error('Product not found.');
    if(!active){
      const usage=await store.productUsage(tenantId,id);
      if(usage.registered)throw new Error('This product has registered RFID items still in service. Transfer, retire or resolve those items before archiving the product.');
      if(usage.encoding)throw new Error('Complete the open RFID encoding jobs before archiving this product.');
      if(usage.receiving)throw new Error('Complete the draft receiving batches before archiving this product.');
      for(const target of principal.tenantIds){
        if((await store.operationsFor(target)).requests.some(r=>r.sku===id&&openRequest(r)))throw new Error('An open order uses this product. Complete or cancel the order before archiving.');
      }
    }
    await store.upsertProducts(tenantId,[{...product,active}]);
    await audit(store,principal,kind,id,active);
    return {kind,id,name:product.name,active};
  }
  const facilities=await store.facilitiesFor(tenantId);
  const facility=kind==='warehouse'?facilities.find(f=>f.facilityId===id):(await store.zonesFor(tenantId)).find(z=>z.zoneId===id);
  if(!facility)throw new Error('Location not found.');
  if(kind==='warehouse'&&facility.facilityType!=='warehouse')throw new Error('Only warehouse facilities can be archived here.');
  if(active&&kind==='location'&&!facilities.some(f=>f.facilityId===facility.facilityId&&f.active!==false))throw new Error('Restore the parent warehouse or facility first.');
  if(!active){
    const matches=a=>kind==='warehouse'?a.facilityId===id:a.zoneId===id;
    if((await store.inventoryFor(tenantId)).some(a=>a.sku&&a.assetStatus!=='retired'&&matches(a)))throw new Error('This area still contains registered items in service, including items in transit. Move, retire or reconcile the items before archiving.');
    if((await store.sessionsFor(tenantId)).some(s=>s.status==='open'&&matches(s)))throw new Error('Complete the open scan sessions before archiving this area.');
    if((await store.receivingBatchesFor(tenantId)).some(b=>b.status==='draft'&&matches(b)))throw new Error('Complete the draft receiving batches before archiving this area.');
    if(kind==='warehouse'&&(await store.shipmentsFor(tenantId)).some(s=>s.customerTenantId===tenantId&&s.destinationFacilityId===id&&s.status!=='received'))throw new Error('An incoming transfer is awaiting receipt at this warehouse. Receive it before archiving.');
  }
  if(kind==='warehouse')await store.upsertFacility(tenantId,{...facility,active});
  else await store.upsertZone(tenantId,{...facility,active});
  await audit(store,principal,kind,id,active);
  return {kind,id,name:facility.name,active};
}

function audit(store,principal,kind,id,active){
  return store.recordAudit({tenantId:principal.tenantId,actorId:principal.actorId,actorRole:principal.role,action:active?'resource.restored':'resource.archived',entityType:kind,entityId:id,details:{active}});
}
