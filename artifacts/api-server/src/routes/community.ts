import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, communityPostsTable } from "@workspace/db";
import {
  CreateCommunityPostBody,
  VoteCommunityPostParams,
  VoteCommunityPostBody,
  ListCommunityPostsQueryParams,
  GetLeaderboardQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/community/posts", async (req, res): Promise<void> => {
  const parsed = ListCommunityPostsQueryParams.safeParse(req.query);
  const type = parsed.success ? parsed.data.type : undefined;
  const limit = (parsed.success ? parsed.data.limit : undefined) ?? 20;

  let query = db.select().from(communityPostsTable).orderBy(desc(communityPostsTable.createdAt));

  const posts = await query.limit(limit);

  const filtered =
    type && type !== "all" ? posts.filter((p) => p.type === type) : posts;

  res.json(filtered);
});

router.post("/community/posts", async (req, res): Promise<void> => {
  const parsed = CreateCommunityPostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [post] = await db
    .insert(communityPostsTable)
    .values({
      type: parsed.data.type,
      title: parsed.data.title,
      content: parsed.data.content,
      authorName: parsed.data.authorName,
      language: parsed.data.language ?? null,
      framework: parsed.data.framework ?? null,
      tags: parsed.data.tags ?? [],
    })
    .returning();

  res.status(201).json(post);
});

router.post("/community/posts/:id/vote", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = VoteCommunityPostParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid post ID" });
    return;
  }

  const body = VoteCommunityPostBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(communityPostsTable)
    .where(eq(communityPostsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const update =
    body.data.direction === "up"
      ? { upvotes: existing.upvotes + 1 }
      : { downvotes: existing.downvotes + 1 };

  const [updated] = await db
    .update(communityPostsTable)
    .set(update)
    .where(eq(communityPostsTable.id, params.data.id))
    .returning();

  res.json(updated);
});

router.get("/community/leaderboard", async (req, res): Promise<void> => {
  const parsed = GetLeaderboardQueryParams.safeParse(req.query);
  const limit = (parsed.success ? parsed.data.limit : undefined) ?? 10;

  // Aggregate by authorName
  const posts = await db.select().from(communityPostsTable).limit(200);
  const map: Record<string, { totalPosts: number; totalUpvotes: number }> = {};

  for (const post of posts) {
    if (!map[post.authorName]) map[post.authorName] = { totalPosts: 0, totalUpvotes: 0 };
    map[post.authorName].totalPosts += 1;
    map[post.authorName].totalUpvotes += post.upvotes;
  }

  const entries = Object.entries(map)
    .map(([authorName, stats]) => {
      const points = stats.totalPosts * 10 + stats.totalUpvotes * 5;
      const badge =
        points >= 200
          ? "quantum-guardian"
          : points >= 100
          ? "gold"
          : points >= 50
          ? "silver"
          : "bronze";

      return {
        authorName,
        totalScans: 0,
        totalPosts: stats.totalPosts,
        totalUpvotes: stats.totalUpvotes,
        badge,
        points,
      };
    })
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));

  res.json(entries);
});

export default router;
