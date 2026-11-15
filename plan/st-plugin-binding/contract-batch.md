# ST 插件网关连接 + 惩罚阈值暴露契约批（草稿 v3，待签核）

> **执行修订记录（2026-11-16，设计重写 v2→v3）。** 2026-11-15/16 用户逐条拍板，连接体验从「设备配对三操作（8 字符用户码手动输码批准）」重设计为「官方网页授权＋插件服务端后台领取＋登录凭据体系」。v2 正文与其 2026-11-15 执行修订记录**整体作废**（全文见公开仓 PR #1/#2 git 历史），其中语义级 sec 修复在新设计中重推演（见 §8）。重写后契约号**维持 v1.34 / 0.11.99**（2026-11-15 取号核查所取；v2 分支未提交合并、号未被消费，按先占者持号沿用；开 PR 时点复核，被占则按让位纪律重编）。

- 状态：三份设计稿（契约批 / 插件批 / 任务单）随公开插件仓 apercus-sillytavern `plan/st-plugin-binding/` docs PR 提交评审。网关侧实现（migration、连接服务、授权页、登录凭据体系）在网关私有仓执行。
- 设计基线：用户 2026-11-15/16 逐条确认条款（免输码网页授权；授权状态归网关、Pass 仅替换登录来源；批准页 URL 携带请求引用、无人工核对码；插件服务端后台领取、无回调地址；交付＝现有用户 key 一把制；插件保存登录凭据、与 API key 分离；key/模型/余额沿用网关现有口径；退出登录与强制失效分离；凭据存酒馆服务端、多用户隔离）。
- 下游批：apercus-sillytavern 插件批（同目录 [plugin-batch.md](plugin-batch.md)）；契约落地随网关侧 C1 契约 PR 在私有仓执行。
- 安全：涉及用户 key 出网关＋新增登录凭据面，按协作规则 9 强制安全评审；v2 已并入的 sec 修复语义按 §8 重推演后并入本稿。
- 关联背景：门户登录正迁移见微通行证（`origin/pass-add`，APE-80）；本契约只依赖「门户已登录会话」，对登录方式（邮箱码 / Pass）不可见，迁移不破坏本契约。

## 0. 背景与目标

apercus-sillytavern（酒馆插件 = ST UI 扩展 + ST 服务端插件；ST 为自带 Node 服务端的应用，插件服务端可后台工作、可安全持久化）定位＝**用户在酒馆连接网关的便捷入口**。插件只服务 Apercus 网关，不提供其他服务商地址、不提供手填 key 输入框。需要网关支持：

1. **网页授权连接**：插件发起 → 官方授权页（复用门户登录状态）→ 用户允许 → 插件服务端后台领取，免输码、免回调地址配置。
2. **保持登录**：登录凭据与 API key 分离；插件记住登录状态，key 更新不要求重新授权。
3. **key / 模型 / 余额查询**：列当前账号有权使用的 key、所选 key 可用的模型、余额用量与 BILL-08 追费阈值——全部沿用网关现有口径。
4. **退出登录**：插件侧清除＋网关使该次登录失效。

非目标：客户端放行 / 客户端头准入（v0.47 挂账独立批次）；key 的创建 / 删除 / 重置管理（只查与选用，D6）；网关侧「已连接插件」管理列表（留决②）；`/v1` 数据面任何行为变化；防截断（已随网关 #443/#444 交付，插件侧对接为插件批 B2，不在本批）。

## 1. 决策记录

