import { useState } from "react";
import { useCreateCommunityPost } from "@workspace/api-client-react";
import { CommunityPostType } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { CheckCircle, ArrowLeft, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function CreatePost() {
  const [, navigate] = useLocation();
  const createPost = useCreateCommunityPost();
  const { toast } = useToast();
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [newPost, setNewPost] = useState({
    title: "",
    content: "",
    type: "question" as CommunityPostType,
    authorName: "Anonymous Dev",
    language: "",
    image: "",
  });

  const validateForm = () => {
    const errors: Record<string, string> = {};
    if (!newPost.title.trim()) errors.title = "Title is required";
    if (!newPost.content.trim()) errors.content = "Content is required";
    if (!newPost.image.trim()) errors.image = "Image URL is required";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreatePost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }

    const postData = {
      title: newPost.title,
      content: newPost.content,
      type: newPost.type,
      authorName: newPost.authorName,
      language: newPost.language || undefined,
      tags: [],
    };

    createPost.mutate({ data: postData }, {
      onSuccess: () => {
        toast({ title: "✓ Post published successfully!" });
        navigate("/community");
      },
      onError: (error) => {
        toast({ title: "Failed to publish post", description: (error as any).message || "Please try again", variant: "destructive" });
      },
    });
  };

  return (
    <div className="flex-1 bg-gradient-to-br from-[#0a0e1f] via-[#050810] to-[#0a0e1f] overflow-y-auto">
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        {/* Header with back button */}
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8"
        >
          <button
            onClick={() => navigate("/community")}
            className="flex items-center gap-2 text-[#00d9ff] hover:text-[#00d9ff]/80 transition-colors mb-6 text-sm font-mono"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Community
          </button>

          <div>
            <p className="text-[10px] font-mono text-[#00d9ff]/50 tracking-widest mb-2 uppercase">// community</p>
            <h1 className="text-4xl font-bold text-[#f1f5f9] mb-2">Create Post</h1>
            <p className="text-[#94a3b8] font-mono text-sm">Share your knowledge and help the community grow</p>
          </div>
        </motion.div>

        {/* Form Card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="rounded-2xl border border-white/8 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-8"
          style={{ boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)" }}
        >
          <form onSubmit={handleCreatePost} className="space-y-6">
            {/* Title */}
            <div>
              <label className="block text-sm font-mono font-semibold text-[#f1f5f9] mb-2">
                Post Title <span className="text-[#ff006e]">*</span>
              </label>
              <input
                placeholder="What's on your mind?"
                value={newPost.title}
                onChange={e => {
                  setNewPost({ ...newPost, title: e.target.value });
                  if (formErrors.title) setFormErrors({ ...formErrors, title: "" });
                }}
                className={`w-full rounded-xl border ${formErrors.title ? "border-[#ff006e]/40 bg-[#ff006e]/5" : "border-white/8 bg-white/2"} px-4 py-3 text-sm font-mono text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#00d9ff]/40 transition-colors`}
              />
              {formErrors.title && (
                <div className="flex items-center gap-1.5 text-xs text-[#ff006e] mt-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {formErrors.title}
                </div>
              )}
            </div>

            {/* Type and Language */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-mono font-semibold text-[#f1f5f9] mb-2">
                  Post Type <span className="text-[#ff006e]">*</span>
                </label>
                <select
                  value={newPost.type}
                  onChange={e => setNewPost({ ...newPost, type: e.target.value as CommunityPostType })}
                  className="w-full rounded-xl border border-white/8 bg-white/2 px-4 py-3 text-sm font-mono text-[#f1f5f9] focus:outline-none focus:border-[#00d9ff]/40 cursor-pointer transition-colors"
                >
                  <option value="question">Question</option>
                  <option value="article">Article</option>
                  <option value="migration-story">Migration Story</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-mono font-semibold text-[#f1f5f9] mb-2">
                  Language / Tech
                </label>
                <input
                  placeholder="e.g., Python, Rust"
                  value={newPost.language}
                  onChange={e => setNewPost({ ...newPost, language: e.target.value })}
                  className="w-full rounded-xl border border-white/8 bg-white/2 px-4 py-3 text-sm font-mono text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#00d9ff]/40 transition-colors"
                />
              </div>
            </div>

            {/* Content */}
            <div>
              <label className="block text-sm font-mono font-semibold text-[#f1f5f9] mb-2">
                Content <span className="text-[#ff006e]">*</span>
              </label>
              <textarea
                placeholder="Share your knowledge, code snippets, migration steps, or ask a question..."
                value={newPost.content}
                onChange={e => {
                  setNewPost({ ...newPost, content: e.target.value });
                  if (formErrors.content) setFormErrors({ ...formErrors, content: "" });
                }}
                rows={8}
                className={`w-full rounded-xl border ${formErrors.content ? "border-[#ff006e]/40 bg-[#ff006e]/5" : "border-white/8 bg-white/2"} px-4 py-3 text-sm font-mono text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#00d9ff]/40 resize-none transition-colors`}
              />
              {formErrors.content && (
                <div className="flex items-center gap-1.5 text-xs text-[#ff006e] mt-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {formErrors.content}
                </div>
              )}
              <p className="text-xs text-[#475569] mt-2">✨ Markdown formatting is supported</p>
            </div>

            {/* Image URL */}
            <div>
              <label className="block text-sm font-mono font-semibold text-[#f1f5f9] mb-2">
                Featured Image <span className="text-[#ff006e]">*</span>
              </label>
              <input
                placeholder="https://picsum.photos/500/300?random=1"
                value={newPost.image}
                onChange={e => {
                  setNewPost({ ...newPost, image: e.target.value });
                  if (formErrors.image) setFormErrors({ ...formErrors, image: "" });
                }}
                className={`w-full rounded-xl border ${formErrors.image ? "border-[#ff006e]/40 bg-[#ff006e]/5" : "border-white/8 bg-white/2"} px-4 py-3 text-sm font-mono text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#00d9ff]/40 transition-colors`}
              />
              {formErrors.image && (
                <div className="flex items-center gap-1.5 text-xs text-[#ff006e] mt-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {formErrors.image}
                </div>
              )}
              <div className="mt-2 p-3 rounded-lg bg-[#00d9ff]/5 border border-[#00d9ff]/20">
                <p className="text-xs text-[#00d9ff] font-mono">
                  💡 Tip: Use <span className="text-[#00ff88]">https://picsum.photos/500/300?random=N</span> for random images
                </p>
              </div>
            </div>

            {/* Author Name */}
            <div>
              <label className="block text-sm font-mono font-semibold text-[#f1f5f9] mb-2">
                Author Name
              </label>
              <input
                placeholder="Your name (optional)"
                value={newPost.authorName}
                onChange={e => setNewPost({ ...newPost, authorName: e.target.value })}
                className="w-full rounded-xl border border-white/8 bg-white/2 px-4 py-3 text-sm font-mono text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#00d9ff]/40 transition-colors"
              />
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={() => navigate("/community")}
                className="flex-1 rounded-xl border border-white/8 bg-white/2 px-4 py-3 text-sm font-mono font-semibold text-[#f1f5f9] hover:bg-white/5 hover:border-white/15 transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createPost.isPending}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-[#00d9ff] bg-[#00d9ff]/10 px-4 py-3 text-sm font-mono font-semibold text-[#00d9ff] shadow-[0_0_14px_rgba(0,217,255,0.2)] hover:bg-[#00d9ff]/18 hover:shadow-[0_0_24px_rgba(0,217,255,0.4)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createPost.isPending ? (
                  <>
                    <span className="h-3.5 w-3.5 border-2 border-[#00d9ff] border-t-transparent rounded-full animate-spin" />
                    Publishing…
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4" />
                    Publish Post
                  </>
                )}
              </button>
            </div>
          </form>
        </motion.div>

        {/* Footer Info */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mt-8 p-4 rounded-xl bg-white/2 border border-white/8"
        >
          <p className="text-xs text-[#475569] font-mono">
            💡 <span className="text-[#f1f5f9]">Pro tip:</span> High-quality posts with clear titles, relevant images, and detailed content get more engagement from the community.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
