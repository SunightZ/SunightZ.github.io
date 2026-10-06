# Sunight的Blog

> 冰冷似雨 · take what you love and see it through.

Sunight（夙夜）的个人技术博客，聚焦 **Android 系统开发 / Shizuku 与 adb 权限 / 内核与 GKI 编译 /
触摸注入 / C 与 C++ / 底层逆向**。

站点由 [Astro](https://astro.build) 在构建期生成纯静态 HTML，托管于 GitHub Pages。
没有后端、没有数据库、没有前端框架运行时。

线上地址：<https://sunightz.github.io>

---

## 功能一览

| 功能 | 说明 |
| --- | --- |
| Markdown 写作 | 内容放在 `src/content/blog/`，frontmatter 由 Zod 做构建期校验 |
| 语法高亮 | Shiki 双主题，切换明暗模式时高亮同步切换 |
| 文章目录 | 右侧 sticky 目录，滚动自动高亮当前章节 |
| 全文搜索 | 构建期生成 `/search.json`，运行时纯前端过滤，`Ctrl/Cmd + K` 或 `/` 唤起 |
| 标签系统 | 标签云、标签详情页、文章标签跳转 |
| 归档 | 按年份分组 |
| 明暗主题 | 跟随系统偏好，可手动切换并记住选择（无闪烁） |
| RSS | `/rss.xml`，构建期生成 |
| Sitemap / robots | `/sitemap-index.xml`、`/robots.txt` |
| 阅读体验 | 阅读时长估算、上一篇/下一篇、阅读进度条、回到顶部 |
| 响应式 | 移动端折叠导航、代码块通栏滚动 |
| SEO | canonical、Open Graph、Twitter Card、文章发布时间与标签 |

除搜索、主题切换、阅读进度三段小组件脚本外，页面不加载任何 JavaScript。

## 目录结构

```text
.
├── astro.config.mjs           # 站点配置（site、sitemap、Shiki 双主题）
├── pnpm-workspace.yaml        # pnpm 11+ 设置（allowBuilds 等）
├── tsconfig.json
├── public/
│   └── favicon.svg
├── src/
│   ├── consts.ts              # 站点标题、导航、社交链接、技能标签
│   ├── content.config.ts      # 内容集合 schema（frontmatter 校验）
│   ├── utils.ts               # 日期、阅读时长、归档、标签、上一篇/下一篇
│   ├── styles/global.css      # 全站样式（含明暗主题变量）
│   ├── components/
│   │   ├── Icon.astro             # 内联 SVG 图标集
│   │   ├── Header.astro           # 顶部导航 + 主题切换 + 移动端菜单
│   │   ├── Footer.astro
│   │   ├── PostCard.astro         # 文章卡片
│   │   ├── TableOfContents.astro  # 目录 + 滚动高亮
│   │   ├── Search.astro           # 搜索面板
│   │   └── BackToTop.astro        # 进度条 + 回到顶部
│   ├── layouts/
│   │   └── BaseLayout.astro       # HTML 骨架、SEO meta、主题初始化
│   ├── pages/
│   │   ├── index.astro            # 首页
│   │   ├── about.astro            # 关于
│   │   ├── archive.astro          # 归档
│   │   ├── 404.astro
│   │   ├── posts/[...slug].astro  # 文章详情
│   │   ├── tags/index.astro       # 标签云
│   │   ├── tags/[tag].astro       # 标签详情
│   │   ├── rss.xml.ts             # RSS
│   │   ├── search.json.ts         # 搜索索引
│   │   └── robots.txt.ts
│   └── content/blog/*.md      # 文章本体
└── .github/workflows/deploy.yml
```

## 本地开发

环境要求：Node.js ≥ 20、pnpm ≥ 10（推荐 11）。

```bash
pnpm install       # 安装依赖
pnpm dev           # 本地开发，默认 http://localhost:4321
pnpm build         # 构建到 dist/
pnpm preview       # 预览构建产物
```

> **关于 pnpm 11**
> 从 pnpm 11 起，`.npmrc` 只读取 registry 与鉴权配置，
> 其余设置（`allowBuilds`、`nodeLinker` 等）必须写在 `pnpm-workspace.yaml`。
> 本项目已配置好 `allowBuilds`，否则安装会以 `ERR_PNPM_IGNORED_BUILDS` 退出。

## 写一篇新文章

在 `src/content/blog/` 下新建 `.md` 文件（文件名即 URL 的一部分）：

```markdown
---
title: '文章标题'
description: '一句话摘要，会用于列表、SEO 描述与 RSS'
pubDate: 2026-01-01
tags: ['Android', 'Kernel']
category: '内核'
pin: false
draft: false
---

正文从这里开始。
```

Frontmatter 字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | ✅ | 文章标题 |
| `description` | string | ✅ | 摘要，用于列表 / SEO / RSS |
| `pubDate` | date | ✅ | 发布日期（`YYYY-MM-DD`） |
| `updatedDate` | date | | 更新日期，填了会在文章头显示 |
| `tags` | string[] | | 标签，会生成对应的标签页 |
| `category` | string | | 分类，显示在卡片与文章头 |
| `pin` | boolean | | 置顶到首页「置顶」区块 |
| `draft` | boolean | | 草稿：不出现在列表、RSS、搜索与 sitemap 中 |

文件路径会决定 URL：`src/content/blog/my-post.md` → `/posts/my-post/`。

### 正文里的可用写法

- 标题会自动生成锚点 id，并被目录收录（只取 h2 / h3）；
- 代码块按语言高亮，右上角显示语言名；
- 表格、引用、行内代码、图片开箱可用；
- 需要强调块时可以直接写 HTML：

```html
<div class="callout">
<span class="callout__title">注意</span>
这里是正文。
</div>
```

## 部署

推送到 `main` 后由 GitHub Actions 自动完成构建与发布，见 `.github/workflows/deploy.yml`。

首次使用需要在仓库里开启一次：

1. 打开 **Settings → Pages**；
2. **Source** 选择 **GitHub Actions**（不要选 `Deploy from a branch`）；
3. 回到 **Actions** 页面确认 `Deploy to GitHub Pages` 执行成功。

之后每次 `git push` 都会自动上线，无需手动构建。

### 切换到自定义域名

1. 修改 `astro.config.mjs` 里的 `site` 为你的域名，例如 `https://www.sunight.cn`；
2. 在 `public/` 下新建 `CNAME` 文件，内容只有一行域名：

   ```text
   www.sunight.cn
   ```

3. 在域名服务商处添加 DNS 记录（CNAME 指向 `sunightz.github.io`，或 A 记录指向 GitHub Pages 的 IP）；
4. 回到 **Settings → Pages** 勾选 **Enforce HTTPS**。

> 注意：`site` 会影响 canonical、RSS 与 sitemap 里的绝对链接，改域名时务必同步修改。

## 自定义

大部分站点身份信息集中在 `src/consts.ts`：

```ts
export const SITE = {
  title: 'Sunight的Blog',
  tagline: '冰冷似雨 · take what you love and see it through.',
  description: '……',
  author: 'Sunight',
  nickname: '夙夜',
  postsPerPage: 8,
};

export const NAV = [ /* 顶部导航 */ ];
export const SOCIALS = [ /* 页脚社交链接 */ ];
export const SKILLS = [ /* 首页技能标签 */ ];
```

配色与排版集中在 `src/styles/global.css` 顶部的 CSS 变量里（`:root` 与 `html.dark` 两组）。

## 常见问题

**构建报 `ERR_PNPM_IGNORED_BUILDS`**
pnpm 11 默认不执行依赖的安装脚本。确认 `pnpm-workspace.yaml` 里有：

```yaml
allowBuilds:
  esbuild: true
```

**页面上的中文标题字体不理想**
`global.css` 里 `--font-sans` 已经按 `PingFang SC → Microsoft YaHei → Noto Sans SC` 排列，
如需固定字体可以自行引入 webfont。

**搜索搜不到新文章**
`/search.json` 是构建期生成的，开发模式下刷新页面即可；线上需要重新构建。

**想关掉某个页面**
删除 `src/pages/` 下对应的文件即可，导航项记得同步移除 `src/consts.ts` 里的对应条目。