- **D1 网页授权＋后台领取，免输码免回调。** 插件服务端发起连接请求 → 插件打开网关官方授权页（URL 携带请求引用）→ 用户在页上允许 → 插件服务端凭轮询密钥后台轮询领取。理由：ST 自带 Node 服务端插件（可轮询、可安全持久化）；插件部署形态任意（本机 / 局域网 / 远程），后台领取使网关无需知道也无需校验酒馆返回地址；完整 key 不经 URL、不经浏览器存储。RFC 8628 §3.3.1 `verification_uri_complete` 同型（免输码为其 sanctioned 优化）。
- **D2 授权状态归网关。** 批准记录、连接关系、凭据发放与撤销全部落在网关库。Pass 只负责「你是谁」：授权页「认出你」借门户会话（现）／Pass（未来），授权账本不随登录方式迁移而迁移（v2 原则保留并升格）。
- **D3 授权页认请求＝URL 携带请求引用；无人工核对码。** v2 的 8 字符用户码、手动输码、逐字比对、禁止 URL 预填整组机制作废（用户 2026-11-15/16 拍板：信任自己部署的酒馆是产品前提，酒馆装错属用户自身问题；人工对码不成为流程必选）。程序层双向校验：插件仅连官方固定网关域名；网关把结果只交付给持轮询密钥的发起方。授权页防「诱导批准」由页面后果全文与网关风控层负责，不以插件交互承担。
- **D4 交付两件套：现有用户 key（一把制）＋插件登录凭据，两者分离。** 批准领取时一次交付 {登录凭据, 当前 key, 用户名}。key 供酒馆连接模型（走酒馆既有保存习惯）；登录凭据供查询面（§2.5）。**授权关系不随 key 变化断开**：key 重置后已签发登录凭据继续有效，插件凭其重新取得当前 key 更新酒馆配置，用户无需重新网页授权（端点见 §2.6 `GET /api/plugin/me/key`）。网关不发明插件专用子 key。
- **D5 退出登录 ≠ 强制失效，两种结束分开。** 插件退出：清插件侧保存件＋调网关注销端点，仅该次登录凭据失效，门户会话与 key 不动。网关强制失效：账号禁用／凭据过期 → 拒绝后续请求，插件如实显示「登录已失效」引导重新授权；过期不算异常事件。
- **D6 查询面沿用网关现有口径。** key 列表＝当前登录账号有权使用的 key（项：稳定编号 / 名称 / 脱敏标识 / 状态；**不含完整 key 明文**）；模型＝所选 key 有权使用的模型（网关权限判断，插件按酒馆适配能力自行过滤展示）；余额 / 用量 / BILL-08 阈值＝现有口径原样，插件只展示不做计算。v1 无 key 创建 / 删除 / 重置接口。
- **D7 连接成功判定归酒馆。** 插件把网关地址与凭据接入酒馆原生连接机制，状态显示沿用酒馆自身结果；插件不另设「已连接」判定，连接失败不等于退出登录。
- **D8 凭据保存在酒馆服务端，浏览器零保存，多用户隔离。** 与酒馆存 API 设置同一台服务端、同一套持久化习惯；按 ST 注入的 `req.user.directories` 按用户隔离。**插件仓 AGENTS「服务端不写 ST secret」条款随本批修订**（2026-11-16 用户拍板与酒馆保存逻辑一致），实现批核对 ST secrets 实际接口后落地。
- **D9 簿记落库＋哈希分级（v2 D6 思想沿用，实体换名）。** 连接请求与登录凭据均落库（migration 取当期空号）；`request_ref` 低熵且进授权页 URL → 存 HMAC-SHA256(KEK, 域分隔)；`polling_secret` / 登录凭据高熵（≥128bit）→ 存普通 sha256；轮询密钥单次消费（行删除即消费）。
- **D10 横切纪律沿用。** 独立限频器（不与数据面 / 登录桶共用）、三路由 `no-store`、DTO `String()`/`GoString()` 脱敏、日志零码值零凭据、批准＋审计同事务、契约先行＋contractDebt 挂账、门禁清单照旧。

## 2. 契约变更一：连接授权域（新域「连接」，替代 v2「绑定」三操作）

### 2.1 `POST /api/connect/requests` —— 发起连接请求（匿名，插件服务端）

- 请求：`{}`（空对象；拒绝未知字段 422）。v1 不收实例自报名（自报不可信、无身份依据，留决③）。
- 200 响应（`Cache-Control: no-store`）：`{"request_ref": string, "polling_secret": string, "authorize_url": string, "expires_at": <UTC date-time>}`
  - `request_ref`：连接请求引用，进 `authorize_url` 查询参数（免输码载体；低熵，库内 HMAC 存储，D9）。
  - `polling_secret`：CSPRNG ≥128bit URL 安全串，即取件凭据；TTL 15 分钟，单次消费。
  - `authorize_url`：网关官方授权页绝对地址（路由随 C3 定稿，留决④）。
- 限频：独立限频器；发起按可信 IP 5 次/分；存活请求上限 500，超限 `429 rate_limited`。创建时顺带删除全部过期行（惰性清理，无后台清扫器）。运维注沿用：现部署 `trusted_proxies` 默认为空，「按 IP」实际退化为全局限速，随批提请 ops 知悉。

