# AGENTS.md — facet-canvas 工作指南

> **任何 AI agent（Claude Code / Cursor / Codex / Copilot / CodeBuddy…）接手本仓库，先读这一份。**
> 它是本仓库的**唯一事实源**：定位、架构、铁律、命令、文档规则、变更流程、禁区全在这里。
> `README.md` 只做门面（给"要不要用"的人看），`docs/` 只放深水区细节。

---

## 0. 30 秒读懂

| | |
|---|---|
| **是什么** | 多维度归属关系的**确认画布**：栏目 = 维度、节点 = 取值、连线 = 归属、**保存 = 一轮确认（留版本）** |
| **不是什么** | 白板 / 流程图工具 / 实时协同系统 / 通用图数据库前端 |
| **技术形态** | 零依赖 Node（内置 `node:sqlite`）+ 原生前端（`index.html` + `app.js` + `style.css`，**无构建**） |
| **数据形态** | 单文件 SQLite + `uploads/`，全在 `data/` 一个目录；备份 = 拷这个目录 |
| **当前版本** | 见 `package.json` 的 `version`；变更记录见 `docs/CHANGELOG.md` |

---

## 1. 架构地图（改代码前先定位到层）

| 路径 | 职责 | 改它要注意 |
|---|---|---|
| `server.js` | HTTP 路由 + SQLite schema/迁移 + 账号与权限 + 版本快照 + 静态服务（入口 `createServer`；写库 `writeGraph`） | 单文件无框架；路由按 `if (p === '/api/…')` 顺序匹配，新接口放在**鉴权中间件之后**；写库统一走 `tx()` / `writeGraph()` |
| `public/index.html` | 页面结构（顶栏 / 工具栏 / 画布容器 / 登录门 / 弹窗壳） | 只有结构；不要在这里写内联脚本或样式 |
| `public/app.js` | 前端全部逻辑，按区块排列：常量与状态 → 纯函数 → 渲染 → 交互 → 网络 → 启动（渲染入口 `render()`；网络入口 `api()`） | 新代码放进对应区块；**DOM 一律 `document.createElement` 或 `esc()` 后拼串** |
| `public/style.css` | 全部样式：`:root` 变量 + 组件类 | 主题色走 `:root` 变量；导出 PNG 会读 `getComputedStyle`，**改样式会影响导出图** |
| `lib/geo.js` | 离线 IP 归属地（可选，缺 `vendor/*.xdb` 自动降级） | 不要让它成为硬依赖 |
| `verify.js` | 只读数据体检：integrity + 各表内容指纹 + 卫生检查 | 只读打开；指纹口径改动 = 历史基线全部失效，慎改 |
| `backup.js` | 备份（VACUUM INTO 一致性快照 + 拷图） | 备份目录必须在 `data/` 之外 |
| `test/smoke.js` | 冒烟测试：临时实例跑全链路（`npm test` 会先跑 `docs-consistency.js`） | 期望值从 `seed.json` 读，**不要硬编码示例数据规模** |
| `seed.json` | 首次播种的示例（5 栏 / 24 节点 / 41 连线 / 3 类标签） | 只放**中性**示例，不许出现真实业务数据 |
| `docs/` | 深入文档（用法 / 数据模型 / 账号 / 变更记录） | 见 §5 文档体系 |

---

### 1.1 常见任务 → 先读什么 / 改哪里

> 定位优先于通读：`app.js` 别从头翻，按这张表跳到具体函数。

