# 参与贡献

> 这是一个刻意保持"零依赖、无构建、单目录"的小工具。改它之前，请先知道它在坚持什么。

## 三分钟上手

```bash
node server.js      # 起服务 → http://localhost:3000（首次登录 admin + 默认口令，见 docs/auth.md）
npm test            # 文档一致性 + 冒烟测试（提交前必跑）
```

Node 22.5+（22.x 需 `--experimental-sqlite`，24+ 直接跑）。**不需要 `npm install`**。

## 提交之前

- [ ] `npm test` 全绿
- [ ] **没有新增 npm 依赖**，没有引入构建步骤（这条是硬约束）
- [ ] 碰数据：`node backup.js` → `node verify.js --save ../before.json` → 改 → `verify.js --baseline before.json`
- [ ] 改功能：同步 `docs/`（用法进 usage、结构进 data-model）与 `docs/CHANGELOG.md`
- [ ] 提交信息写成 `<type>: <一句话>`，正文说清"为什么"

## 约定在哪

硬约束（7 条铁律）、架构地图、"常见任务改哪里"、文档规则、禁区——全在 **[AGENTS.md](AGENTS.md)**。
它虽然写给 AI agent，但人照着做同样适用。

数据结构与接口：[docs/data-model.md](docs/data-model.md)｜使用操作：[docs/usage.md](docs/usage.md)｜账号：[docs/auth.md](docs/auth.md)

## 报问题 / 提需求

说清三件事就能省掉两轮往返：

1. **期望行为**（你以为会发生什么）
2. **实际行为**（实际发生了什么，有控制台报错/截图更好）
3. **复现步骤**（从哪个地址、点了哪里、数据大概长什么样）

> 涉及数据丢失的，请先 `node backup.js` 再复现，别拿唯一一份数据做实验。
