(() => {
'use strict';
const CFG = window.APP_CONFIG || {};
const DEFAULT_CFG = {rate:108, feePct:10, domShip:750, capital:0, goalProfit:0, goalSales:0};
const BUCKET = 'photos';
const CACHE_KEY = 'shiire.cache.v1';
const S = {items:[], comps:[], cfg:{...DEFAULT_CFG}, sb:null, user:null, loaded:false, filter:'all', q:'', view:'list',
  editing:null, compEditing:null, formPhotos:[], newUploads:[], removed:[], uploading:0, urls:{}};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const yen = v => (v < 0 ? '−¥' : '¥') + Math.round(Math.abs(v)).toLocaleString('ja-JP');
const cad = v => 'CA$' + (Math.round(v*100)/100).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = v => isFinite(v) ? (Math.round(v*1000)/10) + '%' : '—';
const today = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const monthKey = d => (d||'').slice(0,7);
const STATUS = {stock:'在庫', listed:'出品中', sold:'売却済'};

function toast(msg){ const t=$('toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,2400); }
function banner(msg){ const b=$('statusBanner'); b.textContent=msg||''; b.hidden=!msg; }

/* ---------- money ---------- */
function calc(it){
  const cfg = S.cfg;
  const rate = n(it.rate) || n(cfg.rate);
  const cost = n(it.costCAD)*rate + n(it.intlJPY) + n(it.dutyJPY) + n(it.otherJPY);
  const fee = (it.feePct === '' || it.feePct == null) ? n(cfg.feePct) : n(it.feePct);
  const dom = (it.domJPY === '' || it.domJPY == null) ? n(cfg.domShip) : n(it.domJPY);
  const price = it.status === 'sold' ? n(it.soldPrice) : n(it.listPrice);
  const net = price ? price - price*fee/100 - dom : 0;
  const profit = price ? net - cost : null;
  return {rate, cost, fee, dom, price, net, profit, margin: price && profit!=null ? profit/price : NaN, roi: cost ? (profit ?? 0)/cost : NaN, sold: it.status==='sold' && price>0};
}

/* ---------- comps ---------- */
function parsePrices(text){
  const out=[]; (String(text||'').match(/\d[\d,，]*/g)||[]).forEach(m=>{ const v=parseInt(m.replace(/[,，]/g,''),10); if(v>=300 && v<=5000000) out.push(v); });
  return out;
}
function stats(arr){
  if(!arr.length) return null;
  const a=[...arr].sort((x,y)=>x-y), m=Math.floor(a.length/2);
  const med = a.length%2 ? a[m] : (a[m-1]+a[m])/2;
  return {n:a.length, min:a[0], max:a[a.length-1], med, avg:a.reduce((s,v)=>s+v,0)/a.length};
}
const norm = s => String(s||'').toLowerCase().replace(/\s+/g,'');
function findComp(it){
  return S.comps.find(c => norm(c.brand)===norm(it.brand) && (!c.color || norm(c.color)===norm(it.color)) && (!c.size || norm(c.size)===norm(it.size)) && (!c.model || norm(it.name).includes(norm(c.model))));
}
function mercariUrl(kw, sold){ return 'https://jp.mercari.com/search?keyword=' + encodeURIComponent(kw) + (sold ? '&status=sold_out' : '&status=on_sale'); }
const kwOf = (b,m,c,s) => [b,m,c,s].map(x=>String(x||'').trim()).filter(Boolean).join(' ');

/* ---------- data layer (Supabase) ---------- */
async function loadAll(){
  const [it, cp, cf] = await Promise.all([
    S.sb.from('items').select('id,data').order('created_at',{ascending:false}),
    S.sb.from('comps').select('id,data'),
    S.sb.from('settings').select('data').maybeSingle(),
  ]);
  const err = it.error || cp.error || cf.error;
  if(err) throw err;
  S.items = it.data.map(r=>({id:r.id, ...r.data}));
  S.comps = cp.data.map(r=>({id:r.id, ...r.data}));
  S.cfg = {...DEFAULT_CFG, ...((cf.data && cf.data.data) || {})};
  S.loaded = true;
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify({items:S.items, comps:S.comps, cfg:S.cfg, at:Date.now()})); }catch{}
  await signPhotos(S.items.flatMap(i=>i.photos||[]));
}
async function refresh(quiet){
  try{ await loadAll(); banner(''); }
  catch(e){ if(!quiet) banner(navigator.onLine ? 'データを読み込めませんでした。少し待ってから開き直してください。' : 'オフラインです。前回読み込んだ内容を表示しています（保存はできません）。'); }
  fillPrefs(); renderAll();
}
function loadCache(){
  try{ const c=JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); if(c){ S.items=c.items||[]; S.comps=c.comps||[]; S.cfg={...DEFAULT_CFG,...(c.cfg||{})}; } }catch{}
}
const strip = o => { const {id, ...rest} = o; return rest; };
async function upsertRow(table, obj){
  if(obj.id){ const {error}=await S.sb.from(table).update({data:strip(obj), updated_at:new Date().toISOString()}).eq('id',obj.id); if(error) throw error; }
  else { const {error}=await S.sb.from(table).insert({data:strip(obj)}); if(error) throw error; }
}
async function deleteRow(table, id){ const {error}=await S.sb.from(table).delete().eq('id',id); if(error) throw error; }

/* ---------- photos ---------- */
const photoSrc = path => S.urls[path] || '';
async function signPhotos(paths){
  const need=[...new Set(paths)].filter(p=>p && !S.urls[p]);
  if(!need.length) return;
  for(let i=0;i<need.length;i+=100){
    const {data,error}=await S.sb.storage.from(BUCKET).createSignedUrls(need.slice(i,i+100), 60*60*24*7);
    if(!error && data) data.forEach(d=>{ if(d.signedUrl) S.urls[d.path]=d.signedUrl; });
  }
}
async function shrink(file){
  try{
    const bmp = await createImageBitmap(file, {imageOrientation:'from-image'});
    const sc = Math.min(1, 1600/Math.max(bmp.width,bmp.height));
    const c=document.createElement('canvas'); c.width=Math.round(bmp.width*sc); c.height=Math.round(bmp.height*sc);
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    const blob = await new Promise(r=>c.toBlob(r,'image/jpeg',0.82));
    if(blob) return blob;
  }catch{}
  return file;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2));
