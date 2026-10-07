import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { sfToday, dateState, filterPermits, summarize, rankNeighborhoods, distanceMeters } from './model.mjs';
import { looksLikeAddress, suggestAddresses } from './address.mjs';
import { photoUrl, photoSource, photoOriginalUrl } from './photos.mjs';
const $ = id => document.getElementById(id);
const form = $('filters'), fields = form.elements;
const number = n => n.toLocaleString('en-US');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const displayDate = date => date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'Not provided';
// Posted signs print dates as MM/DD/YY.
const signDate = date => date ? `${date.slice(5,7)}/${date.slice(8,10)}/${date.slice(2,4)}` : '??/??/??';
const statusKey = status => status==='Enforceable'?'yes':status==='Not Enforceable'?'no':'unknown';
const percent = (part,total) => total ? Math.round(part/total*100) : 0;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const RED = '#b71137', INK = '#111111', GRAY = '#8a8a8a';
const PAGE = 24;
let permits = [], filtered = [], metadata, map, popup, visible = PAGE;
let groups = new Map(), groupKeyById = new Map();
// Address search: the EAS index loads on the first address-like query; `near` is the chosen address point.
let addressIndex, addressIndexLoad, near = null, nearMarker, suggestions = [], distances = new Map(), renderedSignature, focusKey = '';
const smooth = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const formatDistance = meters => meters * 3.28084 < 1000 ? `${Math.max(10, Math.round(meters * 3.28084 / 10) * 10)} ft` : `${(meters / 1609.34).toFixed(1)} mi`;
// Address search centers the map on the address; results are whatever the map shows. The zoom fits about
// 600 m across the map's narrower side (a few blocks each way) on any screen size.
const ADDRESS_VIEW_METERS = 600;
const addressZoom = lat => {const el=$('map'),px=Math.min(el.clientWidth,el.clientHeight)||360;
  return Math.min(17,Math.max(14,Math.log2(78271.5*Math.cos(lat*Math.PI/180)*px/ADDRESS_VIEW_METERS)));}; // 512px tiles
// Without a map (it failed to load), approximate the same view as a box around the address.
function viewBounds() {
  if(map) {const b=map.getBounds();return {west:b.getWest(),south:b.getSouth(),east:b.getEast(),north:b.getNorth()};}
  const dLat=ADDRESS_VIEW_METERS/2/110540, dLng=ADDRESS_VIEW_METERS/2/(111320*Math.cos(near.lat*Math.PI/180));
  return {west:near.lng-dLng,south:near.lat-dLat,east:near.lng+dLng,north:near.lat+dLat};
}
const stamp = status => `<span class="stamp ${statusKey(status)}">${escape(status || 'Unknown')}</span>`;
const photoFor = p => p.photo?.kind==='tow_sign_submission' && photoUrl(p.photo) && photoSource(p.photo) ? p.photo : null;
function photoMarkup(photo, size) {
  return `<span class="photo-frame"><img src="${escape(photoUrl(photo,size))}" alt="${escape(photo.title || 'Public permit photo')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="photo-fallback" hidden>Photo unavailable</span></span>`;
}
function handlePhotoErrors(container) {
  container.querySelectorAll('.photo-frame img').forEach(img => img.addEventListener('error',()=>{
    img.hidden=true;img.nextElementSibling.hidden=false;
  },{once:true}));
}

