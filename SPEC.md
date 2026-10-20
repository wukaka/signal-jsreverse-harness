# Signal-JSReverse-Harness — 协议规格 v0

> 状态：设计草案，尚未实现  
> 日期：2026-10-19  
> 目标：把 JS 逆向从“工具调用 + 流程自述”改造成“oracle 驱动的差分实验 + 可审计证据账本”

## 0. 定位与非目标

**定位**

- 面向高强度前端 JS 逆向（签名参数、风控逻辑、环境补丁、纯离线复现）
- 以 oracle 为成功标准，以 run 为执行单位，以 divergence 为进展度量，以 ledger 为事实源
- 外部 agent 负责推理与提案；harness 负责执行、记录、判定与止损

**非目标**

- 不重写浏览器观察工具；复用现有 JSReverser MCP
- v0 不拥有 LLM 推理循环；不自建多 provider agent 框架
- 不做通用 RPA，也不承诺覆盖所有网站

## 1. 设计原则

1. **Signal over motion**：每一轮必须减少不确定性。
2. **Oracle before rebuild**：未判定服务端实际检查什么，不开始补环境。
3. **Evidence or it did not happen**：未提交给 oracle 的输出不是验收证据；未复现的结论不是事实。
4. **Negative results are assets**：证伪与撤回必须入账，不覆盖。
5. **Proposal vs effect**：agent 只能提案；run 与 oracle 提交由 harness 独占。
6. **One chain at a time**：一条链路一个活跃实验；结论不跨链路外推。

## 2. 总体架构

```text
Human
  │ 批准正控制 / 写授权 / override
  ▼
Harness Core
  ├─ Ledger（唯一事实源）
  ├─ Run Executor（唯一执行入口）
  ├─ Oracle Submitter（唯一提交入口）
  ├─ Divergence Engine
  └─ Stop / Gate 判定
  │ 投影上下文          ▲ 结构化提案
  ▼                     │
Agent Episode（Claude Code / Codex）
  │ 观察类工具调用
  ▼
Tool Gateway ── 现有 JSReverser MCP（browser / hook / network）
```

### 2.1 权限边界

| 动作 | Agent 直接做 | 经 Harness | 人类 |
|---|---|---|---|
| 读账本 / 证据 | ✅ | | |
| 编辑 env / patch 文件 | ✅（harness 快照） | | |
| 提出假设 / 实验计划 | ✅（仅提案） | | |
| 执行 run | | ✅ | |
| 提交 oracle | | ✅ | |
| 写 ledger | | ✅（校验后追加） | |
| 声明过门 / L2 | | ✅（只认 oracle + 证据） | |
| 批准正控制 / 写授权 / override | | | ✅ |

### 2.2 强制级别（v0）

- agent 运行在本地可信进程，不做沙箱
- 强制点放在“效果层”：只有 harness 产生的 run / submit 能获得 L1 / L2 证据
- 绕过 gateway 的观察记为 `source=unmanaged`，最高 L0
- 后续版本可切换到受限容器 + egress 代理，契约不变

## 3. Oracle 契约

### 3.1 定义

oracle 是“可执行、可校准、可证伪”的验收判定。oracle 本身必须被验证，否则后续实验证据无效。

### 3.2 类型

| kind | 适用场景 | 能否作为最终结论 |
|---|---|---|
| `server_accept` | 最终验收 | 是（需已校准） |
| `output_equality` | 纯离线复现的中间验证 | 否 |
| `differential` | 补环境 / 差分调试 | 否 |

### 3.2.1 `output_equality` 判定规则

按 run 的 determinism mode 分两档（见 4.3）。归一化难题的解法是**钉输入，不是设容差**：归一化只做序列化层，不做任何数值容差。

**strict（默认）**

- 前置：`time: frozen / random: seeded`，所有易变输入从参考 run 的 trace 重放（hash 关联，采集面见 5.5）
- 覆盖前置：所有声明的易变输入必须已被 5.5 事件面覆盖；未覆盖 → `insufficient_coverage`，不得降级为严格相等
- 规则：规范化序列化后**逐字节相等**。规范化仅含：对象 key 排序、去空白、UTF-8
- 输入一致而输出不等 → 真实分歧，交 divergence 引擎定位

