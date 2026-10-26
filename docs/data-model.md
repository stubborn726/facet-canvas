# 数据模型 / 接口 / 体检

> 面向维护者与二次开发：表结构、兼容策略、HTTP 接口、数据体检查什么。

## 数据模型

```sql
canvases(id, name, ord, rev, color, style)
  -- 画布：ord=顺序；rev=该画布乐观锁；color=栏目头底色（#RRGGBB，空=默认）；style=节点样式 JSON（名称/选中/链路/连线，空=默认）
  -- 二者都是**按画布隔离**的：各画布各存一套，复制画布会带走，且都进版本快照（恢复版本会一起还原）
columns(canvas, kind, title, ord)              -- 栏目；主键 (canvas, kind) —— 每张画布各自一套
nodes(canvas, id, kind, name, status, source, note, image, tags, grp, tagtypes, by, updated_at, ord, ver)
  -- 主键 (canvas, id)；kind = 所属栏目的 kind（动态，不再写死）；status ∈ {明确, 待确认}；ord = 栏内排序
  -- note = 备注（默认折叠）；tags = 标签（逗号分隔，**格式自 2026-10-14 起从未变过**）；grp = 同栏分组名（空=未分组，纯视觉）
  -- tagtypes = 该节点每个标签属于哪些类型，JSON：{"核心":["类别"],"实验":[]}（2026-10-26）
  --    [] = **显式未分类**（必须与"缺键"区分，否则取消类型后会被老兜底复活）；缺键 = 老数据 → 回落 tag_defs
  --    服务端写入一律白名单清洗：类型必须在 tag_types 里、同名类型去重、坏 JSON 归一为空串；
  --    上限（标签名 ≤60 字符、类型名 ≤40 字符、单节点 ≤500 个标签）**超出的静默丢弃**，不报错
edges(canvas, id, from_id, to_id, status, by, updated_at, ver)
  -- 主键 (canvas, id)；status ∈ {明确, 待确认}；待确认**连线**显示为橙色虚线（连线没有环，不与状态冲突；「显示待确认」默认开启）
versions(id, canvas, created_at, by, note, base_rev, n_nodes, n_edges, data)  -- data = 整图快照(含 columns)
tag_types(canvas, name, color, ord)   -- 标签类型（维度）：每画布一套；color=#RRGGBB；ord=展示顺序
tag_defs(canvas, tag, type)           -- 【兼容用】标签名 → 类型名（type='' 即「未分类」）；只存归属，不改 nodes.tags
  -- 2026-10-26 起归属的**唯一事实源是 nodes.tagtypes**。这张表仍由新版写一份「名字 → 第一个类型」的
  -- 尽力而为映射，只为旧版页面 / 回滚到旧服务端时还认得类型；新版只在节点缺键时拿它兜底（老数据）。
meta(k, v)   -- secret / seeded / password（rev 已挪到 canvases.rev）
```

> **加列/加表都是自动、幂等的**：启动时对已存在的库执行 `ALTER TABLE … ADD COLUMN`（重复执行会被忽略），**只加列、不改旧值**。
> **多画布那次升级需要重建主键**（`nodes`/`edges`/`columns` 改成 `(canvas, …)`）：也是**启动自动完成**，在一个事务里"建新表→搬数据→校验行数→换名"，**行数对不上就整体回滚**；已有数据全部归入默认画布，**逐行逐字段不变**。
> 前端"整图重写"保存时对**缺失的字段保留库中现值**（旧页面 / 旧版本快照 / 旧 localStorage 草稿都不会把 `tags` / `grp` / 连线 `status` 抹掉）；**明确传空串才会清空**。写入也只作用于**当前画布**（`DELETE … WHERE canvas=?`）。
> `tagTypes` / `tagDefs` 同一套规则：**不带这两个字段 = 库中现值不动**（旧页面、改造前的版本快照都安全）；**带数组/对象（哪怕空）= 整表替换**。两种表都是 `CREATE TABLE IF NOT EXISTS`，**没有 ALTER、没有数据迁移**。
> **`tagtypes`（2026-10-26）同样走"缺失即保留现值"**：旧页面不传 → 不清空；传了（含 `''`）→ 按提交内容清洗后写（类型必须在 `tag_types` 里、去重、坏 JSON 归一为空）。这一列是**老库唯一要 ALTER 的新列**，启动自动加、只加列、不动旧值，**没有任何数据迁移**。
> **回滚到旧服务端**：旧代码按显式列名读写，会忽略 `tagtypes`；`tags` + `tag_defs` 仍能让它显示"一词一个类型"，**不丢数据、不报错**（代价：同名跨类型的第二归属在旧版里看不到）。
> ⚠️ 升级时**服务端和前端要一起换**：新前端会给服务端发 `tagTypes`/`tagDefs`，旧服务端会忽略它们（类型配了但不落库）。改完重启一次 `node server.js` 即可建表。

