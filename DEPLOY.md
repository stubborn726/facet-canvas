# 部署指南（多维关系画布）

> 本项目 **零依赖、无构建**：一台装了 **Node.js ≥ 22.5**（用到内置 `node:sqlite`）的机器即可。
> 产物就一个 `server.js` + `public/`，**运行时数据全在 `data/`**（`data.db` + `uploads/`）—— 备份只要备这一个目录。

---

## 0. 前置

- **Node.js ≥ 22.5**（服务器上装）。推荐 22 LTS 或更高。
- 一台能常驻进程的机器（内网服务器 / 云主机），开放一个端口（默认 3000）。
- 可选：域名 + 反向代理（要 HTTPS 时）。

## 1. 把代码放到服务器

把整个 `facet-canvas/` 目录拷过去（也可以直接 `git clone`）。

**需要上传的**（部署集，不是完整目录树——目录树见 README）：

| 上传 | 说明 |
|---|---|
| `server.js`、`lib/`、`public/` | 代码与前端 |
| `backup.js`、`verify.js`、`package.json` | 运维脚本 |
| `seed.json` | 首次播种（干净状态用） |
| `vendor/` | 可选：IP 归属地数据（缺了只影响顶栏显示） |

**不要上传 / 不要覆盖**：`data/` —— 那是线上真实数据（库 + 图片），覆盖等于清库。

> 迁移/覆盖代码时：**不要**覆盖线上的 `data/`（那是真实数据）。
> 从旧版（`data.db`、`uploads/` 直接放在工具根目录）升级：新版启动会**自动**把它们挪进 `data/`（见 §7）。

## 2. 安装 Node

- **Linux**：用发行版包管理器或 nvm；或从 <https://nodejs.org> 下载。
- **Windows**：从 <https://nodejs.org> 下载安装包，或 `winget install OpenJS.NodeJS.LTS`。

装完确认：`node -v`（应 ≥ v22.5）。

## 3. 试跑

```bash

cd facet-canvas
node server.js
```
> 启动后打开页面，用 `admin` + 初始密码登录（口令见 `docs/auth.md`）（**首次登录强制改密**），
> 再在右上角「操作人 ▸ 用户管理」里给同事建账号。口令不再通过环境变量配置。

启动会打印：

```

多维关系画布已启动：http://localhost:3000
运行时数据：.../data ｜ 令牌有效期：365 天
账号：1 个（admin 可在右上角「用户管理」里维护）
账号：admin（默认口令，首次登录必须修改）
```
浏览器打开 `http://<服务器IP>:3000` → 登录 → 能用就进下一步。

**环境变量**（都可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `ADMIN_PASSWORD` | 不设置 | **逃生通道**：设了就重置 `admin` 的口令（每次启动都会重置），用于忘记管理员密码 |
| `IP2REGION_XDB` | `vendor/ip2region_v4.xdb`（也认 `ip2region.xdb`） | 离线 IP 归属地数据文件路径；缺文件时顶栏只显示 IP |
| `TOKEN_DAYS` | 365 | 登录令牌有效期（天） |
| `DATA_DIR` | `./data` | **运行时数据目录**（库 + 图片都在里面，备份就备它） |
| `DB_PATH` | `<DATA_DIR>/data.db` | 数据库文件路径（一般不用改） |
| `UP_DIR` | `<DATA_DIR>/uploads` | 流程图图片目录（一般不用改） |
| `TRUST_PROXY` | 空 | 置 `1` 表示在可信代理之后：登录限流按 `X-Forwarded-For` 最后一跳取真实 IP（**公网反代必开**） |
| `LOGIN_MAX` | 8 | 登录窗口内允许的失败次数，超过则锁定 |
| `LOGIN_WINDOW_MIN` | 15 | 登录限流窗口（分钟） |
| `LOGIN_LOCK_MIN` | 15 | 触发限流后的锁定时长（分钟） |

## 4. 让它常驻（守护进程）

#

## 方案 A：pm2（跨平台，最省事，Windows 也能用）

