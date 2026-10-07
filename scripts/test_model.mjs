import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sfToday,dateState,filterPermits,summarize,rankNeighborhoods} from '../site/dist/model.mjs';
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
test('neighborhood ranking skips small samples and unmapped permits',()=>{
  const make=(hood,yes,no)=>[...Array(yes)].map(()=>({neighborhood:hood,tow_status:'Enforceable'})).concat([...Array(no)].map(()=>({neighborhood:hood,tow_status:'Not Enforceable'})));
  const rows=[...make('A',9,1),...make('B',5,5),...make('C',1,9),...make('D',2,8),...make('Tiny',2,0),...make('Unmapped',10,0),...make('E',6,4),...make('F',3,7)];
  const {top,bottom,eligible}=rankNeighborhoods(rows);
  assert.equal(eligible,6);
  assert.deepEqual(top.map(r=>r.name),['A','E','B']);
  assert.deepEqual(bottom.map(r=>r.name),['C','D','F']);
  assert.equal(top[0].share,.9);
});
test('neighborhood ranking never repeats a neighborhood across lists',()=>{
  const rows=['A','B','C','D'].flatMap((hood,i)=>[...Array(10)].map((_,j)=>({neighborhood:hood,tow_status:j<i*3?'Enforceable':'Not Enforceable'})));
  const {top,bottom}=rankNeighborhoods(rows);
  assert.deepEqual(top.map(r=>r.name),['D','C','B']);
  assert.deepEqual(bottom.map(r=>r.name),['A']);
});