## 数据体检（verify.js，只读）

升级、迁移、改表结构前后，用它证明"除了该变的，别的都没变"。

```bash
node verify.js                        # 体检报告：integrity + 各表行数/指纹 + 卫生检查
node verify.js --save ../before.json  # 升级前：存一份基线（仓库外）
# ……升级 / 迁移……
node verify.js --baseline before.json # 升级后：逐表比对；有差异 → 退出码 1（可进 CI）
node verify.js --with-tagtypes        # 指纹里带上 nodes.tagtypes（默认不带，见下）
```

**它查什么**

- `PRAGMA integrity_check`、文件大小 / 页数、各表行数
- 每张表一个**内容指纹**（sha256 前 16 位）：`canvases / nodes / edges / columns / tag_types / tag_defs / versions / meta`
- 卫生检查：`tags` 行内重名、空 token；`tagtypes` 非法 JSON、指向已删类型、与 `tags` 对不上（键缺失/多余）；`tag_defs` 悬空；版本快照 JSON 能否解析、`n_nodes` 是否与实际一致
- 与基线比对时，`nodes` 有差异会**定位到具体节点和字段**（`c1|交付物:管理后台  tags: [核心] → [核心,实验]`）

**两个刻意的口径**

- `nodes` 指纹**默认不含 `tagtypes`**（2026-10-26 的兼容列会被保存逐步填充，算进去每次都"有差异"）；想看就加 `--with-tagtypes`。同时也不含 `by` / `updated_at` / `ver`（每次保存都会变，属噪声）。
- `versions` 只比"**有没有丢**"：新增版本是正常业务增长，**丢失版本才算事故**。

**只读保证**：全程 `readOnly` 打开，不建表、不写任何行；可以在服务运行中执行（SQLite 允许并发读）。

## 多人同时编辑会怎样

- **不是协同编辑**：各自在浏览器里改草稿，点保存时**整张图**提交。
- **乐观锁按画布**：保存时带上你打开时的 `baseRev`；服务器 rev 已经变了 → **409，不写入**，弹窗让你选「放弃我的改动刷新 / 仍然强制覆盖 / 取消」。**默认不会静默覆盖**。
- 强制覆盖也不是不可挽回：每次保存都会生成**版本**，被盖掉的那一版在「版本历史」里能恢复。
- **每 8 秒看一次 rev**：你没改东西 → 自动跟到最新（别人的改动不进你的撤销栈）；你手上有未保存改动 → 顶栏挂一条**不会消失的提示条**，告诉你"别人存过了"，由你决定何时加载（加载会丢弃你的草稿）。
- 恢复旧版本、重置也走同一把锁：期间有人保存过 → 同样 409 先问一句，不再静默顶掉。
- 仍是**单进程**工具：不要把两个进程指向同一个 `data.db`（真并发写会坏）。

## API

> 除 `/api/login` 外都要 `Authorization: Bearer <token>`。
> **权限在服务端**：`ro` 的所有非 GET 返回 403；`/api/users*` 非管理员返回 403；`must_change=1` 时只放行 `/api/me`、`/api/me/password`。
> 令牌只装 `{v:2, uid, exp}`，角色每次请求回库查（改角色 / 删用户立即生效）。

