# Paper Reader

本地论文管理 + 阅读器，面向 AI 论文阅读。数据保存在 `data/`（SQLite + PDF），只监听 127.0.0.1；可选用 Google Drive 跨设备同步。

## 启动

```bash
npm install
npm run dev          # 开发模式 → http://127.0.0.1:5178
# 或
npm run build && npm start
```

Windows 下也可以双击 `start.cmd`。需要 Node.js ≥ 22.5（用到内置 `node:sqlite`）。

## 安装与更新

从 [Releases](https://github.com/LiaojunChen/paper-reader/releases) 下载：
- `PaperReader-Setup-<版本>.exe`：Windows 安装版（可选安装位置、建桌面快捷方式），**会自动更新**
- `PaperReader-<版本>-portable.exe`：Windows 免安装单文件，不自动更新，需要手动换新版本
- `PaperReader-<版本>-arm64.dmg`：macOS 版（Apple Silicon，M 系列芯片），不自动更新，需要手动换新版本

安装版启动后约 8 秒检查一次更新，之后每 4 小时检查一次；网络出错会在 1/3/10/30 分钟后重试。发现新版本会在后台下载（顶栏显示进度），下载完弹窗问是否重启；选「稍后」就在下次退出时自动安装。也可以在菜单「帮助 → 检查更新」或设置的「更新」一栏手动检查。（仅 Windows 安装版支持；macOS 和免安装版需要自己到发布页下载新版本）

文库数据存在 `%APPDATA%\Paper Reader\library`（Windows）或 `~/Library/Application Support/Paper Reader/library`（macOS），菜单「文件 → 打开数据文件夹」可直达，更新、覆盖安装、卸载都不会动它。

### macOS 安装说明

因为没有 Apple 开发者证书签名，首次打开会被 Gatekeeper 拦截（提示「无法打开，因为无法验证开发者」）。打开方法：在 Finder 里右键（或按住 Control 点击）`Paper Reader.app` → 「打开」，弹窗里再点一次「打开」即可，以后双击正常启动。

### 发布新版本（维护者）

```bash
npm run release -- patch --notes "这次改了什么"   # 0.2.1 → 0.2.2，也可以用 minor / major / 具体版本号
```

脚本会打包，先建成草稿，逐个上传文件（失败自动重试），全部传完才转为正式发布，所以已安装的应用不会拿到半成品。上传中断时重跑同一条命令（不带 patch），会跳过打包继续上传。上传用的是本机 `gh` 的登录，不需要额外配置 token。

## 存储方式

论文走数据库，笔记走 Obsidian 式的文件夹：

```
library/
├── library.db          论文元数据、参考文献、批注（SQLite）
├── files/              PDF 原文件
└── vault/              笔记库：真实的文件夹和 .md，可直接用 Obsidian 打开
    ├── 具身推理/                         ← 文件夹 = 分类
    │   ├── ReAct Synergizing …/          ← 文献文件夹（写第一篇笔记时创建）
    │   │   └── 读后笔记.md
    │   └── 综述整理.md                   ← 独立笔记，与文献文件夹平级
    └── .trash/                           删除的笔记/文件夹
```

- 左侧目录树就是 `vault/` 的结构：展开文件夹看到子文件夹、文献、独立笔记；展开文献只显示它的笔记（批注留在阅读器里，不出现在树上）
- 拖动文献、笔记、文件夹即可移动；在 Obsidian 或资源管理器里改名、移动、编辑，应用会实时同步
- 笔记文件名跟随第一行标题自动更新
- 一篇文献只能放在一个文件夹里，需要交叉归类时用标签
- 设置里可以把笔记库指向一个已有的 Obsidian 库
- 旧版本的分类和笔记会在首次启动时自动迁移进 `vault/`，原表保留为 `_old_*` 备份

## 功能

- 文库：Obsidian 式目录树（见下文「存储方式」）、星标 / 回收站、全文搜索（标题/作者/标签/摘要/批注/笔记）、多标签页阅读、BibTeX 导出
- 网页 / 博客导入：粘贴或拖入网址即可抓取正文，存成干净的阅读视图（保留标题层级、代码块、图片、公式），和论文一样可以高亮、批注、派给 AI、记笔记。原文改了可以点 ⟳ 重新抓取
- 自动索引：PDF 文件名随意，上传后从首页识别标题 / arXiv ID / DOI，再查 arXiv、OpenAlex、Crossref 补全作者、年份、会议、摘要；解析参考文献列表（数字编号和 author-year 两种格式都支持）
- 按标识导入：arXiv ID、DOI、PDF 链接或标题，自动下载开放获取 PDF
- 引用：悬停 `[39]` 弹出卡片（标题/作者/年份/摘要）；`[29–32]`、`[35, 2, 5]` 会展开显示组内每一篇，悬停组里某个编号则只显示那一篇；点击时在侧栏显示详情，阅读位置不动（Ctrl+点击才跳转）；可一键「下载到文库」。图 / 表 / 章节链接在侧栏渲染目标区域的预览
- 批注：8 色高亮，支持自定义颜色含义；侧栏是便签式卡片，可按颜色、AI 状态过滤和搜索；点击卡片定位到原文
- 派给 AI：在批注里写问题，点「🤖 派给 AI」，后台启动一个无头 Claude Code（`claude -p`），工作目录里放着本文全文和参考文献，工具只开放 Read/Grep/Glob/WebSearch/WebFetch。过程实时显示，结果回写到批注里，还能追问。批注里写「帮我下载这篇」，AI 会把论文导入文库
- 划词：翻译 / 解释（任意 OpenAI 兼容接口或 Anthropic API），可固定弹窗、存为批注、插入笔记
- 笔记：类 Obsidian 的实时渲染，平时看到的是排版好的样子，点某一段才显示该段的 Markdown 源码（空行分段，也可切「源码」/「预览」）。支持 KaTeX 公式、代码块、列表。可挂在某篇论文下，也可独立创建；⧉ 在新窗口打开，边看边记；选中文字「→笔记」插入引文（也能发到另一个窗口里打开的笔记）
- 其他：基于全文的 AI 对话（速读卡片 / 方法拆解 / 审稿视角等快捷提问）、PDF 目录、文内查找、夜间模式、记住上次阅读页、Alt+← 返回跳转前位置、界面缩放（Ctrl +/- 或设置里调）

## 快捷键（选中文字后）

`H` 高亮 · `1-8` 指定颜色高亮 · `C` 批注 · `T` 翻译 · `E` 解释 · `A` 派给 AI · `N` 插入笔记 · `Esc` 取消
批注编辑框：`Ctrl+Enter` 保存，`Ctrl+Shift+Enter` 保存并派给 AI

## 设置

**Google Drive 同步**：设置 → 跨端同步 · Google Drive。配置 Google 桌面应用 OAuth 客户端后，在各台设备连接同一账号，即可同步 PDF、文献、批注、笔记、附件和阅读页码，支持离线合并与冲突副本；API Key 和本机路径留在本地。完整的首次配置、同步规则及恢复说明见 [Google Drive 跨端同步](docs/google-drive-sync.md)。

右上角 ⚙：
- LLM：Base URL / API Key / 模型，内置 OpenAI、DeepSeek、通义、Kimi、Anthropic、Ollama 预设
- 文献元数据：OpenAlex Key（可选，免费申请）。不填时与同出口 IP 的人共享每日额度，用满后只能用 Crossref（无摘要）
- 界面缩放
- AI 代理：命令（默认 `claude`；只有 npm 版时填 `claude.cmd`）、模型（如 `sonnet`）、单任务预算上限

## 结构

```
electron/ main.cjs 桌面外壳（内嵌 server，窗口/菜单）
server/  index.js 路由 · db.js SQLite · vault.js 笔记库文件夹/.md · pdftext.js 文本/参考文献抽取
         metadata.js OpenAlex/Crossref/arXiv · webclip.js 网页正文抓取 · agent.js Claude Code 子进程 · llm.js 流式 LLM
client/  App 文库 · FolderTree 目录树 · Library 详情 · Reader 阅读器 · PdfView(pdf.js) / WebView(网页) · Annotations 便签
         refs 引用 · LiveMarkdown 实时渲染 · NoteEditor/NoteWindow 笔记
```
