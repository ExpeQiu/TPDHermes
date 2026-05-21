"use client";

import { useState, useCallback } from "react";

interface Review {
  id: string;
  user: string;
  rating: number;
  comment: string;
  created_at: string;
  helpful: number;
}

interface FeedbackProps {
  skillId: string;
  skillName: string;
  initialReviews?: Review[];
  onReviewSubmit?: (review: Omit<Review, "id" | "created_at" | "helpful">) => void;
}

const MOCK_REVIEWS: Record<string, Review[]> = {
  "speech-writer": [
    {
      id: "r1",
      user: "张明",
      rating: 5,
      comment: "非常实用！领导讲话稿生成质量很高，节省了大量时间。",
      created_at: "2026-04-28",
      helpful: 42,
    },
    {
      id: "r2",
      user: "李华",
      rating: 4,
      comment: "整体不错，但部分专业术语需要手动调整。",
      created_at: "2026-04-20",
      helpful: 18,
    },
    {
      id: "r3",
      user: "王芳",
      rating: 5,
      comment: "产品发布会发言稿超出预期，逻辑清晰，语气恰当！",
      created_at: "2026-04-15",
      helpful: 31,
    },
  ],
  default: [
    {
      id: "r0",
      user: "匿名用户",
      rating: 5,
      comment: "很好用，强烈推荐！",
      created_at: "2026-05-01",
      helpful: 12,
    },
  ],
};

function StarPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          className={`text-2xl transition ${
            star <= value ? "text-yellow-400 scale-110" : "text-slate-600 hover:text-yellow-400/50"
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function ReviewCard({ review }: { review: Review }) {
  return (
    <div className="bg-slate-200 dark:bg-slate-800/50 border border-slate-300 dark:border-slate-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-blue-600/30 flex items-center justify-center text-xs font-medium text-blue-400">
            {review.user.charAt(0)}
          </div>
          <span className="text-sm font-medium">{review.user}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((s) => (
              <span
                key={s}
                className={`text-xs ${s <= review.rating ? "text-yellow-400" : "text-slate-600"}`}
              >
                ★
              </span>
            ))}
          </div>
          <span className="text-xs text-slate-500">{review.created_at}</span>
        </div>
      </div>
      <p className="text-slate-700 dark:text-slate-300 text-sm leading-relaxed">{review.comment}</p>
      <div className="mt-2 flex items-center gap-1 text-xs text-slate-500">
        <span>👍</span>
        <span>{review.helpful} 人觉得有用</span>
      </div>
    </div>
  );
}

export default function Feedback({
  skillId,
  skillName,
  initialReviews,
  onReviewSubmit,
}: FeedbackProps) {
  const [reviews, setReviews] = useState<Review[]>(
    initialReviews ?? MOCK_REVIEWS[skillId] ?? MOCK_REVIEWS.default
  );
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  const avgRating =
    reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
      : "0.0";

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (rating === 0) {
        setError("请选择评分");
        return;
      }
      if (!comment.trim()) {
        setError("请填写评论内容");
        return;
      }
      setSubmitting(true);
      setError("");

      const newReview: Omit<Review, "id" | "created_at" | "helpful"> = {
        user: name.trim() || "匿名用户",
        rating,
        comment: comment.trim(),
      };

      try {
        const feedbackUrl = process.env.NEXT_PUBLIC_FEEDBACK_API_URL;
        if (feedbackUrl) {
          const res = await fetch(`${feedbackUrl.replace(/\/$/, "")}/${skillId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newReview),
          });
          if (!res.ok) throw new Error("API not available");
        }
      } catch {
        // 无配置或失败时仅本地展示
      }

      const localReview: Review = {
        ...newReview,
        id: `local-${Date.now()}`,
        created_at: new Date().toISOString().slice(0, 10),
        helpful: 0,
      };

      setReviews((prev) => [localReview, ...prev]);
      onReviewSubmit?.(newReview);
      setSubmitted(true);
      setRating(0);
      setComment("");
      setName("");
      setSubmitting(false);

      setTimeout(() => setSubmitted(false), 4000);
    },
    [rating, comment, name, skillId, onReviewSubmit]
  );

  const displayReviews = showAll ? reviews : reviews.slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl p-5">
        <h3 className="text-lg font-semibold mb-4">用户反馈</h3>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="text-center sm:text-left">
            <p className="text-5xl font-bold text-yellow-400">{avgRating}</p>
            <div className="flex gap-0.5 justify-center sm:justify-start mt-1 mb-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <span
                  key={s}
                  className={`text-lg ${s <= Math.round(Number(avgRating)) ? "text-yellow-400" : "text-slate-600"}`}
                >
                  ★
                </span>
              ))}
            </div>
            <p className="text-slate-500 text-xs">{reviews.length} 条评价</p>
          </div>
          <div className="hidden sm:block w-px h-16 bg-slate-300 dark:bg-slate-700 mx-2" />
          <div className="flex-1">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = reviews.filter((r) => r.rating === star).length;
              const pct = reviews.length > 0 ? (count / reviews.length) * 100 : 0;
              return (
                <div key={star} className="flex items-center gap-2 text-xs mb-1">
                  <span className="text-slate-400 w-4">{star}</span>
                  <span className="text-yellow-400">★</span>
                  <div className="flex-1 bg-slate-300 dark:bg-slate-700 rounded-full h-1.5">
                    <div
                      className="bg-yellow-400 h-1.5 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-slate-500 w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Review Form */}
      <div className="bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl p-5">
        <h3 className="text-base font-semibold mb-3">发表评价</h3>

        {submitted && (
          <div className="mb-4 px-4 py-3 bg-green-600/20 border border-green-600/40 rounded-lg text-green-300 text-sm">
            ✓ 感谢您的评价！
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Star rating */}
          <div>
            <label className="block text-xs text-slate-400 mb-2">评分</label>
            <div
              onMouseLeave={() => setHoverRating(0)}
              className="flex gap-1"
            >
              <StarPicker
                value={hoverRating || rating}
                onChange={(v) => {
                  setRating(v);
                  setHoverRating(0);
                }}
              />
              {rating > 0 && (
                <span className="ml-2 text-sm text-slate-400 self-center">
                  {[null, "", "很差", "较差", "一般", "好", "很好"][rating]} 
                </span>
              )}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">昵称（选填）</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="匿名用户"
              maxLength={30}
              className="w-full bg-slate-300/60 dark:bg-slate-700/60 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
            />
          </div>

          {/* Comment */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              评价内容 <span className="text-red-400">*</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={`分享您使用「${skillName}」的体验…`}
              rows={3}
              maxLength={500}
              className="w-full bg-slate-300/60 dark:bg-slate-700/60 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
            />
            <p className="text-xs text-slate-500 mt-1 text-right">{comment.length}/500</p>
          </div>

          {error && (
            <p className="text-red-400 text-xs">⚠️ {error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition ${
              submitting
                ? "bg-slate-300 dark:bg-slate-700 text-slate-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-500 text-white"
            }`}
          >
            {submitting ? "提交中…" : "提交评价"}
          </button>
        </form>
      </div>

      {/* Review List */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold">
          最新评价 <span className="text-slate-500 font-normal text-sm">({reviews.length})</span>
        </h3>
        {reviews.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-8">暂无评价，来做第一个评价的人吧！</p>
        )}
        <div className="space-y-3">
          {displayReviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </div>
        {reviews.length > 3 && (
          <button
            onClick={() => setShowAll((prev) => !prev)}
            className="w-full py-2 text-sm text-blue-400 hover:text-blue-300 transition text-center"
          >
            {showAll ? "收起 ↑" : `展开全部 ${reviews.length} 条评价 ↓`}
          </button>
        )}
      </div>
    </div>
  );
}
