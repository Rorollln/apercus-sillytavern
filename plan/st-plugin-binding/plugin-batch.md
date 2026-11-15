# apercus-sillytavern 插件批：网关连接 + 防截断分节 + 计量（草稿 v3，待签核）

> **执行修订记录（2026-11-16，设计重写 v2→v3）。** 随契约批 v3 重设计（见 [contract-batch.md](contract-batch.md) 执行修订记录）同步重写：B1 从「设备配对＋用户码手动批准」改为「官方网页授权＋后台领取＋登录凭据保持登录」；B3 增 key 列表选择与退出登录；凭据保存条款按 2026-11-16 用户拍板修订（key / 登录凭据存 ST 服务端，与酒馆存 API 设置同一套习惯）。上游契约号**维持 v1.34 / 0.11.99**；**发布门控＝v1.34 合并前不得发布面向用户的版本**。v2 正文作废，全文见公开仓 PR #1/#2 git 历史。

- 落位说明：本稿随公开插件仓 `plan/st-plugin-binding/` 交付；分工任务单与契约批设计稿见同目录。上游契约批（网关连接 + 余额阈值字段，v1.34）的网关侧落地在网关私有仓执行，本文只写插件侧消费口径，不含网关内部设计。
- 上游依赖：网关契约批 v1.34（对外口径＝连接授权域〔发起 / 轮询 / 批准 / 取消〕＋插件查询面七端点＋插件登录凭据＋BalanceSnapshot 增列 `penalty_input_threshold` / `penalty_multiplier`）。
- 版本基线：插件 manifest `minimum_client_version: 1.17.0`；本批事件与 API 已按 ST 1.19.0（当前稳定版）源码核对，运行时一律特性检测降级（附录 A）。
- 既有边界修订：固定两个网关域名写死、身份只来自 `req.user.directories`、**key 与登录凭据只存 ST 服务端 secret（按用户目录隔离），不进浏览器存储 / DOM / 日志**、fail-closed。（原「服务端不写 ST secret」条款随 v3 修订，2026-11-16 用户拍板：与酒馆存 API 设置逻辑一致。）

## 0. 目标 / 非目标

目标（2026-11-15/16 用户确认的连接体验）：
1. **网关连接（B1）**：插件里点「连接 Apercus」→ 打开网关官方授权页（复用门户登录状态）→ 用户允许 → 后台自动完成连接；插件记住登录状态，重开酒馆不重复授权；可退出登录。
2. **key / 模型选择（B3）**：显示账号有哪些 key、选用 key；所选 key 可用的模型直接在插件里选择。
3. **自动接入酒馆（B3/B1）**：选中模型后按酒馆原生连接逻辑自动应用配置；连接成功与否**沿用酒馆状态**，插件不另设判定。
4. **防截断分节（B2）**：预设感知 → 手动生成节名单 → 注入（对接网关 #443/#444 已交付契约）。
5. **计量（B3）**：余额 + 追费阈值 + 上下文用量，沿用网关口径只展示。

非目标：instruct / sysprompt 模板切换检测（只检测 chat 预设）；key 的创建 / 删除 / 重置管理（网关侧 v1 不提供，插件只查与选用）；手填 key 输入框与非 Apercus 服务商地址（插件只服务本网关）；附加参数自由编辑器（酒馆 Custom 源原生能力覆盖）；anthropic / responses 面（保持禁用）；网关侧「已连接插件」管理面（留决②）；人工核对码 UI（v3 拍板取消）。

## 1. 切片与验收顺序

### B1 网关连接（依赖 v1.34 连接契约）

流程：面板「连接 Apercus」→ 插件服务端 `POST /api/connect/requests` → UI 打开网关返回的 `authorize_url`（官方授权页，复用门户登录状态；未登录则先登录再回到批准视图）→ 用户在官方页点「允许」（**免输码、免对码**；「取消」则请求作废）→ 插件服务端轮询 `POST /api/connect/requests/poll`（≥5 秒间隔，服务端节流）→ `approved` 一次领取 `{login_credential, key, username}` → 保存至 ST 服务端密钥库（secret 命名空间 `apercus_gateway`，JSON `{"version":1,"login_credential","key","username"}`，v1 无签名，按 directories 隔离）→ 面板显示「已连接：`<username>`」→ 自动进入 key / 模型选择（B3）。

