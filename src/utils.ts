import type { CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** 文章路由：/posts/<id>/ */
export function postUrl(post: Post): string {
  return `/posts/${post.id}/`;
}

/** 排序：置顶优先，其次按发布日期倒序 */
export function sortPosts(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => {
    if (a.data.pin !== b.data.pin) return a.data.pin ? -1 : 1;
    return b.data.pubDate.valueOf() - a.data.pubDate.valueOf();
  });
}

/** 只按日期倒序，用于归档与上下篇 */
export function byDateDesc(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** 过滤草稿 */
export function published(posts: Post[]): Post[] {
  return posts.filter((p) => !p.data.draft);
}

/** 2025-11-02 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 2025 年 11 月 2 日 */
export function formatDateCN(date: Date): string {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/**
 * 阅读时长：中英文混排下按「中文字符 400/分钟 + 英文单词 200/分钟」估算。
 */
export function readingTime(body: string | undefined): number {
  const text = body ?? '';
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const words = (text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) ?? [])
    .length;
  const minutes = cjk / 400 + words / 200;
  return Math.max(1, Math.round(minutes));
}

/** 按年份归档：{ 2025: [...], 2024: [...] } */
export function groupByYear(posts: Post[]): Array<{ year: number; posts: Post[] }> {
  const map = new Map<number, Post[]>();
  for (const post of byDateDesc(posts)) {
    const year = post.data.pubDate.getFullYear();
    if (!map.has(year)) map.set(year, []);
    map.get(year)!.push(post);
  }
  return [...map.entries()].map(([year, list]) => ({ year, posts: list }));
}

/** 标签统计，按出现次数倒序 */
export function tagCounts(posts: Post[]): Array<{ tag: string; count: number }> {
  const map = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

/**
 * 把标签变成安全的 URL 片段。
 * 不做百分号编码 —— 交给 Astro / 浏览器处理，否则会出现「已编码参数」
 * 与「解码后路径」对不上的路由问题（中文标签尤其明显）。
 */
export function tagSlug(tag: string): string {
  return (
    tag
      .trim()
      .toLowerCase()
      // 路径不安全字符统一压成连字符
      .replace(/[/\\#?%&=+\s]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'tag'
  );
}

/** 去掉 Markdown 语法，得到用于搜索索引的纯文本 */
export function plainText(markdown: string | undefined, limit = 6000): string {
  const text = (markdown ?? '')
    .replace(/^---[\s\S]*?---/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, limit);
}

/** 上一页 / 下一页 */
export function siblings(posts: Post[], current: Post): { prev: Post | null; next: Post | null } {
  const list = byDateDesc(posts);
  const index = list.findIndex((p) => p.id === current.id);
  if (index === -1) return { prev: null, next: null };
  return {
    // 时间更早的一篇
    prev: index < list.length - 1 ? list[index + 1]! : null,
    // 时间更新的一篇
    next: index > 0 ? list[index - 1]! : null,
  };
}