| 我要做的事 | 先读 | 改哪里（精确到函数） |
|---|---|---|
| 加一个 HTTP 接口 | [docs/data-model.md](docs/data-model.md)「API」 | `server.js`：`if (p === '/api/…')` 分支，**必须放在鉴权中间件之后**；响应统一 `json(res, code, obj)` |
| 加一列 / 改表结构 | [docs/data-model.md](docs/data-model.md)「数据模型」+ 铁律 2 | `server.js` 顶部建表串 + 一行幂等 `ALTER TABLE ADD COLUMN`；同步 §4 的 `NODE_COLS` 白名单与 `docs/data-model.md` |
| 改保存 / 版本 / 恢复 | [docs/data-model.md](docs/data-model.md)「多人同时编辑」 | 服务端 `writeGraph()` `saveVersion()` `currentGraph()`；前端 `doSave()` `handleConflict()` `doRestore()` |
| 改节点显示（内容 / 外观） | [docs/usage.md](docs/usage.md)「编辑操作」 | `buildNode()`（单个节点 DOM）、`render()`（整图重画）、`style.css` 的 `.node*` |
| 改连线 / 箭头 / 链路高亮 | [docs/usage.md](docs/usage.md)「链路」 | `drawEdges()`（画线）、`paint()`（高亮与置灰）、`reachSet()`（上下游可达） |
| 改标签（chip / 类型 / 筛选） | [designs/2026-10-26-标签归属存储.md](docs/designs/2026-10-26-标签归属存储.md) | 前端 `pairsOf()` `groupTagsByType()` `renderTagbar()` `setTagFilter()` `openAnno()`；服务端 `cleanTagTypes()` `expandTagTypes()` |
| 加一个工具栏按钮 | — | `index.html` 的 `.bar` + `app.js` 里绑定事件 + `syncButtons()`（只读/锁定态要跟着变） |
| 改导出 PNG | [docs/usage.md](docs/usage.md)「导出图片」 | `buildExportCanvas()`（**读 `getComputedStyle`，改样式会影响出图**）、`exportImage()` |
| 改导出链路表 CSV | [docs/usage.md](docs/usage.md)「导出（图 → 链路表）」 | `enumerateChains()`（决定"哪些算一条链路"）+ `doExport()` |
| 改登录 / 权限 | [docs/auth.md](docs/auth.md) + [designs/2026-10-26-账号体系.md](docs/designs/2026-10-26-账号体系.md) | 服务端鉴权中间件（`req.user` 注入、`must_change`、`ro`、`/api/users*`）；前端 `doLogin()` `applyRole()` `openUsers()` |
| 改首次播种示例 | [docs/data-model.md](docs/data-model.md)「种子数据」 | `seed.json`（`kind` 必须与栏目 `kind` 一致；`tagtypes` 的类型必须在 `tagTypes` 里）；测试从 seed 读期望值，不用改 |
| 加体检项 / 改指纹口径 | [docs/data-model.md](docs/data-model.md)「数据体检」 | `verify.js` 的 `simple` 表清单与 `hygiene` 检查段（**改指纹口径会让历史基线全部失效**） |
| 改主题色 / 节点样式 | [docs/usage.md](docs/usage.md)「样式」 | `style.css` 的 `:root` 变量 + `applyStyle()` `STYLE_DEFAULTS` |

## 2. 铁律（违反就不要提交）

1. **零依赖、无构建**：不新增 npm 依赖、不引入 Vite/webpack/框架。只能 Node 内置模块 + 原生浏览器 API。这是本项目的核心卖点。
2. **数据只加不毁**：加字段 = `ALTER TABLE ADD COLUMN` + "缺键回落"；**不改老行、不改老格式**；启动迁移必须**幂等**且可回滚。
3. **`data/` 永不入库**：`data/`、`uploads/`、`vendor/*.xdb` 都在 `.gitignore`。**业务数据、真实公司/产品名、真实人名**不许进代码、文档、测试、示例、提交信息。
4. **动数据必须留证据**：`node backup.js` → `node verify.js --save ../before.json` → 改动 → `node verify.js --baseline before.json`，并报告差异。
5. **前端一切用户输入必须转义**：进 `innerHTML` 前过 `esc()`；不确定就用 `createElement` + `textContent`。
6. **权限判定一律在服务端**：前端隐藏按钮只是体验，不是权限。任何新接口都要落在鉴权中间件之后，并按角色/必须改密状态判断。
7. **不引用任何 CDN**：内网部署会直接挂掉；离线数据文件一律放 `vendor/`。

---

## 3. 常用命令

```bash
node server.js                 # 起服务（默认 3000，数据在 data/）
npm run dev                    # 同上 + --watch（改后端自动重启）

npm test                       # 文档一致性 + 冒烟测试（提交前必跑）
npm run test:docs              # 只跑文档一致性：口令 / 版本号 / 相对链接
npm run test:smoke             # 只跑冒烟测试：临时 DATA_DIR + 随机端口，跑完自动清理
node verify.js                 # 数据体检（只读）：integrity + 各表指纹 + 卫生检查
node verify.js --save ../a.json   # 存基线（写到仓库外，别提交）
node verify.js --baseline a.json   # 与基线比对，有差异退出码 1
node backup.js                 # 备份 data/（保留最近 14 份）
```

环境变量：`PORT` / `TOKEN_DAYS` / `DATA_DIR` / `DB_PATH` / `TRUST_PROXY` / `ADMIN_PASSWORD`（重置管理员口令）/ `IP2REGION_XDB` / `LOGIN_MAX`。

---

## 4. 代码约定

- **服务端**：路由集中在 `createServer` 里；DB 写入一律经过事务或 `writeGraph`；**外部输入先白名单清洗**（见 `cleanTagTypes`：类型必须在 `tag_types` 里、去重、坏 JSON 归一为空串）。
- **前端**：`app.js` 分区排列，新增函数放对应区；渲染函数只读状态、不改状态；改状态后调 `markDirty()` + `render()`。
- **兼容读法**："缺键 = 老数据 → 回落旧表；显式空值 = 用户的选择"。新增字段时同时提供这两条路径。
- **注释**：中文，写"为什么这样做"，不写"这行在干嘛"。
- **错误处理**：只在系统边界（请求体、用户输入、文件 IO、外部服务）；内部调用信任不变量，不堆防御代码。
- **提交信息**：`<type>: <一句话>`，type ∈ `feat|fix|docs|test|refactor|chore`；正文写"为什么"。

