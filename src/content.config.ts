import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content' }),
  // Permissive schema: most fields optional, accepts any type
  // (Obsidian frontmatter is messy — we just need title + tags to render)
  schema: z.object({}).passthrough(),
});

export const collections = { articles };
