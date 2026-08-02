import { useState } from "react";
import { useListCommunityPosts, useVoteCommunityPost, CommunityPostType } from "@workspace/api-client-react";
import { formatDistanceToNow } from "date-fns";
import { ThumbsUp, ThumbsDown, MessageSquare, TrendingUp, Flame, Clock, Globe, ExternalLink, Users, Plus } from "lucide-react";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";

// Real PQC articles from the web (mock data - replace with real API in production)
const WEB_ARTICLES = [
  {
    id: 1,
    title: "NIST Finalizes Post-Quantum Cryptography Standards",
    content: "The National Institute of Standards and Technology (NIST) has officially standardized the first set of post-quantum cryptographic algorithms. These standards, FIPS 203, 204, and 205, are designed to protect against threats from quantum computers. The approved algorithms include ML-KEM (key encapsulation), ML-DSA (digital signatures), and SLH-DSA for hash-based signatures.",
    image: "https://picsum.photos/500/300?random=1",
    type: "article",
    language: "Technical",
    source: "NIST",
    url: "https://nist.gov/news-events/news-releases/2024/08/nist-releases-first-3-finalized-post-quantum-cryptography-standards",
    upvotes: 245,
    downvotes: 8,
  },
  {
    id: 2,
    title: "Google Quantum Chip Willow Shows Progress on Error Correction",
    content: "Google has unveiled its latest quantum processor, Willow, demonstrating significant advances in quantum error correction. While quantum computers pose a threat to current encryption, this development also shows the importance of transitioning to post-quantum cryptography immediately.",
    image: "https://picsum.photos/500/300?random=2",
    type: "article",
    language: "Quantum Computing",
    source: "Google Research",
    url: "https://google.com/quantum",
    upvotes: 189,
    downvotes: 5,
  },
  {
    id: 3,
    title: "Harvest Now, Decrypt Later: Why Organizations Must Act Now on Post-Quantum Cryptography",
    content: "Security researchers warn that adversaries may be collecting and storing encrypted data today to decrypt later when quantum computers become powerful enough. This 'harvest now, decrypt later' attack makes immediate migration to post-quantum cryptography critical for protecting sensitive data.",
    image: "https://picsum.photos/500/300?random=3",
    type: "article",
    language: "Security",
    source: "Gartner",
    url: "https://gartner.com/en/newsroom",
    upvotes: 312,
    downvotes: 12,
  },
  {
    id: 4,
    title: "BSI Recommends ML-KEM for Key Establishment",
    content: "Germany's Federal Office for Information Security (BSI) has recommended the use of ML-KEM for key establishment in new systems. This endorsement from a major government security agency signals the global shift toward post-quantum cryptography adoption.",
    image: "https://picsum.photos/500/300?random=4",
    type: "article",
    language: "Cryptography",
    source: "BSI",
    url: "https://bsi.bund.de",
    upvotes: 156,
    downvotes: 3,
  },
  {
    id: 5,
    title: "Enterprise Hybrid Cryptography: RSA + Post-Quantum Algorithms",
    content: "Leading organizations are deploying hybrid cryptographic approaches, combining traditional RSA with post-quantum algorithms. This strategy provides immediate protection against quantum threats while maintaining compatibility with legacy systems.",
    image: "https://picsum.photos/500/300?random=5",
    type: "article",
    language: "Implementation",
    source: "IEEE",
    url: "https://ieee.org",
    upvotes: 203,
    downvotes: 7,
  },
  {
    id: 6,
    title: "Kyber (ML-KEM) Adoption in TLS 1.3",
    content: "Major web browsers and servers are beginning to support Kyber (standardized as ML-KEM) in TLS 1.3. Cloudflare and others are testing post-quantum key exchange mechanisms in production to ensure security protocols remain quantum-resistant.",
    image: "https://picsum.photos/500/300?random=6",
    type: "article",
    language: "Web Security",
    source: "Cloudflare Blog",
    url: "https://cloudflare.com/blog",
    upvotes: 278,
    downvotes: 6,
  },
];

// Helper function to merge web articles with user-generated posts
const getAllPosts = (userPosts: any[] | undefined) => {
  const posts = userPosts || [];
  return [
    ...WEB_ARTICLES.map((article) => ({
      ...article,
      id: article.id,
      authorName: article.source,
      createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
      isWebArticle: true,
    })),
    ...posts.map((p) => ({
      ...p,
      isWebArticle: false,
    })),
  ];
};

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

const POST_TYPES = ["all", "article", "question", "migration-story"] as const;
type PostTypeFilter = typeof POST_TYPES[number];

const SORT_OPTIONS = [
  { id: "hot", label: "Hot", icon: Flame },
  { id: "new", label: "New", icon: Clock },
  { id: "top", label: "Top", icon: TrendingUp },
] as const;

const TYPE_LABELS: Record<string, string> = {
  all: "All",
  article: "Article",
  question: "Question",
  "migration-story": "Migration Story",
};

