// 多维关系画布 · 备份脚本（零依赖，Node 22.5+）
//
// 用法：node backup.js
//   备份 data/ 目录（data.db + uploads/）到 BACKUP_DIR/facet-<时间戳>/
//   —— 数据库用 VACUUM INTO 导出【一致性快照】，服务运行中执行也安全（无需停机）；
//      图片是一次写入、永不修改的普通文件，直接递归拷贝即可。
//
// 环境变量（都可选，与 server.js 同名同义）：
//   DATA_DIR    运行时数据目录，默认 <本目录>/data
//   DB_PATH     数据库路径，默认 <DATA_DIR>/data.db
//   UP_DIR      图片目录，默认 <DATA_DIR>/uploads
//   BACKUP_DIR  备份根目录，默认 <本目录>/../facet-canvas-backups （必须在 DATA_DIR 之外）
//               注：目录名沿用旧名，改成新名会让已有备份变成孤儿
//   KEEP        保留最近几份，默认 14
//
// 定时执行（示例）：
//   Linux :  0 3 * * * cd /opt/facet-canvas && /usr/bin/node backup.js >> backup.log 2>&1
//   Windows: 任务计划程序 → 每天 03:00 → 程序 node、参数 backup.js、起始目录=本目录

const fs = require('node:fs');
const path = require('node:path');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { console.error('[备份失败] 需要 Node.js 22.5+（用到内置 node:sqlite）'); process.exit(1); }

const DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(DIR, 'data');                 // 与 server.js 保持一致
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'data.db');           // 尊重服务端自定义路径
const UP_SRC = process.env.UP_DIR || path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DIR, '..', 'facet-canvas-backups');
const KEEP = Math.max(1, Number(process.env.KEEP || 14) || 14);
const NAME_RE = /^facet-\d{8}-\d{6}(-\d+)?$/;              // 只清理本脚本产出的目录（早期别名的目录不在此列，需手动清理）

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function copyDir(src, dest) {                        // 递归拷贝（显式实现：语义明确、可移植）
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
function removeDir(dir) {                            // 递归删除
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) removeDir(p); else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}
function fail(msg) { console.error('[备份失败] ' + msg); process.exit(1); }

try {
  const abs = p => path.resolve(p).toLowerCase() + path.sep;
  if (abs(BACKUP_DIR).startsWith(abs(DATA_DIR)))                       // 否则备份会把自己也备进去
    fail(`备份目录不能放在数据目录内：${BACKUP_DIR}（请指到 ${DATA_DIR} 之外）`);
  if (!fs.existsSync(DB_PATH)) fail(`找不到数据库：${DB_PATH}（先启动一次 server.js 生成？）`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = 'facet-' + stamp();
  let out = path.join(BACKUP_DIR, base);
  for (let i = 2; fs.existsSync(out); i++) out = path.join(BACKUP_DIR, `${base}-${i}`);   // 同一秒重复跑：加后缀
  fs.mkdirSync(out, { recursive: true });

  // 1) 数据库：一致性快照（只读源 + 另写新文件，不动线上库）
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(path.join(out, 'data.db')); }
  finally { db.close(); }

  // 2) 图片：整目录拷贝（图片一次写入、永不修改，直接拷安全）
  let imgs = 0;
  if (fs.existsSync(UP_SRC)) { copyDir(UP_SRC, path.join(out, 'uploads')); imgs = fs.readdirSync(UP_SRC).length; }

  // 3) 清单（便于人肉核对这份备份是什么）
  const dbSize = fs.statSync(path.join(out, 'data.db')).size;
  fs.writeFileSync(path.join(out, 'manifest.txt'),
    `备份时间：${new Date().toISOString()}\n源目录：${DATA_DIR}\n数据库：data.db（${dbSize} 字节）\n图片：uploads/（${imgs} 个）\n`);

  // 4) 清理旧备份：按修改时间倒序，只留最近 KEEP 份
  const olds = fs.readdirSync(BACKUP_DIR).filter(n => NAME_RE.test(n))
    .map(n => ({ n, t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t).map(x => x.n);
  olds.slice(KEEP).forEach(n => {
    try { removeDir(path.join(BACKUP_DIR, n)); console.log('已清理旧备份：' + n); }
    catch (e) { console.warn('旧备份清理失败（不影响本次备份）：' + n + ' — ' + e.message); }
  });

  console.log(`[备份完成] ${out}（数据库 ${dbSize} 字节 + 图片 ${imgs} 个；保留最近 ${KEEP} 份，现有 ${Math.min(olds.length, KEEP)} 份）`);
} catch (e) { fail(e.message); }