// An address-like query waiting on a suggestion pick doesn't text-filter; with no address match it falls back to text search.
function textQuery() {
  const text=fields.query.value;
  // addressIndex: undefined = not loaded yet, null = failed to load (fall back to text search).
  if(near||(looksLikeAddress(text)&&addressIndex!==null&&(!addressIndex||suggestAddresses(addressIndex,text).length)))return '';
  return text;
}
function getFilters() {
  const when = fields.when.value;
  return {query:textQuery(),bounds:near?viewBounds():null,
    tow:fields.tow.value,type:fields.type.value,neighborhood:fields.neighborhood.value,
    date:when==='all'?null:when==='today'?sfToday():fields.date.value||sfToday()};
}
function populate(id, values) {
  for (const value of [...new Set(values)].sort()) {
    if ([...$(id).options].some(o=>o.value===value)) continue;
    $(id).add(new Option(value, value));
  }
}
function reset() {
  HTMLFormElement.prototype.reset.call(form); $('date').value=sfToday(); $('date-field').hidden=true;
  near=null; hideSuggestions(); $('search-status').textContent='';
  update(); fit();
}
function update() {
  const when = fields.when.value;
  if(when==='date'&&!$('date').value)$('date').value=sfToday();
  const filters = getFilters();
  filtered = filterPermits(permits, filters);
  distances = new Map(near ? filtered.map(p=>[p.id,distanceMeters(p,near)]) : []);
  filtered.sort(near ? (a,b)=>distances.get(a.id)-distances.get(b.id) || a.number.localeCompare(b.number)
    : (a,b)=>Boolean(!a.address)-Boolean(!b.address) || a.address.localeCompare(b.address,undefined,{numeric:true}) || a.number.localeCompare(b.number));
  $('near-chip').hidden=!near; $('near-address').textContent=near?.address??''; $('fit').textContent=near?'Recenter':'Fit results';
  const stats = summarize(filtered);
  $('tally-when').textContent = (filters.date ? (when==='today'?'Today · ':'')+displayDate(filters.date)+' · SF date' : 'Every downloaded permit')+(near?` · map view around ${near.address}`:'');
  $('total').textContent=number(stats.total);
  $('total-caption').textContent = filters.date ? `tow permit${stats.total===1?'':'s'} cover this date` : `tow permit${stats.total===1?'':'s'} in the snapshot`;
  $('count-no').textContent=number(stats.not_enforceable); $('count-yes').textContent=number(stats.enforceable);
  $('pct-no').textContent=stats.total?percent(stats.not_enforceable,stats.total)+'%':'';
  $('pct-yes').textContent=stats.total?percent(stats.enforceable,stats.total)+'%':'';
  $('ratio-no').style.width=(stats.total?stats.not_enforceable/stats.total*100:0)+'%';
  $('ratio-yes').style.width=(stats.total?stats.enforceable/stats.total*100:0)+'%';
  $('ratio-unknown').style.width=(stats.total?stats.unknown/stats.total*100:0)+'%';
  $('unknown-detail').textContent=stats.unknown ? `Reported Tow Status on the public record · ${number(stats.unknown)} with another or unknown status` : 'Reported Tow Status on the public record';
  const missingDates=permits.filter(p=>dateState(p,sfToday())==='unknown').length;
  const fallbacks=filtered.filter(p=>p.date_basis!=='Tow-away dates').length;
  $('coverage-note').textContent=(near?`Map view around ${near.address}, nearest first · `:'')+`${number(stats.total)} matching · ${number(stats.mapped)} mapped · ${number(stats.total-stats.mapped)} without an exact address match`+
    (filters.date&&missingDates?` · ${number(missingDates)} with unknown dates excluded`:'')+
    (fallbacks?` · ${number(fallbacks)} use permit dates as a fallback`:'');
  $('result-count').textContent=number(stats.total);
  $('mapped-label').textContent=`${number(stats.mapped)} of ${number(stats.total)} permits mapped`;
  visible=PAGE; renderResults(); renderMap(); renderHoods(filters.date);
}
// Rankings follow the date choice only; other filters would collapse them to a single neighborhood.
function renderHoods(date) {
  const MIN=10, {top,bottom,eligible}=rankNeighborhoods(filterPermits(permits,{date}),{minPermits:MIN});
  const active=fields.neighborhood.value;
  const row=r=>`<li><button type="button" class="hood" data-hood="${escape(r.name)}" aria-pressed="${r.name===active}">
    <span class="hood-name">${escape(r.name)}</span>
    <span class="hood-figs"><b>${percent(r.enforceable,r.total)}%</b><span>${number(r.enforceable)} of ${number(r.total)}</span></span>
    <span class="hood-bar" aria-hidden="true"><i style="width:${r.share*100}%"></i></span></button></li>`;
  $('hoods-top').innerHTML=top.map(row).join('');
  $('hoods-bottom').innerHTML=bottom.map(row).join('')||'<li class="hood-empty">—</li>';
  $('hood-ranks').hidden=!eligible;
  $('hood-note').textContent=eligible
    ? `Share of each neighborhood’s permits that are enforceable${date?' on this date':''}. Ranks ${number(eligible)} neighborhoods with ${MIN}+ permits. Tap one to filter the map.`
    : `Not enough permits${date?' on this date':''} to rank neighborhoods (${MIN}+ needed).`;
}
function renderResults() {
  $('results').innerHTML=filtered.length ? filtered.slice(0,visible).map(p=>`
    <button type="button" class="mini-sign" data-permit="${escape(p.id)}" aria-label="${escape(p.address || 'Address not provided')}, ${escape(p.tow_status)}, ${escape(p.number)}">
      <span class="mini-top"><b aria-hidden="true">No</b><span aria-hidden="true">Stopping</span>${stamp(p.tow_status)}</span>
      <span class="mini-body">
        <span class="mini-dates">${signDate(p.start_date)} – ${signDate(p.end_date)}</span>
        <span class="mini-address">${escape(p.address || 'Address not provided')}</span>
        <span class="mini-meta">${escape(p.neighborhood)} · ${escape(p.type)}</span>
        ${distances.has(p.id)?`<span class="mini-distance">${formatDistance(distances.get(p.id))} away</span>`:''}
        ${photoFor(p)?'<span class="mini-photo">Submitted sign photo on file</span>':''}
        ${p.lat===null?'<span class="mini-unmapped">Location not mapped · included in counts</span>':''}
        <span class="mini-rule"></span>
        <span class="mini-permit"><span>${escape(p.number)}</span><span>${escape(p.account || p.phase)}</span></span>
      </span>
    </button>`).join(''):
    (near?`<div class="empty">No tow permits in the map view around ${escape(near.address)} match these filters.<br>Zoom the map out or try another date.</div>`
      :'<div class="empty">No permits match these filters.<br>Try another date or reset the filters.</div>');
  $('more').hidden=visible>=filtered.length;
  $('more').textContent=`Show more · ${number(Math.max(0,filtered.length-visible))} remaining`;
}
function renderMap() {
  groups=new Map(); groupKeyById=new Map();
  for (const p of filtered) {
    if (!Number.isFinite(p.lat)||!Number.isFinite(p.lng)) continue;
    const key=`${p.lat},${p.lng}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(p); groupKeyById.set(p.id,key);
  }
  if (!map?.getSource('permits')) return;
  if(near){nearMarker??=new maplibregl.Marker({element:Object.assign(document.createElement('div'),{className:'near-pin'})});nearMarker.setLngLat([near.lng,near.lat]).addTo(map);}
  else nearMarker?.remove();
  const features=[...groups].map(([key,group])=>{
    const statuses=new Set(group.map(p=>statusKey(p.tow_status)));
    return {type:'Feature',geometry:{type:'Point',coordinates:[group[0].lng,group[0].lat]},
      properties:{key,count:group.length,status:statuses.size===1?[...statuses][0]:'mixed'}};
  });
  // Panning in address mode re-runs update(); skip redraws (which close popups) when nothing visible changed.
  const signature=features.map(f=>f.properties.key+f.properties.status+f.properties.count).join('|');
  if(signature===renderedSignature)return;
  renderedSignature=signature;
  popup?.remove();
  map.getSource('permits').setData({type:'FeatureCollection',features});
  if(!groups.has(focusKey))focusKey='';
  map.setFilter('permit-focus',['==',['get','key'],focusKey]);
}
const loadAddresses=()=>addressIndexLoad??=fetch('/data/addresses.json').then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
  .catch(error=>{addressIndexLoad=null;throw error;});
function hideSuggestions() { suggestions=[]; $('suggestions').hidden=true; $('suggestions').innerHTML=''; }
async function showSuggestions() {
  const text=$('query').value;
  if(near||!looksLikeAddress(text)){hideSuggestions();$('search-status').textContent='';return;}
  if(!addressIndex){
    $('search-status').textContent='Loading SF addresses…';
    try{addressIndex=await loadAddresses();}catch{$('search-status').textContent='Address lookup is unavailable right now. Showing permits whose details match instead.';addressIndex=null;update();fit();return;}
    if($('query').value!==text||near)return;
  }
  suggestions=suggestAddresses(addressIndex,text);
  $('search-status').textContent=suggestions.length?'':`No SF address matches “${text}”. Showing permits whose details match instead.`;
  if(!suggestions.length){update();fit();}
  $('suggestions').innerHTML=`<li class="suggestions-hint">Pick an address to see tow permits nearby</li>`+suggestions.map((a,i)=>`<li><button type="button" data-suggestion="${i}">${escape(a.address)}${a.exact?'':'<small>Closest address on file</small>'}</button></li>`).join('');
  $('suggestions').hidden=!suggestions.length;
}
function selectAddress(address) {
  near=address; $('query').value=address.address; fields.neighborhood.value='';
  hideSuggestions(); $('search-status').textContent='';
  map?.jumpTo({center:[near.lng,near.lat],zoom:addressZoom(near.lat)});
  update();
  document.querySelector('.map-col').scrollIntoView({behavior:smooth(),block:'start'});
}
function clearNear() { near=null; $('query').value=''; update(); fit(); }
function openGroup(key) {
  const group=groups.get(key); if(!group)return;
  if(group.length===1)return openDetail(group[0].id);
  const statuses=[...new Set(group.map(p=>p.tow_status))];
  const el=document.createElement('div'); el.className='map-popup';
  el.innerHTML=`<b>${escape(group[0].address)}</b><small>${number(group.length)} permits at this address · ${escape(statuses.join(' / '))}</small>`+
    group.map(p=>{const photo=photoFor(p);return `<button type="button" class="popup-permit" data-permit="${escape(p.id)}">${photo?photoMarkup(photo,'small'):''}<span><b>${escape(p.number)}</b><span class="popup-status ${statusKey(p.tow_status)}">${escape(p.tow_status)}</span>${photo?'<small>Sign photo · View details</small>':''}</span></button>`;}).join('');
  handlePhotoErrors(el);
  popup?.remove();
  popup=new maplibregl.Popup({maxWidth:'290px',focusAfterOpen:false}).setLngLat([group[0].lng,group[0].lat]).setDOMContent(el).addTo(map);
}
function fit() {
  if (!map) return;
  const bounds=new maplibregl.LngLatBounds();
  if(near)return map.easeTo({center:[near.lng,near.lat],zoom:addressZoom(near.lat)}); // moveend re-runs update()
  const points=filtered.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng));
  if(!points.length)return;
  for(const p of points)bounds.extend([p.lng,p.lat]);
  map.fitBounds(bounds,{padding:36,maxZoom:15,duration:map.loaded()?600:0});
}
function locate(p) {
  $('detail').close();
  const key=groupKeyById.get(p.id); if(!map||!key)return;
  focusKey=key; map.setFilter('permit-focus',['==',['get','key'],key]);
  $('map').scrollIntoView({behavior:smooth(),block:'center'});
  map.flyTo({center:[p.lng,p.lat],zoom:17});
}
function openDetail(id) {
  const p=permits.find(p=>p.id===id);if(!p)return;
  popup?.remove();
  const info=[['Permit number',p.number],['Permit type',p.type],['Company / permit holder',p.account||'Not provided','wide'],['Phase',p.phase],['Status',p.status],['Permit start',displayDate(p.permit_start_date)],['Permit end',displayDate(p.permit_end_date)],['Expiration',displayDate(p.expiration_date)],['Linear feet',p.linear_feet??'Not provided'],['Number of signs',p.sign_count??'Not provided']];
  const photo=photoFor(p);
  const uploaded=photo?.uploaded_at?new Date(photo.uploaded_at).toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric'}):'Date not provided';
  const gallery=photo?`<a class="photo-card" href="${escape(photoOriginalUrl(photo))}" target="_blank" rel="noopener noreferrer">${photoMarkup(photo,'large')}<span>${escape(photo.title)} ↗ · Uploaded ${escape(uploaded)}</span></a><p class="sheet-note">Most recent image upload for this permit. Contents and location are not independently verified; it may show an earlier posting. <a href="${escape(photoSource(photo))}" target="_blank" rel="noopener noreferrer">Official tow-sign submission ↗</a></p>`:`<p class="sheet-note">${metadata.photos?'No public tow-sign photo uploads found for this permit.':'Tow-sign photos have not been indexed for this snapshot.'}</p>`;
  const size=[p.neighborhood,p.linear_feet?`${number(p.linear_feet)} linear ft`:null,p.sign_count?`${number(p.sign_count)} sign${p.sign_count===1?'':'s'}`:null].filter(Boolean).join(' · ');
  $('detail-body').innerHTML=`
    <div class="sheet-section">
      <p class="sign-label">Location:</p>
      <h2 class="sheet-address" id="detail-title">${escape(p.address||'Address not provided')}</h2>
      <p class="sheet-sub">${escape(size)}</p>
    </div>
    <div class="sheet-section">
      <p class="sign-label">Date &amp; Time:</p>
      <p class="sheet-dates">${signDate(p.tow_start_date||p.start_date)} – ${signDate(p.tow_end_date||p.end_date)}</p>
      <p class="sheet-note">${escape(p.date_basis)}. Hours and weekdays printed on posted signs aren't in the public data.</p>
    </div>
    <div class="sheet-section">
      <p class="sign-label">Tow status:</p>
      <span class="stamp sheet-stamp ${statusKey(p.tow_status)}">${escape(p.tow_status||'Unknown')}</span>
      <p class="sheet-note">As reported on the public record when this snapshot was downloaded.</p>
    </div>
    <div class="sheet-section">
      <p class="sign-label">Posted sign photo:</p>
      ${gallery}
    </div>
    <div class="sheet-section">
      <p class="sign-label">Permit information:</p>
      <dl class="sheet-grid">${info.map(([label,value,wide])=>`<div${wide?' class="wide"':''}><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
      ${p.scope?`<p class="sheet-scope">${escape(p.scope)}</p>`:''}
    </div>
    <div class="sheet-foot"><a href="${escape(p.source_url)}" target="_blank" rel="noopener">Open public permit ↗</a>${groupKeyById.has(p.id)&&map?'<button type="button" id="locate">Show on map</button>':''}</div>
    <p class="sheet-fine">${escape(p.location_basis)}. Address points do not show exact curb limits. Always check the posted sign.</p>`;
  handlePhotoErrors($('detail-body'));
  $('locate')?.addEventListener('click',()=>locate(p));
  $('detail').showModal();
  $('detail').querySelector('.sign-sheet').scrollTop=0;
}
function exportFiltered() {
  if(!filtered.length)return;
  const keys=Object.keys(filtered[0]);
  // Spreadsheet-safe strings: prevent public free text from becoming formulas.
  const cell=value=>{let s=value&&typeof value==='object'?JSON.stringify(value):String(value??'');if(typeof value==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  const blob=new Blob(['﻿'+[keys.map(cell).join(','),...filtered.map(p=>keys.map(k=>cell(p[k])).join(','))].join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`no-stopping-sf-permits-${getFilters().date||'all'}-filtered.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
// Recolor OpenFreeMap's Positron style into a quiet gray base so red and black permit dots carry the color.
function restyle(style) {
  const c={land:'#f1f1ef',park:'#e3e7df',water:'#cfd8dd',building:'#e6e6e3',buildingLine:'#dbdbd7',road:'#ffffff',minor:'#ffffff',casing:'#d3d3cf',rail:'#d5d5d1',label:'#4d4d4d',halo:'#f1f1ef',waterLabel:'#5f717b'};
  style.layers=style.layers.filter(l=>!/^(aeroway|airport|highway-shield|road_shield|boundary|landcover_ice|landcover_glacier|label_country|label_state|highway-name-path)/.test(l.id));
  for(const l of style.layers){
    const paint=l.paint??={}, id=l.id;
    if(id==='background')paint['background-color']=c.land;
    else if(id==='park'||id==='landcover_wood')paint['fill-color']=c.park;
    else if(id==='landuse_residential')paint['fill-color']=c.land;
    else if(id==='water')paint['fill-color']=c.water;
    else if(id==='waterway')paint['line-color']=c.water;
    else if(id==='building'){paint['fill-color']=c.building;paint['fill-outline-color']=c.buildingLine;}
    else if(id.startsWith('road_'))l.type==='fill'?paint['fill-color']=c.land:paint['line-color']=c.land;
    else if(id.includes('dashline'))paint['line-color']=c.land;
    else if(id.startsWith('railway'))paint['line-color']=c.rail;
    else if(id.includes('casing'))paint['line-color']=c.casing;
    else if(id.includes('subtle'))paint['line-color']=c.casing;
    else if(/inner/.test(id))paint['line-color']=c.road;
    else if(/highway_minor|highway_path/.test(id)){paint['line-color']=c.minor;paint['line-opacity']=1;}
    else if(l.type==='symbol'){paint['text-color']=/water/.test(id)?c.waterLabel:c.label;paint['text-halo-color']=c.halo;paint['text-halo-width']=1.4;paint['text-halo-blur']=0;}
  }
  return style;
}
async function initMap() {
  const response=await fetch(STYLE_URL);if(!response.ok)throw new Error(`Map style failed (${response.status})`);
  map=new maplibregl.Map({container:'map',style:restyle(await response.json()),center:[-122.443,37.758],zoom:11.4,minZoom:10,maxZoom:19,
    maxBounds:[[-122.75,37.6],[-122.15,37.92]],cooperativeGestures:true,dragRotate:false,pitchWithRotate:false,touchPitch:false,attributionControl:{compact:true}});
  map.touchZoomRotate.disableRotation();map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
  map.addControl(new maplibregl.GeolocateControl({positionOptions:{enableHighAccuracy:true},fitBoundsOptions:{maxZoom:16}}),'top-right');
  let tileErrors=0;map.on('error',()=>{if(++tileErrors>=3)$('map-error').hidden=false;});
  await map.once('load');
  map.addSource('permits',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'permit-dots',type:'circle',source:'permits',
    paint:{'circle-color':['match',['get','status'],'yes',INK,'no',RED,GRAY],
      'circle-radius':['interpolate',['linear'],['zoom'],10,['+',1.6,['*',.3,['min',['get','count'],5]]],12,['+',2.6,['*',.4,['min',['get','count'],5]]],14,['+',5,['*',.6,['min',['get','count'],6]]],17,['+',9,['*',.9,['min',['get','count'],8]]]],
      'circle-stroke-color':'#ffffff','circle-stroke-width':['interpolate',['linear'],['zoom'],10,.7,14,1.6,17,2.5]}});
  map.addLayer({id:'permit-focus',type:'circle',source:'permits',filter:['==',['get','key'],''],
    paint:{'circle-radius':18,'circle-color':'rgba(0,0,0,0)','circle-stroke-color':RED,'circle-stroke-width':4}});
  // Invisible, finger-sized hit targets around each dot.
  map.addLayer({id:'permit-hit',type:'circle',source:'permits',paint:{'circle-radius':['interpolate',['linear'],['zoom'],10,8,15,15],'circle-opacity':0}});
  map.on('click','permit-hit',event=>{
    const nearest=event.features.map(f=>({f,d:map.project(f.geometry.coordinates).dist(event.point)})).sort((a,b)=>a.d-b.d)[0];
    if(nearest)openGroup(nearest.f.properties.key);
  });
  map.on('mouseenter','permit-hit',()=>{map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','permit-hit',()=>{map.getCanvas().style.cursor='';});
  new ResizeObserver(()=>map.resize()).observe($('map'));
  map.on('moveend',()=>{if(near)update();});
  if(near)map.jumpTo({center:[near.lng,near.lat],zoom:addressZoom(near.lat)});
  renderMap();if(near)update();else fit();
}
function registerTools() {
  if(!document.modelContext?.registerTool)return;
  const lifecycle=new AbortController();
  const optionsFor=key=>key==='tow'?[...form.querySelectorAll('input[name="tow"]')].map(i=>i.value):[...$(key).options].map(o=>o.value);
  const tool={name:'filter_sf_permits',title:'Filter SF permits',description:'Update the visible permit filters and return matching counts for this downloaded snapshot.',inputSchema:{type:'object',properties:{query:{type:'string'},tow:{type:'string',enum:['','Enforceable','Not Enforceable']},type:{type:'string'},neighborhood:{type:'string'},date:{type:['string','null'],description:'YYYY-MM-DD for date coverage, or null for all downloaded permits'}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:input=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected filter object');
    for(const [key,value]of Object.entries(input)){
      if(!['query','tow','type','neighborhood','date'].includes(key))throw new Error('Unknown filter');
      if(key==='date'){if(value!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value))throw new Error('Invalid date');}
      else if(typeof value!=='string')throw new Error('Filters must be strings');
      else if(key!=='query'&&!optionsFor(key).includes(value))throw new Error('Unknown filter value');
    }
    for(const [key,value]of Object.entries(input)){
      if(key==='date'){fields.when.value=value===null?'all':'date';if(value)$('date').value=value;$('date-field').hidden=value===null;}
      else fields[key].value=value;
    }
    update();return summarize(filtered);
  }};
  try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
async function init() {
  $('date').value=sfToday();
  form.addEventListener('submit',event=>event.preventDefault());
  form.addEventListener('change',event=>{
    if(event.target.name==='query')return;
    $('date-field').hidden=fields.when.value!=='date';update();
    if(!near&&(event.target.name!=='when'||fields.when.value!=='date'))fit();
  });
  let debounce;$('query').addEventListener('input',()=>{
    if(near&&$('query').value!==near.address)near=null; // editing the address leaves nearby mode
    clearTimeout(debounce);debounce=setTimeout(()=>{update();fit();showSuggestions();},150);
  });
  $('query').addEventListener('keydown',event=>{
    if(event.key==='Enter'&&suggestions.length){event.preventDefault();selectAddress(suggestions[0]);}
    else if(event.key==='ArrowDown'&&suggestions.length){event.preventDefault();$('suggestions').querySelector('button').focus();}
    else if(event.key==='Escape')hideSuggestions();
  });
  $('suggestions').addEventListener('click',event=>{const button=event.target.closest('[data-suggestion]');if(button)selectAddress(suggestions[button.dataset.suggestion]);});
  $('suggestions').addEventListener('keydown',event=>{
    const items=[...$('suggestions').querySelectorAll('button')],i=items.indexOf(document.activeElement);
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();(items[i+(event.key==='ArrowDown'?1:-1)]??$('query')).focus();}
    else if(event.key==='Escape'){hideSuggestions();$('query').focus();}
  });
  document.addEventListener('click',event=>{if(!event.target.closest('.search-wrap'))hideSuggestions();});
  $('clear-near').addEventListener('click',()=>{clearNear();$('query').focus();});
  $('hood-ranks').addEventListener('click',event=>{
    const button=event.target.closest('[data-hood]');if(!button)return;
    fields.neighborhood.value=fields.neighborhood.value===button.dataset.hood?'':button.dataset.hood;
    if(near){near=null;$('query').value='';}
    update();fit();
    if(fields.neighborhood.value)document.querySelector('.map-col').scrollIntoView({behavior:smooth(),block:'start'});
  });
  $('reset').addEventListener('click',reset);$('fit').addEventListener('click',fit);
  document.addEventListener('click',event=>{const button=event.target.closest('[data-permit]');if(button)openDetail(button.dataset.permit);});
  $('more').addEventListener('click',()=>{visible+=PAGE;renderResults();});
  $('export-filtered').addEventListener('click',exportFiltered);
  $('close-detail').addEventListener('click',()=>$('detail').close());
  $('detail').addEventListener('click',event=>{if(event.target===$('detail'))$('detail').close();});
  try {
    const response=await fetch('/data/permits.json');if(!response.ok)throw new Error(`Data download failed (${response.status})`);
    ({permits,metadata}=await response.json());
    $('snapshot-date').textContent='Snapshot · '+new Date(metadata.fetched_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})+' PT';
    $('scope-note').textContent=`${number(metadata.record_count)} unique permits downloaded; source count ${number(metadata.source_count)}. ${metadata.scope_note}`;
    $('photo-note').textContent=metadata.photos?`One submitted tow-sign photo available for each of ${number(metadata.photos.selected_image_count)} permits, selected from ${number(metadata.photos.image_count)} uploads. I choose the newest image upload from TOW sign photo submissions. Index updated ${new Date(metadata.photos.fetched_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles'})} PT. The submission links each upload to its permit’s address; image contents and location are not independently verified. Photos may show an earlier posting and do not determine Tow Status. Direct permit attachments and PDFs are excluded.`:'Tow-sign photo uploads have not been indexed for this snapshot.';
    populate('type',permits.map(p=>p.type));populate('neighborhood',permits.map(p=>p.neighborhood));
    update();registerTools();
  } catch(error){$('error').hidden=false;$('error').textContent=`Could not load the permit snapshot. ${error.message}. Run the data preparation script and reload.`;$('results').innerHTML='<div class="empty">Permit data unavailable.</div>';$('coverage-note').textContent='Data unavailable';return;}
  initMap().catch(()=>{$('map-error').hidden=false;});
}
init();
