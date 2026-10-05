import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sfToday,dateState,filterPermits,summarize} from '../site/dist/model.mjs';
const p={id:'1',address:'1 MAIN ST',number:'SSP-1',account:'Builder',start_date:'2026-10-04',end_date:'2026-10-05',tow_status:'Not Enforceable',type:'Street Space',neighborhood:'Downtown',lat:37.7,lng:-122.4};
test('today uses SF date around UTC midnight and DST',()=>{
  assert.equal(sfToday(new Date('2026-10-05T02:00:00Z')),'2026-10-04');
  assert.equal(sfToday(new Date('2026-01-02T07:30:00Z')),'2026-01-01');
});
test('inclusive date coverage, missing and inverted dates',()=>{
  assert.equal(dateState(p,'2026-10-04'),'covering');assert.equal(dateState(p,'2026-10-05'),'covering');
  assert.equal(dateState(p,'2026-10-03'),'upcoming');assert.equal(dateState(p,'2026-10-06'),'ended');
  assert.equal(dateState({...p,start_date:null},'2026-10-04'),'unknown');
  assert.equal(dateState({...p,end_date:'2026-10-03'},'2026-10-04'),'unknown');
});
test('tow statuses are exact and missing dates stay in all-record view',()=>{
  const rows=[p,{...p,id:'2',tow_status:'Enforceable',lat:null,lng:null},{...p,id:'3',tow_status:'Pending',start_date:null}];
  assert.deepEqual(summarize(rows),{total:3,enforceable:1,not_enforceable:1,unknown:1,mapped:2});
  assert.equal(filterPermits(rows,{date:'2026-10-04'}).length,2);
  assert.equal(filterPermits(rows,{tow:'Enforceable'}).length,1);
  assert.equal(filterPermits(rows,{query:'main',type:'Street Space',neighborhood:'Downtown'}).length,3);
  assert.equal(filterPermits(rows,{query:'no match'}).length,0);
});