- **保持登录（v3 核心）**：登录凭据持久化；重开酒馆保持已登录，**不重复网页授权**；网关 key 重置后授权关系不断——插件凭登录凭据调 `GET /api/plugin/me/key` 重新取得当前 key 并更新酒馆配置，用户无感。
- **退出登录**：面板「退出登录」→ 插件服务端调 `POST /api/plugin/logout`（撤销网关侧本次登录凭据）＋清本地 secret 保存件 → 面板回到未连接态。不影响门户网页登录、不重置网关 key。
- 插件服务端路由（4 新 + 1 改），**安全要求**：全部路由要求 `req.user` 存在否则 401；`POST /connect`、`POST /plan` 校验同源（Origin / `Sec-Fetch-Site`）；`GET /connect/status` 响应仅 `{status: connecting|pending|connected|invalid, username?}`——**永不返回 polling_secret / login_credential / key**；请求 / 响应体与任何凭据值不落日志；对固定网关域名校验 TLS 证书与主机名。
  - `POST /connect`：发起连接请求；`polling_secret` 与 `request_ref` 只存服务端内存（按 directories 键控）。
  - `GET /connect/status`：服务端节流轮询网关；领取成功即落密钥库并清内存取件件。
  - `POST /logout`：代理网关注销＋清本地。
  - `POST /plan`：B2 代理规划调用。
  - `GET /status`：增连接态（`connected` / `invalid`＋失效原因 / `username`），不含开关态。
- 失效 UX：查询面 401（凭据过期 / 账号禁用 / 网关撤销）→ 面板转「登录已失效」，引导重新连接；**凭据过期不算异常事件**。酒馆连接模型失败 / 断网 → **沿用酒馆自身状态展示**，不等于退出登录（D7）。
- **启用门控**：未连接或登录失效时，仅连接入口与说明可用；key / 模型选择、防截断开关与注入、规划调用、余额 / 计量数据全部禁用或隐藏。
- 测试：连接状态机（stub 网关：pending / approved / 取消 / 失效联动 / 网络丢失后重连）、领取恰一次、**key 重置→凭登录凭据刷新成功且登录态不变**、logout 后旧凭据 401、跨用户隔离（directories A/B）、无 `req.user` 401、跨源写拒绝、`/connect/status` 载荷不含敏感字段（断言序列化输出）、密钥库写入 fail-closed。

### B2 防截断分节（契约面＝v1.32 既有字段，零新契约）

状态机：`提醒（事件驱动）→ 指纹（惰性计算）→ 缓存命中? → 注入`；指纹变化 → 提醒 + 出"生成分节参数"按钮（**手动**，不自动调用）。

- **预设检测（只检测 chat 预设，已拍板；oracle 修订＝单事件 + 惰性指纹）**：仅订阅 `PRESET_CHANGED`（过滤 `apiId==='openai'`）驱动提醒与按钮态；指纹在注入时（`CHAT_COMPLETION_SETTINGS_READY`）与按钮点击时惰性计算——`getPresetManager('openai').getSelectedPresetName()` + `JSON.stringify`（原生序，不做键序规范化，接受偶发缓存未命中）+ `crypto.subtle.digest`。指纹未变则提醒自动消退。
- **规划调用（plan call）**：经插件服务端 `POST /plan` 直调网关 `POST /v1/chat/completions`（Bearer 当前 key）——不走用户当前酒馆连接，天然不与 S喵 等脚本互抢，域名固定在服务端强制，请求体（含预设摘要）两端都不落日志。模型＝面板选中的那个模型（**单一选择器**，oracle 砍独立"规划模型"状态；未选模型时规划按钮禁用并提示）。参数：`temperature 0.2`、`max_tokens 600`、不带 tools。
- **提示词 v1（测试期简单版，边测边精进）**：

  ```
  你是分节配置器。阅读角色扮演预设，产出"防截断分节"节名单。
  只输出 JSON 对象，不要任何其他文字：
  {"sections":["节名1","节名2",...]}
  要求：
  - 2~8 个节名，按该预设的叙事节奏排列；每个 ≤20 字、名词短语、不带序号
  - 每节将承载 800–1000 字正文
  预设内容（可能被截断）：
  """
  {预设摘要 ≤16000 字符}
  """
  ```