**live（物料必须新鲜时使用，如重放检测要求新鲜时间戳）**

- 前置：`time: real / random: real`
- 字段分解依据易变溯源（trace `value_meta` / `volatile_paths`）：
  - 确定性字段：严格相等，不等即失败
  - 易变字段：仅格式检查（type / shape / length 合格）；允许变化但不要求必然变化，连续 N 次（默认 3）不变记 `volatile_suspicious` 标记，不改变 verdict
- verdict：`structurally_equal | deterministic_field_mismatch | malformed_volatile_field`
- 本档给不出“相等”，只有结构等价；4.3 的“未声明的易变字段一律视为真实分歧”在此原样生效

**不透明输出**：输出为整体加密串 / 签名时无法做字段分解，live 档退化为纯格式检查、无信号。不透明输出只有 strict 档有意义。

**引擎差异不进 oracle**：超越函数（`Math.sin` 等，ECMA-262 允许实现近似）跨引擎 / 版本可能存在 ULP 级差异。oracle 不设浮点容差；此类差异由 divergence 定位到 site 后走语义裁决（见 8.1），参考侧与候选侧的引擎版本对必须记入证据。

### 3.3 Schema

```yaml
oracle:
  id: x-sign-accept
  version: 1
  kind: server_accept
  scope:
    endpoint: "POST https://api.example.com/v1/risk"
    param: X-Sign
    chain: offline              # browser | offline | hybrid

  material:
    required: [X-Sign, X-Timestamp, session_cookie]
    freshness: per_attempt      # per_attempt | per_session | reusable
    pairing:
      same_session: true
      same_timestamp: true

  submission:
    transport: http             # http | browser
    side_effect: read_only      # read_only | write
    authorization:              # 仅 side_effect=write
      required: true
      approver: human
      approval_ref: null
      max_side_effect_calls: 0
    timeout_ms: 10000
    max_attempts: 5
    rate_limit: "1/s"

  verdict:
    accept: [http_status == 200, json.code == 0]
    reject: [json.code in [1001, 1002]]
    replay_rejected: [json.code == 2001]
    transient: [http_status >= 500, error == TIMEOUT]
    indeterminate: [captcha_challenge, json.code == 3001]

  calibration:
    positive:
      sample_source: human_defined
      source: captured_live     # captured_live | curated_library | manual_entry
      samples:
        - ref: artifacts/controls/pos-001
          provenance:
            captured_at: 2026-10-19T10:32:11+08:00
            chain: browser
            session_ref: sess-042
            accepted_by_server: true
          validation_mode: original_acceptance  # original_acceptance | resubmit
          approved_by: human
          approved_at: 2026-10-19T10:35:00+08:00
    negative_controls:
      source: human_defined
      samples:
        - ref: artifacts/controls/neg-sign-flip
          mutation: "翻转签名最后一位"
          expected: reject
    repeats: 3
    require:
      positive_accept_rate: 1.0
      negative_reject_rate: 1.0
      same_class_per_repeat: true

  evidence:
    store: [raw_request, raw_response, headers, timestamp, session_id, run_id]
    hash: sha256

  validity:
    expires_after: 30m
    revalidate_on: [session_rotation, error_taxonomy_drift]
```

### 3.4 生命周期

```text
draft → calibrated → active → invalidated
```

- `draft`：agent 可生成，不能产生有效证据
- `calibrated`：正控制 accept、负控制 reject（或 replay_rejected），且重复一致
- `active`：可用于实验
- `invalidated`：会话轮换、错误码漂移、校准失败

### 3.5 证据强度

| 级别 | 来源 | 最终结论 |
|---|---|---|
| L0 | 原始观测 / trace / 截图 / 未校准 oracle 的返回 | 否 |
| L1 | `output_equality`、`differential` | 否 |
| L2 | 已校准 `server_accept` | 是 |

纯离线链路可以靠 L1 推进，但关闭任务必须拿到 L2。服务端不可达、验证码阻断或预算耗尽时，任务状态是 `unverified`。

### 3.6 硬规则