### 2.2 `POST /api/connect/requests/poll` —— 轮询领取（匿名，凭 polling_secret）

- 请求：`{"polling_secret": string}`；响应 `Cache-Control: no-store`；匿名路由不读取、不记录 portal cookie 与请求头。
- 200 响应：
  - 未批准：`{"status": "pending"}`
  - 已批准（恰一次）：`{"status": "approved", "connect": {"login_credential": string, "key": string, "username": string}}`。同事务 CAS 删行即消费；批准历史由审计行承载。`login_credential` 即 D4 登录凭据（§2.5），与本 key 同事务签发。
- **失效联动（v2 sec 修复语义沿用）**：领取事务按序校验 ①未过期（`expires_at > now`）→ ②账号状态 `enabled` → ③交付 key 与批准时 `key_hash_snapshot` 同源（重算哈希相等）；任一失败 **404 且不消费**（行随 TTL 消亡，插件重新发起即可；进入登录凭据稳态后 key 变化走 §2.6 刷新，不再走本窗口）。效果：批准后、领取前发生 key 重置 / 账号禁用，该次领取拿不到任何 key（含重置后的新 key），防竞态探测。
- 用户在授权页点「取消」→ 删除该无主行（§2.3 取消端点）；此后 poll 404。404 单一语义不可区分（不存在 / 已消费 / 已过期 / 失效联动 / 已取消），防枚举（v2 原则沿用）。错误序：429 限频先于查库。
- 错误：`404 connect_request_not_found`（新码，逐字登记于 api.md 错误码表）；`422`；`429 rate_limited`（polling_secret ≥5 秒间隔＋可信 IP 30 次/分，独立限频器）；`500`。
- 载体 DTO 带 key 与登录凭据，须实现 `String()`/`GoString()` 脱敏；禁止日志出现请求 / 响应体与任何密钥值。

### 2.3 `POST /api/portal/me/connect/requests/approve` 与 `.../cancel` —— 批准 / 取消（门户会话）

- 鉴权：portal 会话＋精确同源 Origin（沿用 v2 D3）。授权页前端调用；**无人工输码**，`request_ref` 由页面从 URL 取得。
- approve 请求：`{"request_ref": string}`；响应 `{"status": "approved"}`（`no-store`）。
- 行为（CAS）：`UPDATE ... SET user_id=?, key_hash_snapshot=<当前 users.key_hash> WHERE request_ref_hash=? AND user_id IS NULL AND expires_at>now`，`RowsAffected=0` → `404 connect_request_not_found`（未知 / 已批准 / 已过期 / 并发抢批一概同码，恰一 200）。批准不改变 key 本身、不产生 key 新行。
- cancel 请求：`{"request_ref": string}`；行为：`DELETE ... WHERE request_ref_hash=? AND user_id IS NULL`，幂等，404 同码。取消仅为无主请求的体面出路径，无安全语义。
- 审计（同事务，沿用 v2 修复）：`admin_id=NULL`、`admin_name="user:<用户名>"`、`object_type="connect_request"`、`object_id=<行 id>`（AUTOINCREMENT 复用防护）、`change_summary` 固定模板含 user_id（users.username 非唯一）、摘要不含任何码值。cancel 不审计（无授权语义）。
- 错误：`401 unauthorized/session_expired`、`403 user_disabled/permission_denied/origin_forbidden`、`404 connect_request_not_found`、`422`、`429 rate_limited`（按用户 10 次/分＋可信 IP 30 次/分，独立限频器）、`500`。
- 并发测试：双 approve 恰一 200；approve 与 poll 消费并发恰一交付。

### 2.4 网关授权页（非契约件，随批实现）

- 打开即读门户会话：已登录 → 直接进入批准视图；未登录 → 先登录（现邮箱码；Pass 迁移后自动切换，契约不可见），登录后回到批准视图。回跳只携带 `request_ref`（免输码机制本体，非 v2 所禁的「凭据预填」）。
- 批准视图打开即展示：当前账号用户名、后果全文（「允许后此插件将取得你的**完整 API key** 并代表你调用网关；可在插件中退出登录；重置网关 key 将使所有使用处失效，重置有 7 天冷却」）、[允许] [取消] 两键；**无自动批准路径**，必须人工点击。
- 加固沿用 v2 sec 修复：SPA `Content-Security-Policy: frame-ancestors 'none'` ＋ `X-Frame-Options: DENY`；授权与取消路由 `Referrer-Policy: no-referrer`。
- 测试：打开页面零副作用；无自动提交路径；无框嵌套；未登录登录后正确回到批准视图。

