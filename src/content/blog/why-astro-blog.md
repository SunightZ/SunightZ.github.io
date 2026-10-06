---
title: '重新搭这个博客：为什么最后选了 Astro'
description: '把只有一个 Hello World 的仓库改成完整的技术博客：选型对比、内容组织方式、构建期搜索索引，以及「写一个 md 文件然后 push」的发布流程。'
pubDate: 2025-09-01
tags: ['Astro', '博客', '工程化']
category: '工程'
---

这个仓库之前只有一行 `Hello World`。趁着要开始认真记东西，干脆把它重做一遍。

## 一、需求先列清楚

写博客的工具很多，但需求其实很窄：

1. **用 Markdown 写** —— 不想在浏览器里跟富文本编辑器搏斗；
2. **快** —— 首屏要快，不能为了一个标签页加载 300KB 的 JS；
3. **零后端** —— 不要数据库、不要服务器、不要运维；
4. **能搜索** —— 文章多了以后，靠归档翻找是折磨；
5. **能订阅** —— RSS 对我这种读者是刚需；
6. **移动端能看** —— 代码块要能横向滚动，不能撑破布局；
7. **发布要简单** —— 一个 `git push` 结束，不能有「先构建再手动上传」这种步骤。

## 二、选型对比

| 方案 | 优势 | 不选的理由 |
| --- | --- | --- |
| Hexo | 生态成熟、主题多 | 主题定制要改别人的模板，插件链复杂 |
| VitePress | 好写好用、Vue 生态 | 定位是文档站，博客需要的标签/分页要自己补 |
| Next.js | 能力最强 | 对纯静态博客太重，运行时概念也多 |
| 手写 HTML | 完全可控 | 每篇文章都要手抄一遍布局，不可持续 |
| **Astro** | 内容集合 + 默认零 JS + 静态输出 | —— |

决定用 Astro 的关键有两点：

**1. 默认不发送 JavaScript。**
Astro 的组件在构建期就渲染成 HTML。除非你显式写 `<script>` 或者用岛屿（island），
否则产物里一行 JS 都没有。这个博客最终只带三个小组件脚本：主题切换、搜索、阅读进度。

**2. 内容集合（Content Collections）带类型校验。**
Frontmatter 用 Zod 定义 schema，字段写错在**构建期**就报错，
而不是等到线上页面缺个日期才发现。

```ts
// src/content.config.ts
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    pin: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});
```

顺带一个实用效果：`draft: true` 的文章不会出现在任何列表、RSS 和搜索索引里，
本地写完先放着，不担心半成品被推上线。

## 三、为什么手写 CSS 而不用 Tailwind

用 Tailwind 完全可行，但这个站点的样式量不大，手写更划算：

- **少一层构建依赖** —— 少一个插件、少一次版本兼容的麻烦；
- **可以直接用 CSS 变量做主题** —— 明暗切换只需要换一组变量，不需要 `dark:` 前缀散落各处；
- **产物更小** —— 手写 CSS 大约 20KB，压缩后 4KB 左右。

主题的实现就是两组变量 + 一个 `<html class="dark">`：

```css
:root {
  --bg: #ffffff;
  --text: #151a21;
  --accent: #4f8cff;
}

html.dark {
  --bg: #0b0e14;
  --text: #e6edf3;
  --accent: #4f8cff;
}
```

**注意切换时机的处理**：如果在 `DOMContentLoaded` 里读 `localStorage` 再切 class，
用户会先看到一帧亮色再跳到暗色。所以这段逻辑必须内联在 `<head>` 里同步执行：

```html
<script is:inline>
  (function () {
    try {
      var stored = localStorage.getItem('theme');
      var dark = stored
        ? stored === 'dark'
        : !window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.classList.toggle('dark', dark);
    } catch (e) {
      document.documentElement.classList.add('dark');
    }
  })();
</script>
```

`is:inline` 是关键，它让 Astro 不要把这行脚本打包外链——否则又变回异步加载了。

## 四、搜索：构建期生成索引

没有后端也能有全文搜索：**构建时把所有文章的纯文本导出成 JSON，运行时在浏览器里过滤。**

```ts
// src/pages/search.json.ts
export async function GET() {
  const posts = byDateDesc(published(await getCollection('blog')));
  const index = posts.map((post) => ({
    title: post.data.title,
    description: post.data.description,
    tags: post.data.tags,
    url: postUrl(post),
    body: plainText(post.body),          // 去掉 Markdown 语法后的纯文本
  }));
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
```

索引只在用户第一次打开搜索时才 `fetch`，所以首页完全没有额外开销。

打分逻辑很朴素但够用：标题命中权重最高，其次标签、描述，正文按命中次数加权。
对几十篇到几百篇文章的规模，这个方案比引入 FlexSearch / Lunr 更划算——
少一个依赖，也少一次索引格式的兼容问题。

## 五、代码高亮：Shiki 双主题

Astro 内置 Shiki，配置成明暗双主题后，切换主题时高亮会跟着变：

```js
// astro.config.mjs
markdown: {
  shikiConfig: {
    themes: { light: 'github-light', dark: 'github-dark' },
  },
}
```

它会给每个 token 同时输出两套 CSS 变量，再靠一段样式决定用哪套：

```css
html.dark .astro-code,
html.dark .astro-code span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
}
```

这样就不需要生成两套 HTML，也不需要客户端重新高亮。

## 六、发布流程

日常写作只有三步：

```bash
# 1. 新建文章
$EDITOR src/content/blog/my-new-post.md

# 2. 本地预览（可选）
pnpm dev

# 3. 发布
git add . && git commit -m "post: my new post" && git push
```

推送后 GitHub Actions 自动构建并部署到 Pages，大约 1 分钟上线。
整个流程里没有手动上传、没有 FTP、没有「忘记构建」的可能。

Frontmatter 的样子：

```yaml
---
title: '文章标题'
description: '一句话摘要，会出现在列表、SEO 描述和 RSS 里'
pubDate: 2025-09-01
tags: ['Astro', '博客']
category: '工程'
pin: false      # 置顶到首页
draft: false    # 草稿不会出现在任何列表里
---
```

## 七、这个站现在有什么

- 文章页：目录（滚动高亮）、阅读时长、上下篇、标签跳转；
- 归档页：按年份分组；
- 标签页：标签云 + 数量统计；
- 搜索：`Ctrl/Cmd + K` 或 `/` 唤起；
- 明暗主题：跟随系统，可手动切换并记住选择；
- RSS 与 sitemap：构建期生成；
- 响应式：移动端折叠导航、代码块通栏滚动。

**没有任何前端框架运行时**——页面本身就是最终的 HTML，
只有搜索、主题切换、阅读进度这三段小脚本是活的。

## 小结

选工具的时候容易陷入「哪个功能多」，但对个人博客来说，
真正决定能不能坚持下去的是**发布路径有多短**。

现在的路径是：写一个 `.md` 文件 → `git push` → 完成。
没有第二步，就不会有「攒着以后再发」然后永远不发的情况。
