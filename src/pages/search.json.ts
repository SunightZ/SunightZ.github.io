import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { byDateDesc, formatDate, plainText, postUrl, published } from '../utils';

/**
 * 构建期生成的全站搜索索引，供前端 /search.json 拉取。
 * 只保留检索需要的字段，正文截断以控制体积。
 */
export async function GET(_context: APIContext) {
  const posts = byDateDesc(published(await getCollection('blog')));

  const index = posts.map((post) => ({
    title: post.data.title,
    description: post.data.description,
    tags: post.data.tags,
    category: post.data.category,
    date: formatDate(post.data.pubDate),
    url: postUrl(post),
    body: plainText(post.body),
  }));

  return new Response(JSON.stringify(index), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