1. 未校准 oracle 不产生有效证据
2. 最终结论必须引用至少一条 active `server_accept` 命中
3. 出现 `replay_rejected` 时，`freshness` 必须为 `per_attempt`，且同轮物料同会话、同时间窗
4. `indeterminate` 不算通过也不算失败；重试耗尽后标记 oracle blocked
5. `write` 接口缺少 `approval_ref` 时直接拒绝
6. oracle 失效后，旧 L2 证据降级为 L1 参考

### 3.7 正控制由人类定义

- agent 只能生成 `draft` oracle 与候选样本，不能设置 `approved_by`
- 人类选择 `sample_source`，确认样本确实被服务端接受过
- 有重放检测时，`validation_mode=original_acceptance` 不做重放；`resubmit` 得到 `replay_rejected` 记为 `non_replayable_control`，不判校准失败
- 无人类批准的正控制 → 最高 L1，报告必须写 `unverified`

### 3.8 证据保真：全程不脱敏

逆向工作全程禁止对入账证据与物料做任何脱敏 / 变换（no-redaction）：

- 脱敏后的 `raw_request` 无法复现提交；证据的审计价值与可复现性依赖保真
- 改写过的证据无法证明“当时实际发送的是什么”，与账本“原始证据不可改”的定位冲突

敏感数据的管理不靠内容变换，靠边界与生命周期：

1. `.harness/` 是 secret store：`harness init` 自动写入 `.gitignore`，禁止进入版本库 / 同步盘 / 任何外发路径
2. 目录权限 `0700`，宿主磁盘加密（FileVault / BitLocker）为前提条件
3. 任务关闭时由人类决定物料处置：清除 / 加密归档 / 保留

边界：本节只约束**入账内容**。§5 比较策略中的 `redact` 是对齐时的比较策略，不修改、不替换已存储的 artifacts 与 trace，不属于脱敏。

## 4. Run 契约

### 4.1 类型与信封

```yaml
run:
  id: run-20261019-003
  task_id: t-h5st
  iteration: 3              # patch_set 变化才递增
  repeat_index: 1           # 同一 iteration 内第几次重复
  type: execute             # capture | execute | submit
  side: candidate           # reference | candidate
  status: completed         # completed | failed | timeout | blocked | invalid

  comparability:
    event_schema: v1
    instrumentation_hash: sha256:...
    material_hash: sha256:...
    focus_hash: sha256:...
    comparison_policy_hash: sha256:...   # redact / normalization 等比较策略

  inputs: {}
  lineage:
    parent_run: run-...
    patch_set: sha256:...
    changes: [env/patch-003.diff]
  artifacts:
    trace: sha256:...
    output: sha256:...
    stdout: sha256:...
    stderr: sha256:...
  result:
    output_digest: sha256:...
    oracle_verdict: null
```

### 4.2 专有字段

**capture（参考侧）**

```yaml
inputs:
  source: browser           # browser | trace_file
  page_url: ...
  session_ref: ...
  action: "人类触发一次真实提交"
  material_ref: artifacts/materials/m-042.json
reference_quality: live_capture
trace_manifest:             # trace_file 时必填
  captured_at: ...
  event_schema: v1
  instrumentation_hash: sha256:...
  target_script_hash: sha256:...
  environment: {browser, ua}
baseline_group: bg-001
```

**execute（候选侧）**

```yaml
inputs:
  material_ref: ...
  code:
    target_script: sha256:...
    env_version: env-v7
    polyfills_version: poly-v2
  runtime:
    node: 22.14.0
    lockfile: sha256:...
  determinism:
    time: real              # real | frozen | seeded
    random: real
    volatile_paths: ["Date.now", "performance.now", "Math.random"]
  instrumentation:
    profile: core-semantic
```

**submit（oracle 提交）**

```yaml
inputs:
  oracle_id: x-sign-accept
  source_run: run-...
  authorization_ref: null
result:
  verdict: accept | reject | replay_rejected | transient | indeterminate
  response_ref: sha256:...
```

### 4.3 确定性

- 默认 `time: real`、`random: real`
- 易变字段必须显式写入 `volatile_paths`，不做自动推断
- 未声明的易变字段一律视为真实分歧
- `frozen` / `seeded` 必须满足 oracle 配对要求，否则标记为边界，不是补丁

### 4.4 参考来源

| 来源 | 可用性 | 置信度 |
|---|---|---|
| `live_capture` | 实时浏览器采集 | high |
| `trace_file` | 历史 trace + 完整 manifest | medium |

