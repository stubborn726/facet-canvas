#!/usr/bin/env node
/* 冒烟测试：临时实例（独立 DATA_DIR + 随机端口）跑一遍
 *   账号与权限（默认 admin → 强制改密 → 建用户 → 降权/删号立即生效）
 *   业务主链（播种 → 读 → 存 → 冲突 → 版本 → 恢复）+ 数据体检（verify.js）
 * 零依赖、不碰你的 data/：跑完自动删临时目录。用法：node test/smoke.js（或 npm test）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4400 + Math.floor(Math.random() * 400);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-canvas-smoke-'));
const B = 'http://127.0.0.1:' + PORT;
// 默认口令不在这里复制：直接从 server.js 的常量读（单一事实源）
const ADMIN0 = (fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/DEFAULT_ADMIN_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
if (!ADMIN0) { console.log('✗ 没能在 server.js 里找到 DEFAULT_ADMIN_PASSWORD'); process.exit(1); }
// 期望值从 seed.json 读：以后换示例数据，测试不用改
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8'));
const WANT = {
  nodes: (SEED.nodes || []).length,
  edges: (SEED.edges || []).length,
  cols: (SEED.columns || []).length || 4,
  types: (SEED.tagTypes || []).length,
  tagged: (SEED.nodes || []).filter((n) => n.tags).length,
};
const ADMIN1 = 'admin-pass-1';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, d) => { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (p, opt = {}) => {
  const h = {};
  if (opt.token) h.Authorization = 'Bearer ' + opt.token;
  if (opt.body) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
const login = (username, password) => req('/api/login', { method: 'POST', body: { username, password } });

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const cleanup = () => { try { srv.kill(); } catch {} try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/'); ready = true; break; } catch { await sleep(100); } }
  if (!ready) { console.log('服务未启动：\n' + out); process.exit(1); }
  console.log('临时实例：' + B + '   DATA_DIR=' + DATA_DIR + '\n');

  try {
    const home = await req('/');
    check('首页 200 且含画布容器', home.status === 200 && String(home.data).includes('id="graph"'), 'status ' + home.status);
    check('外链样式 /style.css', (await req('/style.css')).status === 200);
    check('外链脚本 /app.js', (await req('/app.js')).status === 200);
    check('未登录读图 → 401', (await req('/api/graph')).status === 401);
    check('错误账号 → 401', (await login('admin', 'nope')).status === 401);

    let r = await login('admin', ADMIN0);
    check('默认 admin 可登录 + mustChange', r.status === 200 && r.data.mustChange === true, JSON.stringify(r.data).slice(0, 100));
    const adminTok = r.data.token;
    check('未改密前读图 → 403', (await req('/api/graph', { token: adminTok })).status === 403);
    check('未改密前进不了用户管理', (await req('/api/users', { token: adminTok })).status === 403);
    check('改自己的密码', (await req('/api/me/password', { method: 'POST', token: adminTok, body: { old: ADMIN0, new: ADMIN1 } })).status === 200);
    check('改密后立即放行读图', (await req('/api/graph', { token: adminTok })).status === 200);

    let g = (await req('/api/graph', { token: adminTok })).data;
    check('播种节点数 = seed.json', g.nodes.length === WANT.nodes, '实际 ' + g.nodes.length + ' / 期望 ' + WANT.nodes);
    check('播种连线数 = seed.json', g.edges.length === WANT.edges, '实际 ' + g.edges.length + ' / 期望 ' + WANT.edges);
    check('栏目数 = seed.json', g.columns.length === WANT.cols, '实际 ' + g.columns.length + ' / 期望 ' + WANT.cols);
    check('标签类型已播种', g.tagTypes.length === WANT.types, '实际 ' + g.tagTypes.length);
    check('节点带标签已播种', g.nodes.filter((n) => n.tags).length === WANT.tagged, '实际 ' + g.nodes.filter((n) => n.tags).length);
    check('节点 kind 都在栏目内', g.nodes.every((n) => g.columns.some((c) => c.kind === n.kind)));

    const rev0 = g.rev, target = g.nodes[0], oldName = target.name;
    target.name = oldName + '·改';
    const saved = await req('/api/save', { method: 'POST', token: adminTok, body: { canvas: g.canvas, nodes: g.nodes, edges: g.edges, columns: g.columns, tagTypes: g.tagTypes, tagDefs: g.tagDefs, baseRev: rev0 } });
    check('保存成功且 rev 前进', saved.status === 200 && saved.data.rev === rev0 + 1, JSON.stringify(saved.data).slice(0, 100));
    g = (await req('/api/graph', { token: adminTok })).data;
    check('改名已落库', g.nodes.some((n) => n.name === oldName + '·改'));
    check('旧 baseRev 保存 → 409', (await req('/api/save', { method: 'POST', token: adminTok, body: { canvas: g.canvas, nodes: g.nodes, edges: g.edges, columns: g.columns, baseRev: rev0 } })).status === 409);

    const list = (await req('/api/versions?canvas=' + encodeURIComponent(g.canvas), { token: adminTok })).data.versions;
    check('已生成版本（≥2）', list.length >= 2, '实际 ' + list.length);
    const oldest = list[list.length - 1].id;
    check('恢复旧版本成功', (await req('/api/restore/' + encodeURIComponent(oldest), { method: 'POST', token: adminTok, body: { baseRev: g.rev } })).status === 200);
    g = (await req('/api/graph', { token: adminTok })).data;
    check('恢复后内容回到旧版', g.nodes.some((n) => n.name === oldName));

    r = await req('/api/users', { method: 'POST', token: adminTok, body: { name: 'viewer', role: 'ro' } });
    const gen = r.data && r.data.password;
    check('新增 ro 用户并回显初始口令', r.status === 200 && typeof gen === 'string' && gen.length === 26, JSON.stringify(r.data).slice(0, 100));
    const vid = r.data.user.id;
    r = await login('viewer', gen);
    check('新用户用初始口令登录 + mustChange', r.status === 200 && r.data.mustChange === true, JSON.stringify(r.data).slice(0, 100));
    let vtok = r.data.token;
    check('ro 用户未改密前读图 → 403', (await req('/api/graph', { token: vtok })).status === 403);
    check('ro 用户能改自己的密码（不被只读拦）', (await req('/api/me/password', { method: 'POST', token: vtok, body: { old: gen, new: 'viewer-pass-1' } })).status === 200);
    check('改密后能读图', (await req('/api/graph', { token: vtok })).status === 200);
    check('普通用户读用户列表 → 403', (await req('/api/users', { token: vtok })).status === 403);
    check('ro 用户写操作 → 403', (await req('/api/save', { method: 'POST', token: vtok, body: {} })).status === 403);

    check('管理员提权 ro→rw', (await req('/api/users/' + vid, { method: 'POST', token: adminTok, body: { role: 'rw' } })).status === 200);
    check('提权后同一令牌立即不再被只读拦', (await req('/api/save', { method: 'POST', token: vtok, body: {} })).status !== 403);
    r = await req('/api/users/' + vid, { method: 'POST', token: adminTok, body: { password: '' } });
    check('管理员重置口令 → 回显随机', r.status === 200 && typeof r.data.password === 'string', JSON.stringify(r.data).slice(0, 100));
    r = await login('viewer', r.data.password);
    check('重置后的口令可登录', r.status === 200);
    vtok = r.data.token;
    check('不能删除自己', (await req('/api/users/1', { method: 'DELETE', token: adminTok })).status === 400);
    check('不能降级最后一个管理员', (await req('/api/users/1', { method: 'POST', token: adminTok, body: { role: 'ro' } })).status === 409);
    check('删除用户', (await req('/api/users/' + vid, { method: 'DELETE', token: adminTok })).status === 200);
    check('被删用户的令牌立即 401', (await req('/api/graph', { token: vtok })).status === 401);

    const verify = spawn(process.execPath, ['verify.js'], { cwd: ROOT, env: Object.assign({}, process.env, { DATA_DIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let vout = '';
    verify.stdout.on('data', (d) => { vout += d; });
    const vcode = await new Promise((res) => verify.on('exit', res));
    check('verify.js 体检通过（退出码 0）', vcode === 0, vout.split('\n').filter((l) => l.includes('←')).join(' | ').slice(0, 160));
  } catch (e) {
    bad('未预期异常', String((e && e.stack) || e).slice(0, 300));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  cleanup();
  process.exit(fail ? 1 : 0);
})();
