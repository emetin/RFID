import {randomUUID} from 'node:crypto';
export function changeHotelContact(hotel,value,actorId,contactId=null){
 hotel.contacts??=[];
 let contact=contactId?hotel.contacts.find(c=>c.contactId===contactId):null;
 if(contactId&&!contact)throw new Error('Contact not found.');
 if(!contact){if(hotel.contacts.length>=200)throw new Error('A hotel can have up to 200 contact records.');contact={contactId:randomUUID(),active:true};}
 const changes={};for(const key of ['name','role','email','phone','notes'])if(value[key]!==undefined){changes[key]=String(value[key]).trim();if(changes[key].length>(key==='notes'?1000:200))throw new Error('Contact details exceed the allowed length.');}
 const next={...contact,...changes};if(!next.name||next.name.length<2)throw new Error('Contact name must contain at least two characters.');if(next.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email))throw new Error('Enter a valid email address.');if(value.active!==undefined){if(typeof value.active!=='boolean')throw new Error('Contact status must be a boolean.');next.active=value.active;}
 Object.assign(contact,next,{updatedAt:new Date().toISOString(),updatedBy:actorId});if(!contactId)hotel.contacts.push(contact);return contact;
}