规则：

1. `trace_file` manifest 缺项 → `invalid`
2. `target_script_hash` 不匹配 → `stale_reference`，基线作废
3. `instrumentation_hash` 不匹配 → 不可比
4. 基线要求 ≥2 条同一来源等级、同一 manifest 的参考 run
5. live 与 trace_file 不得混成一组基线

### 4.5 可比性

```text
comparable | incomparable
invalid_reason:
  schema_mismatch
  instrumentation_mismatch
  stale_reference
  material_unpaired
  insufficient_baseline
  comparison_policy_mismatch
```

`comparison_policy_hash` 覆盖 redact / normalization 等比较策略（focus 已由 `focus_hash` 覆盖）。策略变化 → 旧基线与旧 frontier 不得跨策略比较，必须重建基线或重算。

### 4.6 失败与副作用

- `failed / timeout / blocked` 的 run 落盘作为负面证据，但不进入基线、不产生 frontier
- `blocked` 必须带原因：oracle 未校准、授权缺失、覆盖不足
- capture / execute 默认禁止对外写；submit 由 harness 根据 oracle 授权执行

### 4.7 不可变与复现

- run 记录 append-only；任何输入变化产生新 run
- artifacts 内容寻址（sha256）
- `replayable: true` 要求所有输入固定；浏览器 capture 依赖服务端状态时标记 `replayable: false`

## 5. Divergence 引擎

### 5.1 语义事件

两侧输出同一套规范化事件（由 adapter 映射）：

```text
Event {
  lane: main | worker:<id> | timer:<id>
  seq: int                       # 每 lane 逻辑序号，不用墙钟
  kind: call | return | read | write | error | output
  symbol: "crypto.getRandomValues" | "Date.now" | "canvas.toDataURL" | ...
  site: {script_hash, function, line}
  args_digest, ret_digest, this_digest
  value_meta: {type, shape, length, hash}
  stack_digest
  source: target | harness       # harness 注入事件一律排除
  coverage: full | partial
}
```

### 5.2 对齐

1. 结构对齐：按 `(lane, kind, symbol, site)` 保序序列对齐，忽略值
2. 值比较：对齐后的配对事件比较 digest

这能区分“没调用”和“调用了但值不同”，不会把值差异误报为 missing + extra。

### 5.3 噪声模型

参考侧至少运行两次，收集 ref-vs-ref 分歧签名：

```text
noise_signatures = { signature(d) | d ∈ ref-vs-ref 分歧 }
signature = (lane, symbol, site, classification, normalized_diff)

meaningful(d) = d.signature ∉ noise_signatures
              ∧ 可复现 (K=3 中 ≥ R=2)
              ∧ 落在 focus 范围
```

不得用“序号晚于噪声地板”作为唯一判据，否则会漏掉早于噪声位置的真实分歧。

### 5.4 分歧分类

```text
missing_in_candidate
extra_in_candidate
reordered
value_mismatch
shape_mismatch
exception
call_count_mismatch
coverage_gap
timing_only
```

### 5.5 v1 事件面

参与比较：

- 目标函数 `call` / `return`
- 环境读写：`navigator`、`screen`、`crypto`、`Date`、`Math.random`、storage、canvas / WebGL / audio
- `error`
- `output`：最终输出写入 / 返回链路

不比较：每次属性访问、定时器调度、网络耗时、GC、日志。

### 5.6 覆盖

按 `required_events` 校验覆盖。覆盖不足时结论是 `undetected_divergence` 或 `insufficient_coverage`，不是 `no_divergence`。

### 5.7 Frontier

```text
Frontier = (ref_event_anchor, classification)
ref_event_anchor = (lane, symbol, site, ordinal_in_run)
```

跨轮次：

- 锚点更靠后 → 前移
- 覆盖内无 meaningful 分歧 → 消失；输出仍错 → `coverage_gap`
- 锚点提前 → 退化

### 5.8 Verdict

```text
diverged
no_divergence
undetected_divergence
insufficient_coverage
insufficient_baseline
```

### 5.9 退出条件

`frontier 连续两轮不再前移` 且 `oracle 达到 L2`。两者缺一不可。

### 5.10 API