async function addPhotos(files){
  const list=[...files]; S.uploading+=list.length; renderPhotos();
  for(const f of list){
    try{
      const blob = await shrink(f);
      const path = `${S.user.id}/${uid()}.jpg`;
      const {error} = await S.sb.storage.from(BUCKET).upload(path, blob, {contentType: blob.type || 'image/jpeg', upsert:false});
      if(error) throw error;
      S.urls[path] = URL.createObjectURL(blob);
      S.formPhotos.push(path); S.newUploads.push(path);
    }catch(e){ toast('写真をアップロードできませんでした'); }
    S.uploading--; renderPhotos();
  }
}
function removeFiles(paths){ if(paths.length) S.sb.storage.from(BUCKET).remove(paths).catch(()=>{}); }
function removePhoto(path){
  S.formPhotos=S.formPhotos.filter(x=>x!==path);
  if(S.newUploads.includes(path)){ S.newUploads=S.newUploads.filter(x=>x!==path); removeFiles([path]); }
  else S.removed.push(path);
  renderPhotos();
}
function renderPhotos(){
  $('i_photos').innerHTML = S.formPhotos.map(p=>`<div class="p"><img src="${esc(photoSrc(p))}" alt="商品写真" data-full="${esc(p)}"><button type="button" class="x" data-rm="${esc(p)}" aria-label="この写真を外す">✕</button></div>`).join('')
    + `<label class="addph" for="i_file">＋<br>写真を追加</label>`;
  $('phNote').textContent = S.uploading ? `アップロード中…（${S.uploading}枚）` : (S.formPhotos.length ? '1枚目が一覧の表紙になります' : 'カメラで撮るか、写真を選んでください');
}

/* ---------- routing ---------- */
const VIEWS=['dashboard','items','market','prefs'];
function route(){
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  document.querySelectorAll('[data-panel]').forEach(p=>p.hidden = p.dataset.panel!==v);
  document.querySelectorAll('.tabbar a').forEach(a=>a.setAttribute('aria-current', a.dataset.view===v ? 'page' : 'false'));
  window.scrollTo(0,0);
}
window.addEventListener('hashchange', route);

/* ---------- render ---------- */
function renderAll(){ renderHeader(); renderDashboard(); renderItems(); renderComps(); renderMarketCalc(); renderBrandList(); }
function renderHeader(){ $('rateLabel').textContent = '1 CAD = ' + n(S.cfg.rate).toFixed(2) + ' 円'; }
function renderBrandList(){ $('brands').innerHTML=[...new Set(S.items.map(i=>i.brand).filter(Boolean))].map(b=>`<option>${esc(b)}</option>`).join(''); }

