# 项目管理

本文档说明本项目如何被开发、协作、发布。目前只有一名维护者，但规则按"开源后能跑"的标准来写。

## 1. 项目描述

**English Oral Teacher Agent** —— 一个本地运行的 AI 英语口语陪练智能体。

- **目标用户**：**可配置**（默认示例：13-14 岁中国中学生，详见 `docs/REQUIREMENTS.md` §2.1）
- **核心能力**：英语对话、阶段化课程、跨会话记忆、语音 I/O
- **运行方式**：PC 本地，独立 AI 界面
- **许可协议**：MIT
- **未来仓库**：GitHub（用户名 `zhiyicom`）

## 2. 角色

| 角色 | 人员 | 职责 |
|---|---|---|
| 维护者 / 开发者 | zhiyicom | 设计、编码、测试、发布、文档 |
| 终端用户 | 中学生本人 | 日常使用、练习 |
| 反馈者 | 家长 / 学生 | 报告问题、提需求 |

项目早期无协作者，全部工作由维护者承担。

## 3. 开发工作流

### 3.1 分支策略

采用 **trunk-based**（适合单人 / 小团队）：

- `main` —— 长期存活，**永远可运行**
- 短命特性分支 —— `feat/<scope>-<short-desc>` / `fix/<scope>-<short-desc>`
- 单人项目不需要 `develop` / `release` 分支

合并流程：
1. 从 `main` 切特性分支
2. 在分支上完成 + 提交
3. 开 PR 到 `main`，自审
4. CI 通过后 squash merge

### 3.2 Commit 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <description>
```

常用 type：

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 仅改文档 |
| `refactor` | 重构（既不是 feat 也不是 fix） |
| `test` | 加 / 改测试 |
| `chore` | 杂事（依赖、配置） |
| `style` | 纯格式调整 |

### 3.3 版本号

[SemVer](https://semver.org/lang/zh-CN/)：`vMAJOR.MINOR.PATCH`

- `0.x.x` —— 早期不稳定阶段
- `1.0.0` —— 核心功能可用、文档齐、可给非作者使用
- 主版本号变更 = 破坏性 API / 数据结构变更

每次发版：打 tag + 更新 `CHANGELOG.md`（后期用 release-please 自动生成）。

## 4. 质量门禁

以下检查对每个 PR 必跑（CI 待配置）：

| 检查 | 工具 | 失败时 |
|---|---|---|
| 类型检查 | `tsc --noEmit` | 阻塞 merge |
| Lint + Format | `biome check .` | 阻塞 merge |
| 单元测试 | `vitest run` | 阻塞 merge |
| 构建 | `tsc` | 阻塞 merge |

## 5. Issue 与 PR

- **标签**：`bug` / `feat` / `chore` / `docs` / `question` / `wontfix`
- **PR**：自审 + CI 通过即合；不要求 reviewer
- **重要决策**（架构选型、第三方依赖、破坏性变更）必须写 ADR 到 `docs/adr/NNNN-<short-title>.md`

## 6. 路线图

| 阶段 | 状态 | 内容 |
|---|---|---|
| 0.1 | ✅ 已完成 | 工程脚手架（目录、git、构建工具、文档） |
| 0.2 | ⏳ 下一阶段 | LLM 客户端、提示词加载、状态机原型 |
| 0.3 | ⏳ | 记忆系统（SQLite + 向量索引） |
| 0.4 | ⏳ | 语音 I/O |
| 0.5 | ⏳ | UI（形态待定） |
| 0.6 | ⏳ | 会话归档迁移兼容 |
| 1.0 | ⏳ | 可发布版本、文档完善、首次 GitHub 发布 |

## 7. 变更记录

本文件本身也会随项目演进。修改时记录在文末即可，不另开 ADR。
