#!/usr/bin/env node
/* 文档一致性断言：把"单一事实源"从口号变成可失败的红绿灯。
 *   1) 默认管理员口令：server.js 的常量 == 每篇提到"初始密码"的文档里写的值
 *   2) 版本号：package.json == docs/CHANGELOG.md 的第一个 ## [x.y.z]
 *   3) 文档链接：所有 .md 里的相对链接都能落地（防指针断）
 * 用法：node test/docs-consistency.js（npm test 会先跑它）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? '  → ' + d : '')); };

// ---------- 收集所有 md ----------
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
};
const mds = walk(ROOT);
console.log('文档一致性检查（' + mds.length + ' 篇 md）\n');

// ---------- 1. 默认管理员口令 ----------
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mPw = srv.match(/DEFAULT_ADMIN_PASSWORD\s*=\s*'([^']+)'/);
if (!mPw) bad('server.js 里找不到 DEFAULT_ADMIN_PASSWORD');
else {
  const PW = mPw[1];
  const PREFIX = PW.slice(0, 5);                  // 文档里一旦出现这个前缀，就必须是完整正确值
  const must = ['README.md', 'docs/auth.md'];     // 这两篇必须给出完整值，否则首次使用会卡住
  for (const r of must) {
    const t = fs.readFileSync(path.join(ROOT, r), 'utf8');
    if (t.includes(PW)) ok(r + ' 给出完整的默认口令');
    else bad(r + ' 没有给出完整的默认口令', '应包含 ' + PW.slice(0, 6) + '...');
  }
  for (const p of mds) {
    const r = rel(p);
    if (must.includes(r)) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (!t.includes(PREFIX)) continue;             // 没写口令字面量 → 不管
    if (t.includes(PW)) ok(r + ' 的口令字面量与 server.js 一致');
    else bad(r + ' 写了口令但值不对（或用了省略号）', '要么写全，要么改成指向 docs/auth.md');
  }
}

// ---------- 2. 版本号 ↔ CHANGELOG ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const cl = fs.readFileSync(path.join(ROOT, 'docs/CHANGELOG.md'), 'utf8');
const mVer = cl.match(/^## \[([^\]]+)\]/m);
if (!mVer) bad('docs/CHANGELOG.md 里没有 ## [x.y.z] 形式的版本段');
else if (mVer[1] !== pkg.version) bad('package.json 版本 ' + pkg.version + ' ≠ CHANGELOG 首条 ' + mVer[1]);
else ok('package.json ' + pkg.version + ' 与 CHANGELOG 首条一致');

// ---------- 3. 相对链接可达 ----------
let links = 0, broken = 0;
for (const p of mds) {
  const raw = fs.readFileSync(p, 'utf8');
  const body = raw.replace(/```[\s\S]*?```/g, '');      // 跳过代码块里的示例链接
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    links++;
    const target = path.resolve(path.dirname(p), decodeURI(href.split('#')[0]));
    if (!fs.existsSync(target)) { broken++; bad('链接失效', rel(p) + ' → ' + href); }
  }
}
if (!broken) ok(links + ' 条相对链接全部可达');

// ---------- 4. API 覆盖：server.js 里的每个 /api 路径都必须在 data-model.md 里出现 ----------
const apiSrc = srv.split("'").filter((x) => x.startsWith('/api/')).map((x) => x.split('?')[0]);
const apiDoc = fs.readFileSync(path.join(ROOT, 'docs/data-model.md'), 'utf8');
const missing = [...new Set(apiSrc)].filter((p) => p !== '/api/' && !apiDoc.includes(p));
if (missing.length) bad('这些接口没有写进 docs/data-model.md', missing.join(', '));
else ok(new Set(apiSrc).size - 1 + ' 个接口全部记录在 data-model.md');

// ---------- 5. 过时表述黑名单（现行文档里不许出现） ----------
const BANNED = [
  ['不 push', '仓库已开源，不再是"仅本地"'],
  ['没鉴权分级', '已有 admin/rw/ro 三档'],
  ['唯一的自动化测试', 'npm test 会跑 docs-consistency + smoke'],
  ['2277 行', '不要写会过期的行数，用函数名定位'],
  ['APP_PASSWORD', '已改用账号体系'],
  ['READONLY_PASSWORD', '已改用账号体系'],
];
const liveDocs = ['README.md', 'AGENTS.md', 'DEPLOY.md', 'CONTRIBUTING.md', 'docs/README.md', 'docs/usage.md', 'docs/data-model.md', 'docs/auth.md']
  .map((r) => path.join(ROOT, r)).concat(mds.filter((p) => rel(p).startsWith('docs/designs/')));
let bannedHit = 0;
for (const p of liveDocs) {
  if (!fs.existsSync(p)) continue;
  const t = fs.readFileSync(p, 'utf8');
  for (const [phrase, why] of BANNED) {
    if (t.includes(phrase)) { bannedHit++; bad(rel(p) + ' 出现过时表述「' + phrase + '」', why); }
  }
}
if (!bannedHit) ok('现行文档无过时表述（' + BANNED.length + ' 条黑名单）');

// ---------- 6. designs 每篇必须有 H1 ----------
let noH1 = 0;
for (const p of mds.filter((x) => rel(x).startsWith('docs/designs/'))) {
  if (!fs.readFileSync(p, 'utf8').startsWith('# ')) { noH1++; bad(rel(p) + ' 缺少 H1 标题'); }
}
if (!noH1) ok('designs 每篇都有 H1');

console.log('\n结果：' + (fail ? fail + ' 处不一致' : '全部一致'));
process.exit(fail ? 1 : 0);
