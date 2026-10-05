import { sfToday, dateState, filterPermits, summarize } from './model.mjs';
import { photoUrl, photoSource, photoOriginalUrl } from './photos.mjs';
const $ = id => document.getElementById(id);
const number = n => n.toLocaleString('en-US');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const displayDate = date => date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'Not provided';
const colors = {'Enforceable':'#087f74','Not Enforceable':'#c74832'};
let permits = [], filtered = [], metadata, map, layer, visible = 40;
let markerById = new Map();
const badge = status => `<span class="badge ${status==='Enforceable'?'yes':status==='Not Enforceable'?'no':'unknown'}">${escape(status)}</span>`;
const photoFor = p => p.photo?.kind==='tow_sign_submission' && photoUrl(p.photo) && photoSource(p.photo) ? p.photo : null;
function photoMarkup(photo, size) {
  return `<span class="photo-frame"><img src="${escape(photoUrl(photo,size))}" alt="${escape(photo.title || 'Public permit photo')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="photo-fallback" hidden>Photo unavailable</span></span>`;
}
function handlePhotoErrors(container) {
  container.querySelectorAll('.photo-frame img').forEach(img => img.addEventListener('error',()=>{
    img.hidden=true;img.nextElementSibling.hidden=false;
  },{once:true}));
}
function getFilters() {
  return {query:$('query').value,tow:$('tow').value,type:$('type').value,neighborhood:$('neighborhood').value,
    date:$('date-mode').value==='all'?null:$('date-mode').value==='today'?sfToday():$('date').value};
}
function populate(id, values) {
  for (const value of [...new Set(values)].sort()) {
    if ([...$(id).options].some(o=>o.value===value)) continue;
    $(id).add(new Option(value, value));
  }
}
function reset() {
  HTMLFormElement.prototype.reset.call($('filters')); $('date').value=sfToday(); $('date-label').hidden=true;
  update();
}
function update() {
  if($('date-mode').value==='date'&&!$('date').value)$('date').value=sfToday();
  const filters = getFilters();
  filtered = filterPermits(permits, filters).sort((a,b)=>Boolean(!a.address)-Boolean(!b.address) || a.address.localeCompare(b.address,undefined,{numeric:true}) || a.number.localeCompare(b.number));
  const stats = summarize(filtered);
  $('total').textContent=number(stats.total); $('enforceable').textContent=number(stats.enforceable);
  $('not-enforceable').textContent=number(stats.not_enforceable);
  $('percent').textContent=stats.total ? Math.round(stats.not_enforceable/stats.total*100)+'%' : '—';
  $('ratio-red').style.width=(stats.total?stats.not_enforceable/stats.total*100:0)+'%';
  $('ratio-green').style.width=(stats.total?stats.enforceable/stats.total*100:0)+'%';
  $('ratio-unknown').style.width=(stats.total?stats.unknown/stats.total*100:0)+'%';
  $('unknown-detail').textContent=stats.unknown ? `${number(stats.unknown)} with another / unknown tow status` : 'Of the filtered permits';
  $('total-label').textContent=filters.date ? ($('date-mode').value==='today'?'Permits covering today':'Permits covering selected date') : 'All matching permits';
  $('total-detail').textContent=filters.date?displayDate(filters.date)+' · SF local date':'Full downloaded list';
  const missingDates=permits.filter(p=>dateState(p,sfToday())==='unknown').length;
  const fallbacks=filtered.filter(p=>p.date_basis!=='Tow-away dates').length;
  $('coverage-note').textContent=`${number(stats.total)} matching permits · ${number(stats.mapped)} mapped · ${number(stats.total-stats.mapped)} without an exact address match`+
    (filters.date?` · ${number(missingDates)} records with unknown dates excluded`:'')+
    (fallbacks?` · ${number(fallbacks)} use permit dates as a fallback`:'');
  $('result-count').textContent=number(stats.total);
  $('mapped-label').textContent=`${number(stats.mapped)} / ${number(stats.total)} permits mapped`;
  visible=40; renderResults(); renderMap();
}
function renderResults() {
  $('results').innerHTML=filtered.length ? filtered.slice(0,visible).map(p=>`
    <article class="permit"><div class="permit-heading"><div><button class="permit-address" data-permit="${escape(p.id)}">${escape(p.address || 'Address not provided')}</button><div class="permit-number">${escape(p.number)}</div></div>${badge(p.tow_status)}</div>
      <div class="permit-meta"><span>${escape(p.type)}</span><span>${escape(p.neighborhood)}</span></div>
      <div class="permit-meta"><span>${p.start_date?displayDate(p.start_date):'Unknown start'} – ${p.end_date?displayDate(p.end_date):'unknown end'}</span></div>
      <div class="permit-account">${escape(p.account || p.phase)}</div>${photoFor(p)?`<button class="photo-count" data-permit="${escape(p.id)}">Submitted sign photo ↗</button>`:''}${p.lat===null?'<div class="unmapped">Location not mapped · included in counts</div>':''}</article>`).join(''):
    '<div class="empty">No permits match these filters.<br>Try another date or reset the filters.</div>';
  $('more').hidden=visible>=filtered.length;
  $('more').textContent=`Show more · ${number(Math.max(0,filtered.length-visible))} remaining`;
}
function renderMap() {
  if (!map) return;
  layer.clearLayers(); markerById=new Map();
  const groups=new Map();
  for (const p of filtered) {
    if (!Number.isFinite(p.lat)||!Number.isFinite(p.lng)) continue;
    const key=`${p.lat},${p.lng}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(p);
  }
  for (const group of groups.values()) {
    const statuses=[...new Set(group.map(p=>p.tow_status))];
    const color=statuses.length===1 ? colors[statuses[0]]||'#617189' : '#617189';
    const first=group[0];
    const marker=L.circleMarker([first.lat,first.lng],{radius:group.length>1?8:5.5,color:'#fff',weight:1.2,fillColor:color,fillOpacity:.85}).addTo(layer);
    marker.bindTooltip(`<b>${escape(first.address)}</b><br>${number(group.length)} permit${group.length===1?'':'s'} · ${escape(statuses.join(' / '))}`,{direction:'top'});
    marker.bindPopup(()=>{
      // Create image elements only for an opened popup, not every map marker.
      const popup=document.createElement('div');popup.className='map-popup';
      popup.innerHTML=`<b>${escape(first.address)}</b><small>${number(group.length)} permit${group.length===1?'':'s'} at this address</small>`+
        group.map(p=>{const photo=photoFor(p);return `<button class="popup-permit" data-permit="${escape(p.id)}">${photo?photoMarkup(photo,'small'):''}<span>${escape(p.number)} ${badge(p.tow_status)}${photo?'<small>Submitted sign photo · View details</small>':''}</span></button>`;}).join('');
      popup.addEventListener('click',event=>{const button=event.target.closest('[data-permit]');if(button)openDetail(button.dataset.permit);});
      handlePhotoErrors(popup);return popup;
    },{maxHeight:300,maxWidth:300});
    for(const p of group)markerById.set(p.id,marker);
  }
}
function fit() {
  if (!map) return;
  const points=filtered.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)).map(p=>[p.lat,p.lng]);
  if(points.length)map.fitBounds(L.latLngBounds(points),{padding:[25,25],maxZoom:15});
}
function openDetail(id) {
  const p=permits.find(p=>p.id===id);if(!p)return;
  const photo=photoFor(p);
  const uploaded=photo?.uploaded_at?new Date(photo.uploaded_at).toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric'}):'Date not provided';
  const gallery=photo?`<section class="permit-photos" aria-label="Submitted tow-sign photo"><h3>Submitted tow-sign photo</h3><p>Most recent image upload for this permit. Contents and location are not independently verified; it may show an earlier posting. Tap for the original.</p><div class="photo-gallery"><div><a class="photo-card" href="${escape(photoOriginalUrl(photo))}" target="_blank" rel="noopener noreferrer">${photoMarkup(photo,'large')}<span>${escape(photo.title)} ↗ · Uploaded ${escape(uploaded)}</span></a><a class="photo-source" href="${escape(photoSource(photo))}" target="_blank" rel="noopener noreferrer">Official tow-sign submission ↗</a></div></div></section>`:`<p class="no-photos">${metadata.photos?'No public tow-sign photo uploads found for this permit.':'Tow-sign photos have not been indexed for this snapshot.'}</p>`;
  const fields=[['Permit type',p.type],['Neighborhood',p.neighborhood],['Tow-away start',displayDate(p.tow_start_date)],['Tow-away end',displayDate(p.tow_end_date)],['Phase',p.phase],['Status',p.status],['Permit start',displayDate(p.permit_start_date)],['Permit end',displayDate(p.permit_end_date)],['Expiration',displayDate(p.expiration_date)],['Company / permit holder',p.account||'Not provided'],['Linear feet',p.linear_feet??'Not provided'],['Number of signs',p.sign_count??'Not provided']];
  $('detail-body').innerHTML=`<h2>${escape(p.address||'Address not provided')}</h2><div class="detail-number">${escape(p.number)}</div>${badge(p.tow_status)}${gallery}<dl class="detail-grid">${fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${p.scope?`<p class="detail-scope">${escape(p.scope)}</p>`:''}<div class="detail-links"><a href="${escape(p.source_url)}" target="_blank" rel="noopener">Open public permit ↗</a>${markerById.has(p.id)?'<button id="locate">Show on map</button>':''}</div><p class="detail-note">${escape(p.date_basis)} · ${escape(p.location_basis)}<br>Tow Status reflects the downloaded snapshot. Address points do not show exact curb limits.</p>`;
  handlePhotoErrors($('detail-body'));
  $('detail').scrollTop=0;
  if($('locate'))$('locate').addEventListener('click',()=>{
    $('detail').close();map.setView([p.lat,p.lng],17);markerById.get(p.id)?.openPopup();
    $('map').scrollIntoView({behavior:'smooth',block:'center'});
  });
  $('detail').showModal();
}
function exportFiltered() {
  if(!filtered.length)return;
  const fields=Object.keys(filtered[0]);
  // Spreadsheet-safe strings: prevent public free text from becoming formulas.
  const cell=value=>{let s=value&&typeof value==='object'?JSON.stringify(value):String(value??'');if(typeof value==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  const blob=new Blob(['\uFEFF'+[fields.map(cell).join(','),...filtered.map(p=>fields.map(k=>cell(p[k])).join(','))].join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`sf-permits-${getFilters().date||'all'}-filtered.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function registerTools() {
  if(!document.modelContext?.registerTool)return;
  const lifecycle=new AbortController();
  const tool={name:'filter_sf_permits',title:'Filter SF permits',description:'Update the visible permit filters and return matching counts for this downloaded snapshot.',inputSchema:{type:'object',properties:{query:{type:'string'},tow:{type:'string',enum:['','Enforceable','Not Enforceable']},type:{type:'string'},neighborhood:{type:'string'},date:{type:['string','null'],description:'YYYY-MM-DD for date coverage, or null for all downloaded permits'}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:input=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected filter object');
    for(const [key,value]of Object.entries(input)){
      if(!['query','tow','type','neighborhood','date'].includes(key))throw new Error('Unknown filter');
      if(key==='date'){if(value!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value))throw new Error('Invalid date');}
      else if(typeof value!=='string')throw new Error('Filters must be strings');
      else if(key!=='query'&&![...$(key).options].some(o=>o.value===value))throw new Error('Unknown filter value');
    }
    for(const [key,value]of Object.entries(input)){
      if(key==='date'){$('date-mode').value=value===null?'all':'date';if(value)$('date').value=value;$('date-label').hidden=value===null;}
      else $(key).value=value;
    }
    update();return summarize(filtered);
  }};
  try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
async function init() {
  $('date').value=sfToday();
  $('filters').addEventListener('submit',event=>event.preventDefault());
  $('filters').addEventListener('change',()=>{$('date-label').hidden=$('date-mode').value!=='date';update();});
  let debounce;$('query').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(update,120);});
  $('reset').addEventListener('click',reset);$('fit').addEventListener('click',fit);
  $('results').addEventListener('click',event=>{const button=event.target.closest('[data-permit]');if(button)openDetail(button.dataset.permit);});
  $('more').addEventListener('click',()=>{visible+=40;renderResults();});
  $('export-filtered').addEventListener('click',exportFiltered);
  $('close-detail').addEventListener('click',()=>$('detail').close());
  $('detail').addEventListener('click',event=>{if(event.target===$('detail')){const rect=$('detail').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('detail').close();}});
  try {
    const response=await fetch('/data/permits.json');if(!response.ok)throw new Error(`Data download failed (${response.status})`);
    ({permits,metadata}=await response.json());
    $('snapshot-date').textContent='Snapshot · '+new Date(metadata.fetched_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' PT';
    $('scope-note').textContent=`${number(metadata.record_count)} unique permits downloaded; source count ${number(metadata.source_count)}. ${metadata.scope_note}`;
    $('photo-note').textContent=metadata.photos?`One submitted tow-sign photo available for each of ${number(metadata.photos.selected_image_count)} permits, selected from ${number(metadata.photos.image_count)} uploads. We choose the newest image upload from TOW sign photo submissions. Index updated ${new Date(metadata.photos.fetched_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles'})} PT. The submission links each upload to its permit’s address; image contents and location are not independently verified. Photos may show an earlier posting and do not determine Tow Status. Direct permit attachments and PDFs are excluded.`:'Tow-sign photo uploads have not been indexed for this snapshot.';
    populate('type',permits.map(p=>p.type));populate('neighborhood',permits.map(p=>p.neighborhood));populate('tow',permits.map(p=>p.tow_status));
    if(window.L){
      map=L.map('map',{preferCanvas:true,scrollWheelZoom:false,tapHold:true}).setView([37.763,-122.443],12);
      const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',maxZoom:19}).addTo(map);
      let failures=0;tiles.on('tileerror',()=>{if(++failures>=3)$('map-error').hidden=false;});tiles.on('load',()=>{if(failures===0)$('map-error').hidden=true;});
      layer=L.layerGroup().addTo(map);new ResizeObserver(()=>map.invalidateSize()).observe($('map'));
    }else{$('map-error').hidden=false;$('map-error').textContent='Map library could not load. All permits remain available in the list.';}
    update();fit();registerTools();
  } catch(error){$('error').hidden=false;$('error').textContent=`Could not load the permit snapshot. ${error.message}. Run the data preparation script and reload.`;$('results').innerHTML='<div class="empty">Permit data unavailable.</div>';$('coverage-note').textContent='Data unavailable';}
}
init();
