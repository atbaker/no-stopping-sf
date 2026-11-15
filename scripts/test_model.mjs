import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sfToday,dateState,permitScheduleState,filterPermits,summarize,rankNeighborhoods,distanceMeters,nearestPermits} from '../site/dist/model.mjs';
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
test('bounds filter keeps mapped permits inside the map view; distance is great-circle',()=>{
  const home={lat:37.7599,lng:-122.4148};
  const rows=[{...p,id:'a',lat:37.7599,lng:-122.4148},{...p,id:'b',lat:37.7608,lng:-122.4148},{...p,id:'c',lat:37.7700,lng:-122.4148},{...p,id:'d',lat:null,lng:null}];
  assert.ok(Math.abs(distanceMeters(home,rows[1])-100)<1);
  const bounds={south:37.759,north:37.761,west:-122.416,east:-122.414};
  assert.deepEqual(filterPermits(rows,{bounds}).map(r=>r.id),['a','b']);
  assert.deepEqual(filterPermits(rows,{bounds:{...bounds,north:37.7600}}).map(r=>r.id),['a']);
});

const hours = {status:'listed', weekdays:['Mon','Fri'], start_time:'07:00', end_time:'17:00'};
const scheduled = {...p, tow_status:'Enforceable', tow_start_date:'2026-10-30',
  tow_end_date:'2026-11-02', tow_segments:[hours]};

test('schedule uses the San Francisco weekday and half-open hours on both sides of DST', () => {
  const stateAt = at => permitScheduleState(scheduled, new Date(at));
  assert.equal(stateAt('2026-10-30T13:59:59Z'), 'outside_hours');
  assert.equal(stateAt('2026-10-30T14:00:00Z'), 'within_hours');
  assert.equal(stateAt('2026-10-31T00:00:00Z'), 'outside_hours'); // Friday at 5 p.m.
  assert.equal(stateAt('2026-11-01T20:00:00Z'), 'outside_hours'); // Sunday at noon
  assert.equal(stateAt('2026-11-02T14:00:00Z'), 'outside_hours');
  assert.equal(stateAt('2026-11-02T15:00:00Z'), 'within_hours'); // Monday at 7 a.m. PST
  assert.equal(stateAt('2026-11-03T06:00:00Z'), 'outside_hours'); // Still Monday locally
  assert.equal(stateAt('2026-11-03T08:00:00Z'), 'outside_dates');
});

test('off-hours filter excludes active segments, uncertain schedules and out-of-range dates', () => {
  const overnight = {...hours, start_time:'20:00', end_time:'05:00', status:'needs_verification'};
  const noSigns = {status:'no_tow_signs'};
  const permits = [
    {...scheduled, id:'off', tow_segments:[hours, noSigns]},
    {...scheduled, id:'not-enforceable', tow_status:'Not Enforceable'},
    {...scheduled, id:'other-active-segment', tow_segments:[hours, {...hours, weekdays:['Sun']}]},
    {...scheduled, id:'always-active', tow_segments:[{status:'all_day'}, hours]},
    {...scheduled, id:'overnight', tow_segments:[hours, overnight]},
    {...scheduled, id:'unavailable-segment', tow_segments:[hours, {status:'unavailable'}]},
    {...scheduled, id:'legacy', tow_segments:undefined},
    {...scheduled, id:'no-tow-signs', tow_segments:[noSigns]},
    {...scheduled, id:'expired', tow_end_date:'2026-10-31'},
    {...scheduled, id:'missing-tow-date', tow_start_date:null, start_date:'2026-10-30'},
    {...scheduled, id:'invalid-date', tow_start_date:'2026-09-31'},
  ];
  const at = new Date('2026-11-01T20:00:00Z');
  const ids = options => filterPermits(permits, {...options, at}).map(row => row.id);
  assert.deepEqual(ids({tow:'Enforceable', schedule:'outside_hours'}), ['off']);
  assert.deepEqual(ids({schedule:'within_hours'}), ['other-active-segment', 'always-active']);
  assert.deepEqual(ids({schedule:'unknown'}),
    ['overnight', 'unavailable-segment', 'legacy', 'missing-tow-date', 'invalid-date']);
  assert.deepEqual(ids({schedule:'no_tow_signs'}), ['no-tow-signs']);
  assert.deepEqual(ids({schedule:'outside_dates'}), ['expired']);
});
test('nearest permits are mapped and sorted by distance',()=>{
  const rows=[{...p,id:'far',lat:37.8},{...p,id:'near',lat:37.701},{...p,id:'mid',lat:37.71},{...p,id:'x',lat:null}];
  assert.deepEqual(nearestPermits(rows,{lat:37.7,lng:-122.4},2).map(r=>r.id),['near','mid']);
  assert.deepEqual(nearestPermits(rows,{lat:37.7,lng:-122.4},5).map(r=>r.id),['near','mid','far']);
});
