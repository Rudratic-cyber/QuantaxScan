import { pgTable, text, serial, timestamp, integer, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

/**
 * Public content by design, and therefore **not** organisation-scoped and not
 * RLS-scoped: a community post is meant to be readable by everyone.
 *
 * `authorUserId` attributes a post to an account once sign-in exists (P2).
 * `authorName` is kept for the rows that predate it and for the display name.
 */
export const communityPostsTable = pgTable("community_posts", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // article | question | migration-story
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorName: text("author_name").notNull(),
  authorUserId: varchar("author_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  language: text("language"),
  framework: text("framework"),
  upvotes: integer("upvotes").notNull().default(0),
  downvotes: integer("downvotes").notNull().default(0),
  tags: text("tags").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCommunityPostSchema = createInsertSchema(communityPostsTable).omit({ id: true, createdAt: true, upvotes: true, downvotes: true });
export type InsertCommunityPost = z.infer<typeof insertCommunityPostSchema>;
export type CommunityPost = typeof communityPostsTable.$inferSelect;