---

## 5. 文档体系（这套结构是为"任何 agent 都能接手"设计的）

| 文件 | 角色 | 什么时候改 |
|---|---|---|
| `README.md` | **门面**：是什么 / 给谁用 / 凭什么是它 / 快速开始 | 只在**定位或能力**变化时改；不超过 ~150 行 |
| `AGENTS.md`（本文） | **唯一事实源**：架构、铁律、命令、流程、禁区 | 结构性变化（新目录 / 新约定 / 新禁区） |
| `docs/README.md` | 文档地图 + spec/plan/design 模板 + 命名与分级 | 文档体系本身变化时 |
| `docs/usage.md` | 使用手册：参数、编辑操作、快捷键、标签、多画布、导出 | 功能用法变化 |
| `docs/data-model.md` | 表结构、兼容策略、HTTP 接口、`verify.js` 口径 | 表结构 / 接口变化 |
| `docs/auth.md` | 账号：**怎么用** | 账号用法变化 |
| `docs/designs/` | **关键取舍**：选了什么、否掉了什么、代价是什么（防止"善意重构"推翻既定决策） | 做结构性决策时新增一篇 |
| `docs/guides/` | **方法论**：抛开本软件版本的实践做法 / 词表 / 经验教训（区别于 `usage.md` 的"怎么点"） | **目前没有**——有"要重复讲第二遍"的做法时才建 |
| `docs/CHANGELOG.md` | **版本历史（唯一记录处）** | 每次发布追加一条 |
| `DEPLOY.md` | 部署 / 反代 / 备份迁移 / 升级 | 部署方式变化 |
| `SECURITY.md` | **威胁模型**：默认口令、明文库、令牌与传输的边界 | 安全边界变化 |
| `CONTRIBUTING.md` | **给人的入口**：三分钟上手 + 提交前检查（详细约定仍指向本文） | 流程或门槛变化时 |
| `docs/requirements/{specs,plans,archive}/` | 进行中任务的 spec / plan；完成后移入 `archive/` | 有 L1 任务时 |

**四条规则**

1. **单一事实源**：同一件事只写一处，其它地方**只放指针**（"见 xxx"），不复制内容。
2. **薄壳**：`AGENTS.md` 和 `README.md` 都不展开细节，细节在 `docs/`。
3. **规模分级**：先按 §6.1 判断要不要写文档（L0 不写、L1/L2 必须写）。
4. **版本叙事只写 `docs/CHANGELOG.md`**：不要写在 README，也不要写在提交信息之外的地方。

---

## 6. 任务开立与交付流程

> **硬规则**：L1/L2 任务的规划正文**必须写进 `docs/requirements/`**。
> 工具自带的 plan / plan mode（`~/.claude/plans`、`~/.cursor/` 之类）只作草稿与审批门，**不替代仓库内正文**。
> **未入库的规划 = 未开始**：换一个 agent（或三个月后的你）接手时，看不到计划就等于没有计划。

### 6.1 定类（先判断要不要写文档）

| 级别 | 判据 | 产出 |
|---|---|---|
| **L0** | 改文案、一行修复、样式微调 | 直接改，不写文档（但见 6.6） |
| **L1** | 新功能、改接口、改表结构、改兼容策略 | **spec + plan** |
| **L2** | 跨模块重构、数据迁移、需要分阶段验收 | spec + plan，必要时拆 tickets |

含**多方案权衡 / 结构性取舍**（选型、弃用方案）时，先补 `docs/designs/<YYYY-MM-DD>-<名称>.md`，写清"考虑过什么、为什么否掉、代价是什么"。
> 现成样例：`docs/designs/2026-10-26-账号体系.md`（令牌为何不装角色）、`docs/designs/2026-10-26-标签归属存储.md`（为何不建关联表）。

### 6.2 Spec（做什么）

路径：`docs/requirements/specs/<YYYY-MM-DD>-<短横线名称>.md`（模板见 `docs/README.md`）

必填：**目标/背景 · 范围与不做（YAGNI）· 输入与来源 · 口径与规则 · 产出 · 验收标准 · 开放问题**。
验收标准要写成**可勾选的清单**——将来它是"能不能交付"的唯一判据。

### 6.3 Plan（怎么做）

路径：`docs/requirements/plans/<同名>.md`（与 spec 同名同日期）

必填：**目标与关键取舍 · 依赖 · 全局约束 · checkbox 任务清单 · 验证清单 · 不做的事**。
任务清单按「Task → Step」两级，**做完一项勾一项**（reviewer 和你自己都靠它判断进度）。