```text
compare({
  reference: Run[],      # >= 2，且 manifest 一致
  candidate: Run[],
  policy: {
    lanes,
    normalization: {volatile_paths, redact},
    focus: {stacks_include, output_symbols},
    reproducibility: {k: 3, r: 2},
    coverage: {required_events}
  }
}) -> {
  frontier, noise_floor,
  meaningful_divergences, candidate_divergences,
  coverage_gaps,
  verdict
}
```

## 6. Experiment / Ledger 契约

### 6.1 Hypothesis

```yaml
hypothesis:
  id: h-003
  claim: "服务端校验的是时间戳与签名的绑定，而不是 UA"
  falsifier: "同一签名替换 UA 后仍被拒，则证伪"
  predicts:
    - "仅改 UA：服务端仍 accept"
    - "破坏时间戳绑定：服务端 reject"
  competitors: [h-004]
  scope: {chain: offline, param: X-Sign}
  confidence: 0.4
  status: proposed   # proposed | testing | supported | refuted | withdrawn
```

`claim` 必须可证伪，`falsifier` 必填。

### 6.2 Experiment

```yaml
experiment:
  id: e-012
  kind: discriminating      # probe | discriminating | verification
  targets: [h-003, h-004]
  variable: "ua"            # 唯一自变量
  control_run: run-...
  variant_runs: [run-..., run-...]
  submit_runs: [run-...]
  predictions:
    h-003: {if: "ua_removed", expect: accept}
    h-004: {if: "ua_removed", expect: reject}
  status: completed
```

规则：

- `discriminating` 至少引用两个竞争假设，且能区分它们
- 一次实验只允许一个自变量；否则 `confounded`，证据降级
- `probe` 可以没有假设，但不能支持结论
- `verification` 必须引用已 supported 的假设，并产出 L2

### 6.3 Evidence

```yaml
evidence:
  id: ev-088
  type: run | divergence | oracle_result | observation | human_note
  strength: L0 | L1 | L2
  refs: [sha256:...]
  interpretation: "..."
  actor: agent | harness | human
```

原始产物与解释分开存储；解释可错，原始证据不可改。

### 6.4 Ledger 事件

```text
hypothesis.proposed
hypothesis.state_changed
experiment.planned
experiment.completed
run.recorded
divergence.computed
oracle.result
evidence.recorded
stop.triggered
stop.overridden
human.decision
```

事件字段：

```yaml
seq, ts, task_id, actor(agent|harness|human),
type, payload, refs[], prev_event_hash?
```

### 6.5 不变量

1. append-only；修正只能追加 `retracted` / `superseded_by`
2. 结论必须引用 evidence ID
3. `L2` 需要已校准 oracle + submit run
4. 实验引用的 run 必须通过可比性校验
5. refuted / withdrawn 单独成表，不覆盖
6. 人工决策必须带 `authorization_ref`

### 6.6 信息增益

```text
gain-eligible: discriminating | verification
probe: 入账，但不参与增益，也不推进 streak（probe 锚定见 6.7）

提案与增益解耦：
  hypothesis.proposed 只入账，不计 gain，数量不设上限
  ——提案免费，多路线探索不受惩罚；止损的度量单位是
    “实验结算后信念集合是否变化”，不是路线数量

gain = 1 当且仅当实验结算时发生任一：
  - 证据背书的假设状态变化（supported / refuted / withdrawn）
    必须绑定已结算实验或 evidence refs；无证据撤回
    记 state_changed_unbacked，不计 gain
  - frontier 锚点后移
  - coverage 提升
  - oracle verdict 稳定跨越 accept 边界（连续两次同类判定；
    transient / indeterminate 抖动记 verdict_noise，不计 gain）
```

重复实验（variant hash + material class 相同）直接 `gain=0`。

被证伪、有证据的撤回同样是状态变化：真实多路线探索中的死路天然落在 gain=1 侧；止损针对的是“零信息空转”，与“尝试了多少路线”正交。

### 6.7 止损

