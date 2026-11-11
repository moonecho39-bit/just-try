# PDF View for Obsidian（阶段一~六：批注 · 链接 · AI 伴读 · 富文本便签 · 移动端）

> 英文版（发布用）见 [README.md](./README.md)。

Obsidian 插件：**不替换原生 PDF 查看器、不修改 PDF 文件、批注以 Markdown 反向链接形式存储**。

一句话架构：**笔记是数据库，PDF 是显示器。** 插件不持有任何侧挂数据 ——
卸载插件后，你的高亮依然是一条能点开的普通链接。

## 目录结构

```
pdf-annotator/
├── manifest.json          插件清单
├── main.js                ← 构建产物（esbuild 生成，不手写）
├── styles.css
├── esbuild.config.mjs
├── tsconfig.json
├── versions.json
├── demo/                  不启动 Obsidian 也能看效果（浏览器直接打开 index.html）
│   ├── index.html
│   ├── entry.ts           把真实组件挂到假 DOM 上
│   └── obsidian-stub.ts   `obsidian` 模块的最小替身
├── test/
│   ├── entry.ts           [A]~[J] 十组冒烟测试
│   ├── run.cjs            jsdom 宿主
│   └── fixtures/sample.pdf
└── src/
    ├── main.ts            插件入口：registerView / 命令 / 捕获阶段拦截链接点击
    ├── view.ts            ItemView：DOM 分层、懒渲染、缩放、选区、回链调度、跳转
    ├── renderer.ts        PDFRenderer：Canvas + TextLayer 双通道；getPageText() 只取文本
    ├── coords.ts          四套坐标系与换算（唯一的“度量衡”）
    ├── dom.ts             SVG/HTML 小工具 + 浮层定位（placeFloating）
    ├── link/              ── 阶段三：存储层 ──
    │   ├── format.ts           ★ 链接语法：parse / build / color，纯函数零依赖
    │   ├── textIndex.ts        ★ 文本索引：字符坐标 ⇄ 屏幕矩形 双向映射
    │   ├── scan.ts             ★ 反向链接扫描（ScanHost 抽象，可脱离 Obsidian 单测）
    │   └── navigate.ts         跨视图跳转（PDF→笔记 / 笔记→PDF）
    ├── annot/
    │   ├── types.ts           批注模型（Annotation 可编辑 / BacklinkMark 只读投影）
    │   ├── palettes.ts        色组（马卡龙/莫兰迪/原生/自定义）
    │   ├── toolState.ts       工具状态机（当前工具 + 色槽 + 笔宽）
    │   ├── annotationStore.ts 内存草稿库（CRUD + 撤销栈 + removeSilently）
    │   ├── geometry.ts        纯几何（框、点到线段、箭头头部、交叠率）
    │   ├── ink.ts             手绘采样 / Chaikin 平滑 / 轮廓带成径
    │   ├── pageLayer.ts       每页一个 SVG 绘制层（批注层 + 回链层 + 指针）
    │   └── emitter.ts         极简订阅器
    ├── ui/
    │   ├── selectionToolbar.ts 选区浮动工具栏（含“高亮并复制链接”）
    │   ├── colorPopover.ts     取色弹层
    │   ├── noteEditor.ts       便签浮层编辑器
    │   ├── contextMenu.ts      批注右键菜单（复制链接 / 复制为 Callout）
    │   ├── backlinkPanel.ts    右侧反向链接面板（分组 / 过滤 / hover 联动）
    │   ├── linkDrag.ts         自有拖放（拖到 Markdown 编辑器插入链接）
    │   └── hint.ts             浮动提示条
    └── types/pdfjs.d.ts   pdfjs-dist legacy 路径的类型补丁
```

## 构建

```bash
npm install --registry=https://registry.npmmirror.com
npm run dev      # watch 模式
npm run build    # 类型检查 + 生产构建
npm test         # jsdom 冒烟测试：[A]~[J] 十组，139 项断言

# 不启动 Obsidian 也能看绘制 / 回链 / 面板效果
npx esbuild demo/entry.ts --bundle --format=iife \
  --alias:obsidian=./demo/obsidian-stub.ts --outfile=demo/demo.js
# 然后用浏览器打开 demo/index.html
```