function renderDashboard(){
  const cfg=S.cfg, now=monthKey(today());
  $('monthLabel').textContent = now.replace('-','年') + '月の利益';
  let mProfit=0, mSales=0, totalCost=0, soldNet=0, soldProfit=0, soldCost=0, stockCost=0, stockN=0, soldN=0, listedProj=0;
  for(const it of S.items){
    const c=calc(it); totalCost+=c.cost;
    if(c.sold){ soldN++; soldNet+=c.net; soldProfit+=c.profit; soldCost+=c.cost;
      if(monthKey(it.soldDate)===now){ mProfit+=c.profit; mSales+=c.price; } }
    else { stockN++; stockCost+=c.cost; if(it.status==='listed' && c.profit!=null) listedProj+=c.profit; }
  }
  const goal=(val,g,big,sub,bar)=>{
    $(big).textContent=yen(val); $(big).className='big num ' + (val<0?'neg':'');
    const b=$(bar);
    if(n(g)>0){ const r=val/n(g); $(sub).textContent=`目標 ${yen(g)} ・ 達成率 ${pct(r)}${r<1?` ・ あと ${yen(n(g)-val)}`:''}`; b.firstChild.style.width=Math.max(0,Math.min(100,r*100))+'%'; b.classList.toggle('over',r>=1); }
    else { $(sub).textContent='目標は「設定」で決められます'; b.firstChild.style.width='0'; }
  };
  goal(mProfit,cfg.goalProfit,'gProfit','gProfitSub','gProfitBar');
  goal(mSales,cfg.goalSales,'gSales','gSalesSub','gSalesBar');
  const capital=n(cfg.capital), cash = capital - totalCost + soldNet;
  const k=[
    ['投資額', capital?yen(capital):'未設定', ''],
    ['手元資金の目安', capital?yen(cash):'—', '投資額 − 仕入れ総額 + 売上入金'],
    ['仕入れ総額', yen(totalCost), `${S.items.length}点・送料関税込み`],
    ['純利益（累計）', yen(soldProfit), `${soldN}点売却`, soldProfit<0?'neg':'pos'],
    ['回収率', totalCost?pct(soldNet/totalCost):'—', '入金額 ÷ 仕入れ総額'],
    ['平均ROI', soldCost?pct(soldProfit/soldCost):'—', '売却済み利益 ÷ 原価'],
    ['在庫の原価', yen(stockCost), `${stockN}点（在庫・出品中）`],
    ['出品中の見込み利益', yen(listedProj), '出品価格で売れた場合', listedProj<0?'neg':''],
  ];
  $('kpis').innerHTML = k.map(([l,v,s,cls])=>`<div class="kpi"><small>${esc(l)}</small><b class="${cls||''}">${esc(v)}</b><small>${esc(s)}</small></div>`).join('');
  renderChart(); renderBrands();
}

