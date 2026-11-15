# 任务单：ST 插件网关连接契约批 + 插件批（两人分工）

> **执行修订记录（2026-11-16，设计重写 v2→v3 随批更新）。** 随 [contract-batch.md](contract-batch.md) v3 重设计（免输码官方网页授权＋插件服务端后台领取＋登录凭据体系，2026-11-15/16 用户逐条拍板）同步更新 C1–C3 与 P0–P4 范围。契约号维持 **v1.34 / 0.11.99**（2026-11-15 取号核查所取、未被消费；开 PR 时点复核）；发布门控＝v1.34 合并。**Rorollln 注意：B1 连接流程、B3 key/模型选择、凭据保存条款均已重设计，开工前以 v3 三稿为准，勿按 v2 配对式实现。**

- 依据：[plugin-batch.md](plugin-batch.md)（插件批设计稿）、[contract-batch.md](contract-batch.md)（契约批设计稿），均在本目录；契约落地随网关侧 C1 契约 PR 在私有仓执行。
- 分工逻辑：接缝＝C1 契约冻结；人甲只碰网关仓（私有）、人乙只碰本公开仓，零共享文件。
- 前置：本任务单随公开仓 docs PR 评审；签核后开 Linear 票——批A（契约批）入 Apercusgateway 项目，批B（插件批）入 apercus-sillytavern 新项目；之后每项工作先开分支、走 PR、填 Worklog。

## 人甲（网关侧：Go + 契约文档 + 授权页）

- [ ] **C1 契约 docs PR**（最先飞；contract-in-flight 一次一个）：`docs/api/api.md`（新「连接」域四操作〔发起/轮询/批准/取消〕＋插件查询面七端点＋插件登录凭据体系＋新码 `connect_request_not_found`＋query §2 BalanceSnapshot 增列＋头部 v1.34）、`docs/api/openapi.yaml`（路径＋组件＋0.11.99）、`docs/api-changelog.md`（v1.34 行重写）、`docs/term-glossary.md`（连接请求/轮询密钥/授权页/插件登录凭据/失效联动词条）、`scripts/contract/error-contract.mjs`（新操作＋新码＋SHA 重锁）、`plan/README.md` 索引登记。
  验收：契约评审门（含留决六项落地）＋ sec 评审（v3 新凭据面重新过会）＋ 脚本门禁（plan-refs / comment-hygiene / strict-yaml-validate）。
- [ ] **C2 后端实现 PR**：migrations（连接请求表＋插件登录凭据簿记，取当期空号）；连接服务（CSPRNG、独立限频器、CAS、consume-once、失效联动三谓词、惰性过期、no-store、DTO 脱敏）；登录凭据签发/校验/撤销＋查询面七端点；BalanceSnapshot 两字段贯通；批准/取消/注销审计（用户发起形态）。
  验收：`go test ./internal/store -count=1` 起步；HTTP 回归＝契约批设计稿 §6（全部安全断言，含 key 重置→登录凭据刷新、账号禁用→查询面 401）；独立 reviewer-1。
- [ ] **C3 网关授权页**：官方授权页（复用门户会话、后果全文、允许/取消两键、无自动批准、无人工输码）＋ SPA `frame-ancestors 'none'`/`X-Frame-Options: DENY` ＋ 授权与取消路由 `Referrer-Policy: no-referrer` ＋ 未登录先登录后回批准视图。
  验收：打开页面零副作用断言；无框嵌套；无自动提交路径。
  依赖：与 C2 收尾并行（同一批准端点契约）；C1 必须最先完成。

## 人乙（插件侧：JS + node:test）

- [ ] **P0 插件仓 docs PR**：AGENTS/README 凭据保存条款修订——「服务端不写 ST secret」放宽为「登录凭据与 key 存 ST 服务端 secret（按 directories 隔离），浏览器零保存」（v3 D8，2026-11-16 用户拍板）。
- [ ] **P1＝B1 网关连接**：官方授权页打开、后台轮询领取、登录凭据与 key 落密钥库、保持登录（重开不重复授权）、key 重置自动刷新、退出登录。依赖：C1 字段冻结（开发期 stub 网关，不接真网关）。
- [ ] **P2＝B2 防截断**：`PRESET_CHANGED` 检测（仅 chat 预设）、惰性指纹、`POST /plan` 代理、校验与兜底、指纹缓存、注入、工具/响应格式守卫。对接 #443/#444 既有契约，不受 v3 重设计影响。
- [ ] **P3＝B3 key/模型选择 + 计量**：key 列表与选用、所选 key 模型目录、自动接入酒馆 Custom 源（连接状态沿用酒馆）、余额 + 阈值条（BigInt fail-closed，K 仅展示）、上下文计量。
- [ ] **P4 联调与发布**（门控＝v1.34 合并）：真网关联调（网页授权全流程 + plan call + key 刷新）、消费方冒烟、发布。
  验收：`pnpm test` 全绿 ＋ `pnpm check`；ST 冒烟清单见 plugin-batch.md §3；独立 reviewer-1。

## 跨人协调点

1. C1 评审中任何字段变更，甲主动同步乙；乙不接受未通知的字段漂移。**v3 重设计为最大一次漂移，甲在 C1 冻结时主动通知乙作废 v2 口径。**
2. 授权页路由（留决④）由甲在 C1/C3 定稿，乙对齐「打开授权页」常量。
3. 失效联动两侧各测：甲测网关断言（contract-batch.md §6：approve→重置→poll 404、账号禁用→查询面 401、key 重置→登录凭据刷新），乙测插件失效 UX 与自动刷新。
4. 留决六项（登录凭据 TTL/滑动、网关侧管理面是否入 v1、实例自报名、授权页路由与文案、查询面端点命名、簿记表名）在 C1 契约评审中定，结论回写两份设计稿。