## 安装到 vault

**方式一：从 Release 下载（推荐）**

到 [最新 Release](https://github.com/moonecho39-bit/just-try/releases/latest) 下载
`manifest.json`、`main.js`、`styles.css` 三个文件，放进
`<你的库>/.obsidian/plugins/pdf-annotator/`，然后在「设置 → 第三方插件」里启用。

**方式二：BRAT（自动跟随更新）**

装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 后，执行
**BRAT → Add beta plugin**，填 `moonecho39-bit/just-try`。

> `main.js` 是刻意 git-ignore 的 —— 由 CI 构建后挂在 Release 上。
> 直接 `git clone` **拿不到可用的插件**，需要自己 `npm run build`。

**开发期**：建议把 vault 里的插件目录软链接到本工程，改完 `npm run dev` 即可热更新。

---

# 一、链接语法（协议层）

**这是整个插件的存储格式。** 高亮不写 JSON、不写 PDF 注释、不写侧挂文件，
只写成 Markdown 里的一条**普通链接**：

```markdown
[[论文.pdf#page=3&selection=8,0,10,45&color=yellow]]
[[论文.pdf#page=7&rect=72,600,300,640&color=red]]
[[论文.pdf#page=2]]                                    ← 光秃秃的跳页链接也认
```

| 参数 | 含义 |
|---|---|
| `page=N` | 页码，**从 1 开始**（Obsidian 原生参数，我们复用） |
| `selection=l1,c1,l2,c2` | 文本选区 = **（起始行, 起始字符, 结束行, 结束字符）** |
| `rect=l,b,r,t` | 矩形区域 = （左, 下, 右, 上），PDF 用户空间，**y 向上**，单位 pt |
| `color=NAME` | 可选。颜色名或裸 hex；缺省 `yellow` |
| `offset=l,t,zoom` | 可选。Obsidian 原生滚动位置，我们不生成但**原样保留** |
| `annotation=ID` | 可选。PDF 原生批注 id（PDF++ 的另一种模式），**只读忽略**、不破坏 |

### ★ selection 不是坐标，是索引

这是最容易踩错的一处。`selection=8,0,10,45` 不是 `x1,y1,x2,y2`，
而是「第 8 行第 0 个字符 → 第 10 行第 45 个字符」。

**为什么必须是索引：** 坐标方案在下列任一情况下都会“高亮跑到别处去”，
而索引方案不会 ——

- 用户在另一台机器 / 另一个 DPI 下打开；
- PDF 被重新裁剪（CropBox 改变）；
- 我们自己调整了行合并的容差；
- 笔记同步到手机（屏幕宽度不同）。

索引只依赖**文本内容本身**：内容不变，位置就不变。代价是必须能拿到文本层，
所以扫描版 PDF（无文本层）只能退化用 `rect=`。

### 行是怎么切出来的

字符索引的前提是“行”的定义必须稳定。`textIndex.ts` 用三条规则，任一命中即换行：

1. 上一块 `hasEOL` 为真 → 换行；
2. 基线差 > `max(2, fontSize * 0.45)` → 换行；
3. x 明显回退（< 上一块末尾 − 0.5em）→ 换行。

**不插入空格。** 中文全角标点之间的空隙不是空格，补进去会让索引和原文错位，
`selectionText()` 抽出来的引用就会多出空格。

### 颜色是公开 API

`LINK_COLORS` 的 9 个名字（yellow / orange / red / pink / purple / blue /
cyan / green / gray）一旦改动，用户已有笔记就会变色。**只能加，不能改。**
自定义色写裸 hex（`&color=FFE066`，不带 `#`）—— 它出现在 `#` 之后的 fragment
里，再写一个 `#` 会把子路径截断。

### Callout 形态（可选包裹）

```markdown
> [!PDF|yellow] [[论文.pdf#page=3&selection=8,0,10,45&color=yellow]]
> > 被引用的原文，逐行缩进
> > 第二行
```

`[!PDF|yellow]` 里的 `|yellow` 是 Callout 的配色，与链接里的 `&color=` 独立
（两者都由同一个色槽决定，所以永远一致）。引用行用 `> > ` 而不是 `> `，
这样原文里的 `<callout>` 之类字符不会污染 Callout 解析。

---

# 二、三个闭环

## 闭环① 写入：拖拽 / 复制

| 入口 | 操作 | 结果 |
|---|---|---|
| 选区工具栏 | 点「高亮并复制链接」 | 高亮 + 链接进剪贴板 |
| 命令面板 | `复制选中文字的 PDF 链接`（`Ctrl/⌘+Shift+C`） | 同上，不落高亮 |
| 命令面板 | `复制选中文字为 PDF Callout` | 链接 + 引用原文 |
| 右键菜单 | 已有高亮 → 「复制链接」/「复制为 Callout」 | 复用该高亮的颜色 |
| **直接拖** | 选区上按住**拖动**，拖到 Markdown 编辑器松手 | 光标处插入链接 |

拖放**没有用 HTML5 DnD**：绘制层默认 `pointer-events: none`，页面上根本没有
可作 `draggable` 源的 DOM。改用自有 `pointerdown/move/up` + `elementFromPoint`
找 `.cm-editor` + CodeMirror 的 `posAtCoords` → `editor.replaceRange()`。
拖动时鼠标变抓手、出现一枚跟随的“链接幽灵”块，`body` 加类禁掉文字选中。

拖拽期间需要 Alt 才起手（避免和“拖选文字”抢），高亮上按住 Alt 光标会变成
`can-drag-link`，这既是提示也是判据。

## 闭环② 渲染：backlink highlights

打开 PDF 时：

```
metadataCache.resolvedLinks  ──O(1) 哈希──▶  哪些笔记链到了本 PDF
        │
        ├─ getFileCache().links  ── 便宜正则 [#&]page= 预过滤
        │
        └─ 只对确认命中的文件读正文（每文件一次）→ 抓到 > > 引用行
                │
                ▼
        BacklinkEntry[]  ── 逐页串行──▶  getPageText() → TextPageIndex
                │                              │
                │                       selectionToRects()
                ▼                              ▼
        BacklinkMark { page, rects, color }  ──▶  pageLayer.setBacklinks()
```

几个刻意的设计：

- **不遍历全库读文件。** `resolvedLinks` 已经把“谁链到了我”算好了，
  没命中的文件连打开都不需要。
- **不渲染位图也能定位。** `renderer.getPageText()` 与渲染解耦，只取文本
  （毫秒级）。所以“第 300 页有回链”也能立刻在面板里点进去，不必先把
  300 页画出来。
- **逐页串行 await。** 一次并行几十个 `getTextContent` 会跟渲染抢主线程，
  用户看到的是滚动卡顿；串行只是“回链晚几十毫秒出现”。
- **重扫有防抖。** 监听 `metadataCache.changed` / `deleted`、`vault.rename`，
  300ms 合并。用 `scanToken` 递增作废过期结果，避免慢扫描覆盖新结果。
- **回链画在批注层之下**、`mix-blend-mode: multiply`、透明度 0.28。
  文字透得出来，且多条叠色自然变深 —— 一眼能看出“这里被引用了三次”。

## 闭环③ 双向跳转

**笔记 → PDF。** 必须是**捕获阶段**拦截：

```ts
this.registerDomEvent(document, "click", (ev) => this.onInternalLinkClick(ev), true);
//                                                                          ↑ capture
```

否则 Obsidian 的原生处理器会先把 PDF 用自带查看器打开，我们的跳转就晚了。
只有 `parsePdfLink()` 返回非 null 才 `preventDefault()` + `stopPropagation()`，
其余内部链接原样放行。`Ctrl/⌘` 点击 → 新标签页打开，与 Obsidian 习惯一致。

PDF 已打开时**不重建视图**，直接 `navigateToLink()` 滚动定位 —— 重建会丢掉
缩放、滚动位置和未落盘的草稿。

**PDF → 笔记。** 两条路：

- 双击回链高亮 → `openNoteAt(path, line, ch)`；
- 右侧面板点条目 → 同上。

`openNoteAt()` 用 `leaf.openFile(file, { eState: { line, ch }, state: { mode: "source" } })`
再 `editor.setCursor` + `scrollIntoView` 二次定位 —— 只靠 `eState` 在
“文件本来就在这个 leaf 里”时不可靠。

`Ctrl/⌘+点击` 回链 = 激活跳转；`Alt+拖动` 回链 = 拖一条现成链接出去。
纯点击回链**不会**选中它 —— 回链是只读投影，不是可编辑批注。

---

# 三、阶段三验收清单

1. 拖选文字 → 工具栏点「高亮并复制链接」→ 粘到笔记里，得到
   `[[xxx.pdf#page=3&selection=…&color=yellow]]`
2. 右键已有高亮 → 「复制为 Callout」→ 粘出来是 `> [!PDF|yellow]` 块
3. 在高亮上按住 `Alt` 拖动 → 光标变抓手、出现幽灵块 → 拖进编辑器松手 → 链接落点正确
4. 回到笔记点那条链接 → **不**打开原生查看器，而是在批注视图里滚到该页该行
5. `Ctrl/⌘+点击` 链接 → 新标签页打开 PDF 并定位
6. 打开一个**被多条笔记引用**的 PDF → 对应位置出现彩色高亮，多色重叠处变深
7. 点顶部「回链」按钮 → 右侧面板列出全部引用，按来源笔记分组、带 `P.3` 角标
8. 面板勾「仅本页」→ 只剩当前页的引用
9. 鼠标划过面板条目 ↔ 页面对应高亮互相描边（双向 hover 联动）
10. **双击**页面上的回链高亮 → 跳回引用它的那条笔记的第 N 行
11. 在笔记里改掉 `&color=blue` 并存盘 → 半秒内 PDF 里的高亮变蓝（无需重开）
12. 删掉那条链接 → 对应高亮自动消失
13. 重命名 PDF 文件 → 回链重新解析，不丢（`vault.rename` 触发重扫）
14. 高亮后把链接粘进笔记 → 重扫完成后内存草稿被静默撤掉，颜色**不**变深，
    且 `Ctrl+Z` 不会“撤销”这次去重

# 四、阶段二验收清单（批注工具）

1. 拖选文字 → 选区旁弹出浮动工具栏（不破坏选区）
2. 点「高亮」→ 文字多行高亮，选区清空；换色组再点 → 颜色立刻不同
3. 点工具栏左侧色点 → 切「马卡龙 / 莫兰迪 / 原生」，或取色器自定
4. 点「矩形」/「箭头」→ 在页面上拖拽绘制
5. 点「铅笔」→ 笔迹平滑、快写变细；「马克笔」→ 粗半透明叠色
6. 点「便签」→ 图钉落在选区末尾 → 点击弹出编辑器 → 关闭后内容保留
7. 右键任一高亮/笔迹 → 「删除批注」
8. `Esc` 退出当前工具；`Ctrl/⌘+Z` 撤销、`Ctrl/⌘+Shift+Z` 重做
9. 缩放到 200% / 50%：批注严丝合缝，线宽等比变化，图钉视觉大小不变
10. 「选择」工具下文字**正常可拖选**（绘制层不吃指针）

---

# 五、机制备忘

## 坐标系

四套：**CSS**（真实 px，y 向下）⇄ **BASE**（pt，scale=1，y 向下）
⇄ **NORM**（0~1）⇄ **PDF 用户空间**（y 向上，pt）。

- 落盘（草稿）只用 **NORM**；链接里的 `selection` 用**索引**、`rect` 用 **PDF 空间**。
- 线宽/笔宽用 **pt**，渲染时乘 scale。
- 绘制层的 `<svg viewBox="0 0 页面宽pt 页面高pt">` 直接把 pt 当用户单位，
  所以缩放时批注**零重算**，浏览器自己缩放整层。便签图钉半径写 `10/scale`，
  补偿这层缩放，保持屏幕视觉大小恒定。
- **rect 的逆变换用 viewport 矩阵的逆**，不是“页高 − y”：

```ts
const inv = invertTransform(viewport.transform);
const quad = rectToPdfQuad(norm, inv, width, height); // 而不是 height - y
```

  CropBox 带偏移（有裁边的 PDF 很常见）时，“页高 − y”会整体偏。

## 双向映射必须同源

`selectionToRects()`（读）与 `rectsToSelection()`（写）共用同一个
`TextPageIndex`。这是“高亮 → 链接 → 再打开 PDF 落回原处”能成立的前提；
两者只要行切分逻辑有一点不一致，就会越用越偏。测试 [H] 在真实 PDF 上
断言了这个往返：起始字符 0、结束字符 15±1，跨行选区、越界行号夹取也都覆盖。

## 只读投影 vs 可编辑批注

```ts
interface Annotation   { id, page, rects: Rect[], … }   // NORM，可编辑，进撤销栈
interface BacklinkMark { key, page, rects: Rect[], … }   // NORM，只读，不回写
```

分成两个类型、两个 `<g>`（`.pdfa-layer-backlinks` 排在 `.pdfa-layer-annots` 之前），
好处是 **`Ctrl+Z` 永远不会“撤销掉”磁盘上的笔记**，扫描结果也不会污染撤销栈。

新旧两套东西会重合：用户高亮完把链接粘进笔记，重扫后同位置既有草稿又有回链，
两层叠着颜色明显变深。`dedupeDraftHighlights()` 用几何交叠率
（交集面积 / 较小矩形面积 > 0.55）判定，然后 `store.removeSilently()`
—— 撤掉但不占撤销栈，因为这不是用户的撤销意图。

## pointer-events 的两态

`.pdfa-draw-layer` 默认 `pointer-events: none`（否则盖住 TextLayer，文字选不中），
铅笔/马克笔/矩形/箭头/便签激活时加 `.is-drawing` 临时改 `auto`。

便签点击、右键删除、回链的双击/hover 都**不走 DOM 命中**，改用几何检测挂在
页面容器上 —— 这样即使整层穿透，图钉和回链依然点得到。

## 事件链

```
pointerdown(页面)    → 记录按下，防止拖选途中反复弹工具栏
mouseup(页面)        → 选区落定 → syncSelection()
selectionchange      → 键盘选择的兜底，防抖 140ms
pointerdown/move/up  → 绘制（指针捕获，甩出页面也收得到）
pointermove(页面)    → 回链 hover 命中 + Alt 拖拽光标
dblclick(页面)       → 双击回链跳转
click(document,true) → 捕获阶段拦截 internal-link
```

用 Pointer Events 而不是 Mouse Events：它是超集，能拿到 `pressure`
（手写板压感），为将来接压感笔宽留了入口。

## 笔迹为什么分三条路

| 场景 | 做法 | 原因 |
|---|---|---|
| 抽稀 | 间距 < 0.9pt 丢弃 | 事件密度随刷新率变化，不抽稀会“越画越糊” |
| 平滑 | Chaikin 一次迭代，首尾不动 | 折线有棱角；首尾动了会与指针轨迹对不上 |
| 马克笔 | 中心线 + 描边 | 等宽，元素最少，最锐 |
| 铅笔 | 变宽**轮廓带**填充 | 速度调制要逐点变宽；分段改 `stroke-width` 会在接缝处跳变 |

实时预览与松手后重建**共用 `renderSamples()`**，避免“松手瞬间笔迹变样”。

## 工具状态

唯一真源在 `ToolState`：当前工具 + 每个**色槽**（highlight/shape/ink/marker/note）
的颜色与色组。顶部工具栏、选区工具栏、色点读数、链接的 `&color=` 全从它读，
改它则全部同步 —— 不会出现“显示黄、画出来红、链接里写 blue”。

语义：从顶部**激活工具** = 粘滞（做完一笔仍保持，Esc 退出）；
从浮动工具栏**点一下** = 一次性（做完回 `select`）。

## 工具栏

顶部是一条**固定在视图顶部的单行工具栏**，不随页面滚动、不被正文挤走；
面板很窄（分屏 / 手机）时整条横向滚动，而不是换行把正文往下压。
从左到右按使用频率分组，组间用 1px 分隔线隔开：

| 组 | 内容 | 说明 |
|---|---|---|
| 文件名 | 当前 PDF 名 | 窄面板下自动隐藏（`< 600px`） |
| 页码 | `‹` `[输入框]` `/ 总页` `›` | 输入数字后**回车**跳转；Esc 放弃输入并还原；越界自动夹紧 |
| 缩放 | `−` `100%` `+` `适应宽度` `适应整页` | 点百分比回到 100%；适应整页取宽/高比例的较小值 |
| 批注工具 | 选择 / 高亮 / 下划线 / 便签 / 矩形 / 箭头 / 铅笔 / 马克笔 + 色点 | 与 `ToolState` 同一真源 |
| 撤销 | 撤销 / 重做 | 快捷键 `Ctrl+Z` / `Ctrl+Shift+Z` |
| 面板与 AI | 反向链接（带数量角标）/ AI 菜单 | 面板窄时 AI 仍留在顶部，不会被选区挡住 |

设计上的两个细节：

1. **页码框绝不在用户打字时被覆盖**。滚动事件每帧都会刷页码，
   所以 `syncPageUi()` 用 `document.activeElement` 判断焦点，正在输入就跳过 ——
   否则想输「87」时第二个字符会被滚动冲掉。
2. **翻页用 `scrollTop` 而不是 `scrollIntoView`**。后者会连带把外层容器一起滚，
   容易把顶部工具栏滚出视野；直接写 `offsetTop` 只动内容区，行为可预测。

## 命令一览

| 命令 ID | 名称 | 快捷键 |
|---|---|---|
| `open-in-annotator-view` | 用批注视图打开当前 PDF | — |
| `copy-selection-link` | 复制选中文字的 PDF 链接 | `Mod+Shift+C` |
| `copy-selection-callout` | 复制选中文字为 PDF Callout | — |
| `toggle-backlinks-panel` | 显示 / 隐藏反向链接面板 | — |
| `debug-selection-coords` | 调试：打印当前选区的归一化坐标 | — |
| `clear-page-annotations` | 清除当前页的草稿批注 | — |
| `clear-all-annotations` | 清除本文档的全部草稿批注 | — |

---

# 六、与 PDF++ 的对齐与偏离

**严格对齐的部分（保证互操作）：**

- 存储形态：Markdown 普通链接，无私有语法；
- `page` / `selection` / `rect` / `color` 四个参数的名字与语义；
- `selection` 是**字符索引**而非坐标；
- Callout 用 `> [!PDF|color]` + `> >` 引用原文；
- `color` 用可读色名，未知色退化裸 hex。

**有意偏离的部分：**

| 项 | PDF++ | 本插件 | 原因 |
|---|---|---|---|
| `selection` 的行切分 | 其内部实现 | 三条启发式规则，**不补空格** | 中文排版补空格会让索引与原文错位 |
| `color` 自定义值 | 支持 | 支持裸 hex，**不带 `#`** | 避免截断 fragment 子路径 |
| `annotation=` 参数 | 原生批注模式 | 解析但**忽略**（只读） | 不改 PDF，避免双向写坏原生批注 |
| 写入入口 | 拖拽为主 | 工具栏 / 命令 / 右键 / 拖拽 四条 | 拖拽在触控板上不好用 |
| 回链面板 | 独立侧栏视图 | 内嵌在 PDF 视图右侧 | 面板只在看 PDF 时有意义，不必占全局位置 |
| 行内 `$$` 数学/图片 | 支持 | 暂不支持 | 阶段四 |

**已知代价：**

- 扫描版 PDF（无文本层）无法用 `selection=`，只能 `rect=` 框选。
  这是索引方案的固有代价，不是 bug。
- 回链扫描依赖 `metadataCache` 已索引完该笔记。大库首次打开可能滞后几秒，
  之后靠 `changed` 事件增量补齐。

# 七、其他已知取舍

- pdf.js worker 仍跑在主线程（fake worker）。好处是零配置、在 `app://` 协议下
  不会撞 Worker MIME 限制；代价是超大 PDF 渲染时会有轻微卡顿。换真 Worker
  的改动点只在 `renderer.ts` 顶部。
- 未配置 CJK `cmap`，纯中文 PDF 可能出现部分字形缺失（不影响文本索引）。
- **草稿批注仍只在内存里**（`annotationStore`）：它们的使命是“变成链接”，
  落盘靠你把它粘进笔记。关掉视图前没粘走的草稿会丢。
- 删除/清空没有二次确认，靠 `Ctrl+Z` 兜底。

---

# 阶段四 · AI 智能伴读

选中文字 → ✨ → **翻译 / 解释 / 总结**。结果在弹窗里流式输出，可一键插入笔记。

## 设置项

| 项 | 说明 |
|---|---|
| Provider | OpenAI 兼容 / Ollama / 自定义。**三者共用一套请求代码** —— Ollama 自带 `/v1/chat/completions`，差异只是默认 Base URL、是否需要 Key、默认模型名 |
| Base URL | 写到 `/v1` 为止（写全 `/chat/completions` 也认；Ollama 裸端口会自动补 `/v1`） |
| API Key | 存在 `data.json`；Ollama 留空 |
| 模型 | Ollama 要带 tag，如 `qwen2.5:7b`。可点「拉取列表」从 `/v1/models` 里选 |
| 温度 / 输出上限 | 翻译总结建议 0.2~0.4；输出上限 0 表示交给服务端 |
| 翻译目标语言 | auto = 中文选段译成英文、其它译成中文 |
| 流式输出 | 见下 |
| 附带原文引用 | 插入时是否带 `> > 原文` |
| 用本插件打开 .pdf | 默认关。开了才抢 Obsidian 原生查看器，用于原生查看器打不开某些文件时兜底 |

## 中文 PDF 为什么需要内嵌 CMap

知网、万方这类中文期刊 PDF 普遍满足两个条件：字体编码是 `GBK-EUC-H` / `UniGB-UCS2-H` 这类
双字节 CMap，**且字体不嵌入**。pdf.js 必须靠外部 CMap 表才能把编码映射成字符：

| 条件 | 文本项 | 汉字 | 结果 |
|---|---|---|---|
| 无 CMap | 238 | 0 | 只剩数字与标点，看起来像乱码 |
| 有 CMap | 429 | 1422 | 正常 |

pdf.js 官方做法是给 `cMapUrl` 让它去 `fetch`，但 Obsidian 跑在 `app://` 协议下没有可用的静态
资源地址，而且社区插件只分发三个文件。所以这里把整张表（168 个 `.bcmap`，原始 1.1 MB）
base64 后编进 `main.js`，由 `EmbeddedCMapReaderFactory` 在 `fetch()` 里直接返回字节。

代价是 `main.js` 从 1.6 MB 涨到 3.2 MB；换来的是离线可用、零外部依赖、不会因为漏拷一个
目录就整片中文消失。改表：`node scripts/gen-cmaps.mjs`（从 `node_modules/pdfjs-dist/cmaps` 重生成）。


「测试连接」会发一个 `max_tokens=1` 的真实请求，把 401 / 404 / 网络错误翻译成人话 ——
比让用户去控制台看 CORS 报错有用得多。

## 请求路径：为什么默认不用流式

- **非流式（默认）走 `requestUrl`**。它是 Obsidian 的主进程转发通道，不受 CORS 限制、移动端也能用。
  代价是不可取消（只能 `Promise.race` 超时"不再等"）。
- **流式走 `fetch` + `ReadableStream`**。`requestUrl` 把响应体缓冲完才返回，拿不到流。
  代价是会被 CORS 拦。

于是设置面板里必须逐条告诉用户：

1. 流式只能走 fetch：Ollama 需设 `OLLAMA_ORIGINS=app://obsidian.md` 后重启服务，否则
   浏览器层直接 `Failed to fetch`；
2. 手机上的 `localhost` 是手机自己，连不到电脑上的 Ollama；Android WebView 还可能拦明文 http；
3. 流式失败时插件**自动降级**为 `requestUrl` 重试一次 —— 结果照常拿到，只是没有打字机效果。

SSE 解析的两个真实坑（都有单测）：**半包**（一个 chunk 把事件劈两半，必须留 `rest` 接着拼）
与 **CRLF**（代理改写行尾后，只按 `\n\n` 切会一条事件都切不出来）。

## 插入结构：引用 + 解读

```markdown
> [!PDF|yellow] [[论文.pdf#page=3&selection=8,0,10,45|论文, p.3]]
> > 被解读的原文
>
> **AI 翻译**
> 结果……
```

`> >` 只给原文（PDF++ 的引用约定），AI 结果用单层 `>`，渲染出来是「Callout 里嵌引用块 + 正文」。

插入目标：有打开的 Markdown 笔记 → 插到光标处（Modal 打开后 `activeLeaf` 是 PDF 视图，
所以插件自己记了「最近编辑过的笔记」）；没有 → 追加到伴生笔记并打开。

---

# 阶段五 · 富文本便签

## 数据结构：Callout + 块引用锚点

```markdown
> [!PDF-note|yellow] [[论文.pdf#page=3&rect=72,600,90,620|论文, p.3]]
> 这里是 **Markdown** 正文
>
> ![[附件/pasted-20261109-003217.png]]

^pdfa-note-a1b2c3
```

三个角色：

| 元素 | 作用 |
|---|---|
| Callout 第一行 | **回链**：PDF 哪一页、哪一块，点它跳回 PDF |
| Callout 正文 | 内容，纯 Markdown，Obsidian 原生渲染 |
| `^pdfa-note-<id>` | **块引用锚点**，PDF 上的图钉指向它 |

于是 PDF 与笔记之间是两条**对称的普通链接**：`[[论文.pdf#page=…&rect=…]]` 与
`[[论文 (pdf-notes).md#^pdfa-note-…]]`。

> 锚点为什么写在 Callout **外面**：Obsidian 只把「空行之后、独占一行」的 `^id` 认作块引用；
> 写在 `>` 里只是普通文本，跳转会失效。代价是源码多一行，收益是点图钉真能跳。

## 为什么不能把正文塞进链接参数

1. 链接会长到几 KB，Markdown 一行横着拉出屏幕，**没法读、没法 diff**；
2. URL 参数不能有换行，多段文本 / 列表 / 图片全退化成 `%0A`；
3. 反向链接面板拿链接文本渲染，会显示成一坨乱码；
4. 违反第一原则：**卸掉插件后笔记要依然好看、依然能读**。

PDF++ 的做法正是「正文留在 Markdown，链接只负责指哪打哪」，这里完全沿用。

## 编辑器

- `<textarea>` 编辑源码 + `MarkdownRenderer.render()` 实时预览，**300ms 防抖**
  （`render` 是异步的，每敲一个字都跑会让输入发涩）；
- 粘贴图片：`getAvailablePathForAttachment()` 生成不重名路径 → `vault.createBinary()` →
  在光标处插 `![[…]]`（用 `execCommand("insertText")` 以保住原生撤销栈）；
- 写入是**行级替换**（`upsertNoteBlock`），不整份重写 —— 伴生笔记是用户也能编辑的普通文件，
  整份重写会把他手加的标题、空行风格全部抹平。

---

# 阶段六 · 移动端与发布

## 指针适配层（`src/ui/pointer.ts`）

Pointer Events 是超集，但触屏有三件事它自己解决不了：

| 问题 | 适配层的做法 |
|---|---|
| 没有右键 | 长按 520ms 不动 → 映射成 contextmenu（只对 touch/pen 生效，鼠标长按不算） |
| 没有 dblclick | 自己数两次 tap（间隔 < 320ms、位移 < 30px） |
| 双指缩放会被画成鬼线 | 检测到第二指立即 cancel 整个手势，直到所有手指抬起 |

再加一层极老 WebView 的 TouchEvent / MouseEvent 兜底。三条路径最终都归一成同一个
`PointerSample`（值类型快照 —— 原生 `TouchEvent` 的 `touches` 是活的，`await` 过就取不到值）。

## 发布

`.github/workflows/release.yml`：push tag → `npm ci` → `npm run build` → `npm test` →
校验 tag 与 `manifest.json` 版本一致 → 把 `main.js` / `manifest.json` / `styles.css`
作为三个**独立附件**上传到 GitHub Release（社区市场与 BRAT 都按文件名直接下载，不能打 zip）。
