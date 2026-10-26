// 旧键名 aec_* → fc_*：只搬一次，避免升级后丢本地草稿 / 偏好（TODO(v0.3.0)：都升过一次后可以删掉这段）
(function migrateOldKeys(){
  const map={aec_role:'fc_role',aec_canvas:'fc_canvas',aec_edgebar:'fc_edgebar',aec_draft:'fc_draft'};
  for(const o in map){ try{ const v=localStorage.getItem(o); if(v!==null && localStorage.getItem(map[o])===null) localStorage.setItem(map[o],v); }catch(e){} }
})();
let cols=[{kind:'团队',title:'团队'},{kind:'能力',title:'能力'},{kind:'交付物',title:'交付物'},{kind:'依赖',title:'外部依赖'}];
let nodes=[],edges=[],selNodes=new Set(),selEdges=new Set(),connFrom=null,editMode=false,showAll=true;
let selCol=null;                                             // 选中的栏目（kind）；与节点选择互斥
let activeEdit=null;                                         // 正在内联编辑的输入（点外部要能收掉它）
let token=localStorage.getItem('token')||'', rev=0, dirty=false;
let role=localStorage.getItem('fc_role')||'rw';   // 'admin' | 'rw' | 'ro'（服务端复核，这里只决定界面露什么）
let isAdmin=false, myId=null, myName=localStorage.getItem('userName')||'', mustChange=false;
let canvases=[], canvasId=localStorage.getItem('fc_canvas')||'';   // 多画布：列表 + 当前画布（记住上次）
let drag=null;   // {type:'node'|'col', id}
let marq=null, suppressBgClick=false;   // 框选状态 / 抑制框选后误触发的背景点击
let zoom=1, panX=0, panY=0, spaceDown=false, panDrag=null;   // 画布缩放/平移
let locked=false, expandedNotes=new Set();                   // 锁定画布（会话内）/ 备注展开态
let showNotes=false;                                         // 「显示备注」总开关（用户意图，只有用户点击才改）
let tagFilter=null, tagbarOpen=false;                        // 标签筛选（成员资格高亮，与节点选中链路互斥）/ 标签条展开态（会话内）
let edgebarOpen=localStorage.getItem('fc_edgebar')==='1';  // 「🔗 连线」开关：默认关，选中节点不再自动铺出连线列表
/* ===== 标签类型（2026-10-21）=====
   tagTypes: [{name,color,ord}] 画布级类型（维度）；tagDefs: {标签名: 类型名}（''=未分类）。
   ⚠️ nodes.tags 的存储格式不动（仍是逗号串）——类型只存"归属"，所以旧标签天然落到未分类。 */
let tagTypes=[], tagDefs={};
let headColor='';                                            // 本画布的栏目头颜色（空=用 --colhead 默认）
let hist=[], histSkip=false;                                 // 撤销/重做：内存快照栈（histIdx 见下方历史区块）
const graphEl=document.getElementById('graph'), svg=document.getElementById('edges');
const ctxEl=document.getElementById('ctxmenu'), toastEl=document.getElementById('toast');
const wrapEl=document.querySelector('.wrap');
const imgUrl=u=>u+(u.includes('?')?'&':'?')+'t='+encodeURIComponent(token||'');   // <img> 带不了鉴权头，用 ?t=
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// 服务器存的是 UTC ISO（如 2026-10-14T07:19:50.000Z）；直接 slice 当本地时间显示会**少 8 小时**。
// 这里按**浏览者本机时区**格式化（存储不改，历史数据也不用迁移）。
const fmtTime=s=>{ if(s==null||s==='') return ''; const d=new Date(s); if(isNaN(d.getTime())) return String(s);
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); };
const byId=id=>nodes.find(n=>n.id===id);
const titleOf=k=>(cols.find(c=>c.kind===k)||{}).title||k;
const byOrd=(a,b)=>(a.ord??0)-(b.ord??0)||String(a.name).localeCompare(String(b.name),'zh');
const colIdxOf=k=>cols.findIndex(c=>c.kind===k);
function hint(t){ document.getElementById('hint').textContent=t||''; }
const DRAFT_KEY='fc_draft';
const draftKey=()=>DRAFT_KEY+':'+(canvasId||'c1');   // 草稿按画布隔离，切画布不会串台
// 单选（用于改名/删除/连线/流程图/标状态等只对单个节点生效的操作）：恰好选中 1 个节点时返回它
const primaryNode=()=> selNodes.size===1 ? byId([...selNodes][0]) : null;
// Shift / Ctrl / ⌘ = 加选
const isAdditive=ev=>!!(ev.shiftKey||ev.ctrlKey||ev.metaKey);
// 屏幕坐标 → 画布布局坐标（除以 zoom；原点用画布的变换后矩形，自动含 .wrap 内边距与 pan）
const gRect=()=>graphEl.getBoundingClientRect();
const toLayout=(cx,cy)=>{ const r=gRect(); return {x:(cx-r.left)/zoom, y:(cy-r.top)/zoom}; };
const toLayoutRect=b=>{ const r=gRect(); return {l:(b.left-r.left)/zoom, r:(b.right-r.left)/zoom, t:(b.top-r.top)/zoom, b:(b.bottom-r.top)/zoom}; };

/* ===== 轻提示 / 标签 / 右键菜单（2026-10-14） ===== */
let toastTimer=null;
function toast(msg){ toastEl.textContent=msg; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.remove('show'),1600); }
const splitTags=s=>String(s||'').split(/[,，、;\n\r]+/).map(x=>x.trim()).filter(Boolean);
const tagsOf=n=>splitTags(n&&n.tags);
// 类型相关的纯函数（只在 tagTypes / 节点归属上算，绝不动 nodes.tags 的存储格式）
const typeColorOf=t=>((tagTypes.find(x=>x.name===t)||{}).color)||'';
/* 节点级标签归属（2026-10-26，同名可跨类型）：nodes[i].tagtypes = '{"核心":["类别"],"实验":[]}'
     []   = 显式未分类（放开"一词可属多类型"后必须能区分，否则取消归属会被老兜底复活）
     缺键 = 老数据 → 回落到画布级 tagDefs（升级不丢类型；指向已删类型按未分类算） */
const parseNodeTagTypes=s=>{ try{ const o=JSON.parse(s||'{}'); return (o&&typeof o==='object'&&!Array.isArray(o))?o:{}; }catch{ return {}; } };
const nodeTagTypes=n=>parseNodeTagTypes(n&&n.tagtypes);          // 节点上的「标签 → 类型数组」映射
const typesOfTag=(n,name)=>{
  const v=nodeTagTypes(n)[name];
  if(Array.isArray(v)) return v.filter(t=>typeColorOf(t));
  const lt=tagDefs[name]||''; return typeColorOf(lt)?[lt]:[];
};
/* 节点上的一条标签 = (类型, 名字)；同名词挂两个类型 = 两条，各自一条 chip */
const pairsOf=n=>{ const out=[],seen=new Set();
  tagsOf(n).forEach(name=>{ const ts=typesOfTag(n,name);
    if(!ts.length){ const k='u:'+name; if(!seen.has(k)){ seen.add(k); out.push({name,type:''}); } }
    else ts.forEach(t=>{ const k='t:'+t+':'+name; if(!seen.has(k)){ seen.add(k); out.push({name,type:t}); } }); });
  return out; };
const allPairs=()=>{ const out=[]; nodes.forEach(n=>pairsOf(n).forEach(p=>out.push(p))); return out; };
const uniq=list=>list.filter((x,i)=>list.indexOf(x)===i);
// 某类型下的全部标签名（编辑器「已有」chip 用）；'' = 未分类
const namesOfType=t=>{ const s=[]; allPairs().forEach(p=>{ if(p.type===t && !s.includes(p.name)) s.push(p.name); }); return s; };
const untypedTags=()=>namesOfType('');
// 把 (类型,名字) 二元组按类型分组（节点渲染 + 顶栏标签条共用）——同组内名字去重
const groupTagsByType=pairs=>{
  const out=tagTypes.map(ty=>({ name:ty.name, color:ty.color||'#2563EB', loose:false,
    tags:uniq((pairs||[]).filter(p=>p.type===ty.name).map(p=>p.name)) })).filter(g=>g.tags.length);
  const loose=uniq((pairs||[]).filter(p=>!p.type).map(p=>p.name));
  if(loose.length) out.push({ name:'未分类', color:'#9CA3AF', loose:true, tags:loose });
  return out;
};
/* 类型改名 / 删除时同步所有节点的归属（2026-10-26）：newName=null = 删除该类型（只取消归属，标签名保留） */
function retypeNodes(oldName,newName){
  nodes.forEach(n=>{
    const m=nodeTagTypes(n); let ch=false;
    Object.keys(m).forEach(name=>{
      const arr=Array.isArray(m[name])?m[name]:[];
      if(!arr.includes(oldName)) return;
      m[name]= newName ? uniq(arr.map(t=>t===oldName?newName:t)) : arr.filter(t=>t!==oldName);
      ch=true;
    });
    if(ch) n.tagtypes=JSON.stringify(m);
  });
}
/* 老数据兜底：节点缺某个标签的键 → 用画布级 tagDefs 补成显式数组（[]=未分类），并清掉已不在 tags 里的键。
   只改内存、不标脏；下次保存自然落库（自愈）——所以老画布升级不需要任何迁移脚本。 */
function normalizeTagTypes(){
  nodes.forEach(n=>{
    const names=tagsOf(n);
    if(!names.length){ if(n.tagtypes) n.tagtypes=''; return; }
    const m=nodeTagTypes(n); let ch=false;
    names.forEach(name=>{
      if(!Object.prototype.hasOwnProperty.call(m,name)){
        const lt=tagDefs[name]||''; m[name]=typeColorOf(lt)?[lt]:[]; ch=true;
      }
    });
    Object.keys(m).forEach(k=>{ if(!names.includes(k)){ delete m[k]; ch=true; } });
    if(ch) n.tagtypes=JSON.stringify(m);
  });
}
// 同栏里「同一分组的连续段」末尾下标：整组搬动时用它，避免把别的组劈开
const groupEnd=(list,i)=>{ let j=i; while(j+1<list.length && (list[j+1].grp||'')===(list[i].grp||'')) j++; return j; };
// #RRGGBB 与白色混合出浅底（不另存颜色，只算一次）——pct=与白色的混合比例
const tint=(hex,pct)=>{ const m=/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex||'')); if(!m) return '#EEF4FC';
  const w=Math.max(0,Math.min(100,pct))/100;
  const f=i=>{ const c=parseInt(m[i],16); return Math.round(c*(1-w)+255*w).toString(16).padStart(2,'0'); };
  return '#'+f(1)+f(2)+f(3); };
/* 预设色板：按色相排（蓝→青→绿→黄→橙→红→粉→紫→中性），深浅各一组；末尾还有系统取色器可任选 */
const TAG_PALETTE=[
  ['#1E88E5','亮蓝'],['#2563EB','靛蓝'],['#4F46E5','靛紫'],['#0E9F6E','翠绿'],['#16A34A','绿'],
  ['#65A30D','橄榄'],['#CA8A04','金黄'],['#D97706','橙'],['#EA580C','橘红'],['#DC2626','红'],
  ['#E11D48','玫红'],['#DB2777','粉'],['#C026D3','品红'],['#9333EA','紫'],['#7C3AED','紫罗兰'],
  ['#0891B2','青'],['#0D9488','松石'],['#475569','石板'],['#78716C','灰'],['#B45309','棕']];
const nextTypeColor=()=>{ const used=tagTypes.map(t=>String(t.color||'').toUpperCase());
  const free=TAG_PALETTE.find(([c])=>!used.includes(c.toUpperCase())); return (free||TAG_PALETTE[tagTypes.length%TAG_PALETTE.length])[0]; };
const datalist=(id,list)=>list&&list.length?('<datalist id="'+id+'">'+list.map(o=>'<option value="'+esc(o)+'"></option>').join('')+'</datalist>'):'';
function closeCtx(){ ctxEl.classList.remove('show'); ctxEl.innerHTML=''; }
function openCtx(x,y,items){
  ctxEl.innerHTML=items.map(it=>it==='-'?'<div class="sep"></div>'
    :'<div class="ci'+(it.danger?' danger':'')+'" data-i="'+esc(it.id)+'">'+esc(it.label)
      +(it.key?'<span class="k">'+esc(it.key)+'</span>':'')+'</div>').join('');
  ctxEl.classList.add('show');
  ctxEl.querySelectorAll('.ci').forEach(el=>el.onclick=ev=>{ ev.stopPropagation();
    const it=items.find(i=>i!=='-'&&i.id===el.dataset.i); closeCtx(); if(it&&it.run) it.run(); });
  const r=ctxEl.getBoundingClientRect();
  ctxEl.style.left=Math.max(4,Math.min(x,innerWidth-r.width-8))+'px';
  ctxEl.style.top =Math.max(4,Math.min(y,innerHeight-r.height-8))+'px';
}
document.addEventListener('click',()=>closeCtx());
document.addEventListener('contextmenu',e=>{ if(!e.target.closest('.ctxmenu')) closeCtx(); });

/* ===== 撤销 / 重做：内存快照栈（会话内，不持久化） ===== */
const HIST_MAX=100;
let histIdx=-1;                                   // 当前所处的历史位置（别叫 hi：会和 reachSet 里的局部 hi 撞名）
const snapshot=()=>JSON.stringify({nodes,edges,cols,tagTypes,tagDefs,headColor,styleCfg});   // 配色 / 节点样式也算可撤销的改动
function resetHistory(){ hist=[snapshot()]; histIdx=0; }
function pushHistory(){ if(histSkip) return; const s=snapshot(); if(hist[histIdx]===s) return;
  hist=hist.slice(0,histIdx+1); hist.push(s); if(hist.length>HIST_MAX) hist.shift(); histIdx=hist.length-1; }
function applySnapshot(s){
  histSkip=true;
  const o=JSON.parse(s); nodes=o.nodes; edges=o.edges; cols=o.cols;
  tagTypes=o.tagTypes||[]; tagDefs=o.tagDefs||{};
  headColor=o.headColor!==undefined?o.headColor:headColor;
  if(o.styleCfg){ styleCfg=Object.assign({}, STYLE_DEFAULTS, o.styleCfg); applyStyle(); }
  applyHeadColor();
  selNodes=new Set([...selNodes].filter(id=>byId(id))); selEdges.clear();
  setDirty(true); saveDraft();               // 撤销后就该是"有未保存改动"
  histSkip=false;
  render();
}
function undo(){ if(histIdx<=0){ toast('没有可撤销的操作'); return; } histIdx--; applySnapshot(hist[histIdx]); toast('已撤销'); }
function redo(){ if(histIdx>=hist.length-1){ toast('没有可重做的操作'); return; } histIdx++; applySnapshot(hist[histIdx]); toast('已重做'); }

/* ===== 弹窗 ===== */
const overlay=document.getElementById('overlay'), dialog=document.getElementById('dialog');
let pending=null;
function _open(html,cls){ dialog.className='dialog'+(cls?' '+cls:''); dialog.innerHTML=html; overlay.classList.add('show'); }
function _close(v){ overlay.classList.remove('show'); const p=pending; pending=null; if(p) p(v); }
overlay.addEventListener('click',e=>{ if(e.target===overlay) _close(null); });
function uiPrompt(title,label,value='',allowEmpty=false,list=[]){
  const has=list&&list.length;
  const dl=datalist('ml',list);
  return new Promise(res=>{ pending=res;
    _open(`<h3>${esc(title)}</h3><div class="body"><label>${esc(label)}</label><input type="text" id="mi" value="${esc(value)}"${has?' list="ml"':''}>${dl}</div>
      <div class="foot"><button class="btn ghost" data-x="c">取消</button><button class="btn" data-x="ok">确定</button></div>`);
    const inp=dialog.querySelector('#mi'); inp.focus(); inp.select();
    dialog.querySelector('[data-x=ok]').onclick=()=>{ const v=inp.value.trim(); _close(allowEmpty?v:(v||null)); };
    dialog.querySelector('[data-x=c]').onclick=()=>_close(null);
    inp.onkeydown=e=>{ if(e.key==='Enter'){ const v=inp.value.trim(); _close(allowEmpty?v:(v||null)); } if(e.key==='Escape')_close(null); };
  });
}
// 多字段表单（备注 + 标签）；Esc 取消、Enter（非多行框内）提交
function uiForm(title,fields){
  return new Promise(res=>{ pending=res;
    const body=fields.map((f,i)=>{
      const dl=datalist('dl'+i,f.list);
      /* multiline 支持 rows / grow（随内容长高）/ enterSubmit（Enter 直接提交，Shift+Enter 换行） */
      const box=f.multiline
        ? '<textarea id="mf'+i+'" rows="'+(f.rows||4)+'"'+(f.grow?' class="grow"':'')+(f.enterSubmit?' data-enter="1"':'')+' placeholder="'+esc(f.ph||'')+'">'+esc(f.value||'')+'</textarea>'
        : '<input type="text" id="mf'+i+'" value="'+esc(f.value||'')+'"'+(dl?' list="dl'+i+'"':'')+(f.enterSubmit?' data-enter="1"':'')+' placeholder="'+esc(f.ph||'')+'">';
      const dot=f.dot?('<i class="fdot" style="background:'+esc(f.dot)+'"></i>'):'';   // 标签类型的小色点
      const chips=(f.chips&&f.chips.length)
        ? '<div class="fchips" id="cf'+i+'"><span class="fhint">已有：</span>'
          + f.chips.map(t=>'<span class="fchip" data-t="'+esc(t)+'">'+esc(t)+'</span>').join('')+'</div>'
        : '';
      return '<label>'+dot+esc(f.label)+'</label>'+box+dl+chips;
    }).join('');
    _open(`<h3>${esc(title)}</h3><div class="body">${body}</div>
      <div class="foot"><button class="btn ghost" data-x="c">取消</button><button class="btn" data-x="ok">确定</button></div>`);
    const val=()=>{ const o={}; fields.forEach((f,i)=>{ o[f.key]=dialog.querySelector('#mf'+i).value; }); return o; };
    const first=dialog.querySelector('#mf0'); if(first) first.focus();
    // 自适应高度的多行框：按内容长高（不超过 190px，超了内部滚动）——标签一多也能一眼看全
    const GROW_MAX=190;
    const growEl=el=>{ el.style.height='auto'; el.style.height=Math.min(el.scrollHeight+2,GROW_MAX)+'px';
      el.style.overflowY=el.scrollHeight+2>GROW_MAX?'auto':'hidden'; };
    dialog.querySelectorAll('textarea.grow').forEach(el=>{ growEl(el);
      el.addEventListener('input',()=>growEl(el)); });
    // 候选标签：点 = 在「加入 / 移出」之间切换；选中态跟着框里的内容实时同步
    fields.forEach((f,i)=>{
      const row=dialog.querySelector('#cf'+i), ta=dialog.querySelector('#mf'+i);
      if(!row||!ta) return;
      const sync=()=>{ const cur=splitTags(ta.value);
        row.querySelectorAll('.fchip').forEach(c=>c.classList.toggle('on',cur.includes(c.dataset.t))); };
      row.addEventListener('click',ev=>{ const c=ev.target.closest('.fchip'); if(!c) return;
        ev.preventDefault(); ev.stopPropagation();
        const v=c.dataset.t, cur=splitTags(ta.value), has=cur.includes(v);
        const next=has?cur.filter(x=>x!==v):cur.concat(v);
        ta.value=next.join('，'); growEl(ta); sync(); });
      ta.addEventListener('input',sync); sync();
    });
    dialog.querySelector('[data-x=ok]').onclick=()=>_close(val());
    dialog.querySelector('[data-x=c]').onclick=()=>_close(null);
    dialog.querySelector('.body').addEventListener('keydown',e=>{
      if(e.isComposing||e.keyCode===229) return;      // 中文输入法选词时的 Enter / Esc 不算提交
      if(e.key==='Escape'){ e.preventDefault(); _close(null); }
      else if(e.key==='Enter' && (e.target.tagName!=='TEXTAREA' || (e.target.dataset.enter==='1' && !e.shiftKey))){ e.preventDefault(); _close(val()); } });
  });
}
function uiConfirm(title,msgHtml,{danger=false,okText='确定'}={}){
  return new Promise(res=>{ pending=res;
    _open(`<h3>${esc(title)}</h3><div class="body"><div class="msg">${msgHtml}</div></div>
      <div class="foot"><button class="btn ghost" data-x="c">取消</button><button class="btn ${danger?'dangerfill':''}" data-x="ok">${esc(okText)}</button></div>`);
    dialog.querySelector('[data-x=ok]').onclick=()=>_close(true);
    dialog.querySelector('[data-x=c]').onclick=()=>_close(false);
  });
}
function uiChoose(title,msgHtml,options){
  return new Promise(res=>{ pending=res;
    _open(`<h3>${esc(title)}</h3><div class="body"><div class="msg">${msgHtml}</div></div>
      <div class="foot">${options.map((o,i)=>`<button class="btn ${o.cls||'ghost'}" data-x="${i}">${esc(o.label)}</button>`).join('')}</div>`);
    options.forEach((o,i)=>dialog.querySelector(`[data-x="${i}"]`).onclick=()=>_close(o.value));
  });
}
const LB_ZOOMS=[0, 1.5, 2, 3];                       // 0=适应窗口（看全），其余=放大倍数
function uiLightbox(url,title){
  return new Promise(res=>{ pending=res;
    _open(`<h3>${esc(title||'流程图')}</h3><div class="body"><img src="${esc(url)}" alt="流程图"></div>
      <div class="foot"><span class="muted sp" id="lbtip"></span>
      <a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener">新窗口打开</a>
      <button class="btn" data-x="ok">关闭</button></div>`, 'imgbig');
    dialog.querySelector('[data-x=ok]').onclick=()=>_close(true);
    const img=dialog.querySelector('.body img'), tip=dialog.querySelector('#lbtip');
    let lv=0;
    const apply=()=>{
      const z=LB_ZOOMS[lv];
      if(!z){ img.style.width=''; img.style.height=''; dialog.classList.remove('zoomed'); tip.textContent='点图片放大 · 点遮罩或 Esc 退出'; }
      else {
        const nw=img.naturalWidth||img.clientWidth||1200;
        img.style.width=(nw*z)+'px'; img.style.height='auto'; dialog.classList.add('zoomed');
        tip.textContent='放大 '+Math.round(z*100)+'% · 点图片继续放大（到最大后回到“看全”）';
      }
    };
    img.addEventListener('click',()=>{ lv=(lv+1)%LB_ZOOMS.length; apply(); });
    apply();
  });
}