function renderChart(){
  const months=[]; const d=new Date(); d.setDate(1);
  for(let i=5;i>=0;i--){ const x=new Date(d.getFullYear(), d.getMonth()-i, 1); months.push(x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')); }
  const vals=months.map(m=>S.items.reduce((s,it)=>{const c=calc(it); return c.sold && monthKey(it.soldDate)===m ? s+c.profit : s;},0));
  const goal=n(S.cfg.goalProfit);
  const W=640,H=220,L=64,R=12,T=14,B=30, iw=W-L-R, ih=H-T-B;
  let max=Math.max(goal, ...vals, 0), min=Math.min(0,...vals);
  if(max===min) max=min+10000;
  const step=niceStep((max-min)/4); max=Math.ceil(max/step)*step; min=Math.floor(min/step)*step;
  const y=v=>T+ih-(v-min)/(max-min)*ih, bw=iw/months.length;
  let g='';
  for(let v=min; v<=max+1e-6; v+=step){ g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--f-num)">${v>=10000||v<=-10000?(v/10000)+'万':v.toLocaleString()}</text>`; }
  vals.forEach((v,i)=>{ const x=L+i*bw+bw*.2, w=bw*.6, y0=y(0), y1=y(v), cur=i===vals.length-1;
    g+=`<rect x="${x}" y="${Math.min(y0,y1)}" width="${w}" height="${Math.max(1,Math.abs(y1-y0))}" rx="3" fill="${v<0?'var(--bad)':'var(--accent)'}" opacity="${cur?1:.55}"/>`;
    g+=`<text x="${x+w/2}" y="${H-10}" text-anchor="middle" font-size="11" fill="var(--muted)">${+months[i].slice(5)}月</text>`;
    if(v) g+=`<text x="${x+w/2}" y="${(v<0?Math.max(y0,y1)+13:Math.min(y0,y1)-5)}" text-anchor="middle" font-size="10" fill="var(--ink)" font-family="var(--f-num)">${Math.round(v/1000)}k</text>`;
  });
  if(goal>0) g+=`<line x1="${L}" x2="${W-R}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--tag)" stroke-width="2" stroke-dasharray="5 4"/><text x="${W-R}" y="${y(goal)-5}" text-anchor="end" font-size="11" fill="var(--warn)">目標</text>`;
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="月別純利益">${g}</svg>`;
}
function niceStep(raw){ if(raw<=0) return 1000; const p=Math.pow(10,Math.floor(Math.log10(raw))); const f=raw/p; return (f<=1?1:f<=2?2:f<=5?5:10)*p; }

function renderBrands(){
  const m={};
  for(const it of S.items){ const c=calc(it); if(!c.sold) continue; const k=it.brand||'（未入力）'; const r=m[k]||(m[k]={n:0,profit:0,sales:0,cost:0}); r.n++; r.profit+=c.profit; r.sales+=c.price; r.cost+=c.cost; }
  const rows=Object.entries(m).sort((a,b)=>b[1].profit-a[1].profit);
  $('brandTable').innerHTML = rows.length ? `<table><thead><tr><th>ブランド</th><th class="r">点数</th><th class="r">純利益</th><th class="r">1点平均</th><th class="r">利益率</th><th class="r">ROI</th></tr></thead><tbody>${
    rows.map(([b,r])=>`<tr><td>${esc(b)}</td><td class="r num">${r.n}</td><td class="r num ${r.profit<0?'neg':''}">${yen(r.profit)}</td><td class="r num">${yen(r.profit/r.n)}</td><td class="r num">${pct(r.profit/r.sales)}</td><td class="r num">${pct(r.profit/r.cost)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">売却済みの商品が入ると、どのブランドが儲かるかがここに並びます。</div>';
}

function renderItems(){
  const q=norm(S.q);
  const list=S.items.filter(it => (S.filter==='all'||it.status===S.filter) && (!q || norm([it.brand,it.name,it.color,it.size,it.category,it.notes].join(' ')).includes(q)))
    .sort((a,b)=>(b.soldDate||b.buyDate||'').localeCompare(a.soldDate||a.buyDate||''));
  const counts={stock:0,listed:0,sold:0}; S.items.forEach(i=>counts[i.status]=(counts[i.status]||0)+1);
  $('itemsSummary').textContent = `在庫 ${counts.stock}点 ・ 出品中 ${counts.listed}点 ・ 売却済 ${counts.sold}点`;
  const box=$('itemList');
  if(!S.loaded && !S.items.length){ box.className='list'; box.innerHTML='<div class="empty">読み込み中…</div>'; return; }
  if(!list.length){ box.className='list'; box.innerHTML = S.items.length ? '<div class="empty">条件に合う商品がありません。</div>' : '<div class="empty">まだ商品がありません。右下の「＋」から最初の1点を記録しましょう。</div>'; return; }
  if(S.view==='grid'){
    box.className='gallery';
    box.innerHTML = list.map(it=>{
      const c=calc(it), ph=(it.photos||[])[0];
      const price = c.price ? `${c.sold?'売値':'出品'} ${yen(c.price)}` : `原価 ${yen(c.cost)}`;
      return `<button class="gcard" type="button" data-id="${esc(it.id)}">
        <div class="img">${ph&&photoSrc(ph)?`<img src="${esc(photoSrc(ph))}" alt="${esc(it.brand+' '+it.name)}" loading="lazy">`:'写真なし'}<span class="chip ${esc(it.status)}">${STATUS[it.status]||''}</span></div>
        <div class="cap"><b>${esc(it.brand)} ${esc(it.name)}</b><span>${esc([it.color,it.size].filter(Boolean).join(' / '))}</span><span class="num">${price}${c.profit!=null?` ・ <span class="${c.profit<0?'neg':'pos'}">${yen(c.profit)}</span>`:''}</span></div>
      </button>`;
    }).join('');
    return;
  }
  box.className='list';
  box.innerHTML = list.map(it=>{
    const c=calc(it), comp=findComp(it), cs=comp?stats(comp.prices||[]):null;
    const label = c.sold ? '純利益' : (c.profit!=null ? '見込み利益' : '原価');
    const val = c.profit!=null ? yen(c.profit) : yen(c.cost);
    const cls = c.profit==null ? '' : (c.profit<0?'neg':'pos');
    const meta=[it.color,it.size,it.condition].filter(Boolean).join(' / ');
    const ph=(it.photos||[])[0], src=ph&&photoSrc(ph);
    return `<button class="item${src?' has-ph':''}" type="button" data-id="${esc(it.id)}">
      ${src?`<img class="ph" src="${esc(src)}" alt="" loading="lazy">`:''}
      <div class="t"><span class="chip ${esc(it.status)}">${STATUS[it.status]||''}</span>${esc(it.brand)} ${esc(it.name)}</div>
      <div class="meta">${esc(meta)}${meta?' ・ ':''}<span class="num">${cad(n(it.costCAD))}</span> → 原価 <span class="num">${yen(c.cost)}</span>${c.price?` ・ ${c.sold?'売値':'出品'} <span class="num">${yen(c.price)}</span>`:''}${cs?` ・ 相場 <span class="num">${yen(cs.med)}</span>`:''}</div>
      <div class="money"><small>${label}</small><b class="${cls}">${val}</b>${c.profit!=null?`<small>${pct(c.margin)}</small>`:''}</div>
    </button>`;
  }).join('');
}

function renderComps(){
  if(!S.loaded && !S.comps.length){ $('compTable').innerHTML='<div class="empty">読み込み中…</div>'; return; }
  if(!S.comps.length){ $('compTable').innerHTML='<div class="empty">まだ保存した相場がありません。上で価格を貼り付けて「相場として保存」を押すと、色・サイズ別にここへ貯まります。</div>'; return; }
  const rows=[...S.comps].sort((a,b)=>kwOf(a.brand,a.model).localeCompare(kwOf(b.brand,b.model),'ja') || String(a.color).localeCompare(String(b.color),'ja') || String(a.size).localeCompare(String(b.size)));
  $('compTable').innerHTML = `<table><thead><tr><th>ブランド・モデル</th><th>色・柄</th><th>サイズ</th><th class="r">中央値</th><th class="r">最安</th><th class="r">最高</th><th class="r">件数</th><th>更新日</th><th></th></tr></thead><tbody>${
    rows.map(c=>{ const s=stats(c.prices||[])||{}; return `<tr>
      <td>${esc(kwOf(c.brand,c.model))}</td><td>${esc(c.color)}</td><td>${esc(c.size)}</td>
      <td class="r num"><b>${s.med!=null?yen(s.med):'—'}</b></td><td class="r num">${s.min!=null?yen(s.min):'—'}</td><td class="r num">${s.max!=null?yen(s.max):'—'}</td><td class="r num">${s.n||0}</td>
      <td class="num">${esc(c.updated||'')}</td>
      <td><div class="row" style="flex-wrap:nowrap"><a class="btn small" href="${esc(mercariUrl(c.keyword||kwOf(c.brand,c.model,c.color,c.size),true))}" target="_blank" rel="noopener">メルカリ ↗</a><button class="btn small" type="button" data-comp-edit="${esc(c.id)}">追加・編集</button><button class="btn small danger" type="button" data-comp-del="${esc(c.id)}">削除</button></div></td></tr>`; }).join('')}</tbody></table>`;
}

/* ---------- market form ---------- */
let kwTouched=false;
function marketInputs(){ return {brand:$('m_brand').value.trim(), model:$('m_model').value.trim(), color:$('m_color').value.trim(), size:$('m_size').value.trim()}; }
function updateMarketLinks(){
  const m=marketInputs();
  if(!kwTouched) $('m_kw').value = kwOf(m.brand,m.model,m.color,m.size);
  const kw=$('m_kw').value.trim();
  $('m_sold').href = kw ? mercariUrl(kw,true) : 'https://jp.mercari.com/';
  $('m_sale').href = kw ? mercariUrl(kw,false) : 'https://jp.mercari.com/';
}
function renderMarketStats(){
  const s=stats(parsePrices($('m_prices').value));
  $('m_stats').innerHTML = s ? [['中央値',s.med,1],['平均',s.avg],['最安',s.min],['最高',s.max]].map(([l,v,hi])=>`<div class="stat ${hi?'hi':''}"><small>${l}</small><b>${yen(v)}</b></div>`).join('') + `<div class="stat"><small>件数</small><b>${s.n}</b></div>`
    : '<div class="sub">価格を貼り付けると、中央値・平均・最安・最高が出ます。</div>';
  if(s && !$('b_price').dataset.touched) $('b_price').value = Math.round(s.med);
  renderMarketCalc();
}
function renderMarketCalc(){
  const P=n($('b_price').value), m=n($('b_margin').value)/100, ship=n($('b_ship').value);
  const dom = $('b_dom').value==='' ? n(S.cfg.domShip) : n($('b_dom').value);
  $('b_dom').placeholder = String(n(S.cfg.domShip));
  if(!P){ $('b_out').textContent='—'; $('b_outjpy').textContent=''; return; }
  const maxJPY = P - P*n(S.cfg.feePct)/100 - dom - ship - P*m;
  const rate=n(S.cfg.rate)||1;
  $('b_out').textContent = maxJPY>0 ? cad(maxJPY/rate) : '利益が出ません';
  $('b_out').className = maxJPY>0 ? '' : 'neg';
  $('b_outjpy').textContent = maxJPY>0 ? `（${yen(maxJPY)}）` : '';
}
function resetMarket(){
  ['m_brand','m_model','m_color','m_size','m_kw','m_prices'].forEach(id=>$(id).value='');
  kwTouched=false; S.compEditing=null; $('m_editing').textContent=''; delete $('b_price').dataset.touched; $('b_price').value='';
  updateMarketLinks(); renderMarketStats();
}
async function saveComp(){
  const m=marketInputs(), prices=parsePrices($('m_prices').value);
  if(!m.brand && !m.model) return toast('ブランドかモデルを入れてください');
  if(!prices.length) return toast('売却価格を貼り付けてください');
  const existing = S.compEditing ? S.comps.find(c=>c.id===S.compEditing) : S.comps.find(c=>norm(c.brand)===norm(m.brand)&&norm(c.model)===norm(m.model)&&norm(c.color)===norm(m.color)&&norm(c.size)===norm(m.size));
  try{
    await upsertRow('comps', {id: existing && existing.id, ...m, keyword:$('m_kw').value.trim(), prices, updated:today()});
    toast(existing ? '相場を更新しました' : '相場を保存しました');
    S.compEditing=null; $('m_editing').textContent='';
    await refresh(true);
  }catch{ toast('保存できませんでした。通信状態を確認してください'); }
}
function editComp(id){
  const c=S.comps.find(x=>x.id===id); if(!c) return;
  $('m_brand').value=c.brand||''; $('m_model').value=c.model||''; $('m_color').value=c.color||''; $('m_size').value=c.size||'';
  $('m_kw').value=c.keyword||''; kwTouched=!!c.keyword;
  $('m_prices').value=(c.prices||[]).map(v=>'¥'+v.toLocaleString('ja-JP')).join('  ');
  S.compEditing=id; $('m_editing').textContent='保存済みの相場を編集中。新しい価格を書き足して保存できます。';
  delete $('b_price').dataset.touched; updateMarketLinks(); renderMarketStats();
  window.scrollTo({top:0,behavior:'smooth'});
}

/* ---------- item sheet ---------- */
const F = ['brand','name','category','color','size','condition','status','buyDate','costCAD','rate','intl','duty','other','listPrice','soldPrice','soldDate','dom','fee','notes'];
const MAP = {intl:'intlJPY', duty:'dutyJPY', other:'otherJPY', dom:'domJPY', fee:'feePct'};
function readForm(){
  const o={}; for(const f of F){ o[MAP[f]||f]=$('i_'+f).value.trim(); }
  ['costCAD','rate','intlJPY','dutyJPY','otherJPY','listPrice','soldPrice','domJPY','feePct'].forEach(k=>{ o[k] = o[k]==='' ? '' : n(o[k]); });
  return o;
}
function openSheet(it){
  S.editing = it ? it.id : null;
  $('sheetTitle').textContent = it ? `${it.brand||''} ${it.name||''}`.trim() || '商品を編集' : '仕入れを追加';
  const src = it || {status:'stock', buyDate:today(), rate:S.cfg.rate, condition:'目立った傷や汚れなし'};
  for(const f of F){ const v=src[MAP[f]||f]; $('i_'+f).value = v==null ? '' : v; }
  $('delItem').hidden=!it; $('delItem').classList.remove('armed'); $('delItem').textContent='削除';
  S.formPhotos=[...((it&&it.photos)||[])]; S.newUploads=[]; S.removed=[]; renderPhotos();
  $('sheet').hidden=false; document.body.style.overflow='hidden'; updateCalc();
}
function closeSheet(saved){
  if(saved!==true) removeFiles(S.newUploads);
  S.newUploads=[]; S.removed=[]; $('sheet').hidden=true; document.body.style.overflow=''; S.editing=null;
}
function updateCalc(){
  const it=readForm(); $('i_fee').placeholder=String(S.cfg.feePct); $('i_dom').placeholder=String(S.cfg.domShip);
  const c=calc(it);
  const cells=[['原価（円）',yen(c.cost)],[it.status==='sold'?'売値':'出品価格',c.price?yen(c.price):'—'],['手数料+国内送料',c.price?yen(c.price*c.fee/100+c.dom):'—'],[it.status==='sold'?'純利益':'見込み利益',c.profit!=null?yen(c.profit):'—',c.profit<0?'neg':'pos'],['利益率',c.profit!=null?pct(c.margin):'—'],['ROI',c.profit!=null?pct(c.roi):'—']];
  $('i_calc').innerHTML=cells.map(([l,v,cls])=>`<div><small>${l}</small><b class="${c.profit!=null?cls||'':''}">${v}</b></div>`).join('');
  const comp=findComp(it), s=comp?stats(comp.prices||[]):null, kw=kwOf(it.brand,it.name,it.color,it.size);
  $('i_compRow').innerHTML = (s?`<span class="sub">保存した相場：中央値 <b class="num">${yen(s.med)}</b>（${s.n}件・${esc(comp.updated||'')}）</span>`:'') +
    (kw?`<a class="btn small" href="${esc(mercariUrl(kw,true))}" target="_blank" rel="noopener">この条件でメルカリの売り切れを見る ↗</a>`:'');
}
async function saveItem(e){
  e.preventDefault();
  if(S.uploading) return toast('写真のアップロードが終わるまでお待ちください');
  const it=readForm(); it.photos=[...S.formPhotos];
  if(it.status==='sold' && !it.soldDate) it.soldDate=today();
  const btn=$('saveItemBtn'); btn.disabled=true;
  try{
    await upsertRow('items', {id:S.editing, ...it});
    const gone=[...S.removed];
    closeSheet(true); toast('保存しました'); removeFiles(gone);
    await refresh(true);
  }catch{ toast('保存できませんでした。通信状態を確認してください'); }
  btn.disabled=false;
}
async function deleteItem(){
  const b=$('delItem');
  if(!b.classList.contains('armed')){ b.classList.add('armed'); b.textContent='もう一度押すと削除'; return; }
  try{
    const it=S.items.find(i=>i.id===S.editing); const paths=[...new Set([...((it&&it.photos)||[]), ...S.formPhotos])];
    await deleteRow('items', S.editing); closeSheet(); removeFiles(paths); toast('削除しました');
    await refresh(true);
  }catch{ toast('削除できませんでした'); }
}

/* ---------- prefs ---------- */
function fillPrefs(){
  const c=S.cfg; $('p_capital').value=c.capital||''; $('p_goalProfit').value=c.goalProfit||''; $('p_goalSales').value=c.goalSales||'';
  $('p_rate').value=c.rate; $('p_fee').value=c.feePct; $('p_dom').value=c.domShip;
}
async function savePrefs(e){
  e.preventDefault();
  const cfg={capital:n($('p_capital').value), goalProfit:n($('p_goalProfit').value), goalSales:n($('p_goalSales').value), rate:n($('p_rate').value)||DEFAULT_CFG.rate, feePct:$('p_fee').value===''?DEFAULT_CFG.feePct:n($('p_fee').value), domShip:n($('p_dom').value)};
  try{
    const {error}=await S.sb.from('settings').upsert({user_id:S.user.id, data:cfg, updated_at:new Date().toISOString()});
    if(error) throw error;
    toast('設定を保存しました'); await refresh(true);
  }catch{ toast('保存できませんでした'); }
}
async function fetchRate(){
  $('rateNote').textContent='取得中…';
  try{
    const r=await fetch('https://api.frankfurter.app/latest?from=CAD&to=JPY'); const j=await r.json();
    const v=j && j.rates && j.rates.JPY; if(!v) throw 0;
    $('p_rate').value=(Math.round(v*100)/100).toFixed(2);
    $('rateNote').textContent=`${j.date} 時点の欧州中央銀行の参考レートです。「保存」で反映されます。`;
  }catch{ $('rateNote').textContent='取得できませんでした。手で入力してください。'; }
}
function exportData(){
  const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(), items:S.items, comps:S.comps, settings:S.cfg},null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`shiire-backup-${today()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),5000);
}
async function importData(file){
  const note=$('importNote'); note.textContent='読み込み中…';
  try{
    const j=JSON.parse(await file.text());
    const items=(j.items||[]).filter(x=>!x.sample), comps=(j.comps||[]).filter(x=>!x.sample);
    const clean=x=>{ const {id,sample,...rest}=x; return {data:{...rest, photos:(rest.photos||[]).filter(p=>String(p).includes('/'))}}; };
    if(items.length){ const {error}=await S.sb.from('items').insert(items.map(clean)); if(error) throw error; }
    if(comps.length){ const {error}=await S.sb.from('comps').insert(comps.map(clean)); if(error) throw error; }
    if(j.settings && !S.items.length){ await S.sb.from('settings').upsert({user_id:S.user.id, data:{...DEFAULT_CFG, ...j.settings}}); }
    note.textContent=`商品 ${items.length}点・相場 ${comps.length}件を読み込みました。`;
    await refresh(true);
  }catch{ note.textContent='読み込めませんでした。このアプリで書き出したファイルか確認してください。'; }
}

/* ---------- auth ---------- */
function showApp(){ $('auth').hidden=true; $('app').hidden=false; $('whoami').textContent = `ログイン中：${S.user.email||''}`; route(); }
function showAuth(msg){ $('app').hidden=true; $('auth').hidden=false; $('a_msg').textContent=msg||''; }
async function doLogin(e){
  e.preventDefault();
  const email=$('a_email').value.trim(), password=$('a_pass').value;
  $('a_msg').textContent='ログイン中…';
  const {error}=await S.sb.auth.signInWithPassword({email,password});
  if(error) $('a_msg').textContent = /confirm/i.test(error.message) ? '確認メールのリンクをまだ押していないようです。メールを確認してください。' : 'メールアドレスかパスワードが違います。';
}
async function doSignup(){
  const email=$('a_email').value.trim(), password=$('a_pass').value;
  if(!email || password.length<6){ $('a_msg').textContent='メールアドレスと6文字以上のパスワードを入れてから押してください。'; return; }
  $('a_msg').textContent='作成中…';
  const {data,error}=await S.sb.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}});
  if(error){ $('a_msg').textContent = /not allowed|disabled/i.test(error.message) ? '新しいアカウントの作成は止められています。' : 'アカウントを作れませんでした：'+error.message; return; }
  if(!data.session) $('a_msg').textContent='確認メールを送りました。メールのリンクを押してから、ここでログインしてください。';
}