- **校验与兜底（纯逻辑，进 logic.mjs）**：剥代码围栏 → 解析 JSON → `sections` 字符串数组逐项 trim、去空 → 合法（≥2、≤16、单项 ≤64 字节）才入缓存；否则退默认名单 `["开场","推进","高潮","收尾"]` 并 toast 说明。失败重试一次（附错误摘要），再失败走兜底。
- **缓存**：`extensionSettings.apercusGateway.sectionsCache[fingerprint] = sections`（仅节名单；非敏感，明文 JSON 允许；**登录凭据与 key 绝不进 extensionSettings**）；每预设版本一次调用。
- **注入**：`CHAT_COMPLETION_SETTINGS_READY`（特性检测）→ 开关 ON 且指纹命中 → 合并写 `custom_include_body`：`apercus_antitrunc: true`、`apercus_antitrunc_sections`、**不静默覆盖** `max_tokens`——地板 `节数×1200+2000` 不足时 toast 警告 + 一键"应用建议值"。
- **守卫**：settings 含 `tools` / `tool_choice` / `response_format` 或 `n≠1` → 跳过注入并警告"网关将静默放行"（契约 v1.32 的静默弃臂语义）；面板"含/不含工具"开关开防截断时联动提示关函数调用。
- **开关默认关**。
- 测试：指纹稳定与失效、校验器全分支（64 字节 / 16 项边界）、注入合并不覆盖用户字段、守卫跳过矩阵、缓存命中不重复调用、按钮禁用态（无模型 / 未连接）。

### B3 key / 模型选择 + 面板计量

- **key 列表与选用（v3 新增）**：`GET /api/plugin/me/keys` 列当前账号有权使用的 key（稳定编号 / 名称 / 脱敏标识 / 状态；**不含明文**；v1 恒一把）；面板展示列表供选用。调用凭据刷新走 `GET /api/plugin/me/key`（凭登录凭据；key 重置后由此恢复，登录态不变）。
- **模型选择**：`GET /api/plugin/me/models` 取所选 key 权限内目录，按 `protocol_faces` 含 `chat` 启用（B2 规划调用共用此选择）；点选 → 确认弹窗 → 写 `chatCompletionSettings.custom_model` 并 `saveSettingsDebounced()`，同时由插件服务端把网关地址与当前 key 接入酒馆 Custom OpenAI-compatible 源（URL+key 用户侧零手工输入，绑定后自动写入）；插件不偷偷改 `chat_completion_source`。**连接成功与否沿用酒馆状态**（酒馆连上显示成功、连不上显示酒馆自身的错误，插件不另设判定）。未适配协议的目录行不得显示为可连接。
- **余额 + 阈值**：`GET /api/plugin/me/balance`；两行（H / K，`BigInt` / 整数校验解析，非法值显"未知"，fail-closed）；**K 仅展示**，不做客户端追加额计算。获取失败显示「暂时无法获取」，不显示为零、不影响登录态。
- **上下文长度（单一计量路径）**：发送时对最终 messages 用 `getTokenCountAsync` 计数 + 面板打开时对当前 chat 估算一次；显示 `已用 / getMaxPromptTokens()`。**与惩罚阈值并列**：估算值 ≥ 90%×H 变黄、≥100% 变红，文案注明"估算值，网关按可信输入 token 计费、严格大于阈值才追加"。上下文用量与账户余额**分开显示**。
- 测试：H/K 解析（BigInt / 非法串 / 空串）、阈值刻度换算与变色带、计数聚合、目录行启停、确认弹窗不直接写设置、key 列表渲染（脱敏标识不出明文）。

## 2. 插件服务端路由汇总（新增 4 + 改 1）

