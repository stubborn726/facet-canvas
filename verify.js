#!/usr/bin/env node
/* 数据体检 / 升级前后比对（**只读**：全程 readOnly 打开，不写库、不建表）
 *
 * 用法：
 *   node verify.js                          # 打印体检报告 + 各表指纹
 *   node verify.js --save base.json         # 存一份基线（升级前跑）
 *   node verify.js --baseline base.json     # 与基线比（升级后跑；有差异 → 退出码 1）
 *   node verify.js --with-tagtypes          # 指纹里带上 nodes.tagtypes（默认不带，见下）
 *
 * 环境变量与 server.js 一致：DATA_DIR / DB_PATH
 *
 * 为什么默认**不**把 nodes.tagtypes 算进指纹：
 *   它是兼容性新增列，升级后会被保存逐步填充，算进去会让每次比对都"有差异"。
 *   想看它就用 --with-tagtypes。
 * 版本表（versions）默认只比"有没有丢"：新增版本是正常增长，丢失版本才是事故。
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'data.db');

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const WITH_TT = has('--with-tagtypes');

if (!fs.existsSync(DB_PATH)) {
  console.error('找不到数据库：' + DB_PATH + '\n（用 DATA_DIR / DB_PATH 指定，或先用 node backup.js 确认路径）');
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const all = (sql) => db.prepare(sql).all();
const one = (sql) => db.prepare(sql).get();
const cols = (t) => all('PRAGMA table_info(' + t + ')').map((r) => r.name);

const short = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const rowHash = (r, ks) => short(ks.map((k) => String(r[k] ?? '')).join('\u0001'));
const tableHash = (rows, ks) => short(rows.map((r) => rowHash(r, ks)).sort().join('\u0002')) + ':' + rows.length;

// **有意**的业务内容白名单（不是 schema 镜像）：只比"内容"，不比每次保存都会变的 by / updated_at / ver，
// 也不比兼容列 tagtypes（除非 --with-tagtypes）。加列不必改这里；只有"这列也算业务内容"时才加。
const NODE_COLS = ['canvas', 'id', 'kind', 'name', 'status', 'source', 'note', 'image', 'tags', 'grp', 'ord'];
const EDGE_COLS = ['canvas', 'from_id', 'to_id', 'status'];
const edgeKey = (r) => r.canvas + '|' + r.from_id + '>' + r.to_id;
const nodeKey = (r) => r.canvas + '|' + r.id;

// ---- 读（老库可能缺表/缺列：缺就当空，不报错）----
const hasTable = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);   // 注意：参数必须绑定
const pick = (t, want) => { if (!hasTable(t)) return null; const c = cols(t); return want.filter((k) => c.includes(k)); };

const nodeCols = pick('nodes', NODE_COLS.concat(WITH_TT ? ['tagtypes'] : []));
const edgeCols = pick('edges', EDGE_COLS);
const nodes = nodeCols ? all('SELECT ' + nodeCols.join(',') + ' FROM nodes') : [];
const edges = edgeCols ? all('SELECT ' + edgeCols.join(',') + ' FROM edges') : [];

const snap = {
  at: new Date().toISOString(),
  db: DB_PATH,
  file: { size: fs.statSync(DB_PATH).size, pages: one('PRAGMA page_count').page_count },
  integrity: one('PRAGMA integrity_check').integrity_check,
  tables: {},
  nodes: {},
  edges: {},
  versions: {},
};

const simple = [
  ['canvases', 'SELECT * FROM canvases', ['id', 'name', 'ord']],   // 不含 rev：每次保存都 +1，属噪声（要看版本就比 versions 表）
  ['columns', 'SELECT * FROM columns', ['canvas', 'kind', 'title', 'ord']],
  ['tag_types', 'SELECT * FROM tag_types', ['canvas', 'name', 'color', 'ord']],
  ['tag_defs', 'SELECT * FROM tag_defs', ['canvas', 'tag', 'type']],
];
simple.forEach(([name, sql, ks]) => {
  if (!hasTable(name)) return;
  const c = cols(name);
  const use = ks.filter((k) => c.includes(k));
  const rows = all('SELECT ' + use.join(',') + ' FROM ' + name);
  snap.tables[name] = tableHash(rows, use);
});

if (nodeCols) {
  snap.tables.nodes = tableHash(nodes, nodeCols);
  nodes.forEach((r) => { snap.nodes[nodeKey(r)] = {}; nodeCols.forEach((k) => { snap.nodes[nodeKey(r)][k] = r[k] ?? ''; }); });
}
if (edgeCols) {
  snap.tables.edges = tableHash(edges, edgeCols);
  edges.forEach((r) => { snap.edges[edgeKey(r)] = {}; edgeCols.forEach((k) => { snap.edges[edgeKey(r)][k] = r[k] ?? ''; }); });
}
if (hasTable('versions')) {
  all('SELECT id,canvas,created_at,n_nodes,n_edges FROM versions').forEach((r) => {
    snap.versions[r.id] = { canvas: r.canvas, created_at: r.created_at, n_nodes: r.n_nodes, n_edges: r.n_edges };
  });
  snap.tables.versions = short(Object.keys(snap.versions).sort().join(',')) + ':' + Object.keys(snap.versions).length;
}
if (hasTable('meta')) snap.tables.meta = tableHash(all('SELECT k, v FROM meta'), ['k', 'v']);

// ---- 卫生检查 ----
const names = (s) => String(s || '').split(/[,，、;\n\r]+/).map((x) => x.trim()).filter(Boolean);
const liveTypes = new Set((hasTable('tag_types') ? all('SELECT canvas, name FROM tag_types') : [])   // 老库可能还没有这张表
  .map((r) => r.canvas + '\u0001' + r.name));
const hygiene = [];
if (hasTable('nodes')) {
  const c = cols('nodes');
  let dup = 0, empty = 0, badJson = 0, dangling = 0, noKey = 0, ttNull = 0, ttEmpty = 0, ttFilled = 0, taggedTotal = 0;
  all('SELECT canvas,id,tags' + (c.includes('tagtypes') ? ',tagtypes' : '') + ' FROM nodes').forEach((r) => {
    const ts = names(r.tags);
    if (ts.length) taggedTotal++;
    if (ts.some((x) => !x)) empty++;
    if (new Set(ts).size !== ts.length) dup++;
    if (!c.includes('tagtypes')) return;
    if (r.tagtypes === null) { ttNull++; return; }
    if (r.tagtypes === '') { ttEmpty++; return; }
    ttFilled++;
    let m;
    try { m = JSON.parse(r.tagtypes); } catch { badJson++; return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { badJson++; return; }
    Object.keys(m).forEach((k) => {
      if (!ts.includes(k)) noKey++;                                   // 归属里有、tags 里没这个词
      (Array.isArray(m[k]) ? m[k] : []).forEach((t) => { if (!liveTypes.has(r.canvas + '\u0001' + t)) dangling++; });
    });
    ts.forEach((x) => { if (!(x in m)) noKey++; });                    // tags 里有、归属里缺键 → 会走老表兜底
  });
  const warn = (k, v) => hygiene.push([k, v, true]);
  const info = (k, v) => hygiene.push([k, v, false]);
  warn('tags 行内重名', dup);
  warn('tags 含空 token', empty);
  warn('tagtypes 非法 JSON', badJson);
  if (hasTable('tag_types')) warn('归属指向已删类型', dangling);      // 没有类型表的老库判不了，跳过别误报
  else info('归属指向已删类型', '跳过（老库没有 tag_types）');
  warn('归属与 tags 对不上（键缺失/多余）', noKey);
  if (c.includes('tagtypes')) {
    info('tagtypes 已填 / 有标签的节点', ttFilled + ' / ' + taggedTotal);
    info('tagtypes 空串（尚未写入，走老表兜底）', ttEmpty);
    warn('tagtypes 为 NULL（应为 0）', ttNull);
  }
  if (hasTable('tag_defs')) {
    if (hasTable('tag_types')) {
      const drift = all('SELECT canvas,tag,type FROM tag_defs').filter((r) => r.type && !liveTypes.has(r.canvas + '\u0001' + r.type)).length;
      warn('tag_defs 指向已删类型', drift);
    } else info('tag_defs 指向已删类型', '跳过（老库没有 tag_types）');
  }
}
if (hasTable('versions')) {
  let bad = 0, mismatch = 0;
  all('SELECT n_nodes, data FROM versions').forEach((v) => {
    try { const o = JSON.parse(v.data); if ((o.nodes || []).length !== v.n_nodes) mismatch++; }
    catch { bad++; }
  });
  hygiene.push(['版本快照 JSON 解析失败', bad, true]);
  hygiene.push(['版本 n_nodes 与实际不符', mismatch, true]);
}

// ---- 输出 ----
const fmt = (n) => n.toLocaleString('en-US');
const pad = (s, n) => String(s) + ' '.repeat(Math.max(1, n - String(s).replace(/[^\x00-\xff]/g, 'xx').length));

function report() {
  console.log('数据库      : ' + DB_PATH + '   （只读打开）');
  console.log('文件        : ' + fmt(snap.file.size) + ' bytes / ' + snap.file.pages + ' 页');
  console.log('integrity   : ' + snap.integrity);
  console.log('指纹口径    : nodes' + (WITH_TT ? '（含 tagtypes）' : '（**不含** tagtypes，那是升级逐步填充的兼容列）'));
  console.log('');
  Object.keys(snap.tables).sort().forEach((t) => {
    const [h, c] = snap.tables[t].split(':');
    console.log('  ' + pad(t, 12) + h + '   ' + c + ' 行');
  });
  console.log('');
  console.log('卫生检查：');
  hygiene.forEach(([k, v, warn]) => console.log('  ' + pad(k, 40) + v + (warn && v !== 0 ? '  ← 注意' : '')));
}

const savePath = argOf('--save');
if (savePath) {
  fs.writeFileSync(savePath, JSON.stringify(snap));
  report();
  console.log('\n已保存基线：' + savePath);
  process.exit(0);
}

const basePath = argOf('--baseline');
if (basePath) {
  let b;
  try { b = JSON.parse(fs.readFileSync(basePath, 'utf8')); } catch (e) { console.error('读不了基线：' + e.message); process.exit(2); }
  report();
  console.log('\n===== 与基线比对（' + (b.at || '?') + '）=====');
  let bad = 0;
  // 基线里有、现在整张表都没了 —— 只遍历当前表会静默放过，这是最容易漏掉的事故
  Object.keys((b && b.tables) || {}).forEach((t) => {
    if (snap.tables[t] === undefined) { console.log('  ✗ ' + t + '：基线里有、现在整张表不见了  ← 事故！'); bad++; }
  });
  Object.keys(snap.tables).sort().forEach((t) => {
    const a = b.tables && b.tables[t];
    if (!a) { console.log('  + ' + t + '：基线里没有这张表（新增）'); return; }
    if (a === snap.tables[t]) { console.log('  = ' + t + '  一致'); return; }
    if (t === 'versions') {   // 版本只比"有没有丢"
      const lost = Object.keys(b.versions || {}).filter((id) => !snap.versions[id]);
      const add = Object.keys(snap.versions).filter((id) => !b.versions[id]);
      console.log('  ' + (lost.length ? '✗' : '~') + ' versions：新增 ' + add.length + ' 条，丢失 ' + lost.length + ' 条' + (lost.length ? '  ← 事故！' : '（正常增长）'));
      if (lost.length) { bad++; lost.slice(0, 5).forEach((id) => console.log('      丢失版本 ' + id)); }
      return;
    }
    if (t === 'meta') {   // meta 存口令 / 播种标记等配置：变了通常是"改了口令"这类正常操作，不算数据事故
      console.log('  ~ meta 有差异：' + a + ' → ' + snap.tables[t] + '（口令 / 播种标记等配置项，请自行确认）');
      return;
    }
    bad++;
    console.log('  ✗ ' + t + ' 有差异：' + a + ' → ' + snap.tables[t]);
  });
  // 节点级差异（能定位到具体行）
  if (b.nodes && snap.tables.nodes !== (b.tables || {}).nodes) {
    const bi = b.nodes, ci = snap.nodes;
    const add = Object.keys(ci).filter((k) => !bi[k]);
    const del = Object.keys(bi).filter((k) => !ci[k]);
    const chg = Object.keys(ci).filter((k) => bi[k] && JSON.stringify(bi[k]) !== JSON.stringify(ci[k]));
    console.log('  节点：新增 ' + add.length + ' / 删除 ' + del.length + ' / 内容变化 ' + chg.length);
    chg.slice(0, 20).forEach((k) => {
      const fields = Object.keys(ci[k]).filter((f) => String(bi[k][f] ?? '') !== String(ci[k][f] ?? ''));
      console.log('    ' + k + '  ' + fields.map((f) => f + ': [' + String(bi[k][f] || '').slice(0, 40) + '] → [' + String(ci[k][f] || '').slice(0, 40) + ']').join(' ; '));
    });
    if (chg.length > 20) console.log('    …还有 ' + (chg.length - 20) + ' 个');
    del.slice(0, 10).forEach((k) => console.log('    删除 ' + k));
  }
  console.log(bad ? '\n结果：发现 ' + bad + ' 处差异（见上）' : '\n结果：与基线一致');
  process.exit(bad ? 1 : 0);
}

report();