### 6.4 执行

1. **定位**：读 §1 架构地图 → 读相关 `docs/` → 确认要改哪一层（服务端 / 前端 / 脚本 / 文档）。
2. **小步改**：一次只动一个关注点；改完立刻 `node --check`（或 `node --check public/app.js`）。
3. **验证**：`npm test`；**碰数据**再加 `verify.js --save/--baseline` 前后比对；**碰迁移**必须验证"老库能直接启动"。
4. **沉淀**：稳定的口径 / 词表 / 约定写进 `docs/`（或 `AGENTS.md` 的铁律），不要只留在对话里。

### 6.5 收尾（DoD，缺一不可）

- [ ] spec/plan 移入 `docs/requirements/archive/{specs,plans}/`（保留子目录结构）
- [ ] `docs/CHANGELOG.md` 追加一节（新增 / 变更 / 兼容 / 移除）
- [ ] **能力或定位变了** → 改 README；**结构或约定变了** → 改 AGENTS.md；**接口/表结构变了** → 改 docs/data-model.md
- [ ] `npm test` 全绿；碰数据则 `verify.js --baseline` 无意外差异
- [ ] 提交信息能**独立说明"为什么"**（不看代码也懂）

> 归档不是形式：`docs/requirements/` 里只留"正在做"的，archive 里是"做过什么、当时怎么想的"——这两者都是给下一个 agent 的上下文。

### 6.6 小任务（L0）的等价动作

不写 spec/plan，但下面三件仍要做，否则不算交付：

1. `npm test` 通过（或明确说明为什么这条改动不需要测）
2. `docs/CHANGELOG.md` 补一行（纯样式/文案可在提交信息里说明"不入 CHANGELOG"）
3. 提交信息写清原因

### 6.7 收尾自检（5 条）

- [ ] `npm test` 通过
- [ ] 没新增依赖、没引入构建步骤
- [ ] 老库能直接启动（迁移幂等、旧数据可读）
- [ ] 没有业务数据 / 真实名词进入仓库
- [ ] 文档指针没断（README / AGENTS / docs 互相引用的路径都存在）

## 7. 禁区

- ❌ 换技术栈（Vue/React/Vite/Postgres…）——"零依赖、单目录、可私有化"是本项目的存在理由
- ❌ 把默认管理员口令改成"更安全的值"并写进文档（口令只能出现在 `server.js` 常量与测试里，且必须配合 `must_change`）
- ❌ 打乱 `nodes` 表字段顺序 / 重命名既有列——`verify.js` 的指纹是按下标取的，历史基线会全部失效
- ❌ 在 `public/` 里引用 CDN 或远程字体
- ❌ 用 `SELECT *` 写"按列位置"的逻辑（表结构会演进）
- ❌ 把示例数据换成真实业务数据（这是最容易犯、也最难撤回的错误）

---

## 8. 已知限制与路线

- 限制：撤销/重做仅会话内；协同是 8 秒轮询 + 乐观锁；SQLite 单实例；改密不踢其他设备；明文 HTTP（需反代 HTTPS）。
- 路线：令牌版本号、用户组/项目级权限、更多导出格式、交互打磨。
- 详见 `README.md` 的「已知限制 / 后续」。

---

## 9. 新文件放哪（目录树只有一份）

> **目录树只维护一处**：见 [README 的「目录」](README.md#目录)。本节只规定**新增东西该放哪**，
> 避免同一个树写两遍、各自漂。

| 要加的东西 | 放到 | 不要放 |
|---|---|---|
| 新的 HTTP 接口 | `server.js` 的 `createServer` 内，鉴权中间件之后 | 新建 `routes/` 目录（会破坏"单文件后端"的可移植性） |
| 新的前端功能 | `public/app.js` 对应区块 + `public/style.css` | `index.html` 里写内联脚本/样式 |
| 运维脚本（体检/备份这类） | 仓库根（如 `verify.js`） | `test/`（那里放测试） |
| 自动化测试 | `test/` | 仓库根 |
| 使用 / 参考 / 决策文档 | `docs/`（按 §5 分类） | README（README 只做门面） |
| 离线数据文件（大文件） | `vendor/`（不入库） | `public/`（会被当静态资源公开访问） |
| 运行时数据 | `data/`（gitignore） | 任何会入库的位置 |

> 新增**顶层**文件时，同步更新 README 的目录树（唯一那份）。

---

## 10. 版本与发布

1. 改 `package.json` 的 `version`（语义化：新增能力 → minor，修 bug → patch）。
2. `docs/CHANGELOG.md` 追加一节，写清"新增 / 变更 / 兼容"。
3. 打 tag：`git tag v<version>`。
4. 不强制发布到 npm（本工具是"拷目录即部署"的形态）。
