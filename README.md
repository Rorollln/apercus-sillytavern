# Apercus SillyTavern 插件（未接通首版）

本仓库是 Apercus Gateway 面向 SillyTavern 的独立插件项目，当前是**可安装的基础骨架**，不是已登录、可用的网关客户端。

真实 Pass 账户绑定、登录、Key 配置、模型切换、余额读取目前全部 **blocked（未接通）**。界面会如实显示未连接状态；登录请求返回 `501 pass_binding_unavailable`，不会伪装成功，也不会写入 SillyTavern 的 source、secret 或任何原始 key。

## 当前状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 插件安装 | 可安装 | UI 扩展与服务端插件均可手动复制安装，见下文 |
| 状态只读接口 | 可用 | `GET /api/plugins/apercus-gateway/status` 返回固定未连接状态 |
| 模型目录 | blocked | 需要服务端账户绑定；未绑定时返回 `409 not_connected` |
| 余额查询 / 快照 | blocked | 需要服务端账户绑定；未绑定时返回 `409 not_connected` |
| Pass 登录 / 账户绑定 | blocked | 网关授权与交付契约未完成，`POST /login` 固定返回 501 |
| Key 配置 / 凭据交付 | blocked | 不提供手填 key、共享 key 或任何安装入口 |
| 模型切换 / 原生协议适配 | blocked | 本版没有已核实、已落地的原生适配器 |
| 自动更新 / 下载 loader | 未实现 | 本版没有 updater 或下载安装器 |

不要把 `GET /status` 的 200 理解为登录成功：它的响应始终是 `authAvailable: false`、`connected: false`，三个协议面均为 `false`。

## 目录内容

| 路径 | 内容 |
|---|---|
| `ui/` | SillyTavern UI 扩展：`manifest.json`、`index.js`、`logic.mjs`、`style.css` |
| `server/` | SillyTavern 服务端插件：`index.js`、`core.js`、`package.json` |
| `test/` | `node:test` 测试：纯逻辑、固定路由、用户隔离、错误与泄密边界 |
| `LICENSE` | GNU AGPL v3 完整文本 |

UI 与 server 是两套独立安装单元，安装位置不同。

## 安装

以下步骤由 SillyTavern 用户自行执行；本仓库不会改动现有 SillyTavern 安装、用户配置或其他扩展。

### 1. UI 扩展

UI 扩展需要放在 SillyTavern 的用户扩展目录。按本地 SillyTavern 1.17.0 源码核实：

- 磁盘目录：`<SillyTavern>/data/<用户 handle>/extensions/<扩展目录名>`，默认用户为 `data/default-user/extensions/`
- 加载 URL 命名空间：`/scripts/extensions/third-party/<扩展目录名>`
- 全局安装的等价目录是 `<SillyTavern>/public/scripts/extensions/third-party/<扩展目录名>`

因此，把 `ui/` 内的**文件内容**复制到：

```text
<SillyTavern>/data/default-user/extensions/apercus-gateway/
```

多用户部署时，把 `<用户 handle>` 换成目标用户的真实 handle（例如 `data/<handle>/extensions/apercus-gateway/`）。目录名使用 `apercus-gateway`，与插件路由 ID 一致，便于识别。

> 不要用本仓库根 URL 在 SillyTavern 的“安装扩展”里直接克隆。Git 仓库根目录不是 UI 扩展仓库：`manifest.json` 在 `ui/` 子目录下，而 SillyTavern 的扩展安装器要求扩展仓库根目录直接包含 `manifest.json`。后续如需在线安装，应发布独立的 UI 扩展仓库或提供打包产物，而不是当前这个同时包含 `server/` 的仓库根。

### 2. 服务端插件

把 `server/` 内的**文件内容**复制到：

```text
<SillyTavern>/plugins/apercus-gateway/
```

然后在 SillyTavern 的 `config.yaml` 中设置：

```yaml
enableServerPlugins: true
```

