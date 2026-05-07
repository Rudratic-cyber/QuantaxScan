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
  article: { bg: "rgba(79, 142, 247, 0.1)", border: "1px solid rgba(79, 142, 247, 0.3)", text: "#4f8ef7" },
  question: { bg: "rgba(251, 191, 36, 0.1)", border: "1px solid rgba(251, 191, 36, 0.3)", text: "#fbbf24" },
  "migration-story": { bg: "rgba(52, 211, 153, 0.1)", border: "1px solid rgba(52, 211, 153, 0.3)", text: "#34d399" },
};

const BADGE_STYLES: Record<string, { color: string; glow: string }> = {
  gold: { color: "#FFD700", glow: "rgba(255,215,0,0.4)" },
  silver: { color: "#C0C0C0", glow: "rgba(192,192,192,0.3)" },
  bronze: { color: "#CD7F32", glow: "rgba(205,127,50,0.3)" },
  "quantum-guardian": { color: "#4f8ef7", glow: "rgba(79,142,247,0.5)" },
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
    <div className="flex-1 bg-gradient-to-br from-[#0a0e1f] via-[#050810] to-[#0a0e1f] overflow-y-auto relative">
      <div className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Header */}
        <Reveal>
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-[10px] font-mono text-[#00d9ff]/50 tracking-widest mb-1 uppercase">// collective_defense</p>
              <h1 className="text-3xl font-bold text-[#f1f5f9] tracking-tight">Community</h1>
              <p className="text-[#94a3b8] font-mono text-xs mt-1">Post questions, share migration stories, and learn from the community</p>
            </div>
            <button
              onClick={() => navigate("/community/create")}
              className="inline-flex items-center gap-2 rounded-lg border border-[#00d9ff] bg-[#00d9ff]/10 px-5 py-2.5 text-sm font-mono font-bold text-[#00d9ff] shadow-[0_0_14px_rgba(0,217,255,0.2)] hover:bg-[#00d9ff]/18 hover:shadow-[0_0_24px_rgba(0,217,255,0.4)] transition-all"
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
                <div className="flex items-center gap-2 mb-5 pb-4 border-b border-white/6">
                  <p className="text-[9px] font-mono text-[#475569] uppercase tracking-widest">Sort:</p>
                  <div className="flex gap-2">
                    {SORT_OPTIONS.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        onClick={() => setSortBy(id as "hot" | "new" | "top")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono transition-colors ${
                          sortBy === id
                            ? "bg-[#00d9ff]/15 border border-[#00d9ff]/40 text-[#00d9ff]"
                            : "border border-white/8 text-[#475569] hover:border-white/20 hover:text-[#f1f5f9]"
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
                        className="rounded-xl border border-white/8 bg-gradient-to-br from-[#0a0e1f] to-[#050810] hover:border-[#00d9ff]/20 transition-all overflow-hidden"
                        style={{ boxShadow: "inset 0 0 15px rgba(0,217,255,0.04)" }}
                      >
                        {/* Image box */}
                        {post.image && (
                          <div className="relative h-48 overflow-hidden bg-black/40">
                            <img
                              src={post.image}
                              alt={post.title}
                              className="w-full h-full object-cover opacity-80 hover:opacity-100 transition-opacity"
                            />
                            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#050810]" />
                          </div>
                        )}

                        <div className="p-4 sm:p-5">
                          {/* Header row: Type + Language + Web Info */}
                          <div className="flex flex-wrap items-center gap-2 mb-3">
                            {post.isWebArticle && (
                              <span className="flex items-center gap-1 rounded px-2.5 py-1 text-[9px] font-mono uppercase tracking-widest font-semibold bg-[#00d9ff]/12 border border-[#00d9ff]/30 text-[#00d9ff]">
                                <Globe className="h-3 w-3" /> web info
                              </span>
                            )}
                            <span
                              className="rounded px-2.5 py-1 text-[9px] font-mono uppercase tracking-widest font-semibold"
                              style={{
                                background: typeStyle.bg,
                                border: typeStyle.border,
                                color: typeStyle.text,
                              }}
                            >
                              {post.type.replace("-", " ")}
                            </span>
                            {post.language && (
                              <span className="rounded px-2.5 py-1 text-[9px] font-mono text-[#94a3b8] border border-white/10 bg-white/4">
                                {post.language}
                              </span>
                            )}
                          </div>

                          {/* Title */}
                          <h2 className="text-base sm:text-lg font-bold text-[#f1f5f9] mb-2 leading-snug">{post.title}</h2>

                          {/* Preview */}
                          <p className="text-sm text-[#94a3b8] font-mono leading-relaxed line-clamp-2 mb-4">{post.content}</p>

                          {/* Footer: Author + Engagement metrics */}
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-white/6">
                            <div className="flex items-center gap-3">
                              <div className="h-7 w-7 rounded-full bg-[#050810] border border-white/10 flex items-center justify-center flex-shrink-0">
                                <Users className="h-3.5 w-3.5 text-[#475569]" />
                              </div>
                              <div className="text-xs">
                                <p className="text-[#f1f5f9] font-mono">{post.authorName}</p>
                                <p className="text-[#475569] font-mono text-[11px]">{formatDistanceToNow(new Date(post.createdAt))} ago</p>
                              </div>
                            </div>

                            {/* Vote + Comment count + External link */}
                            <div className="flex items-center gap-3">
                              <div className="flex items-center gap-2">
                                {!post.isWebArticle && (
                                  <>
                                    <button
                                      onClick={() => handleVote(post.id, "up")}
                                      className="text-[#475569] hover:text-[#00d9ff] transition-colors p-1.5 hover:bg-white/5 rounded"
                                    >
                                      <ThumbsUp className="h-4 w-4" />
                                    </button>
                                    <span className="font-mono text-sm font-semibold text-[#f1f5f9] min-w-[28px] text-center">{score}</span>
                                    <button
                                      onClick={() => handleVote(post.id, "down")}
                                      className="text-[#475569] hover:text-[#ff006e] transition-colors p-1.5 hover:bg-white/5 rounded"
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
                                  className="flex items-center gap-1.5 text-[#00d9ff] hover:text-[#00d9ff] transition-colors px-3 py-1.5 rounded hover:bg-white/5 border border-[#00d9ff]/20"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  <span className="text-xs font-mono">Read More</span>
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
                      <MessageSquare className="h-12 w-12 text-[#2d3f5c] mx-auto mb-3 opacity-50" />
                      <p className="text-[#475569] font-mono text-sm">No posts yet in this category</p>
                      <p className="text-[#2d3f5c] font-mono text-xs mt-1">Be the first to share knowledge</p>
                    </div>
                  </Reveal>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="w-full lg:w-64 shrink-0 space-y-4">
              {/* Filter Card */}
              <div className="rounded-lg border border-white/8 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-4" style={{ boxShadow: "inset 0 0 15px rgba(0,217,255,0.04)" }}>
                <p className="text-[9px] font-mono uppercase tracking-widest text-[#00d9ff] mb-4 font-semibold">📁 Filter</p>
                <div className="space-y-2">
                  {POST_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => setPostType(t)}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs font-mono transition-all ${
                        postType === t
                          ? "bg-[#00d9ff]/15 border border-[#00d9ff]/40 text-[#00d9ff]"
                          : "text-[#475569] hover:text-[#f1f5f9] hover:bg-white/5 border border-transparent"
                      }`}
                    >
                      {postType === t ? <span>▶ </span> : <span>  </span>}
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stats Card */}
              <div className="rounded-lg border border-white/8 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-4" style={{ boxShadow: "inset 0 0 15px rgba(0,217,255,0.04)" }}>
                <p className="text-[9px] font-mono uppercase tracking-widest text-[#00d9ff] mb-4 font-semibold">📊 Stats</p>
                <div className="space-y-3">
                  <div>
                    <p className="text-[11px] text-[#475569] font-mono mb-1">Total Posts</p>
                    <p className="text-xl font-bold text-[#f1f5f9]">{sortedPosts.length}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-[#475569] font-mono mb-1">Web Resources</p>
                    <p className="text-xl font-bold text-[#00d9ff]">{sortedPosts.filter(p => p.isWebArticle).length}</p>
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