/* ---------- events ---------- */
$('authForm').addEventListener('submit',doLogin);
$('a_signup').addEventListener('click',doSignup);
$('logout').addEventListener('click',async()=>{ await S.sb.auth.signOut(); try{localStorage.removeItem(CACHE_KEY);}catch{} location.hash=''; });
$('addItem').addEventListener('click',()=>openSheet(null));
$('itemList').addEventListener('click',e=>{ const b=e.target.closest('.item, .gcard'); if(b){ const it=S.items.find(i=>i.id===b.dataset.id); if(it) openSheet(it);} });
$('closeSheet').addEventListener('click',()=>closeSheet()); $('cancelItem').addEventListener('click',()=>closeSheet());
$('sheet').addEventListener('click',e=>{ if(e.target===$('sheet')) closeSheet(); });
document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return; if(!$('lightbox').hidden){ $('lightbox').hidden=true; return; } if(!$('sheet').hidden) closeSheet(); });
$('itemForm').addEventListener('input',updateCalc); $('itemForm').addEventListener('change',updateCalc); $('itemForm').addEventListener('submit',saveItem);
$('delItem').addEventListener('click',deleteItem);
$('i_file').addEventListener('change',e=>{ const fs=e.target.files; if(fs&&fs.length) addPhotos(fs); e.target.value=''; });
$('i_photos').addEventListener('click',e=>{
  const rm=e.target.closest('[data-rm]'); if(rm){ removePhoto(rm.dataset.rm); return; }
  const im=e.target.closest('[data-full]'); if(im){ $('lightImg').src=photoSrc(im.dataset.full); $('lightbox').hidden=false; }
});
$('lightbox').addEventListener('click',()=>{ $('lightbox').hidden=true; });
$('statusFilter').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; S.filter=b.dataset.f; $('statusFilter').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); renderItems(); });
$('viewMode').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; S.view=b.dataset.v; $('viewMode').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); try{localStorage.setItem('shiire.view',S.view);}catch{} renderItems(); });
$('search').addEventListener('input',e=>{ S.q=e.target.value; renderItems(); });
['m_brand','m_model','m_color','m_size'].forEach(id=>$(id).addEventListener('input',updateMarketLinks));
$('m_kw').addEventListener('input',()=>{ kwTouched=$('m_kw').value.trim()!==''; updateMarketLinks(); });
$('m_prices').addEventListener('input',renderMarketStats);
$('m_save').addEventListener('click',saveComp); $('m_reset').addEventListener('click',resetMarket);
$('b_price').addEventListener('input',()=>{ $('b_price').dataset.touched='1'; renderMarketCalc(); });
['b_margin','b_ship','b_dom'].forEach(id=>$(id).addEventListener('input',renderMarketCalc));
$('compTable').addEventListener('click',async e=>{
  const ed=e.target.closest('[data-comp-edit]'); if(ed){ editComp(ed.dataset.compEdit); return; }
  const del=e.target.closest('[data-comp-del]'); if(!del) return;
  if(!del.classList.contains('armed')){ del.classList.add('armed'); del.textContent='本当に削除'; return; }
  try{ await deleteRow('comps', del.dataset.compDel); toast('削除しました'); await refresh(true); }catch{ toast('削除できませんでした'); }
});
$('prefsForm').addEventListener('submit',savePrefs);
$('fetchRate').addEventListener('click',fetchRate);
$('exportBtn').addEventListener('click',exportData);
$('importFile').addEventListener('change',e=>{ const f=e.target.files&&e.target.files[0]; if(f) importData(f); e.target.value=''; });
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && S.user) refresh(true); });
window.addEventListener('online',()=>{ if(S.user) refresh(); });

/* ---------- boot ---------- */
try{ if(localStorage.getItem('shiire.view')==='grid'){ S.view='grid'; $('viewMode').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x.dataset.v==='grid')); } }catch{}
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});

if(!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || !window.supabase){ $('setup').hidden=false; return; }
S.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
updateMarketLinks(); renderMarketStats();

let started=false;
S.sb.auth.onAuthStateChange((_ev, session)=>{
  S.user = session ? session.user : null;
  if(!S.user){ started=false; S.loaded=false; S.items=[]; S.comps=[]; showAuth(); return; }
  if(started) return; started=true;
  setTimeout(()=>{ loadCache(); fillPrefs(); showApp(); renderAll(); refresh(); }, 0);
});
})();