const TYPE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  article: { bg: "#eef0fe", border: "1px solid rgba(79, 70, 229, 0.25)", text: "#4f46e5" },
  question: { bg: "#fffbeb", border: "1px solid rgba(217, 119, 6, 0.25)", text: "#d97706" },
  "migration-story": { bg: "#ecfdf5", border: "1px solid rgba(5, 150, 105, 0.25)", text: "#059669" },
};

const BADGE_STYLES: Record<string, { color: string; bg: string }> = {
  gold: { color: "#d97706", bg: "#fffbeb" },
  silver: { color: "#64748b", bg: "#f1f3f7" },
  bronze: { color: "#b45309", bg: "#fef7ed" },
  "quantum-guardian": { color: "#4f46e5", bg: "#eef0fe" },
};

export function Community() {
  const [, navigate] = useLocation();
  const [postType, setPostType] = useState<PostTypeFilter>("all");
  const [sortBy, setSortBy] = useState<"hot" | "new" | "top">("hot");
  const { data: userPosts, refetch: refetchPosts } = useListCommunityPosts(
    postType === "all" ? undefined : { type: postType as CommunityPostType }
  );
  const votePost = useVoteCommunityPost();
  const { toast } = useToast();

  const posts = getAllPosts(userPosts);

  const handleVote = (id: number, direction: "up" | "down") => {
    votePost.mutate({ id, data: { direction } }, { onSuccess: () => refetchPosts() });
  };

  // Sort posts and filter by type, only showing posts with images
  const sortedPosts = posts ? [...posts]
    .filter((p) => {
      // Only show posts with images
      if (!p.image) return false;
      // Filter by post type
      if (postType !== "all" && p.type !== postType) return false;
      return true;
    })
    .sort((a, b) => {
      const scoreA = a.upvotes - a.downvotes;
      const scoreB = b.upvotes - b.downvotes;
      
      if (sortBy === "hot") return scoreB - scoreA; // Popular first
      if (sortBy === "top") return scoreB - scoreA; // Top score
      if (sortBy === "new") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return 0;
    }) : [];

  return (
    <div className="flex-1 bg-[#ffffff] overflow-y-auto relative">
      <div className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Header */}
        <Reveal>
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-[11px] font-semibold text-[#4f46e5] tracking-widest mb-1 uppercase">Collective Defense</p>
              <h1 className="text-3xl font-bold text-[#0a0e1a] tracking-tight">Community</h1>
              <p className="text-[#475569] text-sm mt-1">Post questions, share migration stories, and learn from the community</p>
            </div>
            <button
              onClick={() => navigate("/community/create")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#4f46e5] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#4338ca] transition-all"
            >
              <Plus className="h-4 w-4" /> Create Post
            </button>
          </div>
        </Reveal>

        {/* Posts section */}
        <Reveal delay={0.06}>
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Main feed */}
            <div className="flex-1">
              {/* Sort bar */}
              <Reveal delay={0.08}>
                <div className="flex items-center gap-2 mb-5 pb-4 border-b border-[#eceef2]">
                  <p className="text-[10px] font-semibold text-[#6b7280] uppercase tracking-widest">Sort</p>
                  <div className="flex gap-2">
                    {SORT_OPTIONS.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        onClick={() => setSortBy(id as "hot" | "new" | "top")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          sortBy === id
                            ? "bg-[#eef0fe] border border-[#4f46e5]/25 text-[#4f46e5]"
                            : "border border-[#e5e7eb] text-[#475569] hover:border-[#d8dce3] hover:text-[#0a0e1a]"
                        }`}
                      >
                        <Icon className="h-3 w-3" /> {label}
                      </button>
                    ))}
                  </div>
                </div>
              </Reveal>

              {/* Post list */}
              <div className="space-y-4">
                {sortedPosts.map((post, i) => {
                  const typeStyle = TYPE_COLORS[post.type] || TYPE_COLORS.article;
                  const score = post.upvotes - post.downvotes;
                  return (
                    <Reveal key={post.id} delay={0.04 * i}>
                      <motion.div
                        whileHover={{ y: -2 }}
                        className="rounded-xl border border-[#e5e7eb] bg-white hover:border-[#4f46e5]/25 transition-all overflow-hidden"
                        style={{ boxShadow: "0 8px 24px rgba(15,23,42,0.06)" }}
                      >
                        {/* Image box */}
                        {post.image && (
                          <div className="relative h-48 overflow-hidden bg-[#f1f3f7]">
                            <img
                              src={post.image}
                              alt={post.title}
                              className="w-full h-full object-cover opacity-95 hover:opacity-100 transition-opacity"
                            />
                          </div>
                        )}

                        <div className="p-4 sm:p-5">
                          {/* Header row: Type + Language + Web Info */}
                          <div className="flex flex-wrap items-center gap-2 mb-3">
                            {post.isWebArticle && (
                              <span className="flex items-center gap-1 rounded px-2.5 py-1 text-[9px] uppercase tracking-widest font-semibold bg-[#eef0fe] border border-[#4f46e5]/25 text-[#4f46e5]">
                                <Globe className="h-3 w-3" /> Web Info
                              </span>
                            )}
                            <span
                              className="rounded px-2.5 py-1 text-[9px] uppercase tracking-widest font-semibold"
                              style={{
                                background: typeStyle.bg,
                                border: typeStyle.border,
                                color: typeStyle.text,
                              }}
                            >
                              {post.type.replace("-", " ")}
                            </span>
                            {post.language && (
                              <span className="rounded px-2.5 py-1 text-[9px] font-medium text-[#475569] border border-[#e5e7eb] bg-[#f1f3f7]">
                                {post.language}
                              </span>
                            )}
                          </div>

                          {/* Title */}
                          <h2 className="text-base sm:text-lg font-bold text-[#0a0e1a] mb-2 leading-snug">{post.title}</h2>

                          {/* Preview */}
                          <p className="text-sm text-[#475569] leading-relaxed line-clamp-2 mb-4">{post.content}</p>

                          {/* Footer: Author + Engagement metrics */}
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-[#eceef2]">
                            <div className="flex items-center gap-3">
                              <div className="h-7 w-7 rounded-full bg-[#f1f3f7] border border-[#e5e7eb] flex items-center justify-center flex-shrink-0">
                                <Users className="h-3.5 w-3.5 text-[#6b7280]" />
                              </div>
                              <div className="text-xs">
                                <p className="text-[#0a0e1a] font-medium">{post.authorName}</p>
                                <p className="text-[#6b7280] text-[11px]">{formatDistanceToNow(new Date(post.createdAt))} ago</p>
                              </div>
                            </div>

                            {/* Vote + Comment count + External link */}
                            <div className="flex items-center gap-3">
                              <div className="flex items-center gap-2">
                                {!post.isWebArticle && (
                                  <>
                                    <button
                                      onClick={() => handleVote(post.id, "up")}
                                      className="text-[#6b7280] hover:text-[#4f46e5] transition-colors p-1.5 hover:bg-[#f1f3f7] rounded"
                                    >
                                      <ThumbsUp className="h-4 w-4" />
                                    </button>
                                    <span className="font-mono text-sm font-semibold text-[#0a0e1a] min-w-[28px] text-center">{score}</span>
                                    <button
                                      onClick={() => handleVote(post.id, "down")}
                                      className="text-[#6b7280] hover:text-[#dc2626] transition-colors p-1.5 hover:bg-[#f1f3f7] rounded"
                                    >
                                      <ThumbsDown className="h-4 w-4" />
                                    </button>
                                  </>
                                )}
                              </div>
                              {post.isWebArticle && post.url && (
                                <a
                                  href={post.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 text-[#4f46e5] hover:text-[#4338ca] transition-colors px-3 py-1.5 rounded hover:bg-[#eef0fe] border border-[#4f46e5]/25"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  <span className="text-xs font-medium">Read More</span>
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    </Reveal>
                  );
                })}

                {sortedPosts.length === 0 && (
                  <Reveal delay={0.1}>
                    <div className="text-center py-16">
                      <MessageSquare className="h-12 w-12 text-[#9aa3b2] mx-auto mb-3" />
                      <p className="text-[#475569] text-sm">No posts yet in this category</p>
                      <p className="text-[#9aa3b2] text-xs mt-1">Be the first to share knowledge</p>
                    </div>
                  </Reveal>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="w-full lg:w-64 shrink-0 space-y-4">
              {/* Filter Card */}
              <div className="rounded-lg border border-[#e5e7eb] bg-white p-4 shadow-sm">
                <p className="text-[10px] uppercase tracking-widest text-[#6b7280] mb-4 font-semibold">Filter</p>
                <div className="space-y-2">
                  {POST_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => setPostType(t)}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium transition-all ${
                        postType === t
                          ? "bg-[#eef0fe] border border-[#4f46e5]/25 text-[#4f46e5]"
                          : "text-[#475569] hover:text-[#0a0e1a] hover:bg-[#f7f8fa] border border-transparent"
                      }`}
                    >
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stats Card */}
              <div className="rounded-lg border border-[#e5e7eb] bg-white p-4 shadow-sm">
                <p className="text-[10px] uppercase tracking-widest text-[#6b7280] mb-4 font-semibold">Stats</p>
                <div className="space-y-3">
                  <div>
                    <p className="text-[11px] text-[#6b7280] mb-1">Total Posts</p>
                    <p className="text-xl font-bold text-[#0a0e1a]">{sortedPosts.length}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-[#6b7280] mb-1">Web Resources</p>
                    <p className="text-xl font-bold text-[#4f46e5]">{sortedPosts.filter(p => p.isWebArticle).length}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>

    </div>
  );
}