```text
streak 在 gain-eligible 实验 gain=0 时 +1；gain=1 时 streak 归零
stop_eligible = streak >= threshold     # 默认 2，按任务配置（预算紧 / 风控敏感调小）

暂缓需兑换（deferral）：
  新增竞争假设可暂缓止损，条件：
    - 必须绑定一个可执行的 discriminating 实验提案（bound_experiment）
    - 该实验结算：gain=1 → 暂缓兑现，streak 归零
                  gain=0 → 本次暂缓被消耗，记 1 次空转（deferral_consumed）
  连续 M 次空转（默认 2）→ stop 无条件触发，不再接受兑换
  未绑定实验的提案不产生任何暂缓效果

probe 锚定：
  每个 probe 必须声明它要消除的 open uncertainty
  open_uncertainties 从 status=proposed/testing 的假设派生，不单设实体
  实验前后 open_uncertainties 清单无变化 → 记 probe_stagnation
  probe_stagnation 连续 K 次（默认 2）→ 等同 gain=0，streak +1

人工 override：追加 stop.overridden，必须写明理由
  stop 是升级到人，不是终止任务；换路线 / 重定方向由 override 承载
```

兑换与空转的记账挂在 `hypothesis.proposed` / `experiment.completed` 的 payload 上（`bound_experiment`、`gain`、`deferral_consumed`），不新增事件类型。

### 6.8 投影视图

- 活跃假设及置信度
- 已证伪 / 已撤回表
- frontier 历史
- streak 与 stop 状态
- 未解决不确定性清单
- `human_interventions`：逐任务统计人工介入次数（正控制确认、写授权、override、语义裁决），由 `human.decision` 事件投射得到，作为流程成本指标

## 7. 运行时与接口

### 7.1 Episode 契约

输入：

```yaml
episode:
  goal: "当前阶段要减少的不确定性"
  context_projection:
    - open_hypotheses
    - last_frontier
    - recent_evidence
    - experiment_constraints
  budget: {turns, tokens, wall_time}
```

输出只允许结构化提案：

```yaml
proposal:
  type: hypothesis | experiment | patch | claim_gate | note
  refs: [...]
  rationale: "..."
```

### 7.2 Agent 侧 MCP 工具

```text
get_brief()                     # 投影上下文
get_view(name)                  # 账本投影查询

propose_hypothesis(...)         # 仅提案
propose_experiment(...)         # 返回校验结果，不执行
execute_experiment(id)          # harness 执行 run 矩阵
submit(run_id, oracle_id)       # harness 提交 oracle

record_observation(...)         # L0 证据
claim_gate(stage, evidence[])   # 申请过门，harness 判定
ask_human(kind, payload)        # 正控制批准 / 写授权 / override / 语义裁决（adjudication，见 8.1）
```

原则：提案与执行分离。只有 `execute_experiment` 和 `submit` 能产生 L1 / L2 证据。

### 7.3 Tool Gateway

- 代理现有 JSReverser MCP 的观察类工具
- 逐次记录 tool、参数摘要、结果摘要、actor、绑定的 experiment / probe
- 经 gateway 的观察自动记 L0
- 未经过 gateway 的调用记 `source=unmanaged`，最高 L0
- 检测到直接向 oracle endpoint 发起的请求时标记 `unmanaged_submission`；v0 不阻断，但不计入 L2
- 浏览器点击 / 输入允许，同样入账并绑定 experiment

### 7.4 CLI

```text
harness init --task ... --oracle ...
harness oracle calibrate --interactive
harness approve --control | --write | --override
harness status
harness stop | resume
harness report
```

### 7.5 存储布局

```text
.harness/
  task.json
  ledger.jsonl
  oracle/
  runs/<run_id>/{record.json, trace.jsonl, output, stdout, stderr}
  artifacts/sha256/...
  snapshots/<iteration>/
```

### 7.6 并发

- 默认单实验、单链路
- 多 worker 只允许独立 experiment，且属于不同 baseline group
- 同一 chain 禁止并行改环境

## 8. 阶段与门的位置

阶段是**默认 profile**，不是引擎本体。五阶段是出发点，可以扩展或重排。

| 主阶段 | 覆盖原门 | 退出条件 |
|---|---|---|
| Frame | G0 + blackbox A | 一句话说清“什么算成功”，链路范围确定 |
| Observe & Baseline | G1 + blackbox A/B | 至少一条真实提交；错误码分类完成；样本库可用 |
| Isolate | G2 + blackbox B/D | 明确失败层；未过此门禁止 rebuild |
| Hypothesize & Experiment | G3 + blackbox C/D | 至少两个竞争假设；下一实验能区分它们 |
| Rebuild & Validate | G4 + G5 + blackbox E/F | 参数稳定生成；first divergence 不再前移；L2 通过 |

