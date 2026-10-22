---
description: "面向组合、调优或调试 contextDrift 投影单元的客户端与维护者的长上下文漂移评分。"
kind: "package-reference"
---

# @deepseek-ai/dsh-context-drift

[English](README.md) | 中文

## 概要

本包估算下一次请求因长上下文而损失的回答质量，并建议压缩对话或开启新对话。它提供 `contextDrift` 值：由六个信号计算的 0–100 分、每个信号的占比、原始读数以及计算起点。六个信号是：相对路由有效上下文的长度、人类轮数、仍在上下文中的错误、旧话题占比、工具输出占比和压缩层数。该折叠不调用模型，压缩后重新计算。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当客户端需要显示上下文漂移时，将本插件与会话存储和投影注册表一同挂载。web-app 包为 `dsh-client-ui-context-drift` 中的会话标题漂移指示器挂载了它。

### 组合

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-context-drift'
  config:
    modelProfiles:
      - provider: deepseek-official
        model: deepseek-v4-pro
        effectiveTokens: 120000
```

### 评分

每个信号归一化到 0–1，其中 `smooth` 是 `[0, 1]` 上的三次 S 曲线 `x²(3 − 2x)`：

| 信号 | 公式 |
|---|---|
| 长度 L | `smooth((live − 0.25·E) / (0.75·E))`，`live` 为下一次请求以服务商用量为锚的提示词 token 数，`E` 为有效上下文 |
| 轮数 T | `smooth((turns − 8) / 22)`，统计仍在上下文中的人类消息 |
| 错误 M | `1 − exp(−(toolErrors + 2·corrections + 2·loopWarnings + interrupts) / 8)` |
| 旧话题 S | `staleShare × L`，即来自早期话题的消息 token 占比 |
| 噪声 N | `clamp((toolShare − 0.5) / 0.4) × L` |
| 层数 C | `clamp((compactions − 1) / 2)` |

`score = round(100 × (1 − Π(1 − wᵢ·sᵢ)))`，权重为长度 0.6、轮数 0.25、错误 0.35、旧话题 0.4、噪声 0.2、层数 0.3。每个信号的占比为 `−ln(1 − wᵢ·sᵢ)` 除以总和，因此各占比之和等于总分；占比最大的信号即 `cause`。仅长度一项恰好在 `E` 处达到高等级；其他信号需要相互叠加。

有效上下文 `E` 取路由的 `modelProfiles` 条目，否则取 `min(windowRatio × window, fallbackEffectiveTokens)`，再否则取回退值，且不超过 `windowRatio × window`。默认值为 0.5 和 64,000，因此未配置的 1M token 路由使用 64,000。

### 等级与建议

| 分数 | 等级 |
|---|---|
| 低于 `levels.drifting`（35） | `fresh`，操作 `none` |
| 低于 `levels.high`（60） | `drifting` |
| 不低于 `levels.high` | `high` |

在 `fresh` 之外，当会话已有 `newChatAfterCompactions`（2）次压缩（`actionReason: 'layers'`）、旧话题是主要原因（`stale`），或计算起点是不足 `recentCompactionTurns`（3）个人类轮次之前的压缩（`recent-compaction`）时，操作为 `new-chat`。否则为 `compact`（`cause`）。该值还携带解析后的阈值，包括 `levels.rearm`（50），客户端用它决定何时重新显示已关闭的提示。

### 统计范围

只统计保留在模型可见表面上的节点。人类轮次是来源类型为 `user` 的 `user/message`。纠正是紧跟助手回复、且匹配某个 `correctionPatterns`（不区分大小写的正则表达式，默认含英文与中文）的人类消息。重复调用警告是 `repeat-tool-reminder` 消息，中断是被中断的助手回复。服务商重试和失败尝试不会进入表面，因此不计入。关键词不少于 `topic.minKeywords`（6）个、且其中出现在当前话题中的比例低于 `topic.minOverlap`（15%）的人类消息会开启新话题；工具调用中的路径并入当前话题。

### 失败与恢复

无效配置会使加载失败。若替换事件引用了折叠从未见过的节点，该值会标记为 `degraded: true` 并继续折叠，因为抛出异常的投影单元会使该会话的所有投影停止。卸载插件会移除该键。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节说明该值背后的折叠；可观察行为已在[使用本包](#use-this-package)中完整描述。

### 设计思路

折叠维护一份保留表面的账本：每个表面节点一条记录，包含启发式 token 数（token meter 的 `estimateMessage`）、类型、话题和错误标记。替换事件按表面相同的方式拼接账本，因此压缩会移除被遮蔽的轮次和错误。实时 token 数与 `contextPressure` 一致：最新的服务商用量样本加上此后表面的启发式变化。评分在线路视图中依据解析后的配置完成。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、`inject`、单元注册 |
| [`src/config.ts`](src/config.ts) | 配置模式、默认值与加载时校验 |
| [`src/projection.ts`](src/projection.ts) | 折叠：状态模式、逐事件转换、线路视图 |
| [`src/score.ts`](src/score.ts) | 漂移公式、占比、等级与建议 |
| [`src/text.ts`](src/text.ts) | 关键词提取、话题重叠与纠正匹配 |
| [`src/types.ts`](src/types.ts) | `contextDrift` 线路值及其投影键声明 |

### 状态版本

状态版本由折叠语义常量与折叠配置（`topic`、`correctionPatterns`）的哈希组合而成，任一变化都会使持久化检查点失效，下次打开时重新折叠。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

以下页面介绍提供该值的注册表以及使用它的界面。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md) — 驱动投影单元并提供快照与变更流的注册表。
- [Token meter](../../llm/token-meter/README.zh.md) — 本单元沿用的启发式计价与 `contextPressure` 锚定方式。
- [上下文漂移客户端插件](../../client/ui-context-drift/README.zh.md) — 会话标题指示器与输入框提示。

-----

<a id="model-experience"></a>
## 模型体验

无，本单元将已记录的事件折叠为面向客户端的读模型，不增加任何模型可见内容。

#### KV Cache 影响

无；本包从不组装或发送服务商请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>


以下限制说明评分能看到和不能看到的内容。它们是本包当前的约束。

- **权重是基于研究的默认值，并未在每条路由上实测** — 了解某路由的质量曲线后，请为其设置 `modelProfiles`；根据会话历史学习 `effectiveTokens` 属于延后工作。
- **话题变化基于词汇** — 换了说法、没有共同关键词的同一话题可能被视为新话题，复用词汇的新话题也可能被视为同一话题。
- **纠正基于短语匹配** — 不符合任何已配置模式的纠正不会被统计。
- **消息投影不重新计价** — 图片卸载等内容投影沿用原消息的启发式价格，与 `contextBreakdown` 相同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