```bash

npm i -g pm2
TRUST_PROXY=1 pm2 start server.js --name facet-canvas
pm2 save              # 记住当前进程列表
pm2 startup           # 开机自启（按提示执行它给出的那条命令）
pm2 logs facet-canvas          # 看日志
pm2 restart facet-canvas       # 重启
```
> 上线后**更新代码**的流程见 §4.1。

#

## 方案 B：systemd（Linux，最稳）

`/etc/systemd/system/facet-canvas.service`：

```ini

[Unit]
Description=多维关系画布
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/facet-canvas
Environment=PORT=3000
# 公网部署（反代之后）：
Environment=TRUST_PROXY=1
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash

sudo systemctl daemon-reload
sudo systemctl enable --now facet-canvas
sudo systemctl status facet-canvas
journalctl -u facet-canvas -f        # 看日志
```
#

## 方案 C：Windows 服务

用 [NSSM](https://nssm.cc) 把 `node server.js` 注册成服务；或用「任务计划程序」设为开机启动。

#

### 4.1 更新代码（迭代发布）

**先记住一条**：替换文件时**只覆盖代码，绝不覆盖 `data/`**（`data.db` + `uploads/` 是线上真实数据，覆盖即丢失）。建议用 rsync/拷贝时排除该目录。

除了代码本身，本工具**只有** `server.js` / `public/` / `backup.js` / `verify.js` / `seed.json` / `package.json` 这几个文件需要更新。

> **数据库升级是自动的，重启即可**：
> - **加列**（如 `nodes.tags` / `nodes.grp` / `nodes.tagtypes` / `edges.status` / `versions.canvas`）：`ALTER TABLE … ADD COLUMN`，**幂等**（已存在会被忽略），**旧行旧值一律不动**；
> - 2026-10-26 新增的 `nodes.tagtypes`（标签跨类型同名）属于**纯加列**：没有数据重写、没有迁移脚本，启动日志会打印一行「[迁移] nodes 新增列 tagtypes」——**只有真的加了一次才打印**。
> - **多画布那次升级要重建主键**（`nodes`/`edges`/`columns` 改成 `(canvas, id)` / `(canvas, kind)`）：启动时在一个事务里"建新表 → 搬数据 → **校验行数** → 换名"，**行数对不上就整体回滚**，已有数据全部归入默认画布、**逐行逐字段不变**。
>
> 所以升级只需"替换文件 + 重启"。**升级前仍建议先 `node backup.js`**（一次性不可逆操作，有备份才有退路）。
> 升级后建议让**还开着旧页面的同事强刷一次**（Ctrl+F5）；即便没刷，旧页面不带 `canvas` 参数 → 服务端把它当**默认画布**处理，**不会碰别的画布**，新字段也会被保留（不会清坏）。
>
> **时区（可选）**：库里时间统一存 UTC，版本的**列表与详情由浏览器按访问者本机时区换算**，始终正确。只有"恢复到 xxx 的版本"这句**写进版本说明的文字**用的是**服务器本机时区**——若服务器时区不是 UTC+8，可加 `TZ=Asia/Shanghai` 启动（`new Date().toISOString()` 存库仍是 UTC，不受影响）。
>
> ⚠️ **回滚不能只回代码**：多画布升级改过**主键**。若把 `server.js` 换回旧版本，旧代码按 `id` 整表重写会把不同画布的同名节点互相覆盖 → **必须"回旧代码 + 用升级前的 `data/` 备份覆盖"同时做**。
>
> 而 **2026-10-26 的 `tagtypes` 不一样，只回代码是安全的**：它是纯加列，旧代码按显式列名读写、会忽略这一列，`tags` + `tag_defs` 仍能显示"一词一个类型"，**不丢数据、不报错**；代价只是同名跨类型的**第二个归属在旧版里看不到**，再升回新代码即恢复。
>
> **升级/迁移前后想留证据**：`node verify.js --save ../升级前.json` → 动完 `node verify.js --baseline 升级前.json`（只读，有差异退出码 1）。见 `README.md`「数据体检」一节。

#

### pm2

```bash

# ① 在服务器上替换 server.js / public/ 等文件（不含 data/）
# ② 重启使其读新代码
pm2 restart facet-canvas
pm2 logs facet-canvas            # 确认启动成功、无报错
```
| 改了什么 | 命令 | 说明 |
|---|---|---|
| `server.js` / `public/` | `pm2 restart facet-canvas` | 纯代码改动，重启即生效 |
| **环境变量**（如 `PORT`、`TRUST_PROXY`） | `PORT=8080 pm2 restart facet-canvas --update-env` | pm2 记忆的是**首次启动**时的环境，plain `restart` 不会带上新变量，必须加 `--update-env` 并在前面带上全部变量 |
| **入口文件 / 启动参数** | `pm2 delete facet-canvas` → `pm2 start server.js --name facet-canvas` → `pm2 save` | 改了入口名或启动参数后 `restart` 会认旧路径而失败，需重建 |
| 新增 npm 依赖 | 先 `npm install`，再 restart | 本项目零依赖，一般不会遇到 |

- **`pm2 save` 时机**：任何改过启动方式（`delete` + `start`）之后都要补一次，否则机器重启时 pm2 按上次快照恢复，改动会丢。
- **确认当前进程指向**：`pm2 describe facet-canvas` 可看脚本路径与工作目录是否正确。
- **回滚**：重新替换回旧文件再 `pm2 restart facet-canvas` 即可。

#

### systemd

```bash

# ① 替换文件（不含 data/）
sudo systemctl restart facet-canvas
sudo systemctl status facet-canvas
journalctl -u facet-canvas -f     # 看日志
```
改了 `.service` 里的事项（环境变量、路径等）要先 `sudo systemctl daemon-reload` 再 `restart`。

#

### Windows 服务（NSSM）

```bash

nssm restart FacetCanvas
# 改了环境变量：nssm set FacetCanvas AppEnvironmentExtra PORT=3000，再 restart
```
#

### 什么时候需要停服？

| 情况 | 要不要停服 |
|---|---|
| 更新 `server.js` / `public/` | 不用，`restart` 即可（有秒级中断） |
| 从**旧版**升级（`data.db` 在外层，触发自动迁移） | **Windows 要先停服务**，否则文件被占用迁移会失败（见 §7） |
| 手工 `cp` 整个 `data/` 做备份 | 要先停服务（见 §7，或用 `backup.js`） |

## 5. 开放端口 / 防火墙

- 放行你用的端口（如 3000）；内网直接访问 `http://<服务器IP>:3000`。
- 只在局域网用 → 到此就够了。

## 6. 反向代理 + HTTPS（可选，但公网必做）

nginx（含公网加固要点）：

```nginx

server {
    listen 443 ssl;
    server_name your.domain.com;
    # ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

    client_max_body_size 14m;      # ⚠ 必加：流程图走 base64 上传，默认 1m 会被挡

    # ① 只想让公司出口放行（比任何"随机字符串"都强，推荐）
    allow 203.0.113.0/24;          # 换成你的办公网出口 IP / VPN 段
    deny  all;

    # ② 可选：网关再挂一道 basic auth（浏览器原生弹窗，应用零改动）
    # auth_basic           "Restricted";
    # auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;   # ⚠ 配 TRUST_PROXY=1 时必需
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
HTTPS 用 certbot 签个证书即可（`certbot --nginx`）。
**公网部署时后端务必带 `TRUST_PROXY=1`**，否则登录限流看到的是代理 IP，会把所有人算成同一个人。

### 6.1 公网暴露加固

三件事按重要性排序：

1. **HTTPS**（必须）—— 否则口令与令牌在公网上是明文。
2. **入口收窄**（最强）—— 在网关/反代做 **IP 白名单 / VPN / basic auth**（见上面 §6 的 nginx 示例）。"随机路径/随机域名"之类的做法只是**降低被扫到的概率**，**不是安全边界**——链接泄漏了就等于开门（日志、浏览器历史、转发、截图都会漏）。
3. **账号与限流** —— 用默认管理员登录后**第一件事就是改密**（不改就进不去别的功能）；之后一律用账号，不再有全局口令。登录失败限流已内置（默认 15 分钟内失败 8 次锁 15 分钟）。

**图片也已需要登录**：`/uploads/*` 现在必须带令牌（浏览器加载图片用 `?t=<令牌>`），未登录一律 401。

## 7. 备份与迁移

**要备份的只有一个目录**：`data/`（内含 `data.db` 业务数据 + `uploads/` 图片，缺一不可）。

#

## 用仓库自带的 `backup.js`（推荐）

```bash

node backup.js
# → ../facet-canvas-backups/facet-<时间戳>/{data.db, uploads/, manifest.txt}
```
- **可在服务运行中执行**：脚本用 SQLite 的 `VACUUM INTO` 导出**一致性快照**（不会拷到"写了一半"的库），只加读锁，不需停机。
- 图片整目录直接拷贝（图片是一次写入、永不修改的普通文件）。
- 默认**保留最近 14 份**，更老的自动清理。可调：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `./data` | 要备份的数据目录 |
| `BACKUP_DIR` | `../facet-canvas-backups` | 备份根目录（**放在 `data/` 之外**，避免把备份也备进去） |
| `KEEP` | 14 | 保留最近几份 |

#

## 定时执行（任务只负责"何时跑"）

- **Linux（cron）**

```

  0 3 * * * cd /opt/facet-canvas && /usr/bin/node backup.js >> backup.log 2>&1
  
```
- **Windows（任务计划程序）**：新建任务 → 每天 03:00 → 程序 `node`、参数 `backup.js`、起始目录=工具目录。
- 建议把 `BACKUP_DIR` 指到**另一块盘 / NAS / 异机**，别和 `data/` 同盘。

#

## 为什么不能直接 `cp` 数据库？

SQLite 是单文件库，**服务正在写时直接 `cp` / `rsync` 可能拷到撕裂或半写状态**。要么用 `backup.js`（`VACUUM INTO`），要么**先停服务**再整拷 `data/`。

#

## 从旧版升级（`data.db` + `uploads/` 在工具根目录）

新版启动时**自动**把它们挪进 `data/`（仅当新位置为空；**幂等**，重复启动无副作用）。
⚠️ Windows 上请先**停止服务**再启动，否则文件被占用会迁移失败并给出明确提示。

#

## 迁移到新机器

把 `server.js` / `backup.js` / `public/` / `seed.json` / `data/` 一起拷过去，`node server.js` 即可。

## 8. 注意事项（重要）

| 事项 | 说明 |
|---|---|
| **单实例** | SQLite 是单文件库，**不要**起多个进程指向同一个 `data.db`（会锁冲突/写坏）。要扛并发得换 Postgres。 |
| **口令** | 默认管理员口令写在代码里（看到源码就知道）→ 首次登录会被强制改密，改完才算安全；平时口令存在 `data/data.db` 的 `users` 表（scrypt 哈希）。 |
| **公网暴露** | 必须 **HTTPS**；强烈建议再叠 **IP 白名单 / VPN / basic auth**（真正的边界）。"随机路径/随机域名"只是"少被扫到"，**拿到链接即等于拿到数据**。 |
| **反代后** | 后端要带 `TRUST_PROXY=1`，否则登录限流把所有人当同一个 IP（代理 IP）。 |
| **Node 版本** | 必须 ≥ 22.5（用了内置 `node:sqlite`）。 |
| **首次启动** | 库为空时自动用 `seed.json` 播种并建「初始版本（种子）」，无需手工初始化。 |
| **账号与权限** | 三档角色：`admin`（管用户+改画布）/ `rw`（改画布）/ `ro`（只看）。首次用 `admin` + 默认口令登录后**强制改密**，再在「用户管理」里建同事账号。 |
| **令牌在 URL** | 图片走 `?t=<令牌>`（`<img>` 带不了头），令牌会有机会出现在**代理/网关日志**里；对日志做访问控制，或改用 JS 取图（见 README 备注）。 |

