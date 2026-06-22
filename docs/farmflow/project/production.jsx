/* ФермериБГ — Производство (daily prep list aggregated from confirmed orders) */
const { useState: useProdState, useMemo: useProdMemo } = React;

function ProductionPage({ orders, toast }) {
  // aggregate confirmed orders → per-product totals + order counts
  const agg = useProdMemo(() => {
    const map = new Map();
    orders.filter((o) => o.status === "confirmed").forEach((o) => {
      o.items.forEach((it) => {
        const cur = map.get(it.name) || { name: it.name, qty: 0, orders: new Set(), tint: tintFor(it.name) };
        cur.qty += it.qty;
        cur.orders.add(o.id);
        map.set(it.name, cur);
      });
    });
    return Array.from(map.values())
      .map((r) => ({ ...r, orders: r.orders.size }))
      .sort((a, b) => b.qty - a.qty);
  }, [orders]);

  const confirmedCount = orders.filter((o) => o.status === "confirmed").length;
  const [done, setDone] = useProdState({});
  const doneCount = agg.filter((r) => done[r.name]).length;
  const allDone = agg.length > 0 && doneCount === agg.length;

  const toggle = (name) => setDone((d) => ({ ...d, [name]: !d[name] }));

  return (
    <div style={{ animation: "ff-fade-up .3s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <p style={{ fontSize: 15, color: "var(--ink-2)", fontWeight: 600 }}>
          <strong style={{ color: "var(--ink)", fontWeight: 800 }}>{confirmedCount}</strong> потвърдени поръчки
          <span style={{ color: "var(--muted-2)", margin: "0 8px" }}>·</span>
          <strong style={{ color: "var(--ink)", fontWeight: 800 }}>{agg.length}</strong> продукта за приготвяне
        </p>
        <div style={ffPageStyles.datePick}>
          <IconSlots size={17} /><span>събота, 30 май 2026</span><IconChevronDown size={16} />
        </div>
      </div>

      <div className="ff-prod-grid" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, alignItems: "start" }}>
        {/* prep list */}
        <Card pad={0} style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 22px 15px", borderBottom: "1px solid var(--border-2)" }}>
            <h2 style={{ fontSize: 17, fontWeight: 800 }}>За приготвяне днес</h2>
            <span style={{ fontSize: 13, fontWeight: 700, color: allDone ? "var(--green-700)" : "var(--muted)" }}>
              {doneCount}/{agg.length} готови
            </span>
          </div>

          {agg.map((r, i) => {
            const isDone = !!done[r.name];
            return (
              <button key={r.name} onClick={() => toggle(r.name)} className="ff-prep-row" data-on={isDone} style={{
                display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 18, alignItems: "center", width: "100%",
                textAlign: "left", padding: "20px 22px", borderBottom: i < agg.length - 1 ? "1px solid var(--border-2)" : "none",
                transition: "background .14s",
              }}>
                {/* checkbox */}
                <span style={{
                  width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: "grid", placeItems: "center",
                  border: isDone ? "none" : "2px solid var(--border)", background: isDone ? "var(--green-600)" : "var(--surface)",
                  color: "#fff", transition: "background .14s, border-color .14s",
                }}>
                  {isDone && <IconCheck size={17} stroke={3} />}
                </span>

                {/* name */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.01em", color: isDone ? "var(--muted)" : "var(--ink)", textDecoration: isDone ? "line-through" : "none", textDecorationColor: "var(--muted-2)" }}>
                    {r.name}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>от {r.orders} {r.orders === 1 ? "поръчка" : "поръчки"}</div>
                </div>

                {/* qty */}
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
                  <span className="ff-fig" style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.03em", color: isDone ? "var(--muted-2)" : "var(--green-700)", lineHeight: 1 }}>{r.qty}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "var(--muted)" }}>бр</span>
                </div>
              </button>
            );
          })}

          {!agg.length && (
            <div style={{ padding: "56px 20px", textAlign: "center", color: "var(--muted)" }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--green-50)", color: "var(--green-600)", display: "grid", placeItems: "center", margin: "0 auto 12px" }}>
                <IconBasket size={28} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink-2)" }}>Няма потвърдени поръчки</div>
              <div style={{ fontSize: 13.5, marginTop: 3 }}>Потвърди поръчки, за да се появи списъкът за приготвяне.</div>
            </div>
          )}
        </Card>

        {/* side: progress + tip */}
        <div className="ff-prod-side" style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 0 }}>
          <Card style={{ borderTop: "3px solid var(--green-600)" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--muted)", marginBottom: 12 }}>Напредък</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="ff-fig" style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--ink)" }}>{doneCount}</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: "var(--muted-2)" }}>/ {agg.length}</span>
            </div>
            <div style={{ height: 9, borderRadius: 99, background: "var(--border-2)", overflow: "hidden", marginTop: 14 }}>
              <div style={{ height: "100%", width: `${agg.length ? (doneCount / agg.length) * 100 : 0}%`, background: allDone ? "var(--green-600)" : "var(--green-500)", borderRadius: 99, transition: "width .35s" }}></div>
            </div>
            <div style={{ fontSize: 13, color: allDone ? "var(--green-700)" : "var(--muted)", fontWeight: 600, marginTop: 12, lineHeight: 1.4 }}>
              {allDone ? "Всичко е приготвено — готов за доставка! 🌿" : `Общо ${agg.reduce((s, r) => s + r.qty, 0)} бройки за приготвяне.`}
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
              <span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--amber-softer)", color: "var(--amber-600)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                <IconClock size={19} />
              </span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>Преди бране</div>
                <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3, lineHeight: 1.5 }}>
                  Чекни всеки продукт, докато го приготвяш. Списъкът се събира автоматично от потвърдените поръчки за деня.
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// map item name → product tint (for any future use / consistency)
function tintFor(name) {
  const t = [
    ["Ягоди", "#D94A4A"], ["Боровинки", "#5B5BA8"], ["Малини", "#C0426B"], ["Къпини", "#3B3B57"],
    ["Череши", "#A11E2E"], ["Сироп", "#C13A52"], ["сладко", "#B23B5E"], ["Мед", "#D89A2B"], ["Арония", "#4A2E55"],
  ].find(([k]) => name.includes(k));
  return t ? t[1] : "#8B8573";
}

Object.assign(window, { ProductionPage, tintFor });
