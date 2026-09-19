import React, { useState } from "react";
import { Star, CheckCircle2 } from "lucide-react";
import { submitFeedback } from "./lib/api";

const TAGS = ["برخورد خوب", "کیفیت کار", "وقت‌شناسی", "محیط تمیز", "قیمت مناسب"];

export default function FeedbackPage({ bookingId }) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [tags, setTags] = useState([]);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  function toggleTag(t) {
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function submit() {
    if (!rating) { setError("لطفاً امتیاز بدهید"); return; }
    setSubmitting(true);
    setError("");
    const res = await submitFeedback({ bookingId, rating, tags, comment });
    setSubmitting(false);
    if (!res.ok) { setError(res.error); return; }
    setDone(true);
  }

  const wrap = {
    minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20, background: "#faf7f5", fontFamily: "Vazirmatn, system-ui, sans-serif",
  };
  const card = {
    width: "100%", maxWidth: 380, background: "white", borderRadius: 20,
    padding: 28, boxShadow: "0 4px 24px rgba(0,0,0,.08)", textAlign: "center",
  };

  if (done) {
    return (
      <div dir="rtl" style={wrap}>
        <div style={card}>
          <CheckCircle2 size={52} color="#4caf7d" style={{ margin: "0 auto 14px" }} />
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>ممنون از نظرتون!</h2>
          <p style={{ fontSize: 13.5, color: "#777" }}>نظر شما به ما کمک می‌کنه خدمات بهتری ارائه بدیم.</p>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" style={wrap}>
      <div style={card}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>نوبت شما چطور بود؟</h2>
        <p style={{ fontSize: 12.5, color: "#888", marginBottom: 18 }}>چند ثانیه وقت بگذارید و نظرتون رو باهامون در میون بذارید</p>

        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 16 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setRating(n)}
              onMouseEnter={() => setHoverRating(n)}
              onMouseLeave={() => setHoverRating(0)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}
              aria-label={`${n} ستاره`}
            >
              <Star size={32} fill={n <= (hoverRating || rating) ? "#f5b301" : "none"} color="#f5b301" strokeWidth={1.5} />
            </button>
          ))}
        </div>

        {rating > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 16 }}>
            {TAGS.map((t) => (
              <button
                key={t}
                onClick={() => toggleTag(t)}
                style={{
                  padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: tags.includes(t) ? "1px solid #c98a4b" : "1px solid #ddd",
                  background: tags.includes(t) ? "#c98a4b" : "white",
                  color: tags.includes(t) ? "white" : "#555",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="نظر شما (اختیاری)"
          style={{ width: "100%", minHeight: 70, padding: 10, borderRadius: 10, border: "1px solid #ddd", fontSize: 13, resize: "vertical", fontFamily: "inherit", marginBottom: 14 }}
        />

        {error && <p style={{ color: "#d33", fontSize: 12, marginBottom: 10 }}>{error}</p>}

        <button
          onClick={submit}
          disabled={submitting}
          style={{
            width: "100%", padding: 13, borderRadius: 12, border: "none", cursor: "pointer",
            background: "#c98a4b", color: "white", fontSize: 14, fontWeight: 700, fontFamily: "inherit",
          }}
        >
          {submitting ? "در حال ثبت..." : "ثبت نظر"}
        </button>
      </div>
    </div>
  );
}
