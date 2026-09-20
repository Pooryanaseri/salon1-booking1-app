function FeedbackStatsCard() {
  const { data: stats, loading, refetch } = useData(fetchFeedbackStats, [], { cacheKey: "feedback_stats" });
  const total = stats?.total_count || 0;
  const maxCount = Math.max(1, ...[1, 2, 3, 4, 5].map((n) => Number(stats?.[`rating_${n}`] || 0)));

  if (!SUPABASE_ENABLED) {
    return (
      <div className="card mb-4" style={{ padding: 14, background: "var(--color-bg-secondary)", border: "1px dashed var(--color-border)" }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary)" }}>
          این بخش به دیتابیس Supabase نیاز دارد. با اتصال به Supabase، میانگین رضایت مشتریان و توزیع نظرات به صورت خودکار در این کارت نمایش داده می‌شود.
        </p>
      </div>
    );
  }

  if (loading && !stats) {
    return (
      <div className="card mb-4" style={{ padding: 16, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
        در حال بارگذاری شاخص‌های رضایت...
      </div>
    );
  }

  if (total === 0 && !loading) {
    return (
      <div className="card mb-4" style={{ padding: 14, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
        هنوز نظری ثبت نشده است. پس از ارسال پیامک نظرسنجی و ثبت نظر توسط مشتریان، آمار در این بخش نمایش داده خواهد شد.
      </div>
    );
  }

  return (
    <div className="card mb-4" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--color-heading)" }}>شاخص رضایت مشتریان</h4>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{toFa(total)} نظر ثبت‌شده</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <div className="tabular" style={{ fontSize: 28, fontWeight: 800, color: "var(--color-heading)" }}>
          {toFa(stats?.avg_rating || 0)}
        </div>
        <div>
          <div style={{ display: "flex", gap: 2, marginBottom: 2 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                size={14}
                fill={n <= Math.round(stats?.avg_rating || 0) ? "var(--color-warning)" : "none"}
                color="var(--color-warning)"
              />
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>از ۵ ستاره</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {[5, 4, 3, 2, 1].map((n) => {
          const count = Number(stats?.[`rating_${n}`] || 0);
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ width: 14, textAlign: "left", color: "var(--color-text-secondary)" }}>{toFa(n)}</span>
              <div style={{ flex: 1, height: 6, background: "var(--color-bg-secondary)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--color-warning)", borderRadius: 3 }} />
              </div>
              <span className="tabular" style={{ width: 36, textAlign: "right", color: "var(--color-text-secondary)", fontSize: 11 }}>
                {toFa(count)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
