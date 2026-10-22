---
description: "面向阅读、组合或调试漂移界面的用户与维护者的会话标题上下文漂移指示器与输入框提示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-context-drift

[English](README.md) | 中文

## 概要

本插件显示一个对话因长上下文而损失了多少回答质量。会话标题中的指示器用按等级着色的进度条显示漂移分数；悬停或点击会打开卡片，列出读数、主要原因、计算起点以及「立即压缩」和「新对话」按钮。漂移严重时，输入框上方的提示会推荐与原因相符的操作。该值来自 `dsh-context-drift` 中的宿主 `contextDrift` 投影。

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

将此客户端行与宿主 `dsh-context-drift` 行一同挂载；web-app 包会同时挂载二者。缺少宿主行时投影不存在，两个界面都不渲染。

### 组合

```yaml
- name: '@deepseek-ai/dsh-context-drift'
- name: '@deepseek-ai/dsh-client-ui-context-drift'
```

### 你会看到什么

| 界面 | 行为 |
|---|---|
| 标题指示器 | 会话标题工具区中的仪表图标、短进度条和分数；清晰时为绿色，漂移时为琥珀色，严重时为红色。空白会话与其他标题元素一起隐藏 |
| 详情卡片 | 短暂悬停或点击后打开；列出实时与有效 token 数、上下文窗口、轮数、失败的工具调用、纠正、重复调用警告、被中断的回复、旧话题与工具输出占比、压缩次数、主要原因及其占比，以及计算起点及其时间 |
| 输入框提示 | 达到严重等级时出现在输入框上方，显示推荐操作的建议和两个按钮，推荐的按钮在前 |

**立即压缩** 通过 Commands Remote 在该会话中执行 `/compact`，因此记录中会像手动输入命令一样显示；命令返回的失败信息会直接显示。**新对话** 打开一个新会话，其草稿包含指向本对话的 `#` 引用，发送草稿时宿主会把本对话总结进新对话。

关闭提示后，它在当前计算起点内保持隐藏。分数降到宿主的重新提醒阈值以下，或压缩移动了计算起点后，提示会再次出现。关闭状态按会话保存在本浏览器的本地存储中；存储被禁用时只在当前页面有效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节说明界面的接线方式；可观察行为已在[使用本包](#use-this-package)中完整描述。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、标题工具区与输入停靠区注册，以及绑定会话的操作 |
| [`src/client/DriftChip.tsx`](src/client/DriftChip.tsx) | 标题指示器、悬停与固定卡片、Escape 与外部点击关闭 |
| [`src/client/DriftCard.tsx`](src/client/DriftCard.tsx) | 卡片内容、等级色调，以及共享的压缩与新对话控件 |
| [`src/client/DriftNudge.tsx`](src/client/DriftNudge.tsx) | 输入框提示及其关闭后的重新提醒逻辑 |
| [`src/client/model.ts`](src/client/model.ts) | 会话引用编码、提示显示规则与 token 格式化 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中文与英文词典 |
| [`src/index.ts`](src/index.ts) | 无行为的 Node 半部，使本包成为普通 Loader 行 |

### 会话引用

新对话草稿使用 `dsh-session-reference` 解析的规范 `dsh-session:` URI：UTF-8 JSON 会话 ID 的无填充 base64url。浏览器编码与宿主编码逐字节一致，标签会转义反斜杠和右方括号。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

以下页面介绍界面所渲染的值以及它们执行的命令。

- [上下文漂移投影](../../session/context-drift/README.zh.md) — 分数、信号、等级与建议。
- [压缩命令](../../compaction/command-compact/README.zh.md) — `/compact` 的作用及其报告的信息。
- [会话引用](../../context/session-reference/README.zh.md) — `#` 引用如何把另一个会话总结进提示词。

-----

<a id="model-experience"></a>
## 模型体验

本插件本身无直接影响。立即压缩执行现有的 `/compact` 命令，新对话起草一个由用户发送的 `#` 会话引用；它们的模型可见效果归 `dsh-command-compact` 和 `dsh-session-reference` 所有。

#### KV Cache 影响

本插件本身无影响；它发起的压缩会按压缩包文档所述的缓存效果改写历史。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>


以下限制说明界面未覆盖的内容。它们是本包当前的约束。

- **代理运行时不会禁用压缩按钮** — 命令会返回忙碌，失败信息直接显示。
- **引用标签是通用文字** — 新对话草稿使用本地化的「上一个对话」作为引用标签，而不是会话标题。
- **关闭状态按浏览器保存** — 在其他浏览器或设备上提示会再次出现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