- G6 DeepDive 作为可选子状态
- 门只放在高成本或不可逆检查点，不约束每个动作
- 扩展约束：每个 stage 必须有可判定退出条件；每个 action 必须归属 stage；gate 必须能引用证据

### 8.1 Profile：full 与 light

默认 `full`，简单任务可选择 `light`，避免流程成本超过任务本身。

| 维度 | full | light |
|---|---|---|
| 适用 | 高不确定性、多轮、服务端判定 | 短任务、单参数、行为确定 |
| oracle | 必需 | 必需 |
| 假设 / 实验 | 必需 | 可选 |
| ledger | 全量事件 | run + oracle + human.decision |
| divergence | 必需 | 可选，允许只做输出比对 |
| stop | gain streak + budget | 预算 / 失败计数（定义见下） |
| 人工介入点 | 正控制、写授权、override、语义裁决 | 正控制、写授权、override |

**profile 选择权**：选择与切换 light / full 由人类决定，记入 `human.decision`；agent 与 harness 只能建议切换。不允许 agent 自选——否则 light 的弱止损成为绕开 gain 止损的旁门，违反“提案与效果分离”原则。

**light 的度量定义**（缺此定义则升级判据不可执行）：

- 轮（round）：一次 `execute` 及其评估记一轮；评估指 `submit`，或 `output_equality` / `differential` 比较
- 进展（progress）：基准判据是 oracle verdict 相对上一轮改善（`indeterminate` 得到确定判定，或 `reject → accept`）；`output_equality` 判定为 strict 相等或 `structurally_equal` 时记进展（充分条件，判定规则见 3.2.1）。判据皆无满足 → 记 1 轮无进展
- 失败计数：只挂 oracle `reject` 与 `failed / timeout` run；`indeterminate` 不计入（§3.6 规则 4）
- 升级建议触发：连续 2 轮无进展，或失败计数达到阈值（默认 3），或预算消耗过半仍无 accept

**语义裁决**（仅 full）：人对 harness 无法机械判定的模糊结果做裁定，经 `ask_human(kind=adjudication)` 发起。典型场景：`indeterminate` verdict 的归类、噪声样本不足时某分歧是否算 meaningful、trace 缺口是否阻塞结论。裁定记为 `human.decision`，进入 `human_interventions` 统计。

约束：

1. light 不放宽 L2：最终成功仍必须通过已校准的 `server_accept`
2. unmanaged 证据仍不能成为 L2
3. light 触发升级判据时 harness 建议升级到 full；是否升级由人类决定
4. 选择与升级写入 ledger（`human.decision`），便于统计成本

## 9. v0 范围

**纳入**

- oracle 定义、人类校准、L0–L2 证据准入
- 证据保真策略与 `.harness/` secret store 边界（见 3.8）
- full / light 两种 profile
- execute / submit run，离线 Node 链路
- ledger 与投影视图（含 `human_interventions`）
- divergence v1（核心语义事件）
- MCP server + CLI 骨架
- 单任务单链路

**暂不纳入**

- agent 沙箱与 egress 代理
- 自研 LLM 循环与多 provider
- 全量插桩、WASM / 网络深度适配
- 多链路并发
- 阶段 profile 的完整 gate 引擎

## 10. 设计验收场景

协议必须能正确处理以下场景，否则视为设计缺陷：

1. 重放检测：重放拒绝不误判为 oracle 失效
2. 随机噪声：ref-vs-ref 噪声不会掩盖早于噪声位置的真实分歧
3. 绕过 gateway：未受管的提交无法获得 L2
4. 假设刷屏：未绑定 discriminating 实验的提案不能兑换暂缓；连续 M 次空转后止损无条件触发
5. 过期参考：trace_file 的脚本 hash 不匹配时基线作废
6. 覆盖缺口：输出不一致但 trace 无分歧时，结论是 `undetected_divergence`，不是成功
7. 校准缺失：没有人类批准的正控制时，任务最高只能到 L1