/* ===== 登录门 ===== */
const gate=document.getElementById('gate');
function showGate(msg){ document.getElementById('gate-msg').textContent=msg||'请输入用户名与密码'; gate.classList.add('show'); }
function hideGate(){ gate.classList.remove('show'); }
function setWhoami(){ document.getElementById('whoami').textContent=localStorage.getItem('userName')||'—'; }
/* ===== 当前访问者：IP / 归属地 / 角色 ===== */
function renderNet(w){
  const el=document.getElementById('netline'); if(!el) return;
  const ip=(w&&w.ip)||'未知', lab=(w&&w.geoLabel)||'';
  const badge = role==='ro' ? '<span class="rolebadge">只读</span>' : '';
  // 顶栏只留 IP + 位置两段（"归属地库未安装"这类运维信息放 tooltip，别挤在界面上）
  el.innerHTML = badge + '<span>IP <b class="ip">'+esc(ip)+'</b></span>'
    + (lab ? '<span>· '+esc(lab)+'</span>' : '');
  el.title = '当前访问 IP：'+ip+(lab?'（'+lab+'）':'')
    + ((w&&w.geoReady===false) ? '\n归属地库未安装：vendor/ip2region.xdb（放进去重启即可显示省市区，不影响使用）' : '')
    + '\n点「退出」可换个账号重新登录';
}
async function loadWhoami(){
  try{
    const w=await api('GET','/api/whoami');
    role = normRole(w.role); isAdmin = role==='admin'; myId = w.id || myId;
    localStorage.setItem('fc_role',role);
    applyRole(); setWhoami(); renderNet(w);
  }catch(e){ console.warn('whoami 失败（IP/角色未取到）：', e && e.message); }
}
function applyRole(){
  const bu=document.getElementById('btn-users');           // 「用户管理」只给管理员看
  if(bu) bu.style.display = (role==='admin') ? '' : 'none';
  const be=document.getElementById('btn-edit');
  if(role==='ro'){
    be.disabled=true; be.textContent='只读账号'; be.title='只读账号：只能查看，不能编辑';
    be.classList.remove('on');
    document.getElementById('btn-save').style.display='none';
    document.getElementById('btn-addcol').style.display='none';
    document.getElementById('btn-set').style.display='none';
  } else {
    be.disabled=false; be.title='';
    document.getElementById('btn-save').style.display='';
    document.getElementById('btn-addcol').style.display='';
    document.getElementById('btn-set').style.display='';
    if(!editMode) be.textContent='编辑模式：关';
  }
}
/* 常驻提示条：别人保存过、而本地正好有未保存改动时出现（不打断编辑，只提醒） */
function showExt(r){
  const el=document.getElementById('extbar');
  el.innerHTML='⚠ 画布已被其他人更新（服务器 rev '+r+' · 你基于 rev '+rev+'）—— 你手上的是旧数据，'
    + '<b>点这里加载最新</b>；直接保存会弹冲突提示。';
  el.classList.add('show');
}
function hideExt(){ document.getElementById('extbar').classList.remove('show'); }
document.getElementById('extbar').addEventListener('click',async()=>{
  if(dirty){
    const pick=await uiChoose('加载最新版本','你还有未保存的改动（'+nodes.length+' 个节点）。加载最新会<b>丢弃</b>这些改动。',
      [{label:'丢弃并加载最新',value:'ok',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
    if(pick!=='ok') return;
  }
  try{ await load(); toast('已加载最新版本（rev '+rev+'）'); }catch(e){ toast('加载失败：'+e.message); }
});
async function doLogin(){
  const un=document.getElementById('gate-user').value.trim();
  const pw=document.getElementById('gate-pw').value;
  if(!un) return gateMsg('请先填写用户名');
  if(!pw) return gateMsg('请输入密码');
  try{
    const r=await api('POST','/api/login',{username:un,password:pw},{noauth:true});
    token=r.token; localStorage.setItem('token',token);
    myId=r.id||null; myName=r.name||un;
    role=normRole(r.role); isAdmin=role==='admin'; mustChange=!!r.mustChange;
    localStorage.setItem('userName',myName); localStorage.setItem('fc_role',role);
    hideGate(); setWhoami(); applyRole();
    if(mustChange){ openChangePw(true); return; }      // 初始密码：先改密，别的都不放行
    await bootAfterLogin();
  }catch(e){
    gateMsg((e.code===401 ? '' : '登录失败：') + (e.message||'无法连接服务器'));
  }
}
function gateMsg(t, isErr=true){
  const el=document.getElementById('gate-msg');
  el.textContent=t||'请输入用户名与密码';
  el.classList.toggle('err', !!t && isErr);
}
async function bootAfterLogin(){ await loadCanvases(); await load(); await loadWhoami(); }

/* ===== 账号：顶栏菜单 / 修改密码 / 用户管理（仅管理员）===== */
const normRole=r=> r==='admin' ? 'admin' : (r==='ro' ? 'ro' : 'rw');
const roleLabel=r=> r==='admin' ? '管理员' : (r==='ro' ? '只读' : '可编辑');
function openUserMenu(){
  pending=null;
  _open('<h3>账号</h3><div class="body">'
    + '<div style="font-size:13px;margin-bottom:10px;">'+esc(myName||'—')+' · <span class="muted">'+roleLabel(role)+'</span></div>'
    + '<button class="btn" style="width:100%;margin-bottom:6px;" id="um-pw">修改我的密码</button>'
    + (isAdmin?'<button class="btn" style="width:100%;margin-bottom:6px;" id="um-users">用户管理</button>':'')
    + '<button class="btn ghost" style="width:100%;" id="um-out">退出登录</button></div>'
    + '<div class="foot"><button class="btn ghost" id="um-close">关闭</button></div>');
  document.getElementById('um-pw').onclick=()=>{ _close(null); openChangePw(false); };
  const u=document.getElementById('um-users');
  if(u) u.onclick=()=>{ _close(null); openUsers(); };
  document.getElementById('um-out').onclick=()=>{ _close(null); doLogout(); };
  document.getElementById('um-close').onclick=()=>_close(null);
}
function openChangePw(forced){
  _open('<h3>'+(forced?'请设置新密码':'修改我的密码')+'</h3><div class="body">'
    + (forced?'<div class="muted" style="font-size:12px;margin-bottom:8px;">当前是初始密码，改完才能开始操作。</div>':'')
    + '<label>当前密码</label><input type="password" id="pw-old" autocomplete="current-password">'
    + '<label style="margin-top:8px;">新密码（至少 6 位）</label><input type="password" id="pw-new" autocomplete="new-password">'
    + '<label style="margin-top:8px;">再输一次</label><input type="password" id="pw-new2" autocomplete="new-password">'
    + '<div id="pw-msg" style="margin-top:8px;font-size:12px;color:#C2255C;"></div></div>'
    + '<div class="foot">'+(forced?'':'<button class="btn ghost" id="pw-cancel">取消</button>')+'<button class="btn" id="pw-ok">确定</button></div>');
  const msg=document.getElementById('pw-msg'), okBtn=document.getElementById('pw-ok');
  const cancel=document.getElementById('pw-cancel'); if(cancel) cancel.onclick=()=>_close(null);
  const submit=async()=>{
    const oldPw=document.getElementById('pw-old').value, a=document.getElementById('pw-new').value, b2=document.getElementById('pw-new2').value;
    if(a.length<6) return (msg.textContent='新密码至少 6 位');
    if(a!==b2) return (msg.textContent='两次输入不一致');
    okBtn.disabled=true;
    try{
      await api('POST','/api/me/password',{old:oldPw,new:a});
      _close(true); mustChange=false; toast('密码已修改');
      if(forced) await bootAfterLogin();
    }catch(e){ msg.textContent=e.message; okBtn.disabled=false; }
  };
  okBtn.onclick=submit;
  document.getElementById('pw-new2').addEventListener('keydown',ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); submit(); } });
  setTimeout(()=>{ const el=document.getElementById('pw-old'); if(el) el.focus(); },50);
}
async function openUsers(){
  let list=[], delArm='';
  pending=null;
  _open('<h3>用户管理</h3><div class="body">'
    + '<div class="uhead"><b id="ucount">—</b><span class="muted">管理员可管用户 · 可编辑能改画布 · 只读只能看</span></div>'
    + '<div class="utable"><div class="urow uhd"><span>用户</span><span>角色</span><span style="text-align:right">操作</span></div><div id="ulist"></div></div>'
    + '<div class="uadd"><input id="u-name" placeholder="新用户名" maxlength="40">'
    +   '<select id="u-role"><option value="rw">可编辑</option><option value="ro">只读</option><option value="admin">管理员</option></select>'
    +   '<button class="btn" id="u-add">新增</button></div>'
    + '<div id="u-msg" class="umsg"></div>'
    + '</div><div class="foot"><button class="btn" id="u-close">关闭</button></div>');
  const box=document.getElementById('ulist'), msg=document.getElementById('u-msg'), cnt=document.getElementById('ucount');
  const say=(html)=>{ msg.innerHTML=html||''; msg.classList.toggle('show', !!html); msg.querySelectorAll('[data-copy]').forEach(b=>{
    b.onclick=()=>{ const t=b.dataset.copy;
      (navigator.clipboard? navigator.clipboard.writeText(t): Promise.reject()).then(()=>toast('已复制'),()=>toast('复制失败，请手动选中'));
    }; }); };
  const pwLine=(label,pw)=> label+'：<code>'+esc(pw)+'</code><button class="mini" data-copy="'+esc(pw)+'">复制</button>';

  async function reload(){
    try{ list=(await api('GET','/api/users')).users; }catch(e){ say('读取失败：'+esc(e.message)); return; }
    cnt.textContent='共 '+list.length+' 个账号';
    box.innerHTML = list.map(u=>'<div class="urow">'
      + '<span class="uname">'+esc(u.name)+(u.id===myId?'<i>我</i>':'')+'</span>'
      + '<span class="urole '+u.role+'"><select data-a="role" data-id="'+u.id+'" title="改角色">'
      +   ['admin','rw','ro'].map(r=>'<option value="'+r+'"'+(u.role===r?' selected':'')+'>'+roleLabel(r)+'</option>').join('')
      + '</select></span>'
      + '<span class="uact">'
      +   '<button class="btn ghost sm" data-a="reset" data-id="'+u.id+'" title="生成新的随机密码">重置密码</button>'
      +   '<button class="btn ghost sm danger" data-a="del" data-id="'+u.id+'">'+(delArm===u.id?'确认删除':'删除')+'</button>'
      + '</span></div>').join('') || '<div class="urow"><span class="uname muted">还没有账号</span></div>';
    box.querySelectorAll('[data-a]').forEach(el=>{
      const id=Number(el.dataset.id), act=el.dataset.a;
      if(act==='role') el.onchange=async()=>{
        try{ await api('POST','/api/users/'+id,{role:el.value}); toast('已改为'+roleLabel(el.value)); await reload(); }
        catch(e){ say('改角色失败：'+esc(e.message)); await reload(); }
      };
      if(act==='reset') el.onclick=async()=>{
        const nm=(list.find(u=>u.id===id)||{}).name||'';
        try{ const r=await api('POST','/api/users/'+id,{password:''});
          say('已重置「'+esc(nm)+'」的密码　'+pwLine('新密码', r.password||'')+'　<span class="muted">（对方登录后需改密）</span>');
          await reload();
        }catch(e){ say('重置失败：'+esc(e.message)); }
      };
      if(act==='del') el.onclick=async()=>{
        if(delArm!==id){ delArm=id; await reload(); setTimeout(()=>{ if(delArm===id){ delArm=''; reload(); } },4000); return; }
        try{ await api('DELETE','/api/users/'+id); delArm=''; say('已删除账号'); await reload(); }
        catch(e){ say('删除失败：'+esc(e.message)); delArm=''; await reload(); }
      };
    });
  }

  document.getElementById('u-add').onclick=async()=>{
    const name=document.getElementById('u-name').value.trim();
    if(!name) return say('请填用户名');
    try{
      const r=await api('POST','/api/users',{name,role:document.getElementById('u-role').value});
      document.getElementById('u-name').value='';
      say('已新增「'+esc(name)+'」　'+(r.password?pwLine('初始密码',r.password):'密码为你指定的')
        +'　<span class="muted">（转告本人，登录后需改密）</span>');
      await reload();
    }catch(e){ say('新增失败：'+esc(e.message)); }
  };
  document.getElementById('u-close').onclick=()=>_close(null);
  await reload();
}
/* 顶栏时钟：精确到秒。显示的是**本机**时间；版本历史里的时间是服务器时间，两者可能有偏差 */
function tickClock(){
  const el=document.getElementById('clock'); if(!el) return;
  const d=new Date(), p=(n)=>String(n).padStart(2,'0');
  el.textContent=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
tickClock();
setInterval(tickClock, 1000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) tickClock(); });   // 后台标签页计时器会被节流，回到前台立刻校准