| 路由 | 变化 |
|---|---|
| `POST /connect` / `GET /connect/status` | B1（含鉴权 / 同源 / 载荷约束） |
| `POST /logout` | 撤销网关登录凭据＋清本地 |
| `POST /plan` | B2 代理规划调用（Bearer 当前 key） |
| `GET /status` | 增连接态（connected/invalid+原因/username），不含开关态 |
| `GET /balance` / `GET /models` / `GET /keys` | 透传 v1.34 查询面；目录行带启用条件 |

## 3. 验收与门禁

- 插件仓 `pnpm test`（node --test）全绿；`pnpm check` 通过；不引入第三方依赖（延续现仓约束）。
- 本地 ST 冒烟（stub 授权页）：连接 UI → 领取 → 选 key → 选模型 → 酒馆连接 → 开防截断 → 切预设 → 提醒 → 手动生成节名单 → 发送 → 分节按序到达 → 余额 / 阈值 / 上下文条正确 → **重开酒馆保持已登录** → 模拟 key 重置 → 自动刷新成功 → 退出登录 → 回未连接态。
- 真网关联调（v1.34 合并后）：真实网页授权 + 真实 plan call + key 刷新；报告注明插件修订、网关契约 v1.34、环境、未覆盖项。HTTP 回归（连接域 + 查询面 + 余额字段）属网关契约批验收，插件侧只做消费方冒烟。
- 独立 reviewer-1 审查插件批实现（覆盖率、边界、凭据不落 UI / DOM / 日志 / 浏览器存储）。

## 4. 风险与说明

- ST 版本漂移：所有事件 / API 特性检测（附录 A 清单），manifest `minimum_client_version` 不动。
- S喵 等社区脚本：README 写明与防截断注入互斥使用；规划调用已隔离在插件服务端。
- 规划调用消耗：按钮旁注明"将消耗少量额度（模型 X）"，失败最多重试一次。
- key 重置联动：网关重置 key → 旧 key 401 → 插件凭登录凭据自动刷新（不要求重新网页授权）；登录凭据自身过期 / 账号禁用 → 「登录已失效」引导重新连接（不做自动重试）。
- 既认残余风险：ST 服务端 secret 命名空间对同机其他 server 插件可读，连接即全量 key 权限（生态既认，v1.34 契约批登记）。

## 附录 A：ST 1.19.0 事件 / API 核对清单（研究结论）

| 名称 | 状态 |
|---|---|
| `OAI_PRESET_CHANGED_BEFORE/AFTER`、`PRESET_CHANGED`、`CHAT_COMPLETION_SETTINGS_READY`、`GENERATE_AFTER_DATA`、`SETTINGS_UPDATED` | 存在可用 |
| 裸 `OAI_PRESET_CHANGED`、`getMaxContextSlots` | 不存在，勿用 |
| `getTokenCount`、`getMaxContextSize`、`renderExtensionTemplate`、`showLoader` | deprecated，用 `getTokenCountAsync` / `getMaxPromptTokens` / `renderExtensionTemplateAsync` / `context.loader` |
| `ChatCompletionService.processRequest`（可指定 model/url） | 存在但未文档化，本批不依赖（plan call 走插件服务端） |

## 附录 B：上游契约引用（v1.32 / v1.34，网关私有仓维护；本文只列消费口径）

- 节名单语义（v1.32）：请求体顶层 `apercus_antitrunc: true` + `apercus_antitrunc_sections`（≤16 项、单项 ≤64 字节、有效项 <2 降级单节；网关剥字段后转发上游）；`max_tokens` 地板 `节数×1200+2000` 客户端自担。
- 插件批流程口径：每预设版本一次 plan 调用、指纹缓存失效、与 S喵 等脚本互斥说明（网关只消费字段，节名单由插件生成）。
- 连接授权域与查询面（v1.34）：发起 / 轮询 / 批准 / 取消四操作＋插件查询面七端点＋插件登录凭据（TTL 与撤销语义随契约评审定稿）＋BalanceSnapshot 增列；插件侧 UX 依据＝官方授权页复用门户登录、免输码允许/取消。
