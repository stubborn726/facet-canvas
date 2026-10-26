// 多维关系画布 · 零依赖后端（Node 22+ 内置 node:sqlite）
// 运行：node server.js   → http://localhost:3000（首次启动用 admin + 默认口令登录，登录后强制改密）
// 数据：data/ 目录（data.db + uploads/ 图片）—— 整包备份 data/ 即可
// 模型：编辑在浏览器端为草稿，点「保存」才提交 → 每次保存生成一个版本，可恢复。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const geo = require('./lib/geo');            // 离线 IP 归属地（vendor/ip2region.xdb；缺文件则只显示 IP）
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('启动失败：需要 Node.js 22.5+（用到内置 node:sqlite）。当前版本：' + process.version
    + '\n早期 22.x 可试：node --experimental-sqlite server.js');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const TOKEN_DAYS = Number(process.env.TOKEN_DAYS || 365);
// 登录限流（默认：15 分钟窗口内失败 8 次 → 锁 15 分钟）
const LOGIN_MAX = Math.max(1, Number(process.env.LOGIN_MAX || 8));
const LOGIN_WINDOW_MS = Math.max(1, Number(process.env.LOGIN_WINDOW_MIN || 15)) * 60000;
const LOGIN_LOCK_MS = Math.max(1, Number(process.env.LOGIN_LOCK_MIN || 15)) * 60000;
const DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(DIR, 'data');   // 运行时数据（库 + 图片）集中一处，整包即可备份
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'data.db');
const UP_DIR = process.env.UP_DIR || path.join(DATA_DIR, 'uploads');
const MAX_UP = 10 * 1024 * 1024;

