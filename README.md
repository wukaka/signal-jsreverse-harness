# Signal-JSReverse-Harness

面向高强度前端 JS 逆向的 **oracle 驱动 harness**：把逆向从「工具调用 + 流程自述」改造成「差分实验 + 可审计证据账本」。

核心分工只有一句话：**agent 负责推理与提案，harness 独占执行、记录、判定与止损，ledger 是唯一事实源。**

## 为什么需要它

逆向过程中最贵的错误不是「试错」，而是**无法区分「我以为成了」和「服务端认可了」**。这个项目用三件事压缩这种不确定性：

1. **Oracle before rebuild** —— 先判定服务端实际检查什么，再开始补环境。
2. **Evidence or it did not happen** —— 没提交给 oracle 的输出不是验收证据；没复现的结论不是事实。
3. **Proposal vs effect** —— agent 只能提案；run 与 oracle 提交由 harness 独占，绕过 gateway 的调用不计入最终证据。

> 设计原则全文见 [SPEC.md](./SPEC.md#1-设计原则)。

## 工作方式

```text
Human
  │ 批准正控制 / 写授权 / override / profile 切换
  ▼
Harness Core
  ├─ Ledger（唯一事实源，append-only 哈希链）
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

| 动作                  | Agent 直接做       | 经 Harness               | 人类 |
| --------------------- | ------------------ | ------------------------ | ---- |
| 读账本 / 证据         | ✅                 |                          |      |
| 编辑 env / patch 文件 | ✅（harness 快照） |                          |      |
| 提出假设 / 实验计划   | ✅（仅提案）       |                          |      |
| 执行 run              |                    | ✅                       |      |
| 提交 oracle           |                    | ✅                       |      |
| 写 ledger             |                    | ✅（校验后追加）         |      |
| 声明过门 / L2         |                    | ✅（只认 oracle + 证据） |      |

## 快速开始

要求 Node.js >= 20.19.0。

```bash
npm install
npm run build
npm test          # 构建 + 单元/集成测试
npm run typecheck
```

初始化一个任务工作区（默认落在 `.harness/tasks/<task>/`）：

```bash
node build/src/cli.js init --task demo --goal "还原某站 X-S 签名" --chain offline --profile full
```

启动 harness MCP server（供 agent 以 stdio 接入）：

```bash
node build/src/cli.js serve --task demo
# 如需代理现成的观察类 MCP 工具，再提供 gateway 配置：
# node build/src/cli.js serve --task demo --gatewayConfig ./gateway.json
```

`gateway.json` 形如 `{ "command": "...", "args": [...], "env": {...} }`。

## CLI 速查

CLI 脚本名为 `harness`，编译后入口为 `build/src/cli.js`。

| 命令                                              | 作用                                                       |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `init`                                            | 初始化任务工作区（task / goal / profile / chain / oracle） |
| `hypothesis add`                                  | 提交可证伪假设（claim + falsifier）                        |
| `experiment plan \| execute \| complete`          | 规划、执行、结算单变量实验                                 |
| `approve --kind control\|write\|override\|budget` | 记录人工批准                                               |
| `oracle save --file <json> [--approve]`           | 保存 oracle 配置并可选批准正控制                           |
| `gate status \| claim \| attest`                  | 查看 / 申请 / 补证阶段门                                   |
| `stop override --reason ...`                      | 人工覆盖止损                                               |
| `profile set --profile full\|light`               | 切换 profile（人类决策，记入 ledger）                      |
| `status`                                          | 输出 ledger 投影                                           |
| `ledger verify`                                   | 校验 append-only 哈希链                                    |
| `submit --oracle <id> --live --authorize <ref>`   | 将最新受管 run 提交给 oracle（显式授权才允许）             |
| `task-report [--out ...]`                         | 由 ledger 渲染 Markdown 报告                               |
| `serve`                                           | 以 stdio 启动 MCP server                                   |

## Agent 侧 MCP 工具

| 工具                            | 作用                                      |
| ------------------------------- | ----------------------------------------- |
| `get_brief()`                   | 获取投影上下文、门状态与剩余约束          |
| `get_view(name)`                | 查询账本投影                              |
| `propose_hypothesis(...)`       | 提出假设（仅提案）                        |
| `propose_experiment(...)`       | 校验实验计划（不执行）                    |
| `execute_experiment(id)`        | 由 harness 执行 run 矩阵                  |
| `submit(run_id, oracle_id)`     | 由 harness 提交 oracle                    |
| `record_observation(...)`       | 记录 L0 证据                              |
| `claim_gate(stage, evidence[])` | 申请过门，harness 判定                    |
| `ask_human(kind, payload)`      | 正控制批准 / 写授权 / override / 语义裁决 |

只有 `execute_experiment` 与 `submit` 能产生 L1 / L2 证据。

## Oracle 与证据等级

| oracle kind       | 适用场景             | 能否作为最终结论 |
| ----------------- | -------------------- | ---------------- |
| `server_accept`   | 最终验收             | ✅（需已校准）   |
| `output_equality` | 纯离线复现的中间验证 | ❌               |
| `differential`    | 补环境 / 差分调试    | ❌               |

| 级别 | 来源                                         | 最终结论 |
| ---- | -------------------------------------------- | -------- |
| L0   | 原始观测 / trace / 截图 / 未校准 oracle 返回 | 否       |
| L1   | `output_equality`、`differential`            | 否       |
| L2   | 已校准 `server_accept`                       | 是       |

正控制由人类定义并批准；没有人类批准的正控制时，任务最高只能到 L1，报告标记 `unverified`。

## Profile：full 与 light

- `full`（默认）：高不确定性、多轮任务，要求假设/实验、divergence 与全量 ledger。
- `light`：短任务、单参数场景，保留 oracle 与关键事件，降低流程成本。
- 选择与切换由**人类**决定并写入 `human.decision`；light 不放宽 L2 要求。

## 存储布局

```text
.harness/tasks/<task>/
  task.json
  ledger.jsonl            # append-only，带哈希链
  oracle/
  runs/<run_id>/          # record.json / trace.jsonl / output / stdout / stderr
  artifacts/
  snapshots/<iteration>/
```

## v0 范围

**纳入**：oracle 定义与人类校准、L0–L2 证据准入、full/light profile、execute/submit run、ledger 与投影、divergence v1、MCP server + CLI 骨架、单任务单链路。

**暂不纳入**：agent 沙箱与 egress 代理、自研 LLM 循环、多链路并发、完整 gate 引擎、WASM/网络深度适配。

## 开发

```bash
npm run build        # tsc → build/
npm run typecheck    # tsc --noEmit
npm test             # build + node --test
npm run format       # prettier --write .
npm run check-format # prettier --check .
```

协议细节（oracle 契约、run 信封、divergence 语义、ledger 不变量、止损规则等）以 [SPEC.md](./SPEC.md) 为准。
