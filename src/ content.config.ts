import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      pubDate: z.string(),
      description: z.string(),
      cover: z.string().optional(),
      time: z.string(),
      word: z.number(),
    }),
});

export const collections = { blog };