// 一次性迁移：老版把 data.db / uploads/ 放在工具根目录 → 挪进 DATA_DIR（仅当目标不存在；幂等、可重复启动）
function moveInto(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
  try { fs.renameSync(src, dest); }
  catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }   // 跨盘回退
  return true;
}
function migrateLegacy() {
  const moved = moveInto(path.join(DIR, 'data.db'), DB_PATH) | moveInto(path.join(DIR, 'uploads'), UP_DIR);
  if (moved) console.log(`已把旧的 data.db / uploads/ 迁移到 ${DATA_DIR}`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.DATA_DIR && !process.env.DB_PATH && !process.env.UP_DIR) {   // 仅在用默认路径时迁移，不打扰自定义配置
  try { migrateLegacy(); }
  catch (e) {
    console.error('运行时数据迁移失败：' + e.message
      + '\n请先停止正在运行的服务，或手动把 data.db 与 uploads/ 移入 data/ 后重试。');
    process.exit(1);
  }
}

const CID = 'c1';                                  // 默认画布 id：迁移时把已有数据全归到它
const DEFAULT_CANVAS_NAME = '示例画布';
const db = new DatabaseSync(DB_PATH);
// 2026-10-14 多画布：nodes/edges/columns 主键改成 (canvas, …)，各画布各自一套栏目/节点/连线。
// 老库（表无 canvas 列）由 migrateCanvases() 一次性重建；这里是新库的直接定义。
db.exec(`
  CREATE TABLE IF NOT EXISTS canvases(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, ord INTEGER DEFAULT 0, rev INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nodes(
    canvas TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT DEFAULT '明确', source TEXT DEFAULT '', note TEXT DEFAULT '',
    image TEXT DEFAULT '', tags TEXT DEFAULT '', grp TEXT DEFAULT '', tagtypes TEXT DEFAULT '',
    by TEXT DEFAULT '', updated_at TEXT, ver INTEGER DEFAULT 1, ord INTEGER DEFAULT 0,
    PRIMARY KEY(canvas, id)
  );
  CREATE TABLE IF NOT EXISTS edges(
    canvas TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    status TEXT DEFAULT '明确', by TEXT DEFAULT '', updated_at TEXT, ver INTEGER DEFAULT 1,
    PRIMARY KEY(canvas, id)
  );
  CREATE TABLE IF NOT EXISTS columns(
    canvas TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, title TEXT NOT NULL, ord INTEGER DEFAULT 0,
    PRIMARY KEY(canvas, kind)
  );
  CREATE TABLE IF NOT EXISTS tag_types(          -- 2026-10-21 标签类型（维度）：颜色 + 展示顺序，按画布各自一套
    canvas TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, color TEXT DEFAULT '#2563EB', ord INTEGER DEFAULT 0,
    PRIMARY KEY(canvas, name)
  );
  CREATE TABLE IF NOT EXISTS tag_defs(           -- 标签名 → 类型名的归属（只存归属；节点的 tags 字段格式不变）
    canvas TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL, type TEXT DEFAULT '',
    PRIMARY KEY(canvas, tag)
  );
  CREATE TABLE IF NOT EXISTS versions(
    id TEXT PRIMARY KEY, canvas TEXT DEFAULT '', created_at TEXT, by TEXT, note TEXT,
    base_rev INTEGER, n_nodes INTEGER, n_edges INTEGER, data TEXT
  );
  CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`);
try { db.exec("ALTER TABLE nodes ADD COLUMN image TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN ord INTEGER DEFAULT 0"); } catch {}   // 栏内排序
// 2026-10-14 标注与交互增强：标签 / 同栏分组 / 连线置信度。只加列（幂等），已有行由默认值填充、旧值不动。
try { db.exec("ALTER TABLE nodes ADD COLUMN tags TEXT DEFAULT ''"); } catch {}    // 标签（逗号分隔）
try { db.exec("ALTER TABLE nodes ADD COLUMN grp TEXT DEFAULT ''"); } catch {}     // 同栏分组名（避开 SQL 关键字 group）
// 2026-10-26 标签跨类型同名：类型归属从"画布级全局唯一"改为"节点级可多值"（JSON：{标签: [类型...]}）。
// 只加列、不动 nodes.tags —— 老数据零迁移；旧代码按显式列名读写，指向新库也不会错位。
try { db.exec("ALTER TABLE nodes ADD COLUMN tagtypes TEXT DEFAULT ''"); console.log('[迁移] nodes 新增列 tagtypes（标签类型归属）'); } catch {}
try { db.exec("ALTER TABLE edges ADD COLUMN status TEXT DEFAULT '明确'"); } catch {}
try { db.exec("ALTER TABLE versions ADD COLUMN canvas TEXT DEFAULT ''"); } catch {}   // 版本归属的画布（老版本归默认画布）
try { db.exec("ALTER TABLE canvases ADD COLUMN color TEXT DEFAULT ''"); } catch {}   // 2026-10-21 每张画布自定义栏目头颜色（空=默认）
try { db.exec("ALTER TABLE canvases ADD COLUMN style TEXT DEFAULT ''"); } catch {}   // 2026-10-21 每张画布的节点样式（选中/链路/名称，JSON；空=默认）

// 默认栏目（首次 / 无栏目时播种）
const DEFAULT_COLUMNS = [['团队', '团队'], ['能力', '能力'], ['交付物', '交付物'], ['依赖', '外部依赖']];
function ensureColumns() {
  if (getMeta('cols_init')) return;            // 只初始化一次，之后（哪怕用户删空栏目）也不重置
  // 栏目现在是**按画布**的：新库直接写成默认画布的栏目；老库（columns 还没有 canvas 列）保持旧写法，由随后的迁移归属
  const byCanvas = db.prepare('PRAGMA table_info(columns)').all().some((x) => x.name === 'canvas');
  if (db.prepare('SELECT COUNT(*) c FROM columns').get().c === 0) {
    const ins = byCanvas
      ? db.prepare('INSERT OR REPLACE INTO columns(canvas,kind,title,ord) VALUES(?,?,?,?)')
      : db.prepare('INSERT OR REPLACE INTO columns(kind,title,ord) VALUES(?,?,?)');
    DEFAULT_COLUMNS.forEach(([k, t], i) => { if (byCanvas) ins.run(CID, k, t, i); else ins.run(k, t, i); });
  }
  setMeta('cols_init', '1');
}
const META_DEFAULTS = { rev: '0', secret: '', cols_init: '' };
for (const [k, v] of Object.entries(META_DEFAULTS)) db.prepare('INSERT OR IGNORE INTO meta(k,v) VALUES(?,?)').run(k, v);
fs.mkdirSync(UP_DIR, { recursive: true });

const now = () => new Date().toISOString();
// 把 UTC ISO 转成**服务器本机时区**的可读时间——只用于写进版本说明的文字（库里仍存 UTC）
const localStamp = (iso) => { if (iso == null || iso === '') return ''; const d = new Date(iso); if (isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
const uuid = () => Math.random().toString(36).slice(2, 10);
const getMeta = (k) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? '';
const setMeta = (k, v) => db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run(k, String(v));
const getRev = () => Number(getMeta('rev'));    // 仅用于迁移：把旧的全局 rev 承接给默认画布
ensureColumns();                                // 需在 meta 辅助函数之后调用

/* ===== 多画布：事务/清表小工具、默认画布、一次性迁移、画布级 rev ===== */
const tx = (fn) => {                              // 统一事务：异常一律回滚
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
};
const wipeCanvas = (cid, tables) => { for (const t of tables) db.prepare('DELETE FROM ' + t + ' WHERE canvas=?').run(cid); };
const hasCol = (t, c) => db.prepare('PRAGMA table_info(' + t + ')').all().some((x) => x.name === c);
const countOf = (t) => db.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
const CANVAS_SCOPED = ['nodes', 'edges', 'columns', 'versions', 'tag_types', 'tag_defs'];   // 按画布归属的表
function migrateCanvases() {
  const rebuilt = !hasCol('nodes', 'canvas');     // 老库判据：nodes 还没有 canvas 列 ⇒ 需要重建主键
  tx(() => {                                      // 全程单事务：建表 → 搬数据 → 校验 → 换名 → 归属默认画布
    if (rebuilt) {
      const b = { n: countOf('nodes'), e: countOf('edges'), c: countOf('columns') };
      db.exec(`CREATE TABLE nodes_new(
        canvas TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        status TEXT DEFAULT '明确', source TEXT DEFAULT '', note TEXT DEFAULT '',
        image TEXT DEFAULT '', tags TEXT DEFAULT '', grp TEXT DEFAULT '', tagtypes TEXT DEFAULT '',
        by TEXT DEFAULT '', updated_at TEXT, ver INTEGER DEFAULT 1, ord INTEGER DEFAULT 0,
        PRIMARY KEY(canvas, id))`);
      // 重建时**必须带上 tagtypes**：上面的 ALTER 已加过列，这里漏了等于把它 drop 掉
      db.prepare(`INSERT INTO nodes_new(canvas,id,kind,name,status,source,note,image,tags,grp,tagtypes,by,updated_at,ver,ord)
        SELECT ?, id,kind,name,status,source,note,image,tags,grp,tagtypes,by,updated_at,ver,ord FROM nodes`).run(CID);
      db.exec(`CREATE TABLE edges_new(
        canvas TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
        status TEXT DEFAULT '明确', by TEXT DEFAULT '', updated_at TEXT, ver INTEGER DEFAULT 1,
        PRIMARY KEY(canvas, id))`);
      db.prepare(`INSERT INTO edges_new(canvas,id,from_id,to_id,status,by,updated_at,ver)
        SELECT ?, id,from_id,to_id,status,by,updated_at,ver FROM edges`).run(CID);
      db.exec(`CREATE TABLE columns_new(
        canvas TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, title TEXT NOT NULL, ord INTEGER DEFAULT 0,
        PRIMARY KEY(canvas, kind))`);
      db.prepare('INSERT INTO columns_new(canvas,kind,title,ord) SELECT ?, kind,title,ord FROM columns').run(CID);
      const a = { n: countOf('nodes_new'), e: countOf('edges_new'), c: countOf('columns_new') };
      if (a.n !== b.n || a.e !== b.e || a.c !== b.c)   // 行数不符 → 整笔回滚，绝不交出半张表
        throw new Error(`多画布迁移行数不一致：nodes ${b.n}→${a.n} / edges ${b.e}→${a.e} / columns ${b.c}→${a.c}`);
      db.exec('DROP TABLE nodes;   ALTER TABLE nodes_new   RENAME TO nodes;');
      db.exec('DROP TABLE edges;   ALTER TABLE edges_new   RENAME TO edges;');
      db.exec('DROP TABLE columns; ALTER TABLE columns_new RENAME TO columns;');
      // ⚠️ "全部版本归属 c1" 的补归属与校验只属于这次一次性迁移——
      //    迁移之后各画布本就各持版本（如复制画布的初始版本归属新画布），
      //    若放在迁移外每次启动都跑，任何非默认画布一有版本就会让服务拒绝启动。
      const nVer = countOf('versions');
      for (const t of CANVAS_SCOPED)                // 还没归属画布的行一律归默认画布（幂等）
        db.prepare(`UPDATE ${t} SET canvas=? WHERE canvas IS NULL OR canvas=''`).run(CID);
      const strayVer = db.prepare('SELECT COUNT(*) c FROM versions WHERE canvas<>?').get(CID).c;
      if (countOf('versions') !== nVer || strayVer)  // 版本：条数不变 + 全部已归属默认画布
        throw new Error(`多画布迁移版本校验失败：${nVer}→${countOf('versions')}，未归属 ${strayVer}`);
    }
    if (countOf('canvases') === 0)                // 默认画布：承接旧 meta.rev，升级后首次保存不会假冲突
      db.prepare('INSERT INTO canvases(id,name,ord,rev) VALUES(?,?,?,?)').run(CID, DEFAULT_CANVAS_NAME, 0, getRev());
  });
  return rebuilt;
}
if (migrateCanvases()) console.log(`多画布迁移完成：已有数据归入默认画布「${DEFAULT_CANVAS_NAME}」`);

const canvasRev = (cid) => Number((db.prepare('SELECT rev FROM canvases WHERE id=?').get(cid) || {}).rev || 0);
const bumpCanvasRev = (cid) => db.prepare('UPDATE canvases SET rev=rev+1 WHERE id=?').run(cid);
const canvasExists = (cid) => !!db.prepare('SELECT 1 x FROM canvases WHERE id=?').get(cid);
const defaultCanvasId = () => (db.prepare('SELECT id FROM canvases ORDER BY ord, id LIMIT 1').get() || {}).id || CID;
// canvas 参数缺省 = 默认画布 → 旧页面（不带 canvas）照旧读写默认画布，且不会碰别的画布
function resolveCanvas(v) {
  const cid = String(v == null ? '' : v).trim() || defaultCanvasId();
  return canvasExists(cid) ? cid : null;
}

// 令牌密文（首次生成，持久化）
if (!getMeta('secret')) setMeta('secret', crypto.randomBytes(32).toString('hex'));
const SECRET = getMeta('secret');
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
// 令牌**只装 uid + 过期时间**：角色不写进令牌，每次请求回库查 → 改角色 / 删用户立即生效
function issueToken(uid) {
  const p = Buffer.from(JSON.stringify({ v: 2, uid, exp: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  return p + '.' + sign(p);
}
function verifyToken(t) {
  if (!t) return null;
  const [p, s] = String(t).split('.');
  if (!p || !s) return null;
  const expect = sign(p);
  const sb = Buffer.from(s), eb = Buffer.from(expect);   // 按字节比长度：非 ASCII 令牌不能触发 timingSafeEqual 抛错
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return (o.v === 2 && Number.isFinite(o.uid) && o.exp > Date.now()) ? o : null; } catch { return null; }   // 老令牌没有 v=2 → 一律失效
}
/* ===== 账号（2026-10-26 取代"两个全局口令"）：口令 scrypt 加盐哈希，角色以库为准 ===== */
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rw', must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT)`);

const ROLES = ['admin', 'rw', 'ro'];
// 公开仓库里人人可见 → 只是"入场券"：must_change=1 强制首次登录改密，改完才放行
const DEFAULT_ADMIN_PASSWORD = 'ES9kxuDLUyNfyzEfQtTEWhnNKM';
const genPassword = () => {                       // 26 位大小写字母+数字（与默认管理员口令同风格）
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 26; i++) s += A[crypto.randomInt(A.length)];
  return s;
};
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');
}
function checkPassword(pw, stored) {
  try {
    const [alg, N, r, pp, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw == null ? '' : pw), Buffer.from(salt, 'base64'), want.length,
      { N: Number(N), r: Number(r), p: Number(pp) });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}
const userById = (id) => db.prepare('SELECT id,name,role,must_change FROM users WHERE id=?').get(id);
const userByName = (name) => db.prepare('SELECT * FROM users WHERE name=?').get(String(name || '').trim());
const countAdmins = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
const pubUser = (u) => ({ id: u.id, name: u.name, role: u.role, mustChange: !!u.must_change, created_at: u.created_at });

// 首次建库 → 内置 admin；ADMIN_PASSWORD=xxx 是"忘记管理员口令"的逃生通道（每次启动都会重置 admin 口令）
function ensureAdmin() {
  const forced = String(process.env.ADMIN_PASSWORD || '').trim();
  const admin = userByName('admin');
  if (!admin) {
    db.prepare('INSERT INTO users(name,pass,role,must_change,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('admin', hashPassword(forced || DEFAULT_ADMIN_PASSWORD), 'admin', forced ? 0 : 1, now(), now());
    return forced ? 'admin（口令来自 ADMIN_PASSWORD）' : 'admin（默认口令，首次登录必须修改）';
  }
  if (forced) {
    db.prepare("UPDATE users SET pass=?, must_change=0, updated_at=? WHERE name='admin'").run(hashPassword(forced), now());
    return 'admin（口令已被 ADMIN_PASSWORD 重置）';
  }
  return null;
}
const adminNote = ensureAdmin();

/* ===== 登录失败限流（防止公网被慢慢爆破口令）===== */
const loginFails = new Map();                      // ip -> { n, first, until }
// 归一化：::ffff:1.2.3.4 → 1.2.3.4；::1 → 127.0.0.1；去掉 IPv6 的 %zone 后缀
function normIp(x) {
  let s = String(x == null ? '' : x).trim().replace(/%.*$/, '');
  s = s.replace(/^::ffff:/i, '');
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  return s;
}
function clientIp(req) {
  // 只有在明确处于可信代理之后才采信 X-Forwarded-For；否则客户端可伪造该头绕过限流
  if (process.env.TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',');
    const last = xff[xff.length - 1].trim();       // 最后一跳是自家代理追加的真实客户端 IP
    if (last) return normIp(last);
  }
  return normIp(req.socket.remoteAddress);
}
function loginLockLeft(ip) {
  const a = loginFails.get(ip);
  if (!a || !a.until) return 0;
  const left = a.until - Date.now();
  if (left > 0) return Math.ceil(left / 1000);
  loginFails.delete(ip); return 0;
}
function noteLoginFail(ip) {
  const now = Date.now();
  let a = loginFails.get(ip);
  if (!a || now - a.first > LOGIN_WINDOW_MS) a = { n: 0, first: now, until: 0 };
  a.n++;
  if (a.n >= LOGIN_MAX) { a.until = now + LOGIN_LOCK_MS; a.n = 0; a.first = now; }
  loginFails.set(ip, a);
  if (loginFails.size > 5000) { for (const [k, v] of loginFails) if (!v.until || v.until < now) loginFails.delete(k); }
}
function noteLoginOk(ip) { loginFails.delete(ip); }
function applySeed(cid) {                          // 读 seed.json 写入指定画布（供首次播种 / /api/reset 显式调用）
  const seedPath = path.join(DIR, 'seed.json');
  if (!fs.existsSync(seedPath)) return false;
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  // 种子可以带栏目 / 标签类型：这样首次打开就是一份"看得出能力"的完整示例（不带则用默认 4 栏）
  writeGraph(cid, seed.nodes || [], seed.edges || [], seed.columns, seed.tagTypes, seed.tagDefs);
  return true;
}
function seedIfEmpty() {
  if (getMeta('seeded')) return false;             // 只播种一次：用户清空画布后重启不再复活种子（旧行为会）
  const hasData = countOf('nodes') > 0;
  if (!hasData && applySeed(CID)) {
    saveVersion(CID, 'seed', '', '初始版本（种子）');
    bumpCanvasRev(CID);
    setMeta('seeded', '1');
    return true;
  }
  setMeta('seeded', '1');                          // 已有数据 / 无 seed.json 也置位，避免以后误播
  return false;
}
// 请求体逐项校验：形状不对宁可 400，也不要把半张图写进库
const isValidNode = (n) => !!n && typeof n.id === 'string' && !!n.id
  && typeof n.kind === 'string' && !!n.kind && typeof n.name === 'string' && !!n.name;
const isValidEdge = (e) => { const f = e && (e.from_id ?? e.from), t = e && (e.to_id ?? e.to); return typeof f === 'string' && !!f && typeof t === 'string' && !!t; };
const isValidColumn = (c) => !!c && typeof c.kind === 'string' && !!c.kind;
// ===== 2026-10-26 标签跨类型同名：节点级归属 {标签名: [类型名...]} =====
//   []   = 显式未分类（必须与"缺键"区分，否则取消类型后会被老兜底复活）
//   缺键 = 老数据 → 回落到画布级 tag_defs
// 只做白名单清洗：类型必须在 liveTypes 内、去重、上限保护；非法一律返回 ''
function cleanTagTypes(raw, liveTypes) {
  let o = raw;
  if (typeof o === 'string') { if (!o.trim()) return ''; try { o = JSON.parse(o); } catch { return ''; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return '';
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (++n > 500) break;                                   // 单节点标签不会到这个量级，防脏载荷
    const name = String(k || '').trim();
    if (!name || name.length > 60) continue;
    const list = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    const ts = [];
    for (const x of list) {
      const tn = String(x || '').trim();
      if (tn && tn.length <= 40 && liveTypes.has(tn) && !ts.includes(tn)) ts.push(tn);
    }
    out[name] = ts;
  }
  return JSON.stringify(out);
}
const splitTagNames = (s) => String(s || '').split(/[,，、;\n\r]+/).map((x) => x.trim()).filter(Boolean);
// 老快照 / 老草稿展开：没有 tagtypes 的节点，用**它自己那份** tagDefs 补成显式数组（不改 nodes.tags）
function expandTagTypes(nodes, legacyTagDefs) {
  const legacy = (legacyTagDefs && typeof legacyTagDefs === 'object') ? legacyTagDefs : {};
  (Array.isArray(nodes) ? nodes : []).forEach((n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tagtypes !== undefined && n.tagtypes !== null && n.tagtypes !== '') return;   // 已有显式归属：不覆盖
    const names = splitTagNames(n.tags);
    if (!names.length) return;
    const m = {};
    names.forEach((name) => { const t = String(legacy[name] || '').trim(); m[name] = t ? [t] : []; });
    n.tagtypes = JSON.stringify(m);
  });
  return nodes;
}
// 标签类型 + 归属的整表替换：**只有显式传了**才动库（旧页面、旧版本快照不带这两个字段 → 现值一律保留）。
// 只写 tag_types / tag_defs 两张字典表，从不碰 nodes.tags —— 节点的标签格式自始至终没变。
function writeTagMeta(cid, tagTypes, tagDefs) {
  const types = new Set();
  if (Array.isArray(tagTypes)) {
    db.prepare('DELETE FROM tag_types WHERE canvas=?').run(cid);
    const ins = db.prepare('INSERT OR REPLACE INTO tag_types(canvas,name,color,ord) VALUES(?,?,?,?)');
    const seen = new Set();
    tagTypes.forEach((t, i) => {
      const name = String((t && t.name) || '').trim();
      if (!name || seen.has(name)) return;                       // 空名 / 重名：跳过，不写坏表
      seen.add(name); types.add(name);
      const c = String((t && t.color) || '');
      ins.run(cid, name, /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#2563EB', Number.isFinite(t && t.ord) ? t.ord : i);
    });
  } else {
    db.prepare('SELECT name FROM tag_types WHERE canvas=?').all(cid).forEach((r) => types.add(r.name));
  }
  if (tagDefs === undefined || tagDefs === null) return;
  const entries = Array.isArray(tagDefs) ? tagDefs.map((d) => [d && d.tag, d && d.type]) : Object.entries(tagDefs);
  db.prepare('DELETE FROM tag_defs WHERE canvas=?').run(cid);
  const ins = db.prepare('INSERT OR REPLACE INTO tag_defs(canvas,tag,type) VALUES(?,?,?)');
  const final = new Map();                                        // 同名以**最后一次**出现为准（与前端「后写的类型生效」一致）
  for (const [rawTag, rawType] of entries) {
    const tag = String(rawTag || '').trim();
    if (!tag) continue;
    final.set(tag, String(rawType || ''));
  }
  for (const [tag, type] of final) ins.run(cid, tag, types.has(type) ? type : '');   // 指向已删除的类型 → 归一为未分类
}
function writeGraph(cid, nodes, edges, columns, tagTypes, tagDefs, headColor, style) {
  tx(() => {                                       // 整图重写必须原子：中途失败要回滚，不能留半张图
    // 整图重写前留底：客户端**没带**某个新字段时（旧页面 / 旧版本快照 / 旧草稿）→ 保留库中现值，不清空。
    // 节点按 id 匹配；连线按「端点对」匹配（连线 id 每次保存都会重建，不能按 id）。取值都限定在**本画布**内。
    const prevN = new Map(db.prepare('SELECT id,tags,grp,tagtypes FROM nodes WHERE canvas=?').all(cid).map((r) => [r.id, r]));
    const prevE = new Map(db.prepare('SELECT from_id,to_id,status FROM edges WHERE canvas=?').all(cid).map((r) => [r.from_id + '>' + r.to_id, r]));
    const pickField = (cur, f, old) => (cur[f] != null ? String(cur[f]) : (old && old[f] != null ? String(old[f]) : ''));
    wipeCanvas(cid, ['nodes', 'edges']);           // ⚠️ 必须按画布删：漏了就是"保存 A 画布清空 B"
    // 标签类型归属要按「本次提交的 tagTypes」清洗：指向已删类型的归属归一为空，不留悬空
    const liveTypes = new Set(Array.isArray(tagTypes)
      ? tagTypes.map((t) => String((t && t.name) || '').trim()).filter(Boolean)
      : db.prepare('SELECT name FROM tag_types WHERE canvas=?').all(cid).map((r) => r.name));
    // 未提交（undefined）→ 保留库里现值（**同样过一遍清洗**，别把指向已删类型的悬空值原样写回）；
    // 提交了（含 '' / '{}'）→ 按提交的清洗结果写
    const pickTagTypes = (cur, old) => (cur.tagtypes != null
      ? cleanTagTypes(cur.tagtypes, liveTypes)
      : (old && old.tagtypes != null ? cleanTagTypes(String(old.tagtypes), liveTypes) : ''));
    const insN = db.prepare('INSERT OR REPLACE INTO nodes(canvas,id,kind,name,status,source,note,image,tags,grp,tagtypes,by,updated_at,ord,ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)');
    const seenN = new Set();
    nodes.forEach((n, i) => {
      if (seenN.has(n.id)) return;
      seenN.add(n.id);
      const old = prevN.get(n.id);
      insN.run(cid, n.id, n.kind, n.name, n.status || '明确', n.source || '', n.note || '', n.image || '',
        pickField(n, 'tags', old), pickField(n, 'grp', old), pickTagTypes(n, old),
        n.by || '', n.updated_at || now(), Number.isFinite(n.ord) ? n.ord : i);
    });
    const insE = db.prepare('INSERT OR REPLACE INTO edges(canvas,id,from_id,to_id,status,by,updated_at,ver) VALUES(?,?,?,?,?,?,?,1)');
    const seenE = new Set();
    for (const e of edges) {
      const from = e.from_id ?? e.from, to = e.to_id ?? e.to;
      const k = from + '>' + to;
      if (seenE.has(k)) continue;            // 去重：同一 from→to 只存一条
      seenE.add(k);
      const st = pickField(e, 'status', prevE.get(k));                                  // 缺失→保留；显式给值→按给的走
      insE.run(cid, uuid(), from, to, st === '待确认' ? '待确认' : '明确', e.by || '', e.updated_at || now());   // id 由服务器生成，避免客户端 id 撞车导致丢边
    }
    writeTagMeta(cid, tagTypes, tagDefs);            // 标签类型 + 归属：与节点同一事务
    if (headColor !== undefined && headColor !== null)   // 栏目配色也进同一事务；null = 本次未提交（保持现值）
      db.prepare('UPDATE canvases SET color=? WHERE id=?')
        .run(/^#[0-9a-fA-F]{6}$/.test(String(headColor || '')) ? String(headColor) : '', cid);
    if (style && typeof style === 'object' && !Array.isArray(style)) {
      // 节点样式：**白名单 + 长度上限**，脏字段直接丢掉。
      // （别用 JSON.stringify(...).slice() 截断：切出半截 JSON 会让读取回落 {}，等于把整张画布的样式静默清零）
      const ALLOWED = ['colSize', 'colWeight', 'colColor', 'nmSize', 'nmWeight', 'nmColor',
        'selColor', 'selRing', 'selBg', 'chainColor', 'chainRing', 'chainBg', 'edgeColor'];
      const clean = {};
      for (const k of ALLOWED) {
        const v = style[k];
        if (typeof v === 'string' && v.length <= 32) clean[k] = v;
      }
      db.prepare('UPDATE canvases SET style=? WHERE id=?').run(JSON.stringify(clean), cid);
    }
    if (Array.isArray(columns) && columns.length) {   // 空数组 = 本次未提交栏目：不碰栏目表（旧行为会清空）
      db.prepare('DELETE FROM columns WHERE canvas=?').run(cid);
      const insC = db.prepare('INSERT OR REPLACE INTO columns(canvas,kind,title,ord) VALUES(?,?,?,?)');
      columns.forEach((c, i) => insC.run(cid, c.kind, c.title || c.kind, Number.isFinite(c.ord) ? c.ord : i));
    }
  });
}
function currentGraph(cid) {
  // 读时归一：指向已不存在类型的归属 → ''（未分类）。不依赖前端兜底，第二个消费方也不会拿到悬空类型
  const liveTypes = new Set(db.prepare('SELECT name FROM tag_types WHERE canvas=?').all(cid).map((r) => r.name));
  const tagDefs = {};
  db.prepare('SELECT tag,type FROM tag_defs WHERE canvas=?').all(cid)
    .forEach((r) => { tagDefs[r.tag] = liveTypes.has(r.type) ? r.type : ''; });
  return {
    nodes: db.prepare('SELECT * FROM nodes WHERE canvas=? ORDER BY kind, ord, name').all(cid),
    edges: db.prepare('SELECT * FROM edges WHERE canvas=?').all(cid),
    columns: db.prepare('SELECT kind,title,ord FROM columns WHERE canvas=? ORDER BY ord').all(cid),
    tagTypes: db.prepare('SELECT name,color,ord FROM tag_types WHERE canvas=? ORDER BY ord, name').all(cid),
    tagDefs,
  };
}
function saveVersion(cid, by, note, forceNote) {
  const g = currentGraph(cid);
  // 画布级外观（配色 / 节点样式）也要进快照，否则"恢复到某版本"只回内容不回外观
  const cv = db.prepare('SELECT color,style FROM canvases WHERE id=?').get(cid) || {};
  g.headColor = cv.color || '';
  try { g.style = cv.style ? JSON.parse(cv.style) : {}; } catch { g.style = {}; }
  const id = 'v' + Date.now().toString(36) + uuid().slice(0, 2);
  db.prepare('INSERT INTO versions(id,canvas,created_at,by,note,base_rev,n_nodes,n_edges,data) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, cid, now(), by || '', forceNote ?? note ?? '', canvasRev(cid), g.nodes.length, g.edges.length, JSON.stringify(g));
  return id;
}
if (seedIfEmpty()) console.log('已用 seed.json 初始化数据');

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
const TOO_LARGE = Symbol('too_large');             // readBody 超限的哨兵：调用方据此返回 413
function readBody(req, limit = MAX_UP * 2) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return;                            // 超限后继续把流读干（不 destroy），保证 end 一定触发
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return resolve(TOO_LARGE);
      if (!chunks.length) return resolve({});
      // 整体解码：逐块 toString 会在分块边界切断多字节字符，把中文变成 U+FFFD 写进库
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
// 只认这几种真图片格式（按魔数，不信任客户端声明的 MIME）；SVG 可携带脚本，一律不收
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head4 = buf.slice(0, 4).toString('latin1');
  if (head4 === 'GIF8') return 'gif';
  if (head4 === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    // ---- 登录（无需鉴权，但有失败限流）----
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const ip = clientIp(req);
      const wait = loginLockLeft(ip);
      if (wait) return json(res, 429, { error: `尝试过于频繁，请 ${wait} 秒后再试` });
      const who = userByName(b.username);
      if (!who || !checkPassword(b.password, who.pass)) { noteLoginFail(ip); return json(res, 401, { error: '用户名或密码不正确' }); }
      noteLoginOk(ip);
      return json(res, 200, { ok: true, token: issueToken(who.id), days: TOKEN_DAYS, id: who.id,
        name: who.name, role: who.role, mustChange: !!who.must_change });
    }

    // ---- 其余 API 需鉴权 ----
    if (p.startsWith('/api/')) {
      const h = req.headers['authorization'] || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : (u.searchParams.get('t') || '');
      const payload = verifyToken(token);
      if (!payload) return json(res, 401, { error: '未登录或令牌失效' });
      const me = userById(payload.uid);            // 每次回库：改角色 / 删用户立刻生效
      if (!me) return json(res, 401, { error: '账号不存在（可能已被管理员删除）' });
      req.user = me;
      req.userName = me.name;                      // 操作人一律以库里账号为准，客户端不能自定
      req.userRole = me.role;
      // 还没改初始密码：只放行"看自己""改自己密码"
      const MUST_ALLOW = ['/api/me', '/api/me/password'];   // 退出只在前端清 token，服务端没有 logout 路由
      if (me.must_change && !MUST_ALLOW.includes(p))
        return json(res, 403, { error: '请先修改初始密码', mustChange: true });
      // 只读账号：在**服务端**拦所有写操作。前端隐藏按钮只是体验层，不能当权限。
      if (me.role === 'ro' && req.method !== 'GET' && req.method !== 'HEAD' && !MUST_ALLOW.includes(p))
        return json(res, 403, { error: '只读账号：没有修改权限' });   // 改自己的密码要放行，否则 ro 用户永远解不开 must_change
      if (String(p).startsWith('/api/users') && me.role !== 'admin')
        return json(res, 403, { error: '只有管理员可以管理用户' });
    }

    // ---- 账号自助 ----
    if (p === '/api/me' && req.method === 'GET')
      return json(res, 200, { id: req.user.id, name: req.user.name, role: req.user.role, mustChange: !!req.user.must_change });

    if (p === '/api/me/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      if (!cur || !checkPassword(b.old, cur.pass)) return json(res, 400, { error: '当前密码不正确' });
      const next = String(b.new || '');
      if (next.length < 6) return json(res, 400, { error: '新密码至少 6 位' });
      db.prepare('UPDATE users SET pass=?, must_change=0, updated_at=? WHERE id=?').run(hashPassword(next), now(), req.user.id);
      return json(res, 200, { ok: true });
    }

    // ---- 用户管理（仅 admin；/api/users* 的权限已在鉴权中间件统一拦过）----
    if (p === '/api/users' && req.method === 'GET')
      return json(res, 200, { users: db.prepare('SELECT * FROM users ORDER BY id').all().map(pubUser) });

    if (p === '/api/users' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const name = String(b.name || '').trim();
      const role = ROLES.includes(b.role) ? b.role : 'rw';
      if (!name || name.length > 40) return json(res, 400, { error: '用户名需 1–40 个字符' });
      if (userByName(name)) return json(res, 409, { error: '用户名已存在：' + name });
      const given = String(b.password || '').trim();          // 没给口令 → 随机生成，回显这一次
      const pw = given || genPassword();
      db.prepare('INSERT INTO users(name,pass,role,must_change,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(name, hashPassword(pw), role, given ? 0 : 1, now(), now());
      const u0 = userByName(name);
      const out = { ok: true, user: pubUser(u0) };
      if (!given) out.password = pw;
      return json(res, 200, out);
    }

    let mu;
    if ((mu = p.match(/^\/api\/users\/(\d+)$/)) && (req.method === 'POST' || req.method === 'DELETE')) {
      const id = Number(mu[1]);
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!target) return json(res, 404, { error: '用户不存在' });
      if (req.method === 'DELETE') {
        if (id === req.user.id) return json(res, 400, { error: '不能删除自己' });
        if (target.role === 'admin' && countAdmins() <= 1) return json(res, 409, { error: '至少要保留一个管理员' });
        db.prepare('DELETE FROM users WHERE id=?').run(id);
        return json(res, 200, { ok: true });
      }
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const sets = [], vals = [];
      if (b.name !== undefined) {
        const nm = String(b.name || '').trim();
        if (!nm || nm.length > 40) return json(res, 400, { error: '用户名需 1–40 个字符' });
        const dup = userByName(nm);
        if (dup && dup.id !== id) return json(res, 409, { error: '用户名已存在：' + nm });
        sets.push('name=?'); vals.push(nm);
      }
      if (b.role !== undefined) {
        if (!ROLES.includes(b.role)) return json(res, 400, { error: '角色只能是 admin / rw / ro' });
        if (target.role === 'admin' && b.role !== 'admin' && countAdmins() <= 1)
          return json(res, 409, { error: '至少要保留一个管理员' });
        sets.push('role=?'); vals.push(b.role);
      }
      let issued = null;
      if (b.password !== undefined) {                        // 传 '' 或空 = 重置为随机，回显一次
        const given = String(b.password || '').trim();
        issued = given || genPassword();
        sets.push('pass=?', 'must_change=?'); vals.push(hashPassword(issued), given ? 0 : 1);
      }
      if (!sets.length) return json(res, 400, { error: '没有要修改的字段' });
      vals.push(now(), id);
      db.prepare('UPDATE users SET ' + sets.concat('updated_at=?').join(', ') + ' WHERE id=?').run(...vals);
      const out = { ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
      if (b.password !== undefined && !String(b.password).trim()) out.password = issued;
      return json(res, 200, out);
    }

    // 画布参数缺省 → 默认画布（旧客户端照旧可用）；resolveCanvas 自己会把参数规整成字符串

    if (p === '/api/graph' && req.method === 'GET') {
      const cid = resolveCanvas(u.searchParams.get('canvas'));
      if (!cid) return json(res, 400, { error: '画布不存在' });
      const cv = db.prepare('SELECT color,style FROM canvases WHERE id=?').get(cid) || {};
      let style = {};
      try { style = cv.style ? JSON.parse(cv.style) : {}; } catch { style = {}; }   // 坏 JSON 不让整张画布挂掉
      return json(res, 200, { rev: canvasRev(cid), canvas: cid, headColor: cv.color || '', style, ...currentGraph(cid) });
    }

    // 当前访问者：IP（反代下取 XFF 最后一跳）、姓名、角色、IP 归属地（无库/内网则为 null）
    if (p === '/api/whoami' && req.method === 'GET') {
      const ip = clientIp(req);
      return json(res, 200, { ip, id: req.user.id, name: req.userName, role: req.userRole,
        geo: geo.lookup(ip), geoLabel: geo.label(ip), geoReady: geo.ready() });
    }

    // 只回 rev 的小接口：前端轮询只想知道"有没有人存过"，不必拉整张图
    if (p === '/api/rev' && req.method === 'GET') {
      const cid = resolveCanvas(u.searchParams.get('canvas'));
      if (!cid) return json(res, 400, { error: '画布不存在' });
      return json(res, 200, { canvas: cid, rev: canvasRev(cid) });
    }

    // 画布列表（带计数，供前端"删除画布"确认弹窗用）
    if (p === '/api/canvases' && req.method === 'GET') {
      const rows = db.prepare('SELECT id,name,ord,rev FROM canvases ORDER BY ord, id').all();
      const st = db.prepare(`SELECT (SELECT COUNT(*) FROM nodes    WHERE canvas=?) n,
                                    (SELECT COUNT(*) FROM edges    WHERE canvas=?) e,
                                    (SELECT COUNT(*) FROM versions WHERE canvas=?) v`);
      return json(res, 200, { canvases: rows.map((c) => {
        const s = st.get(c.id, c.id, c.id);
        return { ...c, n_nodes: s.n, n_edges: s.e, n_versions: s.v };
      }) });
    }

    // 新建画布：空白 + 默认 6 栏
    if (p === '/api/canvas/create' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const name = String(b.name || '').trim();
      if (!name) return json(res, 400, { error: '画布名不能为空' });
      if (db.prepare('SELECT 1 x FROM canvases WHERE name=?').get(name)) return json(res, 400, { error: '已有同名画布：' + name });
      const id = 'c' + Date.now().toString(36) + uuid().slice(0, 3);
      const ord = (db.prepare('SELECT COALESCE(MAX(ord),-1)+1 o FROM canvases').get() || {}).o || 0;
      tx(() => {
        db.prepare('INSERT INTO canvases(id,name,ord,rev) VALUES(?,?,?,0)').run(id, name, ord);
        const insC = db.prepare('INSERT INTO columns(canvas,kind,title,ord) VALUES(?,?,?,?)');
        DEFAULT_COLUMNS.forEach(([k, t], i) => insC.run(id, k, t, i));
      });
      return json(res, 200, { ok: true, id, name, rev: 0 });
    }

    // 复制画布：以某张画布为模板另存一张（栏目/节点/连线全带，版本历史不带）
    // 之所以便宜：nodes/edges/columns 主键是 (canvas, id)/(canvas, kind) → 复制＝换个 canvas 值再插一遍，
    // 行的 id 可原样复用，边的 from_id/to_id 因此自动仍指向本画布存在的节点。
    if (p === '/api/canvas/duplicate' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const src = resolveCanvas(b.id);
      if (!src) return json(res, 400, { error: '画布不存在' });
      const name = String(b.name || '').trim();
      if (!name) return json(res, 400, { error: '画布名不能为空' });
      if (db.prepare('SELECT 1 x FROM canvases WHERE name=?').get(name)) return json(res, 400, { error: '已有同名画布：' + name });
      const srcName = (db.prepare('SELECT name FROM canvases WHERE id=?').get(src) || {}).name || src;
      const id = 'c' + Date.now().toString(36) + uuid().slice(0, 3);
      const ord = (db.prepare('SELECT COALESCE(MAX(ord),-1)+1 o FROM canvases').get() || {}).o || 0;
      tx(() => {
        db.prepare('INSERT INTO canvases(id,name,ord,rev) VALUES(?,?,?,0)').run(id, name, ord);
        // 显式列名（不用 SELECT *）：以后加列也不会错位
        db.prepare('INSERT INTO columns(canvas,kind,title,ord) SELECT ?,kind,title,ord FROM columns WHERE canvas=?').run(id, src);
        db.prepare(`INSERT INTO nodes(canvas,id,kind,name,status,source,note,image,tags,grp,tagtypes,by,updated_at,ver,ord)
          SELECT ?,id,kind,name,status,source,note,image,tags,grp,tagtypes,by,updated_at,ver,ord FROM nodes WHERE canvas=?`).run(id, src);
        db.prepare(`INSERT INTO edges(canvas,id,from_id,to_id,status,by,updated_at,ver)
          SELECT ?,id,from_id,to_id,status,by,updated_at,ver FROM edges WHERE canvas=?`).run(id, src);
        db.prepare('INSERT INTO tag_types(canvas,name,color,ord) SELECT ?,name,color,ord FROM tag_types WHERE canvas=?').run(id, src);
        db.prepare('INSERT INTO tag_defs(canvas,tag,type) SELECT ?,tag,type FROM tag_defs WHERE canvas=?').run(id, src);
        db.prepare('UPDATE canvases SET color=(SELECT color FROM canvases WHERE id=?), style=(SELECT style FROM canvases WHERE id=?) WHERE id=?').run(src, src, id);   // 复制画布连配色与节点样式一起带
        saveVersion(id, req.userName, '', '复制自「' + srcName + '」');   // 只留一个初始版本作还原点
      });
      const st = db.prepare('SELECT (SELECT COUNT(*) FROM nodes WHERE canvas=?) n, (SELECT COUNT(*) FROM edges WHERE canvas=?) e').get(id, id);
      return json(res, 200, { ok: true, id, name, rev: 0, n_nodes: st.n, n_edges: st.e });
    }

    // 重命名画布
    if (p === '/api/canvas/rename' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const cid = resolveCanvas(b.id);
      if (!cid) return json(res, 400, { error: '画布不存在' });
      const name = String(b.name || '').trim();
      if (!name) return json(res, 400, { error: '画布名不能为空' });
      const dup = db.prepare('SELECT id FROM canvases WHERE name=? AND id<>?').get(name, cid);
      if (dup) return json(res, 400, { error: '已有同名画布：' + name });
      db.prepare('UPDATE canvases SET name=? WHERE id=?').run(name, cid);
      return json(res, 200, { ok: true, id: cid, name });
    }

    // 删除画布（连它的节点/连线/栏目/版本一起删）；破坏性 → 必须显式确认；不许删最后一张
    if (p === '/api/canvas/delete' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      if (b.confirm !== 'DELETE') return json(res, 400, { error: '删除画布不可恢复：请显式传 {"confirm":"DELETE"}' });
      const cid = resolveCanvas(b.id);
      if (!cid) return json(res, 400, { error: '画布不存在' });
      if (countOf('canvases') <= 1) return json(res, 400, { error: '至少要保留一张画布' });
      tx(() => {
        wipeCanvas(cid, CANVAS_SCOPED);                            // 连它的版本历史一起删
        db.prepare('DELETE FROM canvases WHERE id=?').run(cid);
      });
      return json(res, 200, { ok: true, id: cid, next: defaultCanvasId() });
    }

    // 保存草稿 → 新版本（只作用于 payload.canvas，缺省=默认画布）
    if (p === '/api/save' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });   // 超限：先于数组校验，否则对 Symbol 取 .nodes 会误判 400
      const cid = resolveCanvas(b.canvas);
      if (!cid) return json(res, 400, { error: '画布不存在' });
      if (!Array.isArray(b.nodes) || !Array.isArray(b.edges))      // 防：请求体坏了会把整个图清空
        return json(res, 400, { error: '请求体无效（nodes/edges 必须为数组）' });
      const badN = b.nodes.filter((n) => !isValidNode(n)).length;   // 逐项校验：非法项宁可 400，也不写坏整张图
      const badE = b.edges.filter((e) => !isValidEdge(e)).length;
      if (badN || badE)
        return json(res, 400, { error: '请求体无效：' + badN + ' 个节点 / ' + badE + ' 条连线缺少 id/kind/name', badNodes: badN, badEdges: badE });
      if (b.columns !== undefined && (!Array.isArray(b.columns) || b.columns.some((c) => !isValidColumn(c))))
        return json(res, 400, { error: '请求体无效：columns 需为 {kind} 数组' });
      if (b.tagTypes !== undefined && b.tagTypes !== null && !Array.isArray(b.tagTypes))
        return json(res, 400, { error: '请求体无效：tagTypes 需为 {name,color,ord} 数组' });
      if (b.tagDefs !== undefined && b.tagDefs !== null && (typeof b.tagDefs !== 'object' || Array.isArray(b.tagDefs)))
        return json(res, 400, { error: '请求体无效：tagDefs 需为 {标签:类型} 对象' });
      const cur = canvasRev(cid);                                  // 乐观锁按画布：别的画布保存不会让这里假冲突
      if (b.baseRev !== undefined && Number(b.baseRev) !== cur && !b.force)
        return json(res, 409, { error: 'conflict', rev: cur, msg: '有人在你编辑期间保存过' });
      writeGraph(cid, b.nodes, b.edges, b.columns, b.tagTypes, b.tagDefs, b.headColor, b.style);
      const vid = saveVersion(cid, req.userName, b.note, b.note);
      bumpCanvasRev(cid);
      return json(res, 200, { ok: true, canvas: cid, rev: canvasRev(cid), versionId: vid });
    }

    if (p === '/api/versions' && req.method === 'GET') {
      const cid = resolveCanvas(u.searchParams.get('canvas'));
      if (!cid) return json(res, 400, { error: '画布不存在' });
      const rows = db.prepare('SELECT id,canvas,created_at,by,note,n_nodes,n_edges FROM versions WHERE canvas=? ORDER BY created_at DESC').all(cid);
      return json(res, 200, { canvas: cid, versions: rows });
    }
    let m;
    if ((m = p.match(/^\/api\/versions\/(.+)$/)) && req.method === 'GET') {
      const v = db.prepare('SELECT * FROM versions WHERE id=?').get(decodeURIComponent(m[1]));
      if (!v) return json(res, 404, { error: '版本不存在' });
      const d = JSON.parse(v.data);
      return json(res, 200, { id: v.id, canvas: v.canvas, created_at: v.created_at, by: v.by, note: v.note,
        nodes: d.nodes || [], edges: d.edges || [], columns: d.columns || [],
        tagTypes: d.tagTypes, tagDefs: d.tagDefs, headColor: d.headColor, style: d.style });   // 旧版本没有这些字段 → undefined
    }
    if ((m = p.match(/^\/api\/restore\/(.+)$/)) && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const v = db.prepare('SELECT * FROM versions WHERE id=?').get(decodeURIComponent(m[1]));
      if (!v) return json(res, 404, { error: '版本不存在' });
      const cid = resolveCanvas(v.canvas);                   // 恢复到**该版本自己的画布**
      if (!cid) return json(res, 400, { error: '该版本所属画布已不存在' });
      // 恢复同样是整图重写：有人在你点「恢复」之后保存过，就得先问一句，不能静默顶掉
      const cur0 = canvasRev(cid);
      if (b.baseRev !== undefined && Number(b.baseRev) !== cur0 && !b.force)
        return json(res, 409, { error: 'conflict', rev: cur0, msg: '有人在你操作期间保存过，恢复会覆盖它' });
      const d = JSON.parse(v.data);
      // 老快照里的节点没有 tagtypes：必须用**该快照自带的 tagDefs** 展开后再写，
      // 否则 writeGraph 会按"未提交 → 保留现值"处理，等于把恢复后的类型留成当前数据（恢复不完整）。
      expandTagTypes(d.nodes, d.tagDefs);
      writeGraph(cid, d.nodes || [], d.edges || [], d.columns, d.tagTypes, d.tagDefs, d.headColor, d.style);   // 旧版本快照没有这几项 → 保留现值（undefined 不写）
      const vid = saveVersion(cid, req.userName, '', '恢复到 ' + localStamp(v.created_at) + ' 的版本');
      bumpCanvasRev(cid);
      return json(res, 200, { ok: true, canvas: cid, rev: canvasRev(cid), versionId: vid });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      if (b.confirm !== 'RESET')                       // 破坏性且无 UI 入口：必须显式确认，防误触
        return json(res, 400, { error: '重置会清空画布：请显式传 {"confirm":"RESET"}' });
      const cid = resolveCanvas(b.canvas);
      if (!cid) return json(res, 400, { error: '画布不存在' });
      const cur1 = canvasRev(cid);
      if (b.baseRev !== undefined && Number(b.baseRev) !== cur1 && !b.force)
        return json(res, 409, { error: 'conflict', rev: cur1, msg: '有人在你操作期间保存过，重置会覆盖它' });
      wipeCanvas(cid, ['nodes', 'edges', 'columns', 'tag_types', 'tag_defs']);
      applySeed(cid);
      setMeta('seeded', '1');
      const insC = db.prepare('INSERT OR REPLACE INTO columns(canvas,kind,title,ord) VALUES(?,?,?,?)');
      DEFAULT_COLUMNS.forEach(([k, t], i) => insC.run(cid, k, t, i));
      const vid = saveVersion(cid, req.userName, '', '重置为种子数据');
      bumpCanvasRev(cid);
      return json(res, 200, { ok: true, canvas: cid, rev: canvasRev(cid), versionId: vid });
    }

    // 上传流程图（JSON base64）
    if (p === '/api/upload' && req.method === 'POST') {
      const b = await readBody(req);
      if (b === TOO_LARGE) return json(res, 413, { error: '请求体过大' });
      const mm = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(b.dataUrl || '');
      if (!mm) return json(res, 400, { error: '仅支持图片（base64 dataURL）' });
      const buf = Buffer.from(mm[2], 'base64');
      if (buf.length > MAX_UP) return json(res, 413, { error: '图片过大（>10MB）' });
      const ext = sniffImage(buf);                     // 按魔数定类型：不信任声明的 MIME，SVG/HTML 一律拒收
      if (!ext) return json(res, 400, { error: '仅支持 PNG / JPG / GIF / WebP / BMP 图片（不收 SVG）' });
      const fname = `${Date.now()}-${uuid()}.${ext}`;
      fs.writeFileSync(path.join(UP_DIR, fname), buf);
      return json(res, 200, { ok: true, url: '/uploads/' + fname });
    }

    // ---- 静态：/uploads（需登录；<img> 发不了 Authorization 头，故也接受 ?t=令牌）----
    if (p.startsWith('/uploads/')) {
      const h = req.headers['authorization'] || '';
      const t = h.startsWith('Bearer ') ? h.slice(7) : (u.searchParams.get('t') || '');
      const pl = verifyToken(t);
      if (!pl) return json(res, 401, { error: '未登录或令牌失效' });
      if (!userById(pl.uid)) return json(res, 401, { error: '账号不存在（可能已被管理员删除）' });   // 删用户后图片也不给看
      const fp = path.join(UP_DIR, path.basename(decodeURIComponent(p)));
      if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=604800, immutable' });
      return fs.createReadStream(fp).pipe(res);
    }

    // ---- 静态：public ----
    const file = p === '/' ? '/index.html' : p;
    const fp = path.join(DIR, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
    if (!fp.startsWith(path.join(DIR, 'public')) || !fs.existsSync(fp)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n多维关系画布已启动：http://localhost:${PORT}`);
  console.log(`运行时数据：${DATA_DIR} ｜ 令牌有效期：${TOKEN_DAYS} 天`);
  console.log(`登录限流：${LOGIN_WINDOW_MS / 60000} 分钟内失败 ${LOGIN_MAX} 次 → 锁 ${LOGIN_LOCK_MS / 60000} 分钟${process.env.TRUST_PROXY === '1' ? ' ｜ 已信任 X-Forwarded-For' : ''}`);
  console.log(`账号：${db.prepare('SELECT COUNT(*) c FROM users').get().c} 个（admin 可在右上角「用户管理」里维护）`);
  if (adminNote) console.log('账号：' + adminNote);
  if (adminNote && !process.env.ADMIN_PASSWORD)
    console.log('      ⚠ 默认管理员口令写在源码里（公开仓库可见）——用它登录后会被要求立刻修改');
  console.log(`IP 归属地：${geo.ready() ? '已加载 ' + geo.status().file : '未加载（' + geo.status().error + '）—— 顶栏只显示 IP'}`);
});