async function doLogout(){
  let discard=false;                                          // 只有用户明确选"丢弃"才删本地草稿
  if(dirty){                                                  // 不许静默丢改动
    const pick=await uiChoose('退出登录','还有 <b>未保存的改动</b>（'+nodes.length+' 个节点 / '+edges.length+' 条连线）。退出会丢弃它们。',
      [{label:'先保存再退出',value:'save'},{label:'丢弃并退出',value:'drop',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
    if(pick===null) return;
    if(pick==='save'){ await doSave(false); if(dirty) return; }   // 保存失败 / 冲突未决 → 不退出
    if(pick==='drop') discard=true;
  } else {
    const pick=await uiChoose('退出登录','退出后要重新输入用户名与密码才能继续操作。',
      [{label:'退出',value:'ok',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
    if(pick!=='ok') return;
  }
  if(discard) clearDraft();                                   // 没选丢弃就留着：下次打开仍可恢复
  setDirty(false);
  token=''; localStorage.removeItem('token');
  localStorage.removeItem('userName'); localStorage.removeItem('fc_role');
  role='rw'; isAdmin=false; myId=null; myName=''; mustChange=false; editMode=false; hideExt();
  const be=document.getElementById('btn-edit');
  be.textContent='编辑模式：关'; be.classList.remove('on');
  applyRole(); setWhoami();
  document.getElementById('gate-pw').value='';
  document.getElementById('gate-user').value='';    // 换人登录：用户名不预填
  showGate('已退出，请重新登录');
}
document.getElementById('btn-logout').addEventListener('click',doLogout);
document.getElementById('userchip').addEventListener('click',openUserMenu);   // 顶栏「操作人」= 账号菜单（改密 / 用户管理 / 退出）
document.getElementById('btn-users').addEventListener('click',()=>{ if(role==='admin') openUsers(); });
['gate-user','gate-pw'].forEach(id=>document.getElementById(id).addEventListener('input',()=>{
  const el=document.getElementById('gate-msg'); if(el.classList.contains('err')) gateMsg('');
}));
document.getElementById('gate-ok').addEventListener('click',doLogin);
document.getElementById('gate-form').addEventListener('submit',e=>{ e.preventDefault(); doLogin(); });
document.getElementById('gate-pw').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });

/* ===== 后端 ===== */
async function api(method,url,body,opt={}){
  const headers={'Content-Type':'application/json'};
  if(token && !opt.noauth) headers['Authorization']='Bearer '+token;
  const r=await fetch(url,{method,headers,body:body?JSON.stringify(body):undefined});
  if(!r.ok){
    const e=await r.json().catch(()=>({}));
    const err=Object.assign(new Error(e.error||('HTTP '+r.status)),{code:r.status,data:e});
    if(r.status===401){
      if(!opt.noauth) showGate('登录已过期，请重新登录');   // 登录请求本身不要被这句覆盖
      throw err;
    }
    if(e.mustChange && !mustChange){ mustChange=true; openChangePw(true); }   // 初始密码没改：服务端会一直拦
    throw err;
  }
  return r.json();
}
function setDirty(v){ dirty=v; document.getElementById('dirty').textContent=v?'● 有未保存的改动':''; document.getElementById('btn-save').disabled=!v; }
function saveDraft(){ if(dirty) localStorage.setItem(draftKey(),JSON.stringify({rev,nodes,edges,cols,canvas:canvasId,tagTypes,tagDefs,headColor,styleCfg})); else localStorage.removeItem(draftKey()); }
function clearDraft(){ localStorage.removeItem(draftKey()); }
function markDirty(){ setDirty(true); pushHistory(); saveDraft(); }   // 数据变更后调用 → 顺便入撤销栈

async function load(){
  const g=await api('GET','/api/graph?canvas='+encodeURIComponent(canvasId));
  if(g.canvas){ canvasId=g.canvas; localStorage.setItem('fc_canvas',canvasId); }   // 服务端回的才是有效的
  nodes=g.nodes||[]; edges=g.edges||[];
  applyCanvasMeta(g);
  normalizeTagTypes();                                // 老数据：按画布级 tagDefs 补成节点级显式归属（缺键才补）
  if(g.columns && g.columns.length) cols=g.columns.slice().sort((a,b)=>(a.ord??0)-(b.ord??0));
  const liveN=new Set(nodes.map(n=>n.id)), liveE=new Set(edges.map(e=>e.id));
  selNodes=new Set([...selNodes].filter(id=>liveN.has(id)));    // 选中项可能已被别人删除
  if(connFrom && !liveN.has(connFrom)) connFrom=null;
  selEdges=new Set([...selEdges].filter(id=>liveE.has(id)));
  rev=g.rev; setDirty(false); clearDraft(); hideExt();
  resetHistory();                                     // 拉到的服务端状态作为撤销栈起点
  renderCanvasName();                                 // 顶栏画布名（切画布后必须跟着变）
  render(); updateRev();
}
async function loadCanvases(){
  const r=await api('GET','/api/canvases');
  canvases=r.canvases||[];
  if(!canvases.some(c=>c.id===canvasId)) canvasId=(canvases[0]||{}).id||'';
  localStorage.setItem('fc_canvas',canvasId);
  renderCanvasName();
}
function renderCanvasName(){
  const c=canvases.find(x=>x.id===canvasId);
  document.getElementById('canvas-name').textContent=c?c.name:'—';
}
/* ===== 多画布：切换 / 新建 / 重命名 / 删除 ===== */
function showHelp(){                              // 说明从常驻区收进弹层，把画布空间让出来
  const rows=[
    ['图例','连线：<b>实线</b>=明确 · <b style="color:#B8801F">橙色虚线</b>=待确认；节点：<b style="color:#B8801F">底部橙条 + 橙字「待确认」</b>=待确认'],
    ['节点','名称下方 <b>缩略图</b>=挂了流程图（点击看大图）；<b>标签 chip</b>=节点上的标签；<b>📝</b>=备注（默认折叠，点它单独展开；顶部「<b>显示备注</b>」是总开关，可一次全展开/收起）'],
    ['画布','顶栏「<b>画布</b>」切换 / 新建 / <b>复制</b> / 重命名 / 删除（每张画布各自一套栏目与版本；复制=以当前画布为模板另存一张，<b>版本历史不复制</b>；删除二次确认、连版本一起删）'],
    ['浏览','<b>Ctrl+滚轮</b>缩放 · <b>滚轮 / 空格拖动</b>平移 · <b>自适应</b>=回到刚打开的视图（100% + 左上对齐）'],
    ['保存','编辑都是<b>草稿</b>，点「<b>保存</b>」或 <b>Ctrl+S</b> 才写入并生成版本；<b>Ctrl+Z</b> 撤销 / <b>Ctrl+Y</b> 重做（仅本会话）'],
    ['账号','顶栏右侧显示<b>操作人</b>与<b>当前访问 IP</b>（有归属地库时带省/市）；「<b>退出</b>」=清掉本机登录态，重新输姓名与口令（换人、换编辑/只读口令都走这里）'],
    ['编辑模式','拖<b>栏目头</b>换栏序；拖<b>节点</b>换序或换栏；<b>拖分组名</b>（虚线框上的小标签）＝整组在本栏内换位；<b>右键节点</b>出操作菜单；空白处<b>拖框</b>框选'],
    ['快捷键','<b>Enter</b>=改名 · <b>M</b>=备注/标签 · <b>N</b>=新增节点 · <b>Ctrl+E</b>=切换编辑模式 · <b>Ctrl+↑/↓</b>=把节点在本栏内挪位 · <b>L</b>=从此节点连线/结束 · <b>↑ / ↓</b>=同栏目内上下移动选中 · <b>← / →</b>=跳到相邻栏目（取纵向最近的节点） · <b>Delete</b>=删除选中 · <b>T</b>=标记待确认/明确 · <b>Esc</b>=取消'],
    ['聚焦','鼠标<b>停在一条线上</b>或<b>停在某个节点上</b> → 其余线淡出，便于连线条密集时顺着一条看'],
    ['连线','选中节点后上方会列出它的全部连线（可在那里直接改状态/删除，比在画布上点线容易）。这栏<b>默认不显示</b>，由工具栏「<b>🔗 连线</b>」开关控制'],
    ['标签筛选','点节点上的<b>标签 chip</b>，或顶栏「<b>🏷 标签</b>」展开标签条再点标签 → 全画布只亮<b>带此标签</b>的节点（按成员资格亮，不沿连线走）；再点一次 / 点空白 / <b>Esc</b> 取消'],
    ['节点样式','⚙ 设置 → 节点样式：名称字号/字重/颜色、选中环、链路环与底色都能改，底部可<b>恢复默认</b>（只影响本机显示）'],
    ['标签类型','标签可分<b>类型</b>（类别 / 阶段…），每类一种颜色：节点上的 chip 浅底同色，标签条按类型分组，<b>点类型名 = 亮出该类型全部节点</b>。类型在「<b>⚙ 标签类型</b>」里新建 / 改色 / 排序 / 删除；没归类的标签是「未分类」，外观不变。<b>同一个词可以同时属于多个类型</b>：在各类型的框里各写一次，节点上会出现两个同名不同色的 chip，点哪个就只亮该类型下带它的节点'],
    ['约束','<b>同一栏目内的节点不能互连</b>（避免误连）'],
  ];
  pending=null;
  _open('<h3>使用说明</h3><div class="body"><div class="help">'
    + rows.map(([k,v])=>'<div class="hrow"><span class="k">'+k+'</span>'+v+'</div>').join('')
    + '</div></div><div class="foot"><span class="muted sp">快捷键在输入框内或弹窗打开时不触发；画布锁定时编辑类快捷键不触发</span>'
    + '<button class="btn" id="helpclose">关闭</button></div>');
  dialog.querySelector('#helpclose').onclick=()=>_close(null);
}
function openCanvasMenu(x,y){
  const items=canvases.map(c=>({id:'c:'+c.id, label:(c.id===canvasId?'✓ ':'　')+c.name, run:()=>switchCanvas(c.id)}));
  if(role!=='ro'){                                   // 只读账号只看画布列表，不给改动入口
    items.push('-');
    items.push({id:'new', label:'＋ 新建画布…', run:createCanvas});
    items.push({id:'dup', label:'⧉ 复制当前画布…', run:duplicateCanvas});
    items.push({id:'ren', label:'✎ 重命名当前画布…', run:renameCanvas});
    items.push({id:'del', label:'✕ 删除当前画布…（二次确认）', danger:true, run:deleteCanvas});
  }
  openCtx(x,y,items);
}
async function switchCanvas(id){
  closeCtx();
  if(id===canvasId) return;
  if(dirty){                                    // 不许静默丢草稿
    const pick=await uiChoose('切换画布','当前画布「'+esc((canvases.find(c=>c.id===canvasId)||{}).name||'')+'」有未保存的改动。',
      [{label:'先保存再切走',value:'save'},{label:'放弃改动并切走',value:'drop',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
    if(pick===null) return;
    if(pick==='save'){ await doSave(false); if(dirty) return; }     // 保存失败 / 冲突未决 → 不切
    if(pick==='drop'){ setDirty(false); clearDraft(); }
  }
  canvasId=id; localStorage.setItem('fc_canvas',canvasId);
  selNodes.clear(); selEdges.clear(); selCol=null; connFrom=null; expandedNotes.clear(); hint('');
  try{ await load(); }catch(e){ return uiConfirm('切换失败',esc(e.message),{okText:'知道了'}); }
  toast('已切到画布：'+((canvases.find(c=>c.id===id)||{}).name||''));
}
async function createCanvas(){
  if(locked) return hint('画布已锁定：先解锁再编辑');
  const name=await uiPrompt('新建画布','画布名称：',''); if(!name) return;
  try{
    const r=await api('POST','/api/canvas/create',{name});
    await loadCanvases(); await switchCanvas(r.id);
    hint('已新建画布「'+name+'」（空白 + 默认 6 栏）。');
  }catch(e){ uiConfirm('新建失败',esc(e.message),{okText:'知道了'}); }
}
async function duplicateCanvas(){
  if(locked) return hint('画布已锁定：先解锁再编辑');
  const src=canvases.find(x=>x.id===canvasId); if(!src) return;
  const name=await uiPrompt('复制画布','新画布名称：',src.name+' 副本'); if(!name) return;
  if(dirty){                                   // 与切换画布同款防丢：复制的是**已保存**的内容（草稿不会带过去）
    const pick=await uiChoose('复制画布','当前画布「'+esc(src.name)+'」有未保存的改动。',
      [{label:'先保存再复制',value:'save'},{label:'放弃改动并复制',value:'drop',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
    if(pick===null) return;                    // 取消 → 不产生画布
    if(pick==='save'){ await doSave(false); if(dirty) return; }   // 保存失败 / 冲突未决 → 不复制
    if(pick==='drop'){ setDirty(false); clearDraft(); }
  }
  try{
    const r=await api('POST','/api/canvas/duplicate',{id:src.id,name});
    await loadCanvases(); await switchCanvas(r.id);        // 此时 dirty 已清，不会再弹一次
    hint('已复制画布「'+name+'」（'+r.n_nodes+' 节点 / '+r.n_edges+' 条连线；版本历史不复制）。');
  }catch(e){ uiConfirm('复制失败',esc(e.message),{okText:'知道了'}); }
}
async function renameCanvas(){
  if(locked) return hint('画布已锁定：先解锁再编辑');
  const c=canvases.find(x=>x.id===canvasId); if(!c) return;
  const name=await uiPrompt('重命名画布','画布名称：',c.name); if(!name||name===c.name) return;
  try{ await api('POST','/api/canvas/rename',{id:canvasId,name}); await loadCanvases(); toast('已改名为：'+name); }
  catch(e){ uiConfirm('重命名失败',esc(e.message),{okText:'知道了'}); }
}
async function deleteCanvas(){
  if(locked) return hint('画布已锁定：先解锁再编辑');
  const c=canvases.find(x=>x.id===canvasId); if(!c) return;
  if(canvases.length<=1) return uiConfirm('不能删除画布','至少要保留一张画布。',{okText:'知道了'});
  if(!await uiConfirm('删除画布','确认删除画布「'+esc(c.name)+'」？<br><span class="muted">其下 <b>'
      +c.n_nodes+' 个节点 / '+c.n_edges+' 条连线 / '+c.n_versions+' 个版本</b>都会一并删除。</span>',{danger:true,okText:'下一步'})) return;
  if(!await uiConfirm('二次确认','删除不可恢复（该画布的版本历史也一起删）。确定删除「'+esc(c.name)+'」？',{danger:true,okText:'确认删除'})) return;
  const gone=c.id;                                                   // 先记住被删的是哪张
  try{
    await api('POST','/api/canvas/delete',{id:gone,confirm:'DELETE'});
    setDirty(false); clearDraft();                                   // 清它的草稿（此刻 draftKey() 还指向它）
    localStorage.removeItem(DRAFT_KEY+':'+gone);                     // 保险：确保该画布的草稿键不留
    canvases=canvases.filter(x=>x.id!==gone);                        // 先从本地列表摘掉，避免 loadCanvases 把新的 canvasId 又选回它
    await loadCanvases();                                            // 服务端列表已无它 → canvasId 落到剩下的第一张
    selNodes.clear(); selEdges.clear(); selCol=null; connFrom=null; expandedNotes.clear(); hint('');
    await load();                                                    // ⚠️ 必须无条件重新拉取：
                                                                     //    不能走 switchCanvas —— 那时 canvasId 已被改成新画布，
                                                                     //    switchCanvas 的 `id===canvasId` 守卫会直接 return，界面就还留着**已删画布**的内容，
                                                                     //    之后再点保存会把那些节点写进另一张画布，把别人覆盖掉。
    toast('已删除画布「'+c.name+'」');
  }catch(e){ uiConfirm('删除失败',esc(e.message),{okText:'知道了'}); }
}
function updateRev(){ document.getElementById('rev').textContent='rev '+rev+' · '+nodes.length+' 节点 / '+edges.length+' 边'; }

/* ===== 画布缩放 / 平移 ===== */
const ZMIN=0.25, ZMAX=2.5;
function clampPan(){                               // 约束平移：至少留 48px 内容可见，防止把画布拖丢
  const r=wrapEl.getBoundingClientRect();
  const availW=r.width-28, availH=r.height-24;     // .wrap 内边距 12px 14px
  const cw=graphEl.scrollWidth*zoom, ch=graphEl.scrollHeight*zoom;
  if(!cw||!ch) return;
  const M=48, loX=M-cw, hiX=availW-M, loY=M-ch, hiY=availH-M;
  panX = loX<=hiX ? Math.min(Math.max(panX,loX),hiX) : (availW-cw)/2;
  panY = loY<=hiY ? Math.min(Math.max(panY,loY),hiY) : (availH-ch)/2;
}
function applyView(){
  clampPan();
  graphEl.style.transform='translate('+panX+'px,'+panY+'px) scale('+zoom+')';
  const b=document.getElementById('btn-zoomreset'); if(b) b.textContent=Math.round(zoom*100)+'%';
}
function setZoom(z, cx, cy){                       // 以视口内某点(cx,cy，缺省=视口中心)为锚缩放
  z=Math.max(ZMIN, Math.min(ZMAX, z));
  const r=wrapEl.getBoundingClientRect(), gr=graphEl.getBoundingClientRect();
  const px=(cx==null? r.left+r.width/2 : cx), py=(cy==null? r.top+r.height/2 : cy);
  const ox=px-gr.left, oy=py-gr.top;               // 相对画布原点（gr.left 已含 pan 与 .wrap 内边距）
  const gx=ox/zoom, gy=oy/zoom;                    // 锚点当前对应的布局坐标
  panX+=ox-gx*z; panY+=oy-gy*z;
  zoom=z; applyView();
}
function fitView(){                                 // 自适应 = 复位到「刚打开的样子」：100% + 顶部/左侧对齐
  graphEl.style.width='';                           // 不撑宽：列宽与连线都保持 100% 时的布局
  zoom=1; panX=0; panY=0;
  applyView();                                      // ⚠️ 必须**先**把新变换落到 DOM
  drawEdges(new Set(visibleNodes().map(n=>n.id)));  // ⚠️ 再重画连线：anchor() 用 getBoundingClientRect()/zoom 换算，
                                                    //    若 zoom 已改而 DOM 还是旧缩放，锚点会被按错倍数换算 → 连线错位
}

/* ===== 渲染 ===== */
function visibleNodes(){ return showAll?nodes:nodes.filter(n=>n.status!=='待确认'); }
const noteIds=()=>nodes.filter(n=>(n.note||'').trim()).map(n=>n.id);   // 有备注的节点（含未显示的待确认节点，取 id 无副作用）
function render(){
  const vis=visibleNodes(), visIds=new Set(vis.map(n=>n.id));
  graphEl.querySelectorAll('.col').forEach(e=>e.remove());
  cols.forEach(c=>{
    const col=document.createElement('div'); col.className='col'; col.dataset.kind=c.kind;
    const h=document.createElement('div'); h.className='col-head'+(editMode?' editable':'')+(selCol===c.kind?' sel-col':''); h.dataset.kind=c.kind;
    const sp=document.createElement('span'); sp.className='ctitle'; sp.textContent=c.title; h.appendChild(sp);
    h.addEventListener('click',ev=>{                       // 编辑模式：点栏目头 = 选中该栏目（Enter 改名 / Delete 删栏目）
      if(ev.target.closest('.colx')||ev.target.closest('.rename-input')) return; ev.stopPropagation();
      if(!editMode) return;
      if(locked) return hint('画布已锁定：先解锁再编辑');
      selNodes.clear(); selEdges.clear(); selCol=c.kind;
      hint('已选中栏目「'+c.title+'」：Enter 改名 · Delete 删除此栏目 · Esc 取消选中。');
      paint();
    });
    h.addEventListener('dblclick',ev=>{ if(ev.target.closest('.colx')) return; ev.stopPropagation(); if(editMode&&!locked) startRenameCol(c.kind); });
    if(editMode){
      h.draggable=true;
      h.addEventListener('dragstart',e=>{ if(locked){ e.preventDefault(); return; } drag={type:'col',id:c.kind}; e.dataTransfer.effectAllowed='move'; try{e.dataTransfer.setData('text/plain',c.kind);}catch(_){} });
      h.addEventListener('dragend',()=>{ drag=null; clearDragUI(); });
      h.addEventListener('dragover',e=>{ if(drag&&drag.type==='col'){ e.preventDefault(); h.classList.add('dragover'); } });
      h.addEventListener('dragleave',()=>h.classList.remove('dragover'));
      h.addEventListener('drop',e=>{ if(drag&&drag.type==='col'){ e.preventDefault(); h.classList.remove('dragover'); moveColumn(drag.id,c.kind); } });
      const x=document.createElement('span'); x.className='colx'; x.textContent='✕'; x.title='删除此栏目';
      x.addEventListener('click',ev=>{ ev.stopPropagation(); delColumn(c.kind); });
      h.appendChild(x);
    }
    col.appendChild(h);
    if(editMode){ const a=document.createElement('div'); a.className='col-add'; a.textContent='＋ 添加';
      a.addEventListener('click',()=>{ if(locked) return hint('画布已锁定：先解锁再编辑'); addNode(c.kind); }); col.appendChild(a); }
    const list=vis.filter(n=>n.kind===c.kind).sort(byOrd);
    let i=0;
    while(i<list.length){                                  // 分组：连续且 grp 相同的节点包一层虚线框（纯视觉，不参与连线）
      const g=list[i].grp||'';
      if(!g){ col.appendChild(buildNode(list[i])); i++; continue; }
      let j=i; while(j<list.length && (list[j].grp||'')===g) j++;
      const box=document.createElement('div'); box.className='nodegroup'; box.dataset.grp=g;
      const t=document.createElement('div'); t.className='ngtitle';
      if(editMode){                                      // 组名当抓手：拖它 = 整组在本栏内换位置
        t.innerHTML='<span class="nggrip">⠿</span>'+esc(g);   // ⠿ = 可拖标识
        t.style.pointerEvents='auto'; t.style.cursor='grab';
        t.title='拖我：整个分组在本栏内换位置';
        bindGroupDrag(t, box, c.kind, g);                 // 用鼠标事件自己做（HTML5 drag 在 dashed 框里 drop 不触发）
      } else t.textContent=g;
      box.appendChild(t);
      for(let k=i;k<j;k++) box.appendChild(buildNode(list[k]));
      col.appendChild(box); i=j;
    }
    if(editMode){
      col.addEventListener('dragover',e=>{ if(drag&&drag.type==='node'){ e.preventDefault(); col.classList.add('dragover'); } });
      col.addEventListener('dragleave',e=>{ if(e.target===col) col.classList.remove('dragover'); });
      col.addEventListener('drop',e=>{ if(drag&&drag.type==='node'){ e.preventDefault(); col.classList.remove('dragover'); moveNode(drag.id,c.kind,null); } });
    }
    graphEl.appendChild(col);
  });
  const pc=nodes.filter(n=>n.status==='待确认').length;
  const pe=edges.filter(e=>e.status==='待确认').length;
  let badge=''; if(pc) badge+=pc; if(pe) badge+=(badge?' · ':'')+'连线 '+pe;
  document.getElementById('pend-count').textContent=badge?('（'+badge+'）'):'';
  // 「显示备注」总开关：只反映用户的选择（showNotes），**不**由"是否已全部展开"反推——
  // 否则没有备注时永远是"未勾选"，用户一点就被弹回去，像勾不上。
  const nIds=noteIds();
  document.getElementById('note-count').textContent=nIds.length?('（'+nIds.length+'）'):'';
  document.getElementById('chk-notes').checked=showNotes;
  drawEdges(visIds); paint();
}
// 单个节点元素（标签 chip + 折叠备注 + 标注/流程图按钮 + 右键菜单）
function buildNode(n){
  const el=document.createElement('div'); el.className='node'+(n.status==='待确认'?' pending':''); el.dataset.id=n.id;
  if(editMode){
    el.draggable=true;
    el.addEventListener('dragstart',e=>{ if(locked){ e.preventDefault(); return; } drag={type:'node',id:n.id}; e.dataTransfer.effectAllowed='move'; try{e.dataTransfer.setData('text/plain',n.id);}catch(_){} });
    el.addEventListener('dragend',()=>{ drag=null; clearDragUI(); });
    el.addEventListener('dragover',e=>{ if(drag&&drag.type==='node'&&drag.id!==n.id){ e.preventDefault(); e.stopPropagation(); el.classList.add('dragover'); } });
    el.addEventListener('dragleave',()=>el.classList.remove('dragover'));
    el.addEventListener('drop',e=>{ if(drag&&drag.type==='node'&&drag.id!==n.id){ e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover'); moveNode(drag.id,n.kind,n.id); } });
  }
  const note=(n.note||'').trim();
  const row=document.createElement('div'); row.className='nrow';
  const nm=document.createElement('span'); nm.className='nm'; nm.textContent=n.name;
  row.appendChild(nm);                       // 不挂 title：悬停乱弹很烦（名称最多两行，看全名用编辑框）
  if(n.status==='待确认'){ const b=document.createElement('span'); b.className='badge'; b.textContent='待确认'; row.appendChild(b); }
  if(note){ const t=document.createElement('button'); t.type='button'; t.className='notetoggle'; t.textContent='📝';
    t.title=expandedNotes.has(n.id)?'收起备注':'展开备注';
    t.addEventListener('click',ev=>{ ev.stopPropagation(); if(expandedNotes.has(n.id)) expandedNotes.delete(n.id); else expandedNotes.add(n.id); render(); });
    row.appendChild(t); }
  if(editMode){ const b=document.createElement('button'); b.type='button'; b.className='annoedit'; b.textContent='⋯'; b.title='备注 / 标签';
    b.addEventListener('click',ev=>{ ev.stopPropagation(); if(locked) return hint('画布已锁定：先解锁再编辑'); openAnno(n.id); }); row.appendChild(b); }
  if(editMode){ const b=document.createElement('button'); b.type='button'; b.className='imgedit'; b.textContent=n.image?'🖼':'📎';
    b.title=n.image?'替换流程图':'上传流程图';
    b.addEventListener('click',ev=>{ ev.stopPropagation(); if(locked) return hint('画布已锁定：先解锁再编辑'); pickFile(url=>setImageFor(n.id,url)); }); row.appendChild(b); }
  el.appendChild(row);
  const pairs=pairsOf(n);
  if(pairs.length){
    /* 标签展示：**每个类型一行**，行内是「色点 + 类型名 + 取值」。
       取值不带底色/边框（纯色文字）—— 6 个标签也不会把节点撑高，且"谁属于哪一类"一眼能看出来。
       未分类单独一行、灰色（不再用蓝色：蓝会和选到蓝色的类型撞）。 */
    const tr=document.createElement('div'); tr.className='ntagrow';
    const mkVal=(name,color,ty)=>{ const s=document.createElement('span'); s.className='ntag'; s.textContent=name;
      if(color){ s.classList.add('typed');                          // 类型色胶囊：浅底 + 同色字 + 同色细边
        s.style.setProperty('--tbg',tint(color,90)); s.style.setProperty('--tc',color); s.style.setProperty('--tbo',tint(color,45)); }
      s.title=ty?('类型：'+ty):'未分类';
      // 筛选按 (类型, 名字) 二元组：同名词挂在两个类型下时，点哪个 chip 只亮那个类型下的节点
      s.addEventListener('click',ev=>{ ev.stopPropagation(); setTagFilter({k:'tag',v:name,ty:ty||''}); return false; });   // 不冒泡：点标签 ≠ 选中节点
      return s; };
    const mkLine=(name,color,vals,loose)=>{
      const line=document.createElement('div'); line.className='ntblock'+(loose?' loose':'');
      if(color) line.style.setProperty('--tc',color);   // 类型名与竖条同色
      if(!loose || tagTypes.length){                 // 全画布都没建类型时不显示「未分类」（纯噪声）
        const tn=document.createElement('span'); tn.className='tname'; tn.textContent=name;   // 类型名单独一行（小字）
        line.appendChild(tn); }
      const vs=document.createElement('span'); vs.className='tvals';
      vals.forEach(t=>vs.appendChild(mkVal(t, color, loose?'':name)));     // 胶囊本身就是分隔，不用再加中点
      line.appendChild(vs);
      return line;
    };
    groupTagsByType(pairs).forEach(g=>tr.appendChild(mkLine(g.name, g.color, g.tags, g.loose)));
    el.appendChild(tr);
  }
  if(note && expandedNotes.has(n.id)){ const d=document.createElement('div'); d.className='nnote'; d.textContent=note; el.appendChild(d); }
  if(n.image){
    const box=document.createElement('div'); box.className='thumbwrap';
    const im=document.createElement('img'); im.className='nthumb'; im.alt=''; im.draggable=false;
    im.title='查看流程图（点击看大图）';
    im.addEventListener('click',ev=>{ ev.stopPropagation(); uiLightbox(imgUrl(n.image),n.name+' · 流程图'); });
    im.addEventListener('error',()=>box.remove());
    im.src=imgUrl(n.image); box.appendChild(im);
    if(editMode){ const d=document.createElement('button'); d.className='thumbdel'; d.textContent='✕'; d.title='删除流程图';
      d.addEventListener('click',ev=>{ ev.stopPropagation(); setImageFor(n.id,''); hint('已删除「'+n.name+'」的流程图（保存后生效）'); });
      box.appendChild(d); }
    el.appendChild(box);
  }
  el.addEventListener('mouseenter',()=>focusEdgesOf(n.id));   // 悬停节点：只看与它相连的线
  el.addEventListener('mouseleave',()=>focusEdgesOf(null));
  el.addEventListener('click',ev=>{ ev.stopPropagation(); onNodeClick(n.id, isAdditive(ev)); });
  el.addEventListener('contextmenu',ev=>{ ev.preventDefault(); ev.stopPropagation();
    if(!editMode) return; if(locked) return hint('画布已锁定：先解锁再编辑'); openNodeCtx(ev.clientX, ev.clientY, n.id); });
  return el;
}
function clearDragUI(){ graphEl.querySelectorAll('.dragover').forEach(e=>e.classList.remove('dragover')); }
function anchor(id,side){ const el=graphEl.querySelector('.node[data-id="'+CSS.escape(id)+'"]'); if(!el) return null;
  const q=toLayoutRect(el.getBoundingClientRect());
  return {x: side==='r'?q.r:q.l, y:(q.t+q.b)/2};     // 布局坐标（已去掉缩放）
}
function drawEdges(visIds){
  // 保险：anchor() 用 getBoundingClientRect()/zoom 换算布局坐标，前提是**DOM 上的变换与 zoom 变量一致**。
  // 若不一致（曾经有过这种 bug：改了 zoom 还没 applyView 就重画），锚点会被按错倍数换算 → 整片连线错位。
  // 这里在量尺寸前先对齐一次，杜绝这一类错误。
  const m=/scale\(([\d.]+)\)/.exec(graphEl.style.transform||'');
  if(m && Math.abs(Number(m[1])-zoom)>1e-6) applyView();
  const w=graphEl.scrollWidth,h=graphEl.scrollHeight;
  svg.setAttribute('viewBox','0 0 '+w+' '+h); svg.style.width=w+'px'; svg.style.height=h+'px';
  const NS='http://www.w3.org/2000/svg'; while(svg.firstChild) svg.removeChild(svg.firstChild);
  graphEl.classList.remove('edge-focus');                    // 重画时清掉"聚焦某条/某组线"的状态
  // ① 先算好每条线的两端锚点（每条只量一次）
  const items=[];
  edges.forEach(e=>{
    if(visIds && (!visIds.has(e.from_id)||!visIds.has(e.to_id))) return;
    if(!showAll && e.status==='待确认') return;                // 待确认连线在关掉「显示待确认」时隐藏（与节点同口径）
    const A=byId(e.from_id),B=byId(e.to_id); if(!A||!B) return;
    const ca=colIdxOf(A.kind), cb=colIdxOf(B.kind);
    if(ca<0||cb<0||ca===cb) return;                            // 同栏连线已被禁止，防御性跳过
    const ltr=ca<cb;
    const a=anchor(e.from_id,ltr?'r':'l'), b=anchor(e.to_id,ltr?'l':'r'); if(!a||!b) return;
    items.push({e,a,b,left:ltr?e.from_id:e.to_id,gap:Math.min(ca,cb)+':'+Math.max(ca,cb)});
  });
  // ② 侧向错位：同一"栏间通道"里，按**起端节点**的纵向位置给每条线一个不一样的"腰"。
  //    否则所有线都从同一条竖直中线穿过，密集时糊成一股绳。错位只挪控制点、不动端点，
  //    所以线永远连在节点上，也不会越出通道。
  const offs=new Map(), leftsByGap=new Map();
  items.forEach(it=>{
    if(!leftsByGap.has(it.gap)) leftsByGap.set(it.gap,new Map());
    const g=leftsByGap.get(it.gap);
    if(!g.has(it.left)) g.set(it.left,(it.a.y+it.b.y)/2);      // 该起端在通道里的纵向中心
  });
  leftsByGap.forEach((g,gap)=>{
    const lefts=[...g.entries()].sort((p,q)=>p[1]-q[1]).map(x=>x[0]);   // 按纵向排序 → 错位稳定、不抖
    const any=items.find(it=>it.gap===gap);
    const span=any?Math.abs(any.b.x-any.a.x):60;                        // 通道宽度
    const maxOff=Math.max(6,Math.min(22,span*0.25));                    // 不越出通道
    const step=lefts.length>1?Math.min(9,(maxOff*2)/(lefts.length-1)):0;
    lefts.forEach((id,k)=>offs.set(id+'@'+gap,(k-(lefts.length-1)/2)*step));
  });
  // ③ 画线
  items.forEach(it=>{
    const e=it.e;
    const mx=(it.a.x+it.b.x)/2+(offs.get(it.left+'@'+it.gap)||0);
    const d='M'+it.a.x+','+it.a.y+' C'+mx+','+it.a.y+' '+mx+','+it.b.y+' '+it.b.x+','+it.b.y;
    const vis=document.createElementNS(NS,'path');
    vis.setAttribute('class','edge'+(e.status==='待确认'?' pending':'')); vis.setAttribute('d',d);
    vis.setAttribute('data-a',e.from_id); vis.setAttribute('data-b',e.to_id); vis.setAttribute('data-e',e.id); svg.appendChild(vis);
    // 命中区两种模式都建 —— 查看模式也能"鼠标停在一条线上、其余淡出"，便于顺着一条看
    const hit=document.createElementNS(NS,'path');
    hit.setAttribute('class','edge-hit'); hit.setAttribute('d',d);
    hit.addEventListener('mouseenter',()=>{ vis.classList.add('hover'); graphEl.classList.add('edge-focus'); });
    hit.addEventListener('mouseleave',()=>{ vis.classList.remove('hover'); graphEl.classList.remove('edge-focus'); });
    if(editMode){
      hit.addEventListener('click',ev=>{ ev.stopPropagation();
        const add=isAdditive(ev);
        if(add){ if(selEdges.has(e.id)) selEdges.delete(e.id); else selEdges.add(e.id); }
        else { selNodes.clear(); selEdges=new Set([e.id]); }
        hint(selEdges.has(e.id)?('已选中连线 '+(byId(e.from_id)||{}).name+' → '+(byId(e.to_id)||{}).name+'；按 Delete 删除'+(add?'（继续 Shift+点击可加选）':'')):'');
        paint(); });
      hit.addEventListener('contextmenu',ev=>{ ev.preventDefault(); ev.stopPropagation();
        if(locked) return hint('画布已锁定：先解锁再编辑'); openEdgeCtx(ev.clientX, ev.clientY, e.id); });
    } else {
      // 查看模式：命中区只为"悬停聚焦"而存在。点它要**保持原行为**——等同点空白（取消选中），
      // 否则会凭空多出一块"点了没反应"的死区。
      hit.addEventListener('click',ev=>{ ev.stopPropagation(); selNodes.clear(); selEdges.clear(); hint(''); paint(); });
    }
    svg.appendChild(hit);
  });
}
// 悬停某个节点时：只把与它相连的线保持正常、其余淡出（连线密集时顺着一个部门看）
function focusEdgesOf(id){
  graphEl.classList.toggle('edge-focus', !!id);
  svg.querySelectorAll('.edge').forEach(p=>p.classList.toggle('hover', !!id && (p.dataset.a===id||p.dataset.b===id)));
}
// 高亮集合：**按栏目顺序**定上下游（左=上游，右=下游），忽略连线箭头方向；取「上游可达 ∪ 下游可达」。
// 例：选某个交付物 → 往左够到产出它的团队/能力；选某个团队 → 往右铺开到它支撑的交付物/依赖。
// 同栏之间的连线不分上下游（本图当前为 0 条）。
function reachSet(start){
  const down=new Map(), up=new Map();
  const push=(m,k,v)=>{ let l=m.get(k); if(!l) m.set(k,l=new Set()); l.add(v); };
  edges.forEach(e=>{
    const a=byId(e.from_id), b=byId(e.to_id); if(!a||!b) return;
    const ca=colIdxOf(a.kind), cb=colIdxOf(b.kind); if(ca===cb) return;      // 同栏：不分上下游
    const [lo,hi]= ca<cb ? [e.from_id,e.to_id] : [e.to_id,e.from_id];        // lo=上游(靠左)、hi=下游(靠右)
    push(down,lo,hi); push(up,hi,lo);
  });
  const go=(m,s)=>{ const seen=new Set(),q=[s]; while(q.length){ const n=q.pop(); (m.get(n)||[]).forEach(x=>{ if(!seen.has(x)){seen.add(x);q.push(x);} }); } return seen; };
  const set=new Set([start]);
  go(down,start).forEach(x=>set.add(x)); go(up,start).forEach(x=>set.add(x));
  return set;
}
function paint(){
  if(tagFilter && !nodes.some(n=>tagMatch(n,tagFilter))) tagFilter=null;   // 标签/类型已不存在（撤销/恢复版本/他人保存把带标签的节点删了）：自动退出，避免全画布置灰卡死
  const sel=[...selNodes].filter(byId);              // 选中项可能已被别人删除；按真实节点算
  const set=new Set();
  const tagMode=!!tagFilter;                         // 标签筛选：按「带此标签」点亮（成员资格），不沿连线走
  if(tagMode){
    nodes.forEach(n=>{ if(tagMatch(n,tagFilter)) set.add(n.id); });
  } else if(sel.length){
    sel.forEach((id,i)=>{ const s=reachSet(id);
      if(!i) s.forEach(x=>set.add(x));               // 第一个节点：铺设它的整条上游∪下游
      else for(const x of [...set]) if(!s.has(x)) set.delete(x); });   // 之后每个：取交集（Ctrl 叠加筛选，越选越少）
    sel.forEach(id=>set.add(id));                    // 选中的点本身始终算在链路上
  }
  const hasSel=tagMode||sel.length>0;
  const dimOn=!editMode;                    // 编辑模式不置灰：否则连线时目标节点变灰看不清
  graphEl.querySelectorAll('.node').forEach(el=>{
    el.classList.remove('active','selected','dim','chain','conn-from');
    if(!tagMode && selNodes.has(el.dataset.id)){ el.classList.add('selected'); return; }
    if(!hasSel) return;
    if(set.has(el.dataset.id)) el.classList.add(editMode?'chain':'active');   // 编辑模式用淡蓝标链路，不遮挡
    else if(dimOn) el.classList.add('dim');
  });
  if(connFrom){ const e=graphEl.querySelector('.node[data-id="'+CSS.escape(connFrom)+'"]'); if(e) e.classList.add('conn-from'); }
  graphEl.querySelectorAll('.col-head').forEach(h=>h.classList.toggle('sel-col', !!selCol && h.dataset.kind===selCol));
  svg.querySelectorAll('.edge').forEach(p=>{
    p.classList.remove('hi','dim','sel');
    if(selEdges.has(p.dataset.e)){ p.classList.add('sel'); return; }
    if(!hasSel) return;
    if(set.has(p.dataset.a)&&set.has(p.dataset.b)) p.classList.add('hi'); else if(dimOn) p.classList.add('dim');
  });
  renderTagbar();
  syncButtons(); renderEdgebar();
}
/* ===== 标签筛选（成员资格高亮）=====
   与节点选中高亮是两个维度：选中=沿连线上下游铺开；标签筛选=「有哪些节点带这个标签」就亮哪些（不管有没有连线）。
   两者互斥：一旦选节点/框选/键盘移动选中，标签筛选即退出。 */
function tagMatch(n,f){                            // f={k:'tag'|'type', v:值, ty:类型}；type + v='' = 未分类
  if(!f) return false;
  const ps=pairsOf(n);
  if(f.k!=='type') return ps.some(p=>p.name===f.v && p.type===(f.ty||''));
  return f.v ? ps.some(p=>p.type===f.v) : ps.some(p=>!p.type);
}
const sameFilter=(a,b)=>!!a&&!!b&&a.k===b.k&&a.v===b.v&&(a.ty||'')===(b.ty||'');
function setTagFilter(f){
  if(!f || sameFilter(tagFilter,f)) tagFilter=null;   // 再点同一个 = 取消
  else { tagFilter=f; selNodes.clear(); selEdges.clear(); selCol=null; connFrom=null; }
  paint();
}
function renderTagbar(){
  const box=document.getElementById('tagbar');
  /* 计数与去重都按 (类型, 名字) 二元组：同名词挂两个类型 → 两个 chip，各算各的节点数 */
  const keyOf=(ty,name)=>ty+'\n'+name;
  const counts=new Map(), list=[], seen=new Set();
  visibleNodes().forEach(n=>pairsOf(n).forEach(p=>{         // 与画布可见口径一致（「显示待确认」开着才计入）
    const k=keyOf(p.type,p.name);
    counts.set(k,(counts.get(k)||0)+1);
    if(!seen.has(k)){ seen.add(k); list.push(p); }
  }));
  const groups=groupTagsByType(list).map(g=>{               // 空组自然被过滤
    const ty=g.loose?'':g.name;
    const byName=(a,b)=>(counts.get(keyOf(ty,b))||0)-(counts.get(keyOf(ty,a))||0)||a.localeCompare(b,'zh');   // 频次降序
    return { ...g, tags:g.tags.slice().sort(byName) };
  });
  const show=tagbarOpen||tagFilter;
  box.classList.toggle('show',show);
  if(!show){ box.innerHTML=''; }
  else if(!list.length){
    box.innerHTML='<span class="tbhint">画布还没有标签：编辑模式里点节点上的「⋯」可给节点加标签；想按类型分色，先点「⚙ 标签类型」建类型。</span>';
  } else {
    const chip=(name,ty,c0)=>{ const c=ty?(c0||'#2563EB'):''; const on=sameFilter(tagFilter,{k:'tag',v:name,ty})?' on':'';
      return '<span class="tbchip'+on+(ty?' typed':' loose')+'" data-k="tag" data-v="'+esc(name)+'" data-ty="'+esc(ty)+'"'
        +(ty?' style="--tbg:'+tint(c,90)+';--tc:'+c+';--tbo:'+tint(c,45)+'"':'')
        +' title="'+(ty?('类型：'+esc(ty)):'未分类')+'"'
        +'>'+esc(name)+' <span class="cnt">×'+(counts.get(keyOf(ty,name))||0)+'</span></span>'; };
    box.innerHTML='<span class="tblabel">按标签筛选：</span>'
      + groups.map(g=>{
          const gh=g.loose
            ? '<span class="tgname loose'+(sameFilter(tagFilter,{k:'type',v:''})?' on':'')+'" data-k="type" data-v="">未分类</span>'
            : '<span class="tgname'+(sameFilter(tagFilter,{k:'type',v:g.name})?' on':'')+'" data-k="type" data-v="'+esc(g.name)+'"'
              +' style="color:'+g.color+'">'
              +'<i class="tdot" style="background:'+g.color+'"></i>'+esc(g.name)+'</span>';
          return '<span class="tgroup">'+gh+g.tags.map(n=>chip(n, g.loose?'':g.name, g.color)).join('')+'</span>';
        }).join('')
      + '<span class="tbhint">点类型=亮整类，点单个值=只亮它；再点一次 / 点空白 / Esc 取消</span>';
    box.querySelectorAll('[data-k]').forEach(el=>el.addEventListener('click',ev=>{ ev.stopPropagation();
      const k=el.dataset.k, v=el.dataset.v, ty=el.dataset.ty||'';
      if(!k) return;
      setTagFilter(k==='type'?{k,v}:{k,v,ty}); }));          // 类型名（含「未分类」）都能点：亮出该类全部节点
  }
  const btn=document.getElementById('btn-tags');     // 有筛选时按钮上直接可见当前标签，收起也不至于"画布灰了却不知为何"
  btn.textContent=tagFilter?('🏷 '+(tagFilter.k==='type'?('类型：'+(tagFilter.v||'未分类')):((tagFilter.ty?tagFilter.ty+'：':'')+tagFilter.v))+' ✕'):(tagbarOpen?'🏷 标签 ▴':'🏷 标签 ▾');
  btn.classList.toggle('on',!!tagFilter);
}
function syncButtons(){
  document.getElementById('btn-addcol').disabled=!editMode;
}
/* 选中节点后的连线：**保持原来的平铺条**（每条带方向、状态、✕），
   只加一个开关「🔗 连线」—— 默认关，需要时再打开；不想看时不会自动冒出来。 */
function renderEdgebar(){
  const box=document.getElementById('edgebar');
  if(!edgebarOpen){ box.classList.remove('show'); box.innerHTML=''; return; }   // 开关关着：选中节点也不出现连线条
  const n=primaryNode();
  if(!n){ box.classList.remove('show'); box.innerHTML=''; return; }
  const rows=edges.filter(e=>e.from_id===n.id||e.to_id===n.id);
  box.classList.toggle('show', rows.length>0);
  if(!rows.length){ box.innerHTML=''; return; }
  box.innerHTML='<span class="eblabel">「'+esc(n.name)+'」的连线（'+rows.length+'）：</span>'
    + rows.map(e=>{ const A=byId(e.from_id),B=byId(e.to_id),out=e.from_id===n.id;
        return '<span class="ebrow">'+(out?'→ ':'← ')+esc(A?A.name:'?')+' → '+esc(B?B.name:'?')
          + (editMode?(' <b class="ebst" data-id="'+esc(e.id)+'" title="切换 明确 / 待确认">'+(e.status==='待确认'?'待确认':'明确')+'</b>')
                    +' <b class="ebdel" data-id="'+esc(e.id)+'" title="删除这条连线">✕</b>':'')+'</span>'; }).join('');
  box.querySelectorAll('.ebdel').forEach(b=>b.addEventListener('click',ev=>{
    ev.stopPropagation(); const e=edges.find(x=>x.id===b.dataset.id); if(e) delEdge(e);
  }));
  box.querySelectorAll('.ebst').forEach(b=>b.addEventListener('click',ev=>{
    ev.stopPropagation(); const e=edges.find(x=>x.id===b.dataset.id); if(!e) return;
    e.status = e.status==='待确认' ? '明确' : '待确认';
    markDirty(); render();
  }));
}
function onNodeClick(id,additive){
  closeCtx();                                            // 节点自身 stopPropagation，得手动收菜单
  if(connFrom){
    if(locked){ hint('画布已锁定：先解锁再编辑'); return; }
    if(connFrom===id){ connFrom=null; hint('已退出连线模式'); paint(); return; }
    const A=byId(connFrom),B=byId(id);
    if(A.kind===B.kind){ hint('同一栏目内的节点不支持连线（避免误连）：「'+A.name+'」与「'+B.name+'」都在「'+titleOf(A.kind)+'」栏。'); return; }
    const idx=edges.findIndex(e=>e.from_id===connFrom&&e.to_id===id);
    if(idx>=0){ edges.splice(idx,1); hint('已取消连线：'+A.name+' → '+B.name+'　（再点一次可重新连）'); }
    else { edges.push({id:'e'+Date.now().toString(36)+Math.random().toString(36).slice(2,4),from_id:connFrom,to_id:id}); hint('已连线：'+A.name+' → '+B.name+'　（再点一次即取消）'); }
    markDirty(); render();
    return;
  }
  if(additive){ if(selNodes.has(id)) selNodes.delete(id); else selNodes.add(id); }
  else if(selNodes.size===1 && selNodes.has(id)) selNodes.clear();   // 再点同一个 = 取消选中
  else selNodes=new Set([id]);
  selEdges.clear(); selCol=null;                                     // 选节点 = 取消栏目选中
  tagFilter=null;                                                    // 选节点 = 退出标签筛选（两个高亮维度互斥）
  paint();
}

/* ===== 拖动：节点换序/换栏、栏目换序 ===== */
function reindex(kind){ nodes.filter(n=>n.kind===kind).sort(byOrd).forEach((n,i)=>n.ord=i); }
// 把一个已经排好序的数组按顺序写回 ord（moveGroup / nudgeNodes / quickAddNode 共用）
const setOrder=arr=>{ arr.forEach((x,i)=>{ x.ord=i; }); };
function moveNode(id,kind,beforeId){
  const n=byId(id); if(!n) return;
  const old=n.kind;
  const list=nodes.filter(x=>x.kind===kind && x.id!==id).sort(byOrd);
  let idx=list.length;
  if(beforeId){ const i=list.findIndex(x=>x.id===beforeId); if(i>=0) idx=i; }
  n.kind=kind; n.ord=0; list.splice(idx,0,n);
  list.forEach((x,i)=>x.ord=i);
  if(old!==kind) reindex(old);
  selNodes=new Set([n.id]); selEdges.clear(); markDirty(); drag=null; render();
  hint('已把「'+n.name+'」移到「'+titleOf(kind)+'」第 '+(list.findIndex(x=>x.id===id)+1)+' 位。保存后生效。');
}
/* 分组拖拽：用鼠标事件实现（父框 pointer-events:none，HTML5 drag 的 drop 事件在子元素上不触发） */
function bindGroupDrag(handle, box, kind, grp){
  handle.addEventListener('mousedown',ev=>{
    if(locked || !editMode || ev.button!==0 || spaceDown) return;
    ev.preventDefault(); ev.stopPropagation();
    const x0=ev.clientX, y0=ev.clientY;
    let active=false, hot=null;
    const mark=el=>{ if(hot===el) return; if(hot) hot.classList.remove('dragover'); hot=el; if(hot) hot.classList.add('dragover'); };
    const move=e=>{
      if(!active && Math.hypot(e.clientX-x0,e.clientY-y0)<4) return;   // 抖一下不算拖
      if(!active){ active=true; box.classList.add('dragging'); document.body.style.cursor='grabbing'; }
      const el=document.elementFromPoint(e.clientX,e.clientY);
      const nodeEl=el&&el.closest&&el.closest('.node');
      const n=nodeEl?byId(nodeEl.dataset.id):null;
      mark(n && n.kind===kind && n.grp!==grp ? nodeEl : null);          // 只高亮本栏的、别的组的节点
    };
    const up=e=>{
      document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up);
      document.body.style.cursor='';
      box.classList.remove('dragging'); mark(null);
      if(!active) return;
      const el=document.elementFromPoint(e.clientX,e.clientY);
      const nodeEl=el&&el.closest&&el.closest('.node');
      if(nodeEl){
        const n=byId(nodeEl.dataset.id);
        if(n && n.kind===kind && n.grp!==grp) moveGroup(kind,grp,n.id);
        else if(n && n.kind!==kind) hint('分组只能在本栏内移动');
        return;
      }
      const colEl=el&&el.closest&&el.closest('.col');
      if(colEl){
        const head=colEl.querySelector('.col-head');
        if(head && head.dataset && head.dataset.kind===kind) moveGroup(kind,grp,null);
        else hint('分组只能在本栏内移动');
      }
    };
    document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
  });
}
/* 整组换位：组内成员**连续地**插到目标位置，绝不会把别的分组劈开 */
function moveGroup(kind,grp,beforeId){
  const colNodes=nodes.filter(x=>x.kind===kind).sort(byOrd);
  const members=colNodes.filter(x=>x.grp===grp);
  if(!members.length){ drag=null; return; }
  const others=colNodes.filter(x=>x.grp!==grp);
  let idx=others.length;
  if(beforeId){
    const b=others.find(x=>x.id===beforeId);
    if(b){
      const bGrp=b.grp||'';
      if(bGrp) idx=groupEnd(others, others.indexOf(b))+1;   // 目标是别的组：整组放到那一组之后（不插进人家中间）
      else idx=others.indexOf(b);
    }
  }
  const arr=[...others.slice(0,idx), ...members, ...others.slice(idx)];
  setOrder(arr);
  markDirty(); render();
  hint('已把分组「'+grp+'」（'+members.length+' 个节点）移到本栏第 '+(idx+1)+' 位。保存后生效。');
}
/* Ctrl+↑/↓：把选中的节点在**本栏内**上/下挪一位（选中项跟着走，画布自动带回来）。
   多选时逐个交换，选中的整块相对顺序不变。 */
function nudgeNodes(dir){
  const ids=[...selNodes].filter(byId);
  if(!ids.length) return hint('先选中节点，再按 Ctrl+↑ / Ctrl+↓ 移动位置');
  const kinds=new Set(ids.map(id=>byId(id).kind));
  if(kinds.size>1) return hint('一次只能移动同一栏内的节点');
  const kind=[...kinds][0];
  const col=nodes.filter(n=>n.kind===kind).sort(byOrd);
  const idxs=ids.map(id=>col.findIndex(n=>n.id===id)).filter(i=>i>=0).sort((a,b)=>a-b);
  if(!idxs.length) return;
  if(dir<0 && idxs[0]===0) return hint('已经是本栏第一个了');
  if(dir>0 && idxs[idxs.length-1]===col.length-1) return hint('已经是本栏最后一个了');
  // 跨到「别的组 / 组外」时，这个节点自动脱离原分组 —— 否则会把一个分组劈成两段
  if(dir>0){ for(let i=idxs.length-1;i>=0;i--){ const n=col[idxs[i]], t=col[idxs[i]+1];
      if(n.grp && n.grp!==(t.grp||'')) n.grp='';
      const [x]=col.splice(idxs[i],1); col.splice(idxs[i]+1,0,x); } }
  else { for(const i of idxs){ const n=col[i], t=col[i-1];
      if(n.grp && n.grp!==(t.grp||'')) n.grp='';
      const [x]=col.splice(i,1); col.splice(i-1,0,x); } }
  setOrder(col);
  const byG={}; col.forEach(n=>{ if(n.grp) (byG[n.grp]=byG[n.grp]||[]).push(n); });
  Object.keys(byG).forEach(g=>{ if(byG[g].length<2) byG[g].forEach(n=>{ n.grp=''; }); });   // 只剩 1 个 → 散开
  markDirty(); render(); ensureVisible(ids[0]);
  hint('已'+(dir<0?'上移':'下移')+'「'+byId(ids[0]).name+'」在第 '+(col.findIndex(n=>n.id===ids[0])+1)+' 位。保存后生效。');
}
/* N：新增节点 —— 有选中节点就插在它后面，否则插到选中栏目的末尾 */
async function quickAddNode(){
  let kind=null, afterId=null;
  if(selNodes.size===1){ const n=byId([...selNodes][0]); if(n){ kind=n.kind; afterId=n.id; } }
  if(!kind && selCol) kind=selCol;
  if(!kind) return hint('先选中一个节点（或栏目），再按 N 新增');
  const name=await uiPrompt('新增「'+titleOf(kind)+'」节点','节点名称：','');
  if(!name) return;
  const dup=nodes.find(n=>n.kind===kind && n.name.trim().toLowerCase()===name.trim().toLowerCase());
  if(dup) return uiConfirm('已存在同名节点','「'+esc(titleOf(kind))+'」列下已有 <span class="em">'+esc(dup.name)+'</span>，未重复添加。',{okText:'知道了'});
  const id=kind+':'+name+':'+Math.random().toString(36).slice(2,5);
  const node={id,kind,name,status:'明确',source:'',note:'',image:'',tags:'',grp:'',ord:0};
  nodes.push(node);
  const col=nodes.filter(x=>x.kind===kind && x.id!==id).sort(byOrd);
  let idx=col.length;
  if(afterId){
    const i=col.findIndex(x=>x.id===afterId);
    if(i>=0){
      if(col[i].grp) idx=groupEnd(col,i)+1;           // 插在分组里会把组劈开 → 改插到该组**之后**
      else idx=i+1;
    }
  }
  col.splice(idx,0,node); setOrder(col);
  selNodes=new Set([id]); selEdges.clear(); selCol=null; markDirty(); render(); ensureVisible(id);
  hint('已新增「'+name+'」，按 Enter 可改名。保存后生效。');
}
function moveColumn(kind,beforeKind){
  if(kind===beforeKind){ drag=null; return; }
  const c=cols.find(x=>x.kind===kind); if(!c){ drag=null; return; }
  const arr=cols.filter(x=>x.kind!==kind);
  let idx=arr.length;
  const i=arr.findIndex(x=>x.kind===beforeKind); if(i>=0) idx=i;
  arr.splice(idx,0,c); cols=arr; cols.forEach((x,j)=>x.ord=j);
  markDirty(); drag=null; render(); hint('已调整栏目顺序。保存后生效。');
}

/* ===== 编辑动作 ===== */
async function addNode(kind){
  const name=await uiPrompt('新增「'+titleOf(kind)+'」','节点名称：',''); if(!name) return;
  const dup=nodes.find(n=>n.kind===kind && n.name.trim().toLowerCase()===name.trim().toLowerCase());
  if(dup){ const st=dup.status==='待确认'?'（它目前是“待确认”，勾选顶部「显示待确认」可见）':'';
    return uiConfirm('已存在同名节点','「'+esc(titleOf(kind))+'」列下已有 <span class="em">'+esc(dup.name)+'</span> '+st+'，未重复添加。',{okText:'知道了'}); }
  const id=kind+':'+name+':'+Math.random().toString(36).slice(2,5);
  nodes.push({id,kind,name,status:'明确',source:'',note:'',image:'',ord:nodes.filter(n=>n.kind===kind).length});
  selNodes=new Set([id]); selEdges.clear(); markDirty(); render();
  hint('已添加「'+name+'」（默认“明确”）。如需标为待确认，点上方「标记待确认」。');
}
async function addColumn(){
  if(locked) return hint('画布已锁定：先解锁再编辑');
  const title=await uiPrompt('新增栏目','栏目名称：',''); if(!title) return;
  let kind=title, n=1; while(cols.some(c=>c.kind===kind)) kind=title+'#'+(++n);
  cols.push({kind,title,ord:cols.length}); markDirty(); render();
  hint('已新增栏目「'+title+'」。可拖栏目头调整顺序，保存后生效。');
}
async function delColumn(kind){
  if(cols.length<=1) return uiConfirm('不能删除栏目','至少要保留一个栏目（否则画布无处安放节点）。',{okText:'知道了'});
  const cnt=nodes.filter(n=>n.kind===kind).length;
  if(!await uiConfirm('删除栏目','删除栏目「'+esc(titleOf(kind))+'」'+(cnt?('，其下 <span class="em">'+cnt+' 个节点</span>及它们的连线会一并删除'):'')+'？<br><span class="muted">保存后生效；不可恢复（可刷新丢弃草稿）。</span>',{danger:true,okText:'删除'})) return;
  cols=cols.filter(c=>c.kind!==kind); cols.forEach((c,i)=>c.ord=i);
  if(selCol===kind) selCol=null;
  nodes=nodes.filter(n=>n.kind!==kind);
  const ids=new Set(nodes.map(n=>n.id)); edges=edges.filter(e=>ids.has(e.from_id)&&ids.has(e.to_id));
  selNodes.clear(); selEdges.clear(); markDirty(); render();
}
async function delNode(id){ const n = id ? byId(id) : primaryNode(); if(!n) return;
  const cnt=edges.filter(e=>e.from_id===n.id||e.to_id===n.id).length;
  if(!await uiConfirm('删除节点','确认删除 <span class="em">'+esc(n.name)+'</span>？'
    +'<br><span class="muted">相连的 '+cnt+' 条线会一并删除；保存后生效。</span>',{danger:true,okText:'删除'})) return;
  nodes=nodes.filter(x=>x.id!==n.id); edges=edges.filter(e=>e.from_id!==n.id&&e.to_id!==n.id);
  selNodes.clear(); selEdges.clear(); markDirty(); render(); }
function delEdge(e){ if(!e) return; edges=edges.filter(x=>x.id!==e.id); selEdges.delete(e.id); markDirty(); render(); }

/* ===== 行内改名（Enter/失焦提交，Esc 取消，不弹窗） ===== */
function inlineEdit(host, initial, onCommit){
  if(!host || host.querySelector('.rename-input')) return;
  const inp=document.createElement('input'); inp.type='text'; inp.className='rename-input'; inp.value=initial;
  host.textContent=''; host.appendChild(inp);
  inp.focus(); inp.select();
  let done=false;
  const finish=(commit)=>{ if(done) return; done=true; activeEdit=null;
    const v=inp.value.trim();
    if(commit && v && v!==initial) onCommit(v);
    render(); };
  inp.addEventListener('mousedown',e=>e.stopPropagation());
  inp.addEventListener('click',e=>e.stopPropagation());
  inp.addEventListener('keydown',e=>{ e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); finish(true); }
    else if(e.key==='Escape'){ e.preventDefault(); finish(false); } });
  inp.addEventListener('blur',()=>finish(true));
  activeEdit={ inp, finish };
}
// 点编辑器之外任何地方 → 提交并收掉。
// 必须有这一层：画布/框选等的 mousedown 会 preventDefault，导致输入框收不到 blur，编辑器会卡住。
document.addEventListener('mousedown',ev=>{
  if(!activeEdit) return;
  if(activeEdit.inp===ev.target) return;
  activeEdit.finish(true);
}, true);
function startRenameNode(id){ if(locked) return hint('画布已锁定：先解锁再编辑');
  const n=byId(id); if(!n) return;
  const el=graphEl.querySelector('.node[data-id="'+CSS.escape(id)+'"]'); if(!el) return;
  const nm=el.querySelector('.nm'); if(!nm) return;
  inlineEdit(nm, n.name, v=>{
    const dup=nodes.find(x=>x.id!==n.id && x.kind===n.kind && x.name.trim().toLowerCase()===v.toLowerCase());
    if(dup){ hint('「'+titleOf(n.kind)+'」列下已有「'+dup.name+'」，未改动。'); return; }
    n.name=v; markDirty(); toast('已改名：'+v);
  });
}
function startRenameCol(kind){ if(locked) return hint('画布已锁定：先解锁再编辑');
  const c=cols.find(x=>x.kind===kind); if(!c) return;
  const head=graphEl.querySelector('.col-head[data-kind="'+CSS.escape(kind)+'"]'); if(!head) return;
  const sp=head.querySelector('.ctitle'); if(!sp) return;
  inlineEdit(sp, c.title, v=>{ c.title=v; markDirty(); toast('栏目已改名：'+v); });
}

/* ===== 备注 / 标签 ===== */
async function openAnno(id){
  const n=byId(id); if(!n) return;
  const namesBefore=tagsOf(n);
  const fields=[
    {key:'note', label:'备注（默认折叠，点节点上的 📝 展开）', value:(n.note||''), multiline:true, ph:'补充说明、口径、待确认点…'},
  ];
  tagTypes.forEach((ty,ti)=>{                       // 每个类型一个输入框：同一个词写进多个框 = 同时属于这些类型
    fields.push({ key:'ty'+ti, dot:ty.color||'#2563EB',
      label:'标签 · '+ty.name+'（多个用逗号分隔，也可点下面的已有标签）',
      value:namesBefore.filter(t=>typesOfTag(n,t).includes(ty.name)).join('，'),
      multiline:true, rows:2, grow:true, enterSubmit:true, chips:namesOfType(ty.name),
      ph:'用逗号分隔，如：核心，实验' });
  });
  fields.push({ key:'untyped',
    label:tagTypes.length?'未分类标签（多个用逗号分隔，也可点下面的已有标签）':'标签（多个用逗号分隔，如：核心，实验）',
    value:namesBefore.filter(t=>!typesOfTag(n,t).length).join('，'), ph:'核心，实验',
    multiline:true, rows:2, grow:true, enterSubmit:true, chips:untypedTags() });
  const v=await uiForm('备注 / 标签 · '+n.name, fields);
  if(!v) return;
  n.note=String(v.note||'').trim();
  /* 归属（2026-10-26 放开同名跨类型）：同一个词写进几个类型框，就**同时属于**这几个类型，不再互相搬运。
     「未分类」框只装不属于任何类型的词；同一个词两个框都写了 → 以类型为准。
     顺序：以节点原有的标签顺序为基准（只改备注时存下来的串逐字符不变），新增的追加到末尾。 */
  const assign={};                                  // 名字 → [类型...]；空数组 = 未分类
  tagTypes.forEach((ty,ti)=>splitTags(v['ty'+ti]).forEach(t=>{
    if(!assign[t]) assign[t]=[];
    if(!assign[t].includes(ty.name)) assign[t].push(ty.name);
  }));
  splitTags(v.untyped).forEach(t=>{ if(assign[t]===undefined) assign[t]=[]; });   // 写进「未分类」= 显式不带类型
  const kept=namesBefore.filter(t=>assign[t]!==undefined);
  Object.keys(assign).forEach(t=>{ if(!kept.includes(t)) kept.push(t); });
  const added=[], dropped=[];
  Object.keys(assign).forEach(t=>{
    const prev=typesOfTag(n,t), next=assign[t];
    if(!namesBefore.includes(t)) added.push('「'+t+'」'+(next.length?next.join('/'):'未分类'));
    else{
      const gain=next.filter(x=>!prev.includes(x)), lost=prev.filter(x=>!next.includes(x));
      if(gain.length) added.push('「'+t+'」+'+gain.join('/'));
      if(lost.length) dropped.push('「'+t+'」-'+lost.join('/'));
    }
  });
  namesBefore.filter(t=>assign[t]===undefined).forEach(t=>dropped.push('「'+t+'」'));
  const tt={};
  kept.forEach(t=>{ tt[t]=assign[t]||[]; });         // 每个名字都显式写（含 []），"缺键＝老数据兜底"随之失效
  n.tags=kept.join(',');                             // 存储格式不变：仍是逗号串
  n.tagtypes=JSON.stringify(tt);
  if(showNotes && n.note) expandedNotes.add(n.id);   // 总开关开着时，刚写的备注立刻展开
  if(!n.note) expandedNotes.delete(n.id);            // 备注清空了就顺手去掉展开态
  markDirty(); render();
  const brief=x=>x.slice(0,3).join('、')+(x.length>3?(' 等 '+x.length+' 项'):'');
  toast((added.length||dropped.length)
    ? ('标签已更新：'+[added.length?('+'+brief(added)):'', dropped.length?('-'+brief(dropped)):''].filter(Boolean).join(' '))
    : '已更新备注/标签');
}

/* ===== 栏目配色（2026-10-21）：每张画布各一套，存 canvases.color ===== */
function applyHeadColor(){ const r=document.documentElement;
  if(headColor) r.style.setProperty('--colhead', headColor); else r.style.removeProperty('--colhead'); }
// 画布级设置一次性落地（标签类型 / 归属 / 栏目配色 / 节点样式）——load 与 8 秒轮询共用
function applyCanvasMeta(g){
  tagTypes=((g&&g.tagTypes)||[]).slice().sort((a,b)=>(a.ord??0)-(b.ord??0));
  tagDefs=(g&&g.tagDefs)||{};
  headColor=(g&&g.headColor)||'';
  styleCfg=Object.assign({}, STYLE_DEFAULTS, (g&&g.style)||{});
  applyHeadColor(); applyStyle();
}

/* ===== 样式（2026-10-21）：栏目头 / 节点名称 / 选中 / 链路 / 连线 都可调，当前值为默认、可一键恢复 =====
   画布级：存 canvases.style（栏目底色仍存 canvases.color）；随「保存」落库、进版本、复制画布带走 */
const STYLE_DEFAULTS={ colSize:'13px', colWeight:'700', colColor:'#FFFFFF',
  nmSize:'11.5px', nmWeight:'600', nmColor:'#1F2328',
  selColor:'#C2255C', selRing:'2px', selBg:'#FFFFFF',
  chainColor:'#D76A8E', chainRing:'1px', chainBg:'#FBEDF2',
  edgeColor:'#E67E22' };
const PALE_COLORS=['#FFFFFF','#F7FAFF','#F0F7FF','#EAF4FB','#EEF8F1','#F0FBF4','#FFF8EC','#FFF3E0',
  '#FDF0F3','#FCEEF2','#F4EFFE','#F6F6F4'];
let styleCfg=Object.assign({}, STYLE_DEFAULTS);   // 画布级：从 /api/graph 的 style 读，随「保存」落库
function applyStyle(){
  const r=document.documentElement.style;
  r.setProperty('--col-size',styleCfg.colSize);
  r.setProperty('--col-weight',styleCfg.colWeight);
  r.setProperty('--col-fg',styleCfg.colColor);
  r.setProperty('--nm-size',styleCfg.nmSize);
  r.setProperty('--nm-weight',styleCfg.nmWeight);
  r.setProperty('--nm-color',styleCfg.nmColor);
  r.setProperty('--sel',styleCfg.selColor);
  r.setProperty('--sel-ring',styleCfg.selRing);
  r.setProperty('--sel-bg',styleCfg.selBg);
  r.setProperty('--sel-lt',styleCfg.chainColor);
  r.setProperty('--chain-ring',styleCfg.chainRing);
  r.setProperty('--chain-bg',styleCfg.chainBg);
  r.setProperty('--edge',styleCfg.edgeColor);
}
function setStyle(k,v){ styleCfg[k]=v; applyStyle(); markDirty(); renderStylePanel(); }   // 进草稿 + 撤销栈，点保存才落库
// 栏目底色不在 styleCfg 里（存 canvases.color），统一出口，免得两个事件处理器各写一遍
function setHeadColorValue(v){ headColor=v||''; applyHeadColor(); markDirty(); renderStylePanel(); }
function applyStyleField(k,v){ if(k==='headColor') setHeadColorValue(v); else setStyle(k,v); }
function resetStyle(){
  styleCfg=Object.assign({}, STYLE_DEFAULTS);
  headColor='';                              // 栏目底色存在 canvases.color，不在 styleCfg 里，必须单独清
  applyStyle(); applyHeadColor(); markDirty(); renderStylePanel();
  toast('已恢复默认样式（点保存后对所有人生效）');
}
let stylePanelEl=null;
function renderStylePanel(){
  if(!stylePanelEl || !document.body.contains(stylePanelEl)) return;
  const PAL=TAG_PALETTE.map(x=>x[0]);
  const curOf=k=>k==='headColor' ? (headColor||'#0E8FB8') : styleCfg[k];
  const sw=(k,label,pal)=>'<div class="srow"><span class="sk">'+label+'</span><span class="swatches">'
    + (pal||PAL).map(c=>'<i data-k="'+k+'" data-c="'+c+'" class="'+(String(curOf(k)).toLowerCase()===c.toLowerCase()?'on':'')+'" style="background:'+c+'"></i>').join('')
    + '<label class="pickcol" title="自定义颜色（'+(curOf(k)||'')+'）"><input type="color" data-k="'+k+'" value="'
    + (/^#[0-9a-fA-F]{6}$/.test(String(curOf(k)))?curOf(k):'#FFFFFF')+'"></label>'
    + '</span><i class="curdot" style="background:'+esc(curOf(k))+'" title="当前 '+esc(curOf(k))+'"></i></div>';
  const sel=(k,label,opts)=>'<div class="srow"><span class="sk">'+label+'</span><select data-k="'+k+'">'
    + opts.map(o=>'<option value="'+o[0]+'"'+(styleCfg[k]===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select></div>';
  stylePanelEl.innerHTML =
      '<div class="sgroup">栏目头</div>'
    + sw('headColor','底色',PAL)
    + sw('colColor','字色',PALE_COLORS)
    + sel('colSize','字号',[['12px','12'],['13px','13'],['14px','14'],['15px','15']])
    + sel('colWeight','字重',[['600','半粗'],['700','粗']])
    + '<div class="sgroup">节点名称</div>'
    + sel('nmSize','字号',[['10px','10'],['11px','11'],['11.5px','11.5'],['12px','12'],['13px','13'],['14px','14']])
    + sel('nmWeight','字重',[['400','常规'],['600','半粗'],['700','粗']])
    + sw('nmColor','颜色')
    + '<div class="sgroup">选中节点</div>'
    + sw('selColor','环色')
    + sel('selRing','环宽',[['1px','1'],['2px','2'],['3px','3'],['4px','4']])
    + sw('selBg','底色',PALE_COLORS)
    + '<div class="sgroup">链路节点</div>'
    + sw('chainColor','环色')
    + sel('chainRing','环宽',[['1px','1'],['2px','2'],['3px','3']])
    + sw('chainBg','底色',PALE_COLORS)
    + '<div class="sgroup">连线</div>'
    + sw('edgeColor','颜色');
}
function openStyle(){
  pending=null;
  _open('<h3>样式 · 当前画布</h3>'
    + '<div class="body"><div class="muted" style="font-size:11px;line-height:1.7;margin-bottom:8px">'
    + '改完<b>立即预览</b>；属于<b>这张画布</b>，点「保存」后才对所有人生效（可 Ctrl+Z 撤销）。</div>'
    + '<div id="stylepanel"></div></div>'
    + '<div class="foot"><button class="btn ghost" id="st-reset">恢复默认</button><span class="sp"></span>'
    + '<button class="btn" id="st-close">关闭</button></div>');
  stylePanelEl=document.getElementById('stylepanel');
  renderStylePanel();
  stylePanelEl.addEventListener('click',ev=>{
    const i=ev.target.closest('i[data-k]'); if(!i) return;
    applyStyleField(i.dataset.k, i.dataset.c);
  });
  stylePanelEl.addEventListener('change',ev=>{
    const s=ev.target.closest('select[data-k]'); if(s){ setStyle(s.dataset.k, s.value); return; }
    const ci=ev.target.closest('input[type=color][data-k]');
    if(ci) applyStyleField(ci.dataset.k, ci.value);
  });
  document.getElementById('st-reset').onclick=()=>resetStyle();
  document.getElementById('st-close').onclick=()=>_close(null);
}
applyStyle();

/* ===== 标签类型管理（2026-10-21）=====
   类型 = 标签的维度（类别 / 阶段…），决定 chip 颜色；同一个词可以同时属于多个类型（在每个类型的框里各写一次），节点上会显示成多个同名不同色的 chip。
   删除类型不会删节点上的标签——只取消归属，标签回落「未分类」。 */
function openTagTypes(){
  if(role==='ro') return hint('只读账号：不能改标签类型');
  let openPal=null, delArm='';
  pending=null;
  _open('<h3>标签类型</h3>'
    + '<div class="body"><div class="muted" style="font-size:11px;line-height:1.7;margin-bottom:6px">'
    + '类型是标签的维度（如「类别」「阶段」），每类一种颜色。给节点打标签时按类型分输入框，新词自动归到该类型；'
    + '<b>同一个词可以同时属于多个类型</b>（在各类型的框里都写一次即可），颜色与筛选按类型各算各的；'
    + '<b>改名点 ✎</b>（已归到该类型的标签会跟着走）；'
    + '没归类的标签仍是「未分类」，用灰色显示。</div>'
    + '<div id="ttlist"></div>'
    + '<div style="margin-top:8px"><button class="btn ghost" id="ttadd">＋ 新建类型</button></div></div>'
    + '<div class="foot"><span class="muted sp">改完点「保存」才写入版本</span><button class="btn" id="ttclose">关闭</button></div>');
  const list=document.getElementById('ttlist');
  const countOfType=name=>namesOfType(name).length;      // 该类型下的标签名数（同名词挂多类型时各算一次）

  function renderTT(){
    list.innerHTML = tagTypes.length ? tagTypes.map((ty,i)=>{
      const c=ty.color||'#2563EB';
      return '<div class="ttrow" data-n="'+esc(ty.name)+'">'
        + '<i class="sw" data-a="color" style="background:'+esc(c)+'" title="点它换颜色"></i>'
        + '<span class="tn" title="点它也能改名">'+esc(ty.name)+'</span>'
        + '<span class="tc">'+countOfType(ty.name)+' 个标签</span>'
        + '<span class="tact">'
        +   '<button data-a="name" title="改名">✎</button>'
        +   '<button data-a="up"'+(i?'':' disabled')+'>↑</button>'
        +   '<button data-a="down"'+(i<tagTypes.length-1?'':' disabled')+'>↓</button>'
        +   '<button data-a="del" class="'+(delArm===ty.name?'danger':'')+'">'+(delArm===ty.name?'确认删除':'✕')+'</button>'
        + '</span></div>'
        + (openPal===ty.name ? '<div class="palrow">'+TAG_PALETTE.map(([col,nm])=>
            '<i data-c="'+col+'" title="'+nm+'" class="'+(col.toLowerCase()===c.toLowerCase()?'on':'')+'" style="background:'+col+'"></i>').join('')+'</div>' : '');
    }).join('') : '<div class="muted" style="font-size:12px;padding:6px 0">还没有类型。建一个（如「类别」「阶段」），再到节点上把标签归进去。</div>';
  }
  function startRenameTT(row,name){
    const tn=row.querySelector('.tn'); if(!tn) return;
    const inp=document.createElement('input'); inp.type='text'; inp.className='rename-input'; inp.value=name;
    tn.textContent=''; tn.appendChild(inp); inp.focus(); inp.select();
    let done=false;
    const finish=commit=>{ if(done) return; done=true;
      const v=inp.value.trim();
      if(!commit || !v || v===name){ renderTT(); return; }
      if(tagTypes.some(t=>t.name===v)){ toast('已有同名类型：'+v); renderTT(); return; }
      const ty=tagTypes.find(t=>t.name===name); if(!ty){ renderTT(); return; }
      ty.name=v;
      retypeNodes(name,v);                                                       // 节点级归属跟着改名走
      Object.keys(tagDefs).forEach(k=>{ if(tagDefs[k]===name) tagDefs[k]=v; });   // 老数据兜底表也改（回滚可见）
      if(tagFilter && tagFilter.k==='type' && tagFilter.v===name) tagFilter.v=v;
      if(tagFilter && tagFilter.k==='tag' && tagFilter.ty===name) tagFilter.ty=v;   // 进行中的「按标签」筛选也要跟着改名，否则会静默失效
      markDirty(); render(); renderTT();
    };
    inp.addEventListener('mousedown',e=>e.stopPropagation());
    inp.addEventListener('click',e=>e.stopPropagation());
    inp.addEventListener('keydown',e=>{ e.stopPropagation();
      if(e.key==='Enter'){ e.preventDefault(); finish(true); }
      else if(e.key==='Escape'){ e.preventDefault(); finish(false); } });
    inp.addEventListener('blur',()=>finish(true));
  }
  list.addEventListener('click',ev=>{
    ev.stopPropagation();
    if(ev.target.closest('.palrow')){                       // 展开的色板里选色
      const col=ev.target.dataset.c; if(!col) return;
      const ty=tagTypes.find(t=>t.name===openPal);
      if(ty){ ty.color=col; markDirty(); render(); }
      openPal=null; renderTT(); return;
    }
    const row=ev.target.closest('.ttrow'); if(!row) return;
    const name=row.dataset.n;
    if(ev.target.closest('.tn')){ startRenameTT(row,name); return; }   // 直接点类型名也能改名
    const a=ev.target.dataset.a; if(!a) return;
    if(a==='color'){ openPal = openPal===name ? null : name; renderTT(); return; }
    if(a==='name'){ startRenameTT(row,name); return; }
    if(a==='up' || a==='down'){
      const i=tagTypes.findIndex(t=>t.name===name), j=a==='up'?i-1:i+1;
      if(i<0||j<0||j>=tagTypes.length) return;
      const t=tagTypes[i]; tagTypes[i]=tagTypes[j]; tagTypes[j]=t;
      tagTypes.forEach((x,k)=>{ x.ord=k; });
      markDirty(); render(); renderTT(); return;
    }
    if(a==='del'){
      if(delArm!==name){ delArm=name; renderTT();          // 两步确认：破坏性操作不弹窗打断，但也不能一点就没
        setTimeout(()=>{ if(delArm===name){ delArm=''; renderTT(); } },3000); return; }
      tagTypes=tagTypes.filter(t=>t.name!==name);
      retypeNodes(name,null);                                                    // 只取消归属：节点上的标签保留
      Object.keys(tagDefs).forEach(k=>{ if(tagDefs[k]===name) tagDefs[k]=''; });   // 老数据兜底表同上
      delArm=''; openPal=null;
      if(tagFilter && tagFilter.k==='type' && tagFilter.v===name) tagFilter=null;
      if(tagFilter && tagFilter.k==='tag' && tagFilter.ty===name) tagFilter=null;
      markDirty(); render(); renderTT(); toast('已删除类型「'+name+'」，其下标签变为未分类');
    }
  });
  document.getElementById('ttadd').onclick=ev=>{
    ev.stopPropagation();
    let name='新类型', k=1; while(tagTypes.some(t=>t.name===name)) name='新类型'+(++k);
    tagTypes.push({name, color:nextTypeColor(), ord:tagTypes.length});
    markDirty(); render(); renderTT();
    const row=list.querySelector('.ttrow[data-n="'+CSS.escape(name)+'"]');
    if(row) startRenameTT(row,name);
  };
  document.getElementById('ttclose').onclick=()=>_close(null);
  renderTT();
  return null;
}

/* ===== 同栏分组（虚线框，纯视觉，不参与连线） ===== */
async function setGroup(){
  const ids=[...selNodes].filter(byId);
  if(!ids.length) return hint('先选中节点（Ctrl/框选可多选）再设为分组');
  const kinds=new Set(ids.map(id=>byId(id).kind));
  if(kinds.size>1) return hint('分组只在同一栏内：当前选中的节点跨了 '+kinds.size+' 个栏目，请只选同一栏的节点。');
  const kind=[...kinds][0];
  const exist=[...new Set(nodes.filter(n=>n.kind===kind && n.grp).map(n=>n.grp))];
  const g=await uiPrompt('设为分组（'+titleOf(kind)+'）','组名（这些节点会被虚线框圈住、并归拢到一起）：','', false, exist);
  if(!g) return;
  ids.forEach(id=>{ const n=byId(id); if(n) n.grp=g; });
  const all=nodes.filter(n=>n.kind===kind).sort(byOrd);          // 归拢连续：插到第一个成员原来的位置
  const members=all.filter(n=>ids.includes(n.id)), others=all.filter(n=>!ids.includes(n.id));
  const first=all.find(n=>ids.includes(n.id));
  const pos=all.slice(0, all.indexOf(first)).filter(n=>!ids.includes(n.id)).length;
  [...others.slice(0,pos), ...members, ...others.slice(pos)].forEach((n,i)=>{ n.ord=i; });
  markDirty(); render(); hint('已把 '+members.length+' 个节点归入分组「'+g+'」（保存后生效）');
}
function clearGroup(){
  const ids=[...selNodes].filter(byId);
  if(!ids.length) return hint('先选中要取消分组的节点');
  const affected=new Set(ids.map(id=>byId(id)).filter(n=>n.grp).map(n=>n.kind+'\u0000'+n.grp));
  if(!affected.size) return hint('选中的节点没有分组');
  ids.forEach(id=>{ const n=byId(id); if(n) n.grp=''; });
  affected.forEach(k=>{ const [kind,g]=k.split('\u0000');            // 组内只剩 <2 个成员 → 整组散开
    const rest=nodes.filter(n=>n.kind===kind && n.grp===g);
    if(rest.length<2) rest.forEach(n=>{ n.grp=''; }); });
  markDirty(); render(); hint('已取消分组（保存后生效）');
}

/* ===== 状态 / 连线模式 / 右键菜单 ===== */
function toggleStatus(id){
  const list = id ? [byId(id)].filter(Boolean) : [...selNodes].map(byId).filter(Boolean);
  if(!list.length) return;
  const next = list.every(n=>n.status==='待确认') ? '明确' : '待确认';   // 全都"待确认"→一起转"明确"，否则一律转"待确认"
  list.forEach(n=>{ n.status=next; });
  const who = list.length===1 ? ('「'+list[0].name+'」') : (list.length+' 个节点');
  if(next==='待确认' && !showAll){ showAll=true; document.getElementById('chk-all').checked=true;
    hint(who+'已标为“待确认”，已自动显示。保存后生效。'); }
  else hint(who+'已标为“'+next+'”（保存后生效）。');
  markDirty(); render(); }
function toggleLink(id){ const n = id ? byId(id) : primaryNode(); if(!n) return;
  if(connFrom===id){ connFrom=null; hint('已退出连线模式'); paint(); return; }
  connFrom=id; hint('连线模式：从「'+n.name+'」出发 —— 点目标节点=连线，再点同一个=取消；可连多个。Esc / 点空白 / 再点起点 结束。'); paint(); }
function openNodeCtx(x,y,id){
  const n=byId(id); if(!n) return;
  if(!selNodes.has(id)){ selNodes=new Set([id]); selEdges.clear(); paint(); }
  const pend=n.status==='待确认';
  openCtx(x,y,[
    {id:'rename', label:'改名', key:'Enter', run:()=>startRenameNode(id)},
    {id:'anno',   label:'备注 / 标签', run:()=>openAnno(id)},
    {id:'status', label:pend?'标记明确':'标记待确认', key:'T', run:()=>toggleStatus(id)},
    '-',
    {id:'link',   label:connFrom===id?'结束连线':'从此节点连线', key:'L', run:()=>toggleLink(id)},
    {id:'flow',   label:n.image?'流程图（查看 / 替换 / 移除）':'上传流程图', run:()=>flowAction()},
    '-',
    {id:'group',  label:'设为分组', run:()=>setGroup()},
    {id:'ungroup',label:'取消分组', run:()=>clearGroup()},
    '-',
    {id:'del',    label:'删除节点', key:'Delete', danger:true, run:()=>delNode(id)},
  ]);
}
function toggleEdgeStatus(eid){
  const list = eid ? [edges.find(e=>e.id===eid)].filter(Boolean) : edges.filter(e=>selEdges.has(e.id));
  if(!list.length) return;
  const next = list.every(e=>e.status==='待确认') ? '明确' : '待确认';   // 同节点：全待确认→一起转明确，否则一律待确认
  list.forEach(e=>{ e.status=next; });
  hint((list.length===1?'连线':list.length+' 条连线')+'已标为“'+next+'”（保存后生效）。');
  markDirty(); render();
}
function openEdgeCtx(x,y,eid){
  const e=edges.find(v=>v.id===eid); if(!e) return;
  openCtx(x,y,[
    {id:'st',  label:e.status==='待确认'?'标记明确':'标记待确认', key:'T', run:()=>toggleEdgeStatus(eid)},
    {id:'del', label:'删除连线', danger:true, run:()=>delEdge(e)},
  ]);
}

/* ===== 流程图 ===== */
function pickFile(cb){
  const inp=document.getElementById('file'); inp.value='';
  inp.onchange=async()=>{ const f=inp.files[0]; if(!f) return;
    if(f.size>10*1024*1024) return uiConfirm('图片过大','超过 10MB，请压缩后再上传。',{okText:'知道了'});
    const dataUrl=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(f); });
    try{ const {url}=await api('POST','/api/upload',{dataUrl}); cb(url); }catch(e){ uiConfirm('上传失败',esc(e.message),{okText:'知道了'}); }
  };
  inp.click();
}
function setImageFor(id,url){ const n=byId(id); if(!n) return; n.image=url; markDirty(); render(); }
function setImage(url){ const n=primaryNode(); if(!n) return; setImageFor(n.id,url); }
async function flowAction(){
  const n=primaryNode(); if(!n) return;
  if(n.image){
    const act=await uiChoose('流程图 · '+n.name,'该节点已挂流程图：',
      [{label:'查看大图',value:'view',cls:''},{label:'更换',value:'replace',cls:'ghost'},
       {label:'移除',value:'remove',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
    if(act==='view') return uiLightbox(imgUrl(n.image),n.name+' · 流程图');
    if(act==='replace') return pickFile(setImage);
    if(act==='remove'){ if(await uiConfirm('移除流程图','确定移除「'+esc(n.name)+'」的流程图？',{danger:true,okText:'移除'})) setImage(''); }
  } else { hint('选择图片后上传并挂到「'+n.name+'」（保存后生效）'); pickFile(setImage); }
}

/* ===== 导出表格 ===== */
function dl(name, rows){
  const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const lines=rows.map(r=>r.map(q).join(','));
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}
/* 链路表：一行 = 一条"从第一个栏目出发、按栏目顺序向右连出去"的完整链路。
   与高亮同口径：**忽略连线箭头方向**，只按栏目先后（左→右）走。
   （旧实现按"箭头方向 + 向右跨栏"筛，遇到"交付物 → 依赖"这类反向连线会一条都导不出来。） */
function enumerateChains(maxPaths=5000){
  const out=new Map();
  edges.forEach(e=>{ const A=byId(e.from_id),B=byId(e.to_id); if(!A||!B) return;
    const ca=colIdxOf(A.kind), cb=colIdxOf(B.kind);
    if(ca<0||cb<0||ca===cb) return;                    // 同栏 / 未知栏：不参与连线表
    const [l,r]= ca<cb ? [e.from_id,e.to_id] : [e.to_id,e.from_id];   // 左→右
    if(!out.has(l)) out.set(l,[]); out.get(l).push(r); });
  const firstKind = cols.length ? cols[0].kind : null;
  // 起点：必须是【第一个栏目】里、且至少有一条向右连线的节点
  const starts = nodes.filter(n=>n.kind===firstKind && (out.get(n.id)||[]).length);
  const paths=[]; let truncated=false;
  const walk=(id,path)=>{ if(paths.length>=maxPaths){truncated=true;return;}
    const tos=out.get(id)||[];
    if(!tos.length){ if(path.length>1) paths.push(path.slice()); return; }   // 至少连出去一次才导出
    for(const t of tos){ path.push(t); walk(t,path); path.pop(); if(truncated) return; } };
  starts.forEach(s=>walk(s.id,[s.id]));
  return {paths,truncated};
}
async function doExport(){
  const {paths,truncated}=enumerateChains();
  if(!paths.length) return uiConfirm('没有可导出的链路',
    '当前没有「从第一个栏目（'+esc(cols.length?cols[0].title:'—')+'）按栏目顺序向右连得出去」的链路。<br>'
    +'<span class="muted">判定口径：起点必须是第一个栏目里的节点，且至少向右连出去一次；'
    +'忽略连线画的箭头方向（按栏目先后走）。孤儿节点、以及不是从第一个栏目连过来的节点，都不导出。</span>',{okText:'知道了'});
  const rows=[cols.map(c=>c.title)];               // 表头 = 各栏目
  paths.forEach(p=>{ const cells=cols.map(()=>'');
    p.forEach(id=>{ const n=byId(id); if(!n) return; const ci=colIdxOf(n.kind); if(ci>=0) cells[ci]=n.name; });
    rows.push(cells); });
  dl('多维关系画布_链路表.csv', rows);
  if(truncated) uiConfirm('提示','链路过多（超过 5000 条），已截断。请先补全连线或缩小范围。',{okText:'知道了'});
}

/* ===== 导出图片（2026-10-21）=====
   零依赖：自己用 Canvas 2D 重画一遍（节点框 / 名称 / 标签胶囊 / 分组框 / 栏目头 / 连线），
   而不是截屏 —— 好处：不受当前缩放影响、选中/置灰等临时状态不会带进图里。
   格式选 PNG：这类图是纯色块 + 细线 + 小字，JPG 的压缩噪点会让字边发毛、线条发虚，而 PNG 无损且体积反而更小。 */
function expRound(ctx,x,y,w,h,r){
  r=Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}
function expFit(ctx,text,maxW){ if(!text) return '';
  if(ctx.measureText(text).width<=maxW) return text;
  let s=text; while(s.length && ctx.measureText(s+'…').width>maxW) s=s.slice(0,-1);
  return s+'…'; }
function expWrap(ctx,text,maxW,maxLines){
  const out=[]; let line='';
  for(const ch of String(text||'')){
    if(ctx.measureText(line+ch).width>maxW && line){ out.push(line); line=ch; if(out.length===maxLines-1) break; }
    else line+=ch;
  }
  if(out.length<maxLines && line) out.push(line);
  if(out.length===maxLines){                                  // 末行放不下就截断
    let last=out[maxLines-1];
    if(ctx.measureText(last).width>maxW) out[maxLines-1]=expFit(ctx,last,maxW);
  }
  return out;
}
function loadImg(src){ return new Promise(res=>{ if(!src) return res(null);
  const im=new Image(); im.onload=()=>res(im); im.onerror=()=>res(null); im.src=src; }); }
async function buildExportCanvas(){
  const visIds=new Set(visibleNodes().map(n=>n.id));
  const nodeEls=[...graphEl.querySelectorAll('.node')].filter(el=>visIds.has(el.dataset.id));
  if(!nodeEls.length) return null;
  const colEls=[...graphEl.querySelectorAll('.col-head')];
  const grpEls=[...graphEl.querySelectorAll('.nodegroup')].filter(el=>el.querySelector('.node'));
  const boxes=[...nodeEls,...colEls,...grpEls].map(x=>toLayoutRect(x.getBoundingClientRect()));
  const PAD=24;
  const L=Math.min(...boxes.map(b=>b.l))-PAD, T=Math.min(...boxes.map(b=>b.t))-PAD;
  const R=Math.max(...boxes.map(b=>b.r))+PAD, B=Math.max(...boxes.map(b=>b.b))+PAD;
  const W=R-L, H=B-T, S=2;                                     // S=2：两倍分辨率，缩小时字也清楚
  const cv=document.createElement('canvas');
  cv.width=Math.round(W*S); cv.height=Math.round(H*S);
  const ctx=cv.getContext('2d');
  // 视觉常量集中在此（颜色优先取 CSS 变量）：改样式时只需动这里，不用在 200 行里找散落的色值
  const V=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const LOOK={ bg:V('--bg')||'#F5F8FF', warn:V('--warn')||'#B8801F',
    nodeBorder:'#D6DDE6', edge:V('--edge')||'#E67E22', grpEdge:'#7FB2E5', grpEdge2:'#C7DDF2', grpTitle:'#4A86C8' };
  ctx.scale(S,S); ctx.translate(-L,-T);
  ctx.fillStyle=LOOK.bg; ctx.fillRect(L,T,W,H);
  const FONT="'Microsoft YaHei','微软雅黑',sans-serif";
  // 流程图缩略图要先加载完才能画（<img> 的像素不进 canvas）
  const thumbs=nodeEls.map(el=>{ const t=el.querySelector('.nthumb'); return t?{box:toLayoutRect(t.getBoundingClientRect()),src:t.src}:null; });
  const imgs=await Promise.all(thumbs.map(t=>loadImg(t?t.src:'')));

  /* 1. 分组框（虚线） */
  grpEls.forEach(el=>{
    const r=toLayoutRect(el.getBoundingClientRect());
    ctx.save(); ctx.setLineDash([5,4]); ctx.lineWidth=1.5; ctx.strokeStyle=LOOK.grpEdge;
    expRound(ctx,r.l,r.t,r.r-r.l,r.b-r.t,8); ctx.stroke();
    ctx.fillStyle='rgba(127,178,229,.05)'; ctx.fill(); ctx.restore();
    const g=el.dataset.grp||''; ctx.font='bold 10px '+FONT;
    const tw=ctx.measureText(g).width+14;
    ctx.fillStyle='#fff'; ctx.strokeStyle=LOOK.grpEdge2; ctx.lineWidth=1;
    expRound(ctx,r.l+9,r.t-9,tw,15,8); ctx.fill(); ctx.stroke();
    ctx.fillStyle=LOOK.grpTitle; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillText(g, r.l+16, r.t-1.5);
  });

  /* 2. 连线（在节点下面）：直接用 SVG 的 d，坐标与节点同一套 layout 坐标 */
  svg.querySelectorAll('.edge').forEach(p=>{
    const d=p.getAttribute('d'); if(!d) return;
    const pend=p.classList.contains('pending');
    ctx.save();
    ctx.lineWidth=pend?1.2:1; ctx.strokeStyle=pend?LOOK.warn:LOOK.edge;
    ctx.globalAlpha=pend?.85:.5;
    if(pend) ctx.setLineDash([5,4]);
    ctx.stroke(new Path2D(d));
    ctx.restore();
  });

  /* 3. 节点：白底/待确认橙虚线 + 名称（最多两行）+ 标签胶囊 */
  nodeEls.forEach(el=>{
    const n=byId(el.dataset.id); if(!n) return;
    const r=toLayoutRect(el.getBoundingClientRect()), pad=8, inner=r.r-r.l-pad*2;
    const pend=n.status==='待确认';
    const NM=parseFloat(styleCfg.nmSize)||11.5, NMH=Math.round(NM*13)/10;   // 行高 ≈ 1.3
    ctx.save();
    ctx.lineWidth=1; ctx.strokeStyle=LOOK.nodeBorder;                        // 待确认不再用虚线边框（屏幕上已改成底部橙条）
    ctx.fillStyle='#fff';
    expRound(ctx,r.l,r.t,r.r-r.l,r.b-r.t,4); ctx.fill(); ctx.stroke();
    if(pend){ ctx.fillStyle=LOOK.warn; ctx.fillRect(r.l+1, r.b-3, (r.r-r.l)-2, 2); }   // 与屏幕一致的底部 2px 橙条
    ctx.restore();
    // 名称：字号/字重/颜色跟随「样式」设置（以前硬编码 11px，改了样式导出对不上）
    ctx.font=(styleCfg.nmWeight||600)+' '+NM+'px '+FONT; ctx.fillStyle=styleCfg.nmColor||'#1F2328';
    ctx.textAlign='left'; ctx.textBaseline='top';
    const lines=expWrap(ctx,n.name,inner-46,2);
    let ty=r.t+6;
    lines.forEach(ln=>{ ctx.fillText(ln,r.l+pad,ty); ty+=NMH*1.6; });
    if(pend){ ctx.font='9px '+FONT; ctx.fillStyle=LOOK.warn; ctx.fillText('待确认', r.r-pad-30, r.t+7); }
    // 标签类型名（每个类型一行的小字）：同样按 DOM rect 定位，导出图与屏幕一致
    el.querySelectorAll('.tname').forEach(tn=>{
      const tr2=toLayoutRect(tn.getBoundingClientRect()), ts=getComputedStyle(tn);
      if(!tr2.r-tr2.l) return;
      ctx.save(); ctx.font=(ts.fontWeight||'normal')+' '+parseFloat(ts.fontSize)+'px '+FONT;
      ctx.fillStyle=ts.color; ctx.textAlign='left'; ctx.textBaseline='middle';
      // 屏幕上超长类型名会被 CSS 省略号截断，导出时同样截断（否则会画到节点框外）
      ctx.fillText(expFit(ctx,tn.textContent,Math.max(8,(r.r-pad)-tr2.l)), tr2.l, (tr2.t+tr2.b)/2+.5); ctx.restore();
    });
    // 标签胶囊：直接用 DOM 里每个 chip 的 rect / 颜色，位置与屏幕一致
    el.querySelectorAll('.ntag').forEach(chip=>{
      const cr=toLayoutRect(chip.getBoundingClientRect()), cs=getComputedStyle(chip);
      ctx.save(); ctx.fillStyle=cs.backgroundColor; ctx.strokeStyle=cs.borderColor; ctx.lineWidth=1;
      expRound(ctx,cr.l,cr.t,cr.r-cr.l,cr.b-cr.t,8); ctx.fill(); ctx.stroke();
      ctx.font=(cs.fontWeight||'normal')+' '+parseFloat(cs.fontSize)+'px '+FONT; ctx.fillStyle=cs.color;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(chip.textContent, (cr.l+cr.r)/2, (cr.t+cr.b)/2+.5);
      ctx.restore();
    });
  });

  /* 3b. 节点上的流程图缩略图（等比装进它原来的框；加载失败的跳过） */
  thumbs.forEach((t,i)=>{ const im=imgs[i]; if(!t||!im||!im.naturalWidth) return;
    const x=t.box.l, y=t.box.t, w=t.box.r-t.box.l, h=t.box.b-t.box.t;
    ctx.save();
    ctx.fillStyle='#fff'; ctx.fillRect(x,y,w,h);
    const k=Math.min(w/im.naturalWidth, h/im.naturalHeight);
    const dw=im.naturalWidth*k, dh=im.naturalHeight*k;
    ctx.drawImage(im, x+(w-dw)/2, y+(h-dh)/2, dw, dh);
    ctx.strokeStyle='#BBDEFB'; ctx.lineWidth=1; ctx.strokeRect(x+.5,y+.5,w-1,h-1);
    ctx.restore();
  });

  /* 4. 栏目头（最后画，压在连线之上） */
  const headC=headColor||getComputedStyle(document.documentElement).getPropertyValue('--colhead').trim()||'#33506B';
  colEls.forEach(el=>{
    const r=toLayoutRect(el.getBoundingClientRect()), t=el.querySelector('.ctitle');
    ctx.fillStyle=headC;
    expRound(ctx,r.l,r.t,r.r-r.l,r.b-r.t,4); ctx.fill();
    ctx.font=(styleCfg.colWeight||700)+' '+(parseFloat(styleCfg.colSize)||13)+'px '+FONT;
    ctx.fillStyle=styleCfg.colColor||'#FFFFFF'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(expFit(ctx,t?t.textContent:'',(r.r-r.l)-10),(r.l+r.r)/2,(r.t+r.b)/2);
  });

  /* 5. 右下角水印 */
  ctx.font='10px '+FONT; ctx.fillStyle='rgba(120,130,145,.55)'; ctx.textAlign='right'; ctx.textBaseline='bottom';
  const nm=(canvases.find(c=>c.id===canvasId)||{}).name||'';
  ctx.fillText(nm+' · '+fmtTime(new Date().toISOString()).slice(0,16), R-8, B-6);
  return cv;
}
async function exportImage(){
  let cv=null;
  try{ cv=await buildExportCanvas(); }catch(e){ console.error(e); return uiConfirm('导出失败',esc(String(e&&e.message||e)),{okText:'知道了'}); }
  if(!cv) return hint('画布是空的，没有可导出的内容');
  cv.toBlob(b=>{
    if(!b) return uiConfirm('导出失败','图片生成失败，请重试。',{okText:'知道了'});
    const a=document.createElement('a');
    const d=new Date(), p=x=>String(x).padStart(2,'0');
    const stamp=d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes());
    const nm=((canvases.find(c=>c.id===canvasId)||{}).name||'画布').replace(/[\\/:*?"<>|]/g,'_');
    a.download=nm+'_'+stamp+'.png';
    const url=URL.createObjectURL(b);
    a.href=url;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 10000);   // 别立刻移除：个别浏览器会以为下载被取消
    toast('已导出 PNG（'+Math.round(b.size/1024)+' KB）');
  },'image/png');
}
/* ===== 保存 / 版本 ===== */
async function doSave(force){
  if(role==='ro') return hint('只读账号：不能保存');   // 前端先拦一道；服务端仍会 403
  try{
    // 兼容（2026-10-26）：另写一份「名字 → 第一个类型」到画布级 tagDefs。
    // 新版不靠它（归属在 nodes.tagtypes 里），但旧版页面 / 回滚到旧服务端时还认得类型。
    const legacyDefs={};
    nodes.forEach(n=>Object.entries(nodeTagTypes(n)).forEach(([name,ts])=>{
      if(Array.isArray(ts) && ts.length && !legacyDefs[name]) legacyDefs[name]=ts[0];
    }));
    const r=await api('POST','/api/save',{canvas:canvasId,nodes,edges,columns:cols,tagTypes,tagDefs:legacyDefs,headColor,style:styleCfg,note:'',baseRev:rev,force:!!force});
    rev=r.rev; setDirty(false); clearDraft(); updateRev(); hideExt();   // 自己刚存过 = 追上最新，提示条立即收
    toast('已保存（rev '+r.rev+'）');
  }catch(e){ if(e.code===409) return handleConflict(e.data); uiConfirm('保存失败',esc(e.message),{okText:'知道了'}); }
}
async function handleConflict(d){
  const c=await uiChoose('保存冲突','服务器上已有更新的版本（rev '+esc(String(d.rev))+'）。<br>你这次编辑基于旧版本，<span class="em">直接覆盖会丢掉别人的改动</span>。',
    [{label:'放弃我的改动，刷新到最新',value:'reload',cls:''},{label:'仍然强制覆盖',value:'force',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
  if(c==='reload'){ await load(); await uiConfirm('已刷新','已加载服务器最新版本，你的草稿已丢弃。',{okText:'好'}); }
  if(c==='force') await doSave(true);
}
async function openVersions(){
  let list; try{ list=await api('GET','/api/versions?canvas='+encodeURIComponent(canvasId)); }catch(e){ return uiConfirm('失败',esc(e.message),{okText:'知道了'}); }
  const vs=list.versions||[];
  const rows=vs.map(v=>`<div class="vrow"><div class="vmeta"><b>${esc(fmtTime(v.created_at))}</b> · ${esc(v.by||'—')} · ${v.n_nodes}节点/${v.n_edges}边</div>
    <div class="vnote">${esc(v.note||'')}</div>
    <div class="vact"><button class="btn ghost" data-v="view" data-id="${esc(v.id)}">查看</button>
    ${role==='ro'?'':'<button class="btn" data-v="restore" data-id="'+esc(v.id)+'">恢复</button>'}</div></div>`).join('');
  pending=null;
  _open(`<h3>版本历史（${vs.length}）</h3><div class="body">${rows||'<div class="muted">暂无版本</div>'}</div>
    <div class="foot"><span class="muted sp">「恢复」会把该版本内容作为<b>新版本</b>提交，历史不丢。</span><button class="btn" id="vclose">关闭</button></div>`);
  dialog.querySelector('#vclose').onclick=()=>_close(null);
  dialog.querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>{ const id=b.dataset.id;
    if(b.dataset.v==='view') viewVersion(id); else doRestore(id); });
}
async function viewVersion(id){
  let v; try{ v=await api('GET','/api/versions/'+encodeURIComponent(id)); }catch(e){ return uiConfirm('失败',esc(e.message),{okText:'知道了'}); }
  const cn=(v.columns&&v.columns.length?v.columns:cols);
  const groups=cn.map(c=>({t:c.title, names:(v.nodes||[]).filter(n=>n.kind===c.kind).map(n=>n.name)}));
  const body=groups.map(g=>`<div class="groupname">${esc(g.t)}（${g.names.length}）</div><div class="groupnodes">${esc(g.names.join('、')||'—')}</div>`).join('');
  pending=null;
  _open(`<h3>${esc(fmtTime(v.created_at))} 的版本</h3><div class="body">
    <div class="muted" style="margin-bottom:8px;">${esc(v.by||'—')} · ${esc(v.note||'')} · ${v.nodes.length}节点/${v.edges.length}边</div>${body}</div>
    <div class="foot"><button class="btn ghost" id="vback">返回列表</button><button class="btn" id="vclose2">关闭</button></div>`);
  dialog.querySelector('#vclose2').onclick=()=>_close(null);
  dialog.querySelector('#vback').onclick=openVersions;
}
async function doRestore(id){
  if(role==='ro') return hint('只读账号：不能恢复版本');
  if(!await uiConfirm('恢复版本','将该版本内容恢复为当前数据？<br><span class="muted">会作为<b>新版本</b>提交，历史版本保留。</span>',{okText:'恢复'})) return;
  try{ const r=await api('POST','/api/restore/'+encodeURIComponent(id),{baseRev:rev}); await load(); await uiConfirm('已恢复','已生成新版本（'+esc(r.versionId)+'）。',{okText:'好'}); }
  catch(e){
    if(e.code===409) return restoreConflict(id,e.data);
    uiConfirm('失败',esc(e.message),{okText:'知道了'});
  }
}
async function restoreConflict(id,d){
  const pick=await uiChoose('恢复冲突','服务器上已有更新的版本（rev '+esc(String((d&&d.rev)||'?'))+'）。<br>'
    +'你基于 rev '+rev+' 打开，<span class="em">直接恢复会覆盖别人刚保存的改动</span>。',
    [{label:'放弃，加载最新',value:'reload'},{label:'仍然恢复',value:'force',cls:'danger'},{label:'取消',value:null,cls:'ghost'}]);
  if(pick==='reload'){ await load(); return; }
  if(pick!=='force') return;
  try{ const r=await api('POST','/api/restore/'+encodeURIComponent(id),{baseRev:rev,force:true});
    await load(); await uiConfirm('已恢复','已生成新版本（'+esc(r.versionId)+'）。',{okText:'好'}); }
  catch(e2){ uiConfirm('失败',esc(e2.message),{okText:'知道了'}); }
}

/* ===== 事件 ===== */
function setLocked(v){
  locked=v;
  const b=document.getElementById('btn-lock'); b.classList.toggle('on',locked); b.textContent=locked?'已锁定':'锁定画布';
  if(locked && spaceDown){ spaceDown=false; graphEl.classList.remove('pan-mode'); wrapEl.classList.remove('pannable'); }
  hint(locked?'画布已锁定：滚轮/拖动/框选已停用（点选、右键菜单、顶部缩放仍可用）。再点一次解锁。':'画布已解锁。');
  render();
}
function toggleEditMode(){
  if(role==='ro') return hint('只读账号：不能进入编辑模式');
  editMode=!editMode;
  const be=document.getElementById('btn-edit');
  be.textContent='编辑模式：'+(editMode?'开':'关'); be.classList.toggle('on',editMode);
  if(!editMode){ connFrom=null; drag=null; selNodes.clear(); selEdges.clear(); hint(''); }
  else hint('编辑模式：拖栏目头换序、拖节点换序/换栏；空白处拖框可框选；右键节点出操作菜单。快捷键：N=新增 · Ctrl+↑/↓=挪位 · Ctrl+E=退出编辑 · Enter=改名 · Delete=删除 · T=标记待确认。');
  render();
}
document.getElementById('btn-edit').addEventListener('click',()=>toggleEditMode());
document.getElementById('btn-addcol').addEventListener('click',addColumn);
document.getElementById('btn-lock').addEventListener('click',()=>setLocked(!locked));
/* ===== 键盘移动选中：↑/↓ 在本栏目内上下；←/→ 跳到相邻栏目（取纵向中心最近的节点） ===== */
const nodeEl=(id)=>graphEl.querySelector('.node[data-id="'+CSS.escape(id)+'"]');
function nodeMidY(id){ const el=nodeEl(id); if(!el) return null; const q=el.getBoundingClientRect(); return (q.top+q.bottom)/2; }
function ensureVisible(id){                          // 选中的节点若移出视口，最小平移把它带回来
  const el=nodeEl(id); if(!el) return;
  const r=wrapEl.getBoundingClientRect(), q=el.getBoundingClientRect(), M=24;
  if(q.top    < r.top+M)      panY += (r.top+M) - q.top;
  else if(q.bottom > r.bottom-M) panY -= q.bottom - (r.bottom-M);
  if(q.left   < r.left+M)     panX += (r.left+M) - q.left;
  else if(q.right > r.right-M)   panX -= q.right - (r.right-M);
  applyView();                                       // translate 在 scale 之前 → 平移量就是屏幕像素
}
function selectAndReveal(id){ selNodes=new Set([id]); selEdges.clear(); selCol=null; tagFilter=null; paint(); ensureVisible(id); }
function moveSelection(dx, dy){
  const cur=byId([...selNodes][0]); if(!cur) return;
  if(dy){                                            // ↑/↓：同栏目内
    const list=visibleNodes().filter(n=>n.kind===cur.kind).sort(byOrd);   // 与渲染同一顺序
    const i=list.findIndex(n=>n.id===cur.id); if(i<0) return;
    const j=i+dy; if(j<0||j>=list.length) return;    // 到列头/列尾就停，不绕回
    selectAndReveal(list[j].id); return;
  }
  // ←/→：往同方向找第一个「有可见节点」的栏目；在其中取纵向中心离当前节点最近的那个
  const ci=colIdxOf(cur.kind); if(ci<0) return;
  const mid=nodeMidY(cur.id);
  for(let k=ci+dx; k>=0 && k<cols.length; k+=dx){
    const cand=visibleNodes().filter(n=>n.kind===cols[k].kind);
    if(!cand.length) continue;                       // 空栏目 / 该栏节点全隐藏 → 继续往同方向找
    let best=cand[0], bestD=Infinity;
    if(mid!=null) for(const n of cand){ const y=nodeMidY(n.id); if(y==null) continue;
      const d=Math.abs(y-mid); if(d<bestD){ bestD=d; best=n; } }
    selectAndReveal(best.id); return;
  }
}
document.getElementById('btn-help').addEventListener('click',showHelp);
// 「🏷 标签」：无筛选时开/收标签条；有筛选时点它 = 清掉筛选并展开标签条（按钮上的 ✕ 就这个意思）
document.getElementById('btn-set').addEventListener('click',ev=>{    // 标签类型 / 栏目配色 合成一个菜单，给工具栏省宽度
  ev.stopPropagation();
  const r=ev.currentTarget.getBoundingClientRect();
  openCtx(r.left, r.bottom+4, [
    {id:'tt', label:'标签类型（分维度、配色、改名）', run:()=>openTagTypes()},
    {id:'st', label:'样式（栏目 / 节点名称 / 选中 / 链路 / 连线）', run:()=>openStyle()},
  ]);
});
function syncEdgeBtn(){ const b=document.getElementById('btn-edges');
  if(!b) return; b.textContent=edgebarOpen?'🔗 连线 ▴':'🔗 连线 ▾'; b.classList.toggle('on',edgebarOpen); }
document.getElementById('btn-edges').addEventListener('click',()=>{
  edgebarOpen=!edgebarOpen;
  localStorage.setItem('fc_edgebar',edgebarOpen?'1':'0');
  syncEdgeBtn(); renderEdgebar();
  if(edgebarOpen && !primaryNode()) hint('「🔗 连线」已开：选中一个节点，下方会显示它的连线摘要');
  else if(!edgebarOpen) hint('');
});
syncEdgeBtn();
document.getElementById('btn-tags').addEventListener('click',()=>{
  if(tagFilter){ tagFilter=null; tagbarOpen=true; }
  else tagbarOpen=!tagbarOpen;
  paint();
});
document.getElementById('canvas-pick').addEventListener('click',ev=>{
  ev.stopPropagation();                       // 不拦住的话会冒泡到 document 的 closeCtx，菜单刚开就关
  const r=ev.currentTarget.getBoundingClientRect();
  openCanvasMenu(r.left, r.bottom+4);
});
document.getElementById('btn-export').addEventListener('click',ev=>{   // 一个按钮两种导出，省工具栏宽度
  ev.stopPropagation();
  const r=ev.currentTarget.getBoundingClientRect();
  openCtx(r.left, r.bottom+4, [
    {id:'png', label:'导出图片（PNG）', run:()=>exportImage()},
    {id:'csv', label:'导出链路表（CSV）', run:()=>doExport()},
  ]);
});
document.getElementById('chk-all').addEventListener('change',ev=>{ showAll=ev.target.checked; render(); });
// 「显示备注」总开关：勾上=展开所有有备注的节点，取消=全部收起（单个节点的 📝 仍可单独开关）
// 不给文本提示：这个开关一按就看见结果（节点展开/收起），再弹一行提示反而把画布挤一下
document.getElementById('chk-notes').addEventListener('change',ev=>{
  showNotes=ev.target.checked;
  if(showNotes) noteIds().forEach(id=>expandedNotes.add(id)); else expandedNotes.clear();
  render();
});
document.getElementById('btn-refresh').addEventListener('click',async()=>{
  if(dirty && !await uiConfirm('放弃草稿','你有未保存的改动，刷新会丢弃。确定刷新？',{danger:true,okText:'放弃并刷新'})) return;
  await load();
});
document.getElementById('btn-save').addEventListener('click',()=>doSave(false));
document.getElementById('btn-vers').addEventListener('click',openVersions);
document.querySelector('.bar').addEventListener('click',e=>{ const b=e.target.closest('button'); if(b) b.blur(); });   // 点完按钮去掉焦点，避免空格误触发按钮
graphEl.addEventListener('click',e=>{
  if(suppressBgClick) return;   // 框选拖动结束后浏览器补发的 click，忽略
  if(e.target===graphEl||e.target===svg){ selNodes.clear(); connFrom=null; selEdges.clear(); selCol=null; tagFilter=null; hint(''); paint(); }
});
window.addEventListener('resize',()=>{ drawEdges(new Set(visibleNodes().map(n=>n.id))); paint(); });
window.addEventListener('beforeunload',e=>{ if(dirty){ e.preventDefault(); e.returnValue=''; } });
document.addEventListener('keydown',e=>{
  if(gate.classList.contains('show')) return;
  if(overlay.classList.contains('show')){                      // 弹窗打开时：只有「看流程图」弹窗响应 Esc
    if(e.key==='Escape' && dialog.classList.contains('imgbig')) _close(true);
    return;
  }
  if(isTyping(e.target)) return;                               // 输入中：键盘交给输入框（含 Ctrl+Z 的文本撤销）
  const mod=e.ctrlKey||e.metaKey;
  if(mod && (e.key==='s'||e.key==='S')){ e.preventDefault(); if(!dirty) toast('没有未保存的改动'); else doSave(false); return; }
  if(mod && (e.key==='e'||e.key==='E')){ e.preventDefault(); toggleEditMode(); return; }   // Ctrl+E = 切换编辑模式
  if(mod && !e.shiftKey && (e.key==='z'||e.key==='Z')){ e.preventDefault(); undo(); return; }
  if(mod && ((e.key==='y'||e.key==='Y')||((e.key==='z'||e.key==='Z')&&e.shiftKey))){ e.preventDefault(); redo(); return; }
  if(e.key==='Escape'){ closeCtx(); if(connFrom) hint('已退出连线模式'); selNodes.clear(); selCol=null; connFrom=null; selEdges.clear(); tagFilter=null; paint(); return; }
  if(mod && (e.key==='ArrowUp'||e.key==='ArrowDown') && editMode){        // Ctrl+↑/↓ = 把节点在**本栏内**上/下挪一位（不动选中项）
    e.preventDefault();
    if(locked) return hint('画布已锁定：先解锁再移动');
    nudgeNodes(e.key==='ArrowUp' ? -1 : 1); return;
  }
  if((e.key==='n'||e.key==='N') && editMode && !mod){                     // N = 新增节点（插在选中节点之后 / 选中栏目末尾）
    e.preventDefault();
    if(locked) return hint('画布已锁定：先解锁再新增');
    quickAddNode(); return;
  }
  if((e.key==='m'||e.key==='M') && editMode && !mod && selNodes.size===1){ // M = 备注 / 标签（memo）
    e.preventDefault();
    if(locked) return hint('画布已锁定：先解锁再编辑');
    openAnno([...selNodes][0]); return;
  }
  if(selNodes.size===1 && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){
    e.preventDefault();                                                 // ↑↓ 同栏目上下 · ←→ 跳相邻栏目
    const dy = e.key==='ArrowDown' ? 1 : (e.key==='ArrowUp' ? -1 : 0);
    const dx = e.key==='ArrowRight' ? 1 : (e.key==='ArrowLeft' ? -1 : 0);
    moveSelection(dx, dy); return;
  }
  if(e.code==='Space' && !isFormEl(e.target)){                 // 空格 = 平移画布
    if(locked) return hint('画布已锁定：先解锁再平移');
    if(!spaceDown){ spaceDown=true; graphEl.classList.add('pan-mode'); wrapEl.classList.add('pannable'); }
    e.preventDefault(); return;
  }
  if(editMode && locked && (selNodes.size||selEdges.size||selCol)
     && ['Delete','Backspace','Enter','t','T','l','L'].includes(e.key)) return hint('画布已锁定：先解锁再编辑');
  if((e.key==='Delete'||e.key==='Backspace') && editMode){
    if(selCol){ e.preventDefault(); delColumn(selCol); return; }          // 选中栏目 → 删栏目（自带一次确认）
    if(selNodes.size||selEdges.size){ e.preventDefault(); deleteSelection(); return; }
  }
  if(e.key==='Enter' && editMode && !connFrom){
    if(selNodes.size===1){ e.preventDefault(); startRenameNode([...selNodes][0]); return; }
    if(selCol){ e.preventDefault(); startRenameCol(selCol); return; }
  }
  if((e.key==='l'||e.key==='L') && editMode && selNodes.size===1 && !mod){ e.preventDefault(); toggleLink([...selNodes][0]); return; }
  if((e.key==='t'||e.key==='T') && editMode && !mod){
    if(selNodes.size){ e.preventDefault(); toggleStatus(); return; }       // 节点：待确认/明确
    if(selEdges.size){ e.preventDefault(); toggleEdgeStatus(); return; }   // 连线：待确认/明确
  }
});
document.addEventListener('keyup',e=>{
  if(e.code==='Space'){ spaceDown=false; panDrag=null; graphEl.classList.remove('pan-mode'); wrapEl.classList.remove('pannable','panning'); }
});

/* ===== 框选（marquee）：在画布空白处拖动矩形，选中与之相交的节点/连线 ===== */
const marqueeEl=document.createElement('div'); marqueeEl.className='marquee'; graphEl.appendChild(marqueeEl);
function marqueeMove(ev){
  if(!marq) return;
  const p=toLayout(ev.clientX,ev.clientY); marq.x1=p.x; marq.y1=p.y;
  const x=Math.min(marq.x0,marq.x1), y=Math.min(marq.y0,marq.y1);
  const w=Math.abs(marq.x1-marq.x0), h=Math.abs(marq.y1-marq.y0);
  if(w>3||h>3) marq.moved=true;
  marqueeEl.style.display='block';
  marqueeEl.style.left=x+'px'; marqueeEl.style.top=y+'px'; marqueeEl.style.width=w+'px'; marqueeEl.style.height=h+'px';
}
function marqueeUp(ev){
  document.removeEventListener('mousemove',marqueeMove);
  document.removeEventListener('mouseup',marqueeUp);
  if(!marq) return;
  const m=marq; marq=null; marqueeEl.style.display='none';
  if(!m.moved){                                            // 未拖动 = 空白点击：清空选择 / 结束连线模式
    selNodes.clear(); selEdges.clear(); connFrom=null; tagFilter=null; hint(''); paint(); return;
  }
  suppressBgClick=true; setTimeout(()=>suppressBgClick=false,0);
  applyMarquee(Math.min(m.x0,m.x1), Math.min(m.y0,m.y1), Math.abs(m.x1-m.x0), Math.abs(m.y1-m.y0), isAdditive(ev));
}
graphEl.addEventListener('mousedown',ev=>{
  if(!editMode || locked || ev.button!==0 || spaceDown) return;        // 空格拖动=平移，交给画布，不触发框选
  const t=ev.target;
  // .ngtitle = 分组名吸附点：它是拖整组的抓手，必须让 mousedown 正常传递（否则会被 preventDefault 掉、拖不起来）
  if(t.closest && t.closest('.node,.col-head,.col-add,.edge-hit,.ngtitle')) return;
  const p=toLayout(ev.clientX,ev.clientY);
  marq={x0:p.x,y0:p.y,x1:p.x,y1:p.y,moved:false};
  ev.preventDefault();
  document.addEventListener('mousemove',marqueeMove);
  document.addEventListener('mouseup',marqueeUp);
});
function edgeHitsRect(path,rect){                          // 连线：沿路径采样，任一采样点落在框内即命中
  let len=0; try{ len=path.getTotalLength(); }catch(_){ return false; }
  if(!len) return false;
  const N=Math.max(12, Math.min(80, Math.ceil(len/8)));
  for(let i=0;i<=N;i++){ const pt=path.getPointAtLength(len*i/N);
    if(pt.x>=rect.l&&pt.x<=rect.r&&pt.y>=rect.t&&pt.y<=rect.b) return true; }
  return false;
}
function applyMarquee(x,y,w,h,additive){
  tagFilter=null;                                          // 框选 = 节点选中维度，退出标签筛选
  if(!additive){ selNodes.clear(); selEdges.clear(); }
  const rect={l:x,r:x+w,t:y,b:y+h};
  graphEl.querySelectorAll('.node').forEach(el=>{ const q=toLayoutRect(el.getBoundingClientRect());
    if(q.l<=rect.r && q.r>=rect.l && q.t<=rect.b && q.b>=rect.t) selNodes.add(el.dataset.id); });
  svg.querySelectorAll('.edge').forEach(p=>{ if(p.dataset.e && edgeHitsRect(p,rect)) selEdges.add(p.dataset.e); });
  hint('框选：'+selNodes.size+' 个节点 / '+selEdges.size+' 条连线；按 Delete 删除'+(additive?'':'（按住 Shift/Ctrl 拖动可加选）')+'。');
  paint();
}

/* ===== 批量删除选中项：连线直接删；含节点时弹一次确认 ===== */
async function deleteSelection(){
  const nIds=[...selNodes].filter(id=>byId(id));
  const eIds=[...selEdges].filter(id=>edges.some(x=>x.id===id));
  if(!nIds.length && !eIds.length) return;
  if(nIds.length){
    const nset=new Set(nIds);
    const extra=edges.filter(x=>!eIds.includes(x.id)&&(nset.has(x.from_id)||nset.has(x.to_id))).length;
    const names=nIds.map(id=>esc((byId(id)||{}).name||'?'));
    const preview=names.slice(0,10).join('、')+(names.length>10?(' 等 '+names.length+' 个'):'');
    const msg='将删除 <span class="em">'+nIds.length+' 个节点</span>：'+preview
      +'<br>以及 <span class="em">'+(eIds.length+extra)+' 条连线</span>。'
      +'<br><span class="muted">保存后生效；删除不可恢复（可刷新丢弃草稿）。</span>';
    if(!await uiConfirm('批量删除',msg,{danger:true,okText:'确认删除'})) return;
  }
  const nset=new Set(nIds), eset=new Set(eIds);
  nodes=nodes.filter(x=>!nset.has(x.id));
  edges=edges.filter(x=>!eset.has(x.id) && !nset.has(x.from_id) && !nset.has(x.to_id));
  selNodes.clear(); selEdges.clear();
  if(!nIds.length) hint('已删除 '+eIds.length+' 条连线（保存后生效）');
  markDirty(); render();
}

/* ===== 画布缩放 / 平移交互 ===== */
const isTyping=t=>{ const n=t&&t.tagName; return n==='INPUT'||n==='TEXTAREA'||n==='SELECT'||!!(t&&t.isContentEditable); };
const isFormEl=t=>isTyping(t)||(t&&t.tagName==='BUTTON');   // 多加 BUTTON：空格键不要抢按钮的默认行为
wrapEl.addEventListener('wheel',ev=>{                    // Ctrl/⌘+滚轮 = 缩放；普通滚轮 = 平移（避免误缩放）
  if(locked) return;                                     // 锁定时冻结滚轮（缩放按钮仍可用）
  ev.preventDefault();
  const k=ev.deltaMode===1?16:1;
  if(ev.ctrlKey||ev.metaKey) setZoom(zoom*Math.exp(-ev.deltaY*k*0.0015), ev.clientX, ev.clientY);
  else { panX-=ev.deltaX*k; panY-=ev.deltaY*k; applyView(); }
},{passive:false});
wrapEl.addEventListener('mousedown',ev=>{                // 空格+左键 / 中键 = 平移画布
  if(locked || (!spaceDown && ev.button!==1)) return;
  ev.preventDefault();
  panDrag={x:ev.clientX, y:ev.clientY, px:panX, py:panY, moved:false};
  wrapEl.classList.add('panning');
});
document.addEventListener('mousemove',ev=>{
  if(!panDrag) return;
  const dx=ev.clientX-panDrag.x, dy=ev.clientY-panDrag.y;
  if(Math.abs(dx)>2||Math.abs(dy)>2) panDrag.moved=true;
  panX=panDrag.px+dx; panY=panDrag.py+dy; applyView();
});
document.addEventListener('mouseup',()=>{
  if(!panDrag) return;
  if(panDrag.moved){ suppressBgClick=true; setTimeout(()=>suppressBgClick=false,0); }
  panDrag=null; wrapEl.classList.remove('panning');
});
document.getElementById('btn-zoomin').addEventListener('click',()=>setZoom(zoom*1.2));
document.getElementById('btn-zoomout').addEventListener('click',()=>setZoom(zoom/1.2));
document.getElementById('btn-zoomreset').addEventListener('click',()=>setZoom(1));
document.getElementById('btn-fit').addEventListener('click',fitView);

/* ===== 启动 ===== */
(async function boot(){
  setWhoami();
  document.getElementById('gate-user').value=localStorage.getItem('userName')||'';
  if(!token){ showGate(); return; }
  applyView();
  loadWhoami();                                    // 不 await：IP/角色不该拖慢首屏；失败也不影响画布
  let d=null;                                              // 草稿快照：必须赶在 load() 之前取——load() 会 clearDraft()
  try{
    await loadCanvases();                                  // 先把 canvasId 规整成有效的，草稿键才对得上
    const legacy=localStorage.getItem(DRAFT_KEY);          // 老草稿键没带画布前缀：迁给当前画布，别丢
    if(legacy){ localStorage.setItem(draftKey(),legacy); localStorage.removeItem(DRAFT_KEY); }
    d=localStorage.getItem(draftKey());
    await load();
  }
  catch(e){ if(e.code===401) showGate(); else uiConfirm('无法连接服务器','请确认后端已启动：<br><code>node server.js</code>',{okText:'知道了'}); return; }
  if(d){ try{ const o=JSON.parse(d);
    const pick=await uiChoose('发现未保存的草稿',
      '检测到上次未保存的改动（'+o.nodes.length+' 节点）。要恢复吗？'
      +(o.rev!==rev?'<br><span class="muted">注意：草稿基于 rev '+o.rev+'，服务器已是 rev '+rev+' —— 保存时会提示冲突（可放弃我的改动或强制覆盖）。</span>':''),
      [{label:'恢复草稿',value:'keep'},{label:'丢弃草稿',value:'drop',cls:'danger'},{label:'稍后再说',value:null,cls:'ghost'}]);
    if(pick==='keep'){
      nodes=o.nodes; edges=o.edges; if(o.cols&&o.cols.length) cols=o.cols;
      tagTypes=o.tagTypes||tagTypes; tagDefs=o.tagDefs||tagDefs;   // 旧草稿没有这两项 → 沿用刚从服务端读到的
      normalizeTagTypes();                                        // 旧草稿的节点没有 tagtypes → 按草稿自带的 tagDefs 展开
      if(o.headColor!==undefined){ headColor=o.headColor; applyHeadColor(); }
      if(o.styleCfg){ styleCfg=Object.assign({}, STYLE_DEFAULTS, o.styleCfg); applyStyle(); }
      rev=Number(o.rev)||rev;      // 保留草稿的基线 rev：否则保存时不触发乐观锁，会静默覆盖别人的改动
      setDirty(true); resetHistory(); render(); updateRev(); saveDraft();   // load() 刚清过草稿，这里重新落盘
      hint('已恢复本地草稿（基线 rev '+rev+'），记得点「保存」提交。');
    } else if(pick==='drop') clearDraft();
    else if(pick===null){ try{ localStorage.setItem(draftKey(), d); }catch{} hint('草稿仍留在本地，下次打开会再问一次。'); }
  }catch{ clearDraft(); } }
})();
/* ===== 别人的改动：每 8 秒看一次 rev =====
   不脏 → 静默跟到最新（别人的改动不进本地撤销栈）；
   脏   → 不覆盖你，只挂常驻提示条，由你自己决定何时加载。 */
async function pollServer(){
  if(!token || document.hidden) return;
  const cidNow=canvasId;
  try{
    const s=await api('GET','/api/rev?canvas='+encodeURIComponent(cidNow));
    if(s.canvas!==cidNow || cidNow!==canvasId) return;         // 期间切了画布：这次结果作废
    if(s.rev===rev){ hideExt(); return; }
    if(dirty){ showExt(s.rev); return; }
    const g=await api('GET','/api/graph?canvas='+encodeURIComponent(cidNow));
    if(g.canvas && g.canvas!==canvasId) return;
    nodes=g.nodes||[]; edges=g.edges||[];
    applyCanvasMeta(g);
    normalizeTagTypes();                                // 与 load() 同口径：老节点按画布级 tagDefs 补显式归属
    if(g.columns&&g.columns.length) cols=g.columns.slice().sort((a,b)=>(a.ord??0)-(b.ord??0));
    const liveN=new Set(nodes.map(n=>n.id)), liveE=new Set(edges.map(e=>e.id));
    selNodes=new Set([...selNodes].filter(id=>liveN.has(id)));
    if(connFrom&&!liveN.has(connFrom)) connFrom=null;
    selEdges=new Set([...selEdges].filter(id=>liveE.has(id)));
    rev=g.rev; resetHistory(); render(); updateRev(); hideExt();
  }catch{}
}
setInterval(pollServer, 8000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ pollServer(); loadWhoami(); } });