保存后重启 SillyTavern。插件加载后路由挂载在 `/api/plugins/apercus-gateway`。这两处配置属于用户自己的 SillyTavern 安装，应由用户本人修改；本仓库不提供自动修改脚本。

## 固定上游与边界

服务端插件只访问两个编译期常量目标，不接受请求方传入的 URL、Origin 或目标覆盖：

- 模型目录：`https://api.apercus.ai/catalog/models`（数据面）
- 余额：`https://gw.apercus.ai/api/user/balance`（门户面）

目录与余额的请求在设计上只使用当前 SillyTavern 用户的服务器端绑定，不回落到默认用户；当前生产绑定读取器恒返回空值，所以这两个接口都会以 `409 not_connected` 拒绝，而不是发出真实上游请求。浏览器不保存原始 key，不读取共享 key，不显示 `Authorization`，也不写入 SillyTavern 的 secret 设置。

### Pass 与登录

Pass 是未来唯一的身份权威。当前网关侧的授权/交付握手**尚未批准，也没有可用端点**，因此：

- 不存在真实登录流程；
- 不存在凭据交付流程；
- 不能用共享 key 或手填 key 代替；
- 不能把 Pass 身份令牌当作网关 key；
- `/login` 固定返回 501，UI 会显示该错误，而不是成功。

只有等网关侧批准并交付授权契约后，才允许把服务端的绑定读取替换为经 SillyTavern secrets 模块按用户目录读取的已验签记录。在此之前，生产绑定读取器恒返回空值。

### 协议声明

UI 状态栏声明 `chat`、`anthropic`、`responses` 三个协议面，但**原生适配没有落地**：

- `chat`：唯一候选协议面；仍需服务端绑定和已核实适配，当前不可连接；
- `anthropic`：不提供安全适配，明确禁用；
- `responses`：仅声明，未启用；responses-only 模型保持禁用；
- 其他协议面（image、tts、embedding、video）不参与连接选择。

未绑定账户时 `GET /models` 返回 `409 not_connected`，扩展无法取得目录，因此现在不会展示任何模型条目。未来目录接通后，仍必须实现经过核实的安全协议适配，当前不能切换模型，也不会静默修改 SillyTavern 的模型或来源。

## 测试与校验

测试使用 `node:test`，只依赖 Node 原生能力，不需要安装第三方依赖：

```bash
node --test
```

测试全部使用隔离的 stub/fixture（合成绑定、假 fetch、假 ST 路由），**不是真实 Pass 服务，也不是运行中的 SillyTavern**。它们验证映射、状态门禁、固定路由、每用户隔离、错误处理和不泄露凭据等边界，但不构成真实 Pass/ST 验收，也不证明实机可用。

语法检查覆盖 CommonJS 服务端、测试文件、UI 纯逻辑 ESM，以及 `ui/index.js` 的 ESM 解析：

```bash
npm run check
```

`ui/index.js` 在浏览器中由 SillyTavern 作为扩展模块加载；仓库根 `package.json` 不设 `"type": "module"`（测试与服务端插件仍走 CommonJS），因此检查脚本用 `node --input-type=module --check` 读取它的 ESM 语法。

## 版本与安全

- 代码仅对照本地 SillyTavern **1.17.0** 源码核对（`getContext`、事件名、custom source、secrets、`#leftSendForm`），未在运行中的 SillyTavern 加载验证；**1.19.0 未核对**。本仓库不声明支持未验证的版本。
- SillyTavern 默认是单用户应用。启用本插件后，SillyTavern 及其端口只能放在可信本机，或置于有访问认证的反向代理之后；不要直接暴露到公网，也不要以此插件替代 SillyTavern 自身的登录保护。
- 插件不解除 Apercus Gateway 的数据面公网暴露闸门；网关部署约束以其仓库的 `docs/runtime-security.md` 为准。
- 在网关授权/交付契约落地并通过批准前，本插件**不得用于生产**。

## 许可

GNU Affero General Public License v3.0，完整文本见 [LICENSE](LICENSE)。
