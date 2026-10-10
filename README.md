# dsh-client-ui-model-favorites

给 DeepSeek Harness Web GUI 的**模型选择列表**加「收藏 / 置顶」两层能力：

- **收藏**：在模型行上右键 → 收藏，该模型会出现在列表最前面新增的**「收藏」分组**里，行内以 `名称 │ ★`（金色五角星 + 分割线）标注，括号里注明来自哪个供应商。
- **置顶**：右键 → 置顶，该模型升到自己所属供应商分组的最前面。

## 功能

| 能力 | 说明 |
| --- | --- |
| 行内右键菜单 | 在模型行上点右键弹出菜单：`收藏 / 取消收藏`、`置顶 / 取消置顶`，命中当前行对应的模型 |
| 「收藏」分组 | 收藏的模型集中到一个名为**收藏**的分组，插在列表最前面；每行显示为 `模型名（来自 供应商）` |
| 黄色五角星 | 收藏行在同一行末尾追加**分割线 + 金色五角星**（`#f5b301`），类似 markdown 表格的 `名称 │ ★` |
| 分组内置顶 | 置顶只在自己所属供应商分组内生效，不影响其它分组，也不改变 `provider/model` 标识 |
| 命令入口 | `/model-favorites` 管理收藏、`/model-pins` 管理置顶（都带「清空全部」行），键盘用户不依赖右键 |
| 工具行按钮 | 输入框工具行的 `收藏` 按钮（有收藏时 `收藏 N`）直接打开收藏管理弹窗 |
| 持久化 | 两个列表写入 `localStorage` 的同一个键，重启后仍在；同源多窗口自动同步 |
| 可重复激活 | 客户端 HMR 每次保存都会重新求值 bundle；插件用全局注册 symbol 记录装饰状态，重激活时**接管**旧包装而不是再叠一层 |
| 降级安全 | DOM 增强层（右键、星标、分组视觉置顶）全部按特性检测；一旦官方菜单结构变化即自动退化为纯数据层，收藏分组与置顶仍然生效 |

## 工作原理

官方 `dsh-client-ui-model-selection` 插件的每个会话目录（`ModelDirectory`）把模型目录放在一个快照 store 里，输入框模型菜单与 `/model` 弹窗都只读这个快照。本插件分两层介入：

**数据层（必需，零 UI 分叉）**

1. 注入 `modelDirectories`，包装 `directoryFor(sessionId)`，为目录换上派生的 store 门面：
   - `getSnapshot()` 返回装饰后的快照——置顶模型在各自分组内置顶；收藏模型合成一个 `收藏` 分组插到最前；行 `model.id` 用 `<provider>/<model>` 复合键，行名带 `（来自 供应商）`；
   - `subscribe/update/set` 转发真实 store，任一列表或真实快照变化都通知订阅者；
   - `dispose()` 一并退订。
2. 同时包装 `directory.select(selection)`：从 `收藏` 分组选中一行时，把合成分组的 provider 与复合 model id **还原**成真实的 `provider/model`，因此合成分组里的行依然能正确切换模型（输入框菜单与 `/model` 弹窗都走这个方法）。

**DOM 层（增强，可降级）**

3. 一个 DOM 桥监听模型菜单（`role="menu"`、`id$="-models"`）：把每个 `role="menuitemradio"` 行按「分组标题 + 行标题」映射回 `<provider>/<model>`（按名字而非位置匹配，所以官方搜索过滤后依然准确），给收藏行注入分割线与星星，并给 `收藏` 分组加 `order:-1`（配合容器 `flex-direction:column`）把它**视觉**提到最前——用 CSS 顺序而非搬 DOM，React 的协调与菜单自身的行索引完全不受影响。
4. 在该桥上捕获 `contextmenu`：命中已映射的行就阻止默认菜单，在 `shell.overlay`（root 作用域的浮层席位）里通过 `react-dom` 的 `createPortal` 把菜单渲染到 `document.body` 的光标位置，与官方 ModelSelect 自己弹菜单的方式一致。

因此模型 id、provider id、`select()`、推理等级等语义完全不变；插件被禁用时官方 UI 立即恢复原状。

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

