import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    category: z.string().default('随笔'),
    /** 是否置顶到首页 */
    pin: z.boolean().default(false),
    /** 草稿不会出现在任何列表与 RSS 中 */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
