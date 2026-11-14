# AGENTS.md — Apercus SillyTavern 插件

本仓库是 Apercus Gateway 的 SillyTavern UI 扩展与服务端插件，当前为**未接通首版**。所有贡献者与 AI agent 遵守以下规则；更具体的流程以本文件为准。

## 当前范围（硬边界）

1. **统一 Pass**：Pass 是未来唯一的身份权威。登录、账户绑定、凭据交付只能来自网关侧批准的 Pass 授权/交付契约。
2. **无后端授权就不假装成功**：网关授权/交付契约未落地前，不得实现真实登录、不得返回伪造的成功响应，不得把 501 改写成“已登录”，不得把本地状态展示成已连接。
3. **不手填 key、不使用共享 key**：不提供手填 key 输入框，不回退共享 key，不把 Pass 身份令牌当作网关 key，不引入任何替代凭据方案。
4. **无 raw key 持久化**：浏览器不写 localStorage/sessionStorage，不保存或回显原始 key、Authorization、Cookie 或上游凭据；服务端不写 SillyTavern secret，不持久化原始请求头/请求体/上游错误正文。
5. **无 updater / download loader**：本阶段不实现自动更新或下载安装器。
6. **node tests**：测试使用 `node --test`，只依赖 Node 原生能力（Node >= 20），不引入 npm 运行时依赖。测试使用隔离 stub/fixture，不代表真实 Pass 或真实 SillyTavern 验收。
7. **未批准不得生产使用**：在网关授权/交付契约通过批准前，本插件不得用于生产环境。SillyTavern 只能部署在可信本机或置于访问认证之后。
8. **不记录虚假支持版本**：只写实际核对过的版本。当前仅对照 SillyTavern 1.17.0 源码核对，未在运行中的 ST 加载验证；不得宣称支持 1.19.0 或其他未实测版本。

## 固定目标

服务端只访问两个常量目标，禁止请求方覆盖：

- 模型目录：`https://api.apercus.ai/catalog/models`
- 余额：`https://gw.apercus.ai/api/user/balance`

身份只取 SillyTavern 注入的当前用户目录（`req.user.directories`），不读请求体/查询参数/请求头里的 user id，也不回落到默认用户或共享凭据。

## 目录与安装

- `ui/`：SillyTavern UI 扩展（`manifest.json`、`index.js`、`logic.mjs`、`style.css`）。
- `server/`：SillyTavern 服务端插件（`index.js`、`core.js`、`package.json`），路由挂载在 `/api/plugins/apercus-gateway`。
- `test/`：`node:test` 测试。
- 安装由用户手动完成：UI 复制到 `<ST>/data/<handle>/extensions/apercus-gateway/`；server 复制到 `<ST>/plugins/apercus-gateway/`，并由用户设置 `enableServerPlugins: true` 后重启。agent 不得修改用户的 SillyTavern 安装或配置。
- 本仓库根不是 UI 扩展仓库：`manifest.json` 在 `ui/` 下，不能直接用仓库根 URL 安装 UI 扩展。

## 协议声明

原生适配尚未落地。`chat` 是唯一候选协议面；`anthropic` 没有安全适配，保持禁用；`responses` 仅声明、未启用，responses-only 模型禁用。不得把目录展示或状态 200 解释为可连接。

## 校验

```bash
node --test
npm run check
```

`npm run check` 覆盖服务端与测试文件的 CommonJS 语法、`ui/logic.mjs` 以及 `ui/index.js` 的 ESM 语法。提交前两者都应通过；测试通过不等于实机验收。

## 变更纪律

- 不提交、不推送、不部署，除非用户明确要求。
- 不修改现有 SillyTavern 安装、用户配置或其他扩展。
- API 契约以 Apercus Gateway 仓库的 `docs/api/api.md` 为准；不得单方面新增字段、错误码或权限。
