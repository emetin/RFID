import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/portal-design.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function paintManagedList(state){'),source.indexOf('const listRenderWorkflow='));
const paint=vm.runInNewContext(fn+';paintManagedList',{document:{createElement:()=>({append(){}})}});
function fixture(){
 const nodes=new Map();const body={replaceChildren(...rows){this.rows=rows;},append(row){this.rows.push(row);}};
 const state={table:{querySelector:()=>body},rows:Array.from({length:1050},(_,i)=>({row:{cells:[]},cells:['Product '+i],text:'product '+i,status:[i%2?'Active':'Archived']})),page:1,size:10,query:'',status:'',sort:0,desc:false,headers:['Product'],footer:{querySelector(key){if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}}};
 return{state,body,nodes};
}
test('large lists mount only the selected page and clamp pages after filtering',()=>{
 const {state,body,nodes}=fixture();paint(state);assert.equal(body.rows.length,10);assert.match(nodes.get('[role=status]').textContent,/of 1050/);assert.equal(nodes.get('[data-list-prev]').disabled,true);
 state.page=105;paint(state);assert.equal(body.rows.length,10);assert.equal(nodes.get('[data-list-next]').disabled,true);
 state.query='product 1049';paint(state);assert.equal(state.page,1);assert.equal(body.rows.length,1);assert.match(nodes.get('[role=status]').textContent,/of 1/);
});
test('status, natural sorting and page size combine without mutating source records',()=>{
 const {state,body,nodes}=fixture();state.status='Active';state.size=25;state.desc=true;paint(state);assert.equal(body.rows.length,25);assert.match(nodes.get('[role=status]').textContent,/of 525/);assert.equal(body.rows[0],state.rows[1049].row);assert.equal(state.rows.length,1050);
 state.query='missing';paint(state);assert.match(nodes.get('[role=status]').textContent,/0–0 of 0/);assert.equal(nodes.get('[data-list-next]').disabled,true);
});