1. 打开输入框的模型菜单（或 `/model`），在任意模型行上**点右键**：
   - `收藏`：加入最前面的「收藏」分组，行尾出现 `│ ★`；
   - `置顶`：升到自己供应商分组的最前面。
   两个动作都是开关，再次右键同一行即为取消。
2. 不习惯右键时：
   - 输入 `/model-favorites` → 选中一行切换**收藏**（列表里 `★` / `置顶` / `当前使用` 都会标注）；
   - 输入 `/model-pins` → 选中一行切换**置顶**；
   - 或点输入框工具行的 `收藏` 按钮。
3. `/model` 弹窗同样会显示「收藏」分组与置顶顺序，选中其中的行会正确切到对应模型。

数据存放于 `localStorage` 键 `dsh-client-ui-model-favorites`：

```json
{ "ordered": ["deepseek-official/deepseek-chat"], "pinned": ["deepseek-account/deepseek-reasoner"] }
```

`ordered` 是收藏（数组顺序即「收藏」分组内的顺序），`pinned` 是置顶。旧版本只写 `ordered` 的数据会被原样迁移（置顶为空）。删除该键即可重置。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-client-ui-model-favorites
```

并从 profile 的 `dsh.profile.bundles` 中移除同名条目（`dsh plugin remove` 会在下次安装操作时自动对账清理）。

## 兼容性

- **数据层**只依赖 `@deepseek-ai/dsh-client-ui-model-selection` 的公开数据面（`modelDirectories` 服务、目录快照结构、`directory.select`）。上游若调整快照结构，装饰会退化为空操作并打印 `[model-favorites] failed to wrap modelDirectories.directoryFor` 之类的诊断，官方 UI 不受影响。
- **DOM 层**依赖官方菜单的 `role`/`id` 约定。若官方改版导致匹配失败，只会少掉「右键菜单、行内星标、分组视觉置顶」；「收藏」分组与置顶排序仍由数据层保证，控制台会打印 `[model-favorites] DOM bridge unavailable — …`。
- 视觉置顶用 CSS `order` 实现，不改 DOM 顺序；因此键盘上下键仍按官方数据顺序走位（收藏分组与原分组是同一批模型，视觉与走位可能不完全一致）。
- **旧内核兼容**：所有可选集成面（图标原语、React hooks、`commandUi.invoke`、locale 服务、槽位、`react-dom`）均按特性检测独立降级；内核没有快照 store 时，两个列表退回内置 localStorage 实现。唯一硬性依赖是提供快照形态目录 store 的 `modelDirectories` 服务。引擎要求放宽至 `dsh >= 0.1.0`。
- 节点侧（`lib/index.js`）为空实现，只为让插件出现在宿主 roster 中。

## 验证

仓库自带一个独立测试脚本，用假的 `window.__ModuleLoader__`、假 store、假 ctx，**以及一个微型 DOM**驱动真实 `lib/client.js`，覆盖 67 项断言：

- 数据层：收藏分组插入与命名、来源标注、复合 model id、置顶在分组内上升、各分组 id/model id 不变、真实 store 不被改写、订阅通知、`dispose()` 退订、无列表时保持原始快照身份；
- 选择重映射：合成分组的行选回真实 `provider/model`，普通行原样透传；
- 命令与入口：两个命令注册、收藏/置顶弹窗的行状态与清空行、工具行按钮注册与调用链；
- DOM 桥：收藏行注入分割线与星标而普通行不注入、`收藏` 分组被视觉提到最前、右键命中正确模型并能读出菜单动作、动作真的切换状态；
- 重激活幂等：同一 resolver 上二次求值只保留一层装饰（这正是线上出现「四颗星」的原因）；
- 旧内核降级矩阵：缺图标原语 / 缺弹窗调用路径 / 缺 `modelDirectories` / `register` 拒绝 / React 17 / 缺 locale —— 六种场景均不炸插件加载。

```bash
node test/client.harness.mjs ./lib/client.js
```

## 目录结构

```
package.json               插件清单（dsh.bundle.patch / dsh.client.inject）
cordis.patch.yml           bundle patch：把插件行插入 web profile roster
lib/index.js               节点半：空 apply
lib/client.js              浏览器半：两个列表 + 目录装饰 + 选择重映射 + DOM 桥 + 右键菜单 + 两个命令
test/client.harness.mjs    逻辑自测脚本（含微型 DOM）
```