### 2.5 插件登录凭据（connect credential）

- 签发：poll 领取 approved 时同事务生成；CSPRNG ≥128bit URL 安全串；库存 sha256 哈希；簿记对齐现有 `sessions` 表范式（realm 思想，独立簿记命名随实现批）。归属 user_id，**与门户会话互相独立**（插件退出不影响网页登录，反之亦然）。
- 使用：作为 Bearer 在 §2.6 查询面鉴权；**不用于 `/v1` 数据面**（数据面仍只认用户 key，两域不混用沿用现库纪律）。
- 失效：账号禁用 → 立即拒绝；TTL 到期 → 拒绝（插件提示重新授权，不算异常）；插件调 logout → 即时撤销。TTL 数值与滑动策略留决①（建议：30 天固定，不做滑动）。
- 网关侧撤销面（管理台列表 / 用户自助「已连接插件管理」）不入 v1（留决②）；v1 撤销途径＝插件 logout、TTL、账号禁用。

### 2.6 插件查询面（统一登录凭据 Bearer；端点命名终稿留决⑤）

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /api/plugin/me` | `{username}` | 账号确认（登录状态探活） |
| `GET /api/plugin/me/keys` | `[{id, name, masked, status}]` | 当前账号有权使用的 key 列表；**不含明文**；v1 恒一把，结构向后兼容多 key（D6） |
| `GET /api/plugin/me/key` | `{key, username}` | 当前调用凭据交付（语义＝门户「查看 key」的插件形态）；key 重置后的刷新入口（D4），登录凭据不变 |
| `GET /api/plugin/me/models` | 所选 key 权限内模型目录 | 沿用目录与权限口径；插件按酒馆适配能力过滤展示 |
| `GET /api/plugin/me/balance` | BalanceSnapshot（含 §3 两字段） | 沿用现有口径 |
| `GET /api/plugin/me/usage` | 用量（沿用现有口径） | |
| `POST /api/plugin/logout` | `{}` | 撤销本次登录凭据（D5） |

- 全部 `no-store`；查询面错误复用现有信封；`401`（凭据无效 / 过期 / 账号禁用，插件据此显示重新授权）；限频按凭据＋可信 IP（独立限频器）；权限恒＝本人账号，无跨账号面。读操作不写审计；logout 写审计（同事务，形态同 §2.3）。

## 3. 契约变更二：BalanceSnapshot 增列（BILL-08 用户侧暴露；v2 内容原样保留）

`GET /api/user/balance` 与 `GET /api/portal/me/balance` 的 BalanceSnapshot 追加两个**必填**字段（命名与 system_settings KV 键一致）：

| 字段 | 形态 | 语义 |
|---|---|---|
| `penalty_input_threshold` | 非负十进制整数字符串 | 大输入惩罚触发阈值 H（token 数）；可信输入 token 数**严格大于** H 才追加费，等于不追加（BILL-08 口径） |
| `penalty_multiplier` | 十进制整数字符串 | 倍率 K（毫率，K≥1000，1000=1 倍）；超阈值追加＝ceil(B×(K−1000)/1000) 微度，B 为该请求基础费。**仅展示用**，客户端不做追加额计算 |

- 两键为 0001 种子 fail-closed 占位、恒有值，故必填；字符串形态与 admin settings 一致（不经浮点，≤MaxInt64）。消费者以 BigInt / 整数校验解析，非法值按「未知」展示。
- 观察口径：随 `observed_at` 快照（H/K 短 TTL 组件，正常期陈旧上界 5 秒）。零新错误码；`/v1` 与目录不动。

## 4. 数据与迁移

两张新表（migration 号随实现批取当期空号，起草时点 0053/0054）：

- `connect_requests`：`id, request_ref_hash(uniq, HMAC-KEK 域分隔), polling_secret_hash(uniq, sha256), user_id(NULL=未批准), key_hash_snapshot(NULL=未批准), expires_at`。无 status 列；消费＝删行；取消＝删行（仅无主）；过期行读时视同不存在、创建时顺带删除。
- 插件登录凭据簿记：`credential_hash(uniq, sha256), user_id, created_at, expires_at`（命名与列随实现批对齐 sessions 范式；撤销＝删行）。

随批更新 `docs/db-schema.md` / `docs/db-data-dictionary.md`（表数随当期＋2）与审计用户发起形态说明。哈希口径见 D9。

## 5. 本批实现清单（执行批 PR 面）

契约件：`docs/api/api.md`（新「连接」域：2.1/2.2/2.3 六操作＋2.6 查询面七操作＋§3 增列＋头部 v1.34）、`docs/api/openapi.yaml`（路径＋组件＋0.11.99）、`docs/api-changelog.md`（v1.34 行重写为新契约叙事）、`docs/term-glossary.md`（连接请求 / 轮询密钥 / 授权页 / 插件登录凭据 / 失效联动词条）、`scripts/contract/error-contract.mjs`（新操作＋新码＋SHA 重锁）。
实现件：migrations；连接服务（发起 / 轮询 / 批准 / 取消 / 惰性过期；CSPRNG、独立限频器、CAS、consume-once、失效联动、no-store、DTO 脱敏）；登录凭据签发 / 校验 / 撤销＋查询面七端点；BalanceSnapshot 两字段贯通；网关授权页（§2.4 全部项）。
门禁：`node scripts/checks/plan-refs.mjs`、`comment-hygiene.mjs`、`strict-yaml-validate.mjs`；`go test ./internal/server -count=1`（contractDebt 摘牌闸）＋`go test ./internal/store -count=1`。

## 6. 验收口径

- HTTP 回归（批准的隔离测试环境）：发起→pending→批准→approved 一次交付 {登录凭据, key, 用户名}（二次 poll 404 行已删）；取消→poll 404；未登录批准 401；无 Origin 拒绝；限频 429；余额两端点新字段在。负面：未知 request_ref/polling_secret、过期、未批准即 poll、取消后 poll、空体、未知字段——一概 404/422/429 不可区分。
- 安全断言：approve→poll 得两件套；**approve→key 重置→poll 404 且行未删**；**approve→账号禁用→poll 404**；**key 重置→登录凭据仍有效→`GET /api/plugin/me/key` 返回新 key**；**账号禁用→plugin 查询面全 401**；双 approve 恰一 200；approve 与 poll 并发恰一交付；logout 后旧凭据 401 且门户会话不受影响；授权页打开零副作用、无自动批准；响应 `no-store`、日志零码值、DTO 脱敏。
- 独立 reviewer-1 核对覆盖率与断言；Go 集成测试覆盖事务性（批准＋审计同事务；领取＋凭据签发同事务）与并发 CAS。
- 报告注明测试代码修订、契约引用（v1.34）、环境、未覆盖项。

## 7. 分工与排期

两人分工（人甲＝网关侧 / 人乙＝插件侧）任务单见同目录 [tasks.md](tasks.md)；接缝＝C1 契约冻结。v3 重设计影响插件批面（B1 连接体验重写、B3 增 key/模型选择与退出登录、凭据保存条款修订），甲在 C1 冻结时主动同步乙；插件发布门控＝v1.34 合并。

## 8. 评审记录与留决事项

- **v2→v3 重设计记录（2026-11-16）**：作废组＝8 字符用户码、手动输码、逐字比对、禁止 URL 预填（由 D3 取代）；语义级 sec 修复重推演后保留＝approve/poll CAS 与单次消费、失效联动三谓词、404 单一语义、404 先于 429 反转序修正、审计同事务＋user_id＋AUTOINCREMENT、no-store、DTO 脱敏、授权页 frame/referrer 加固、惰性清理全量口径；新增面＝登录凭据体系、查询面七端点、取消路径、key 刷新入口。
- oracle 评审（v2 已并入沿用项）：无后台清扫器、簿记最小列、错误收敛 404、插件侧不做开关态上报。
- sec 评审：v3 全稿需**重新过会**（新凭据面＋免输码流程），不得以 v2 结论沿用。
- 留给契约评审：① 登录凭据 TTL 与滑动策略（现案建议 30 天固定）；② 网关侧「已连接插件」查看 / 撤销管理面是否入 v1（现案不入）；③ 发起请求是否收实例自报名（现案不收，`{}` 空体）；④ 授权页路由与文案（随 C3 定稿）；⑤ 插件查询面端点命名终稿；⑥ plugin 簿记表终名与列（随实现批对齐 sessions 范式）。