### 账号

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/login` | 公开 | `{username, password}` → `{token, days, id, name, role, mustChange}`（`role`：`admin` / `rw` / `ro`） |
| GET | `/api/me` | 登录 | 自己 `{id, name, role, mustChange}` |
| POST | `/api/me/password` | 登录 | `{old, new}`；新密码 ≥6 位；成功后 `must_change` 归零 |
| GET | `/api/users` | admin | 用户列表（**不含口令哈希**） |
| POST | `/api/users` | admin | `{name, role, password?}`；不带 `password` → 随机 26 位并**回显一次**；重名 409 |
| POST | `/api/users/:id` | admin | `{name?, role?, password?}`；`password:''` = 重置为随机并回显；**不能删/降级最后一个 admin** |
| DELETE | `/api/users/:id` | admin | 删除；**不能删自己**；不能删最后一个 admin |

### 画布与图

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/whoami` | 当前访问者 `{ip, id, name, role, geo, geoLabel, geoReady}`（`geo` 为 `null` 表示内网或未装归属地库） |
| GET | `/api/rev` | 只回 `{canvas, rev}`，供前端轮询判断"有没有人存过" |
| GET | `/api/graph` | 当前图 `{rev, canvas, nodes, edges, columns, tagTypes, tagDefs, headColor, style}`；`?canvas=<id>`，缺省=默认画布 |
| GET | `/api/canvases` | 画布列表（带 `n_nodes / n_edges / n_versions` 计数） |
| POST | `/api/canvas/create` | 新建 `{name}` → 空白画布 + 默认栏目 |
| POST | `/api/canvas/duplicate` | 复制 `{id, name}`：栏目/节点/连线全带、**版本不带**（只留 1 个「复制自…」） |
| POST | `/api/canvas/rename` | 重命名 `{id, name}` |
| POST | `/api/canvas/delete` | 删除 `{id, confirm:'DELETE'}`（**连版本一起删**；拒绝删最后一张） |
| POST | `/api/save` | 保存 `{canvas, nodes, edges, columns, note, baseRev, force}` → 新版本；`baseRev` 过期 → 409。节点可带 `tags`/`grp`/`tagtypes`、连线可带 `status`（**缺字段=保留库中现值**） |
| POST | `/api/reset` | 重置为种子 `{"confirm":"RESET"}`（破坏性，生成新版本） |

### 版本与资源

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/versions?canvas=<id>` | 版本列表 |
| GET | `/api/versions/:id` | 某版本的全量数据 |
| POST | `/api/restore/:id` | 恢复到该版本（恢复到**它自己的画布**，生成新版本）；可带 `baseRev` / `force` |
| POST | `/api/upload` | 上传图片 `{dataUrl}` → `{url}`（≤10MB；**按魔数校验** PNG/JPG/GIF/WebP/BMP，**不收 SVG**） |
| GET | `/uploads/<file>` | 图片（要登录；`<img>` 带不了头，故也接受 `?t=<token>`） |

> `canvas` 参数**缺省一律落到默认画布**——旧页面（没强刷）照旧能读写默认画布，且不会碰别的画布。


## 种子数据

`seed.json` 是一份**中性但完整的示例**（权限治理：角色 × 系统 × 操作 × 数据域 × 审批环节）：

| 内容 | 数量 |
|---|---|
| 栏目 | 5（角色 / 系统 / 操作 / 数据域 / 审批环节） |
| 节点 | 33（7 / 7 / 8 / 7 / 4） |
| 连线 | 69（其中 3 条 `待确认`，演示橙色虚线） |
| 标签类型 | 4（敏感度 / 合规要求 / 责任人 / 生命周期），共 12 个标签 |
| 同栏分组 | 3 组（读操作 / 写操作 / 流程，虚线框、不参与连线） |
| 备注 | 2 条（数据域「财务数据」「消息记录」） |

字段：`columns`（kind / title / ord）、`nodes`（id / kind / name / status / source / note / grp / tags / tagtypes）、`edges`（from_id / to_id / status）、`tagTypes`（name / color / ord）。

首次启动自动播种；`/api/reset` 可重新播种。**换成自己的数据**：改 `seed.json` 即可（节点 `kind` 必须与栏目 `kind` 一致；`tagtypes` 里的类型名必须在 `tagTypes` 里，否则会被清洗掉），或删掉它从空白画布开始。
