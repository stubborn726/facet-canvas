// 离线 IP 归属地（ip2region v2 的 xdb 数据文件），零依赖
//
// 数据文件放 vendor/ip2region.xdb（约 11MB，不进仓；缺文件时 lookup() 一律返回 null，
// 页面只显示 IP，不显示归属地）。
//
// 自测：node lib/geo.js 114.114.114.114
//
// xdb 结构（v2）：
//   [0, 256)                        header
//   [256, 256 + 256*256*8)          向量索引：il0 行 × il1 列，每格 8 字节 = [sPtr(4B LE), ePtr(4B LE)]
//   数据区 + 段索引                   段索引每条 14 字节 = [sip(4B) eip(4B) dataLen(2B) dataPtr(4B)]
//   数据记录                         [城市id(4B)] + "国家|区域|省|市|ISP"
//
// 解析失败/格式不对一律返回 null —— 宁可这一行不显示，也不能显示错城市。
const fs = require('node:fs');
const path = require('node:path');

const HEADER = 256;
const VCOLS = 256;
const VSIZE = 8;
const SEG = 14;

let buf = null;
let source = '';
let loadError = '';

// 官方仓库自 2021 起把数据拆成 ip2region_v4.xdb / ip2region_v6.xdb，老文件名叫 ip2region.xdb；
// 两种名字都认（本库只支持 IPv4 版本）。显式指定路径（参数或 IP2REGION_XDB）时只认那一个。
const CANDIDATES = ['ip2region_v4.xdb', 'ip2region.xdb'];   // 现行文件名在前，老名字兜底
const vendorPath = (n) => path.join(__dirname, '..', 'vendor', n);

function load(fp) {
  const list = fp ? [fp]
    : process.env.IP2REGION_XDB ? [process.env.IP2REGION_XDB]
    : CANDIDATES.map(vendorPath);
  let err = null;
  for (const file of list) {
    try {
      const b = fs.readFileSync(file);
      if (b.length < HEADER + VCOLS * VCOLS * VSIZE) throw new Error('文件过小，不是 xdb：' + file);
      buf = b; source = file; loadError = '';
      return true;
    } catch (e) { err = e; }
  }
  buf = null;
  source = list[list.length - 1];
  loadError = err && err.code === 'ENOENT' ? '未找到数据文件：' + list.join(' 或 ') : (err && err.message) || '未知错误';
  return false;
}

const ready = () => !!buf;
const status = () => ({ ready: ready(), file: source, error: loadError });

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || /^127\./.test(String(ip || ''));
const isIPv4 = (ip) => { const p = String(ip || '').split('.'); return p.length === 4 && p.every((x) => /^\d+$/.test(x) && Number(x) >= 0 && Number(x) <= 255); };

function isPrivate(ip) {
  if (!ip) return true;
  const s = String(ip);
  if (s === 'localhost' || s === '::1') return true;
  // 纯 IPv6：只有链路本地 fe80::/10 与唯一本地 fc00::/7 算"内网"，其余是公网 IPv6（本库查不了，但不能谎报内网）
  if (!isIPv4(s)) return /^fe80:/i.test(s) || /^f[cd][0-9a-f]{2}:/i.test(s);
  const p = s.split('.').map(Number);
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;                                   // 运营商级 NAT
  return false;
}

const ipToInt = (ip) => ip.split('.').reduce((a, x) => (a * 256 + Number(x)) >>> 0, 0) >>> 0;

// 区域串只允许可见文字与分隔符：解析错位时通常得到控制字符或乱码，据此拒收
const PLAUSIBLE = /^[\u4e00-\u9fa5A-Za-z0-9|·．\-\s]{2,120}$/;

function lookup(ip) {
  if (!ready() || !ip) return null;
  if (!isIPv4(ip) || isPrivate(ip)) return null;      // 库是 IPv4 的：IPv6 / 内网一律不查
  try {
    const v = ipToInt(ip);
    const il0 = (v >>> 24) & 0xff;
    const il1 = (v >>> 16) & 0xff;
    const cell = HEADER + il0 * VCOLS * VSIZE + il1 * VSIZE;
    if (cell + VSIZE > buf.length) return null;
    const sPtr = buf.readUInt32LE(cell);
    const ePtr = buf.readUInt32LE(cell + 4);
    if (!(ePtr > sPtr) || ePtr > buf.length) return null;
    let lo = 0, hi = Math.floor((ePtr - sPtr) / SEG) - 1, dataPtr = 0, dataLen = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const o = sPtr + mid * SEG;
      const sip = buf.readUInt32LE(o);
      const eip = buf.readUInt32LE(o + 4);
      if (v < sip) hi = mid - 1;
      else if (v > eip) lo = mid + 1;
      else { dataLen = buf.readUInt16LE(o + 8); dataPtr = buf.readUInt32LE(o + 10); break; }
    }
    if (!dataPtr || !dataLen || dataPtr + dataLen > buf.length) return null;
    const rec = buf.slice(dataPtr, dataPtr + dataLen);
    // 现行 v4 数据：整条就是 "国家|省|市|ISP|ISO"（无前置 id）；
    // 老版数据：前 4 字节是城市 id，后面才是 "国家|区域|省|市|ISP"。按首字节是否是文字来区分。
    let raw = rec.toString('utf-8');                       // 必须整条解码后再判断：中文首字占 3 字节，切 1 字节会解成乱码
    if (!/^[\u4e00-\u9fa5A-Za-z]/.test(raw)) raw = rec.slice(4).toString('utf-8');
    if (!PLAUSIBLE.test(raw)) return null;
    const f = raw.split('|');
    if (f.length < 4) return null;
    const clean = (x) => (x && x !== '0' ? String(x).trim() : '');
    const v4 = /^[A-Z]{2}$/.test(String(f[4] || '').trim());   // v4：末段是国家代码；老版：末段是 ISP
    const out = v4
      ? { country: clean(f[0]), region: '', province: clean(f[1]), city: clean(f[2]), isp: clean(f[3]), iso: clean(f[4]), raw }
      : { country: clean(f[0]), region: clean(f[1]), province: clean(f[2]), city: clean(f[3]), isp: clean(f[4]), iso: '', raw };
    return out.city || out.province || out.country ? out : null;
  } catch {
    return null;
  }
}

// 给人看的一行：省 市（同名不重复）
function label(ip) {
  if (isLoopback(ip)) return '本机';
  if (isPrivate(ip)) return '内网';
  if (!isIPv4(ip)) return 'IPv6';                     // 公网 IPv6：如实标，不冒充内网
  const g = lookup(ip);
  if (!g) return '';
  const parts = [];
  if (g.province) parts.push(g.province);
  if (g.city && g.city !== g.province) parts.push(g.city);
  return parts.join(' ') || g.country || '';     // 只有国家级（外资 IP 常见）时显示国家
}

load();

module.exports = { lookup, label, ready, status, isPrivate, isLoopback, isIPv4, load };

if (require.main === module) {
  if (!ready()) {
    console.log('未能加载数据文件：' + (loadError || '未知原因'));
    console.log('请把 ip2region_v4.xdb 放到：' + source + '（见 vendor/README.md）');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const ips = args.length ? args : ['114.114.114.114', '8.8.8.8', '223.5.5.5', '202.96.128.86', '192.168.1.10'];
  for (const ip of ips) console.log(ip.padEnd(16), '→', label(ip) || JSON.stringify(lookup(ip)) || '未命中');
}
