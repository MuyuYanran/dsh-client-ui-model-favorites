# dsh-client-ui-model-favorites

给 DeepSeek Harness Web GUI 的**模型选择**加一个「收藏 / 置顶」能力：收藏过的模型会排在各自 provider 分组的最前面（含收藏的分组整体上浮），并带 `★` 标记；通过 `/model-favorites` 命令随时切换收藏。

## 功能

| 能力 | 说明 |
| --- | --- |
| 收藏置顶 | 被收藏的模型移到所属 provider 分组的最前面；含有收藏的分组排在其它同类分组之前 |
| `★` 标记 | 收藏模型在**输入框模型菜单**、`/model` 弹窗、`/model-favorites` 列表里都显示为 `名称 ★` |
| 工具行入口 | 输入框工具行有一个图钉按钮（带收藏数角标），点击直接打开收藏管理弹窗，无需记命令 |
| 一处开关 | `/model-favorites` 命令或图钉按钮列出全部模型，选中一行即切换该模型的收藏状态，另有「清空全部收藏」 |
| 持久化 | 收藏列表写入 `localStorage`，重启应用后仍然有效；同一浏览器的多个窗口之间自动同步 |
| 零 UI 分叉 | 不替换官方 `ModelSelect` 组件，只装饰数据，官方选择/推理等级/搜索/键盘导航逻辑全部保留 |

## 工作原理

官方 `dsh-client-ui-model-selection` 插件的每个会话目录（`ModelDirectory`）把模型目录放在一个快照 store 里，输入框模型菜单（slot `conversation.input.model`）与 `/model` 命令弹窗都只读这个快照。

本插件：

1. 注入 `modelDirectories` 服务，把 `directoryFor(sessionId)` 包一层，为返回的目录换上一个**派生 store**：
   - `getSnapshot()` 返回装饰后的快照（收藏模型前置 + `★` 名称）；
   - `subscribe/update/set` 转发给真实 store，收藏变化或真实快照变化时通知订阅者；
   - `dispose()` 一并退订，随会话作用域回收。
2. 注册 `/model-favorites` 命令（`commandUi` 的 `popupSelect`）。
3. 在输入框工具行的 `conversation.input.left` 附加槽位（additive list seat）注册一个图钉按钮，点击后通过 `commandUi.invoke` 打开同一个弹窗——与手输 `/model-favorites` 回车走完全相同的路径。

因此模型 id、provider id、`select()`、推理等级等语义完全不变；模型标识统一使用官方的 `<provider>/<model>` 行 id，收藏列表与选择逻辑天然对齐。插件被禁用时官方 UI 立即恢复原状。

## 安装

在插件项目目录中执行（`desktop` 为桌面端 profile 名）：

```bash
# 方式一：本地 clone 后以相对路径安装
dsh plugin --profile desktop add link:./dsh-client-ui-model-favorites

# 方式二：从 GitHub 安装
dsh plugin --profile desktop add github:MuyuYanran/dsh-client-ui-model-favorites
```

`dsh plugin add` 会转发给 profile 目录下的 pnpm 安装依赖，并在安装后读取本包的 `dsh.bundle.patch` 自动把本插件登记进 `dsh.profile.bundles`。

安装完成后**重启 DeepSeek Harness 桌面端**（profile 的插件清单在启动时读取）。

## 使用

1. 打开收藏管理，两种入口等价：
   - 点击输入框工具行的**图钉按钮**（有收藏时带数字角标）；
   - 在输入框输入 `/model-favorites` 回车。
2. 每行显示 `名称 ★`（已收藏）或 `名称`（未收藏）；选中某一行即可切换其收藏状态，重新打开列表可见 `★` 变化。
3. 再打开模型菜单（输入框模型按钮）或 `/model`，收藏模型已置顶并带 `★`。
4. 列表底部的「清空全部收藏」可一次清空。

收藏数据存放于 `localStorage` 键 `dsh-client-ui-model-favorites`，形如：

```json
{ "ordered": ["deepseek-official/deepseek-chat", "deepseek-account/deepseek-reasoner"] }
```

数组顺序即为置顶顺序（先收藏的排更前）。删除该键即可重置。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-client-ui-model-favorites
```

并从 profile 的 `dsh.profile.bundles` 中移除同名条目（`dsh plugin remove` 会在下次安装操作时自动对账清理）。

## 兼容性

- 面向 `@deepseek-ai/dsh-client-ui-model-selection` 的公开数据面（`modelDirectories` 服务与目录快照结构）实现，不依赖其内部组件。
- 若上游调整了目录快照结构（`groups[].models[]`），置顶与 `★` 装饰会退化为空操作，官方 UI 不受影响；控制台会打印 `[model-favorites] failed to wrap modelDirectories.directoryFor` 之类的诊断信息。
- **旧内核兼容**：所有可选集成面（图标原语、React hooks、弹窗调用路径 `commandUi.invoke`、locale 服务、槽位入口）均按特性检测独立降级；内核没有快照 store（或拒绝持久化选项）时，收藏列表退回内置的 localStorage 实现。唯一硬性依赖是提供快照形态目录 store 的 `modelDirectories` 服务。引擎要求放宽至 `dsh >= 0.1.0`。
- 节点侧（`lib/index.js`）为空实现，只为让插件出现在宿主 roster 中。

## 验证

仓库自带一个独立测试脚本，用假的 `window.__ModuleLoader__`、假 store 与假 ctx 驱动真实 `lib/client.js`，覆盖：置顶顺序、`★` 标记、分组上浮、真实 store 不被改写、订阅通知、取消收藏、清空收藏、`dispose()` 退订、未收藏时返回原始快照身份（避免无谓重渲染）、工具行触发按钮的注册与调用链，以及旧内核降级矩阵（缺图标原语 / 缺弹窗调用路径 / 缺 `modelDirectories` / `register` 拒绝 / React 17 / 缺 locale——六种场景均不炸插件加载）。

```bash
node test/client.harness.mjs ./lib/client.js
```

## 目录结构

```
package.json               插件清单（dsh.bundle.patch / dsh.client.inject）
cordis.patch.yml           bundle patch：把插件行插入 web profile roster
lib/index.js               节点半：空 apply
lib/client.js              浏览器半：收藏存储 + 目录装饰 + /model-favorites 命令
test/client.harness.mjs    逻辑自测脚本
```

