/* FarmFlow pages — Products, Slots, Route */
const { useState: useState2 } = React;

/* ============ PRODUCTS ============ */
function ProductsPage({ products, setProducts, toast }) {
  const FF = window.FF;
  const [editId, setEditId] = useState2(null);
  const [draft, setDraft] = useState2({ price: "", stock: "" });

  const startEdit = (p) => { setEditId(p.id); setDraft({ price: p.price.toFixed(2).replace(".", ","), stock: String(p.stock) }); };
  const save = (id) => {
    const price = parseFloat(draft.price.replace(",", ".")) || 0;
    const stock = parseInt(draft.stock) || 0;
    setProducts((prev) => prev.map((p) => p.id === id ? { ...p, price, stock } : p));
    setEditId(null);
    toast("Продуктът е обновен", "ok");
  };
  const toggleActive = (id, on) => {
    setProducts((prev) => prev.map((p) => p.id === id ? { ...p, active: on } : p));
  };
  const stockMeta = (s) => s === 0 ? { label: "Изчерпан", c: "var(--muted)" } : s <= 6 ? { label: `Ниска наличност · ${s}`, c: "var(--amber-600)" } : { label: `В наличност · ${s}`, c: "var(--green-700)" };

  return (
    <div style={{ animation: "ff-fade-up .3s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <p style={{ fontSize: 14, color: "var(--muted)" }}>{products.filter((p) => p.active).length} активни · {products.length} общо</p>
        </div>
        <Btn variant="primary" icon={IconPlus} onClick={() => toast("Формата за нов продукт ще се отвори тук", "info")}>Добави продукт</Btn>
      </div>

      <div className="ff-products-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))", gap: 16 }}>
        {products.map((p, i) => {
          const editing = editId === p.id;
          const sm = stockMeta(p.stock);
          return (
            <Card key={p.id} pad={14} style={{ opacity: p.active ? 1 : 0.62, transition: "opacity .2s", animation: `ff-fade-up .35s ease ${i * 0.03}s both`, display: "flex", flexDirection: "column" }}>
              <ProductThumb tint={p.tint} />
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginTop: 13, gap: 8 }}>
                <div>
                  <div style={{ fontSize: 15.5, fontWeight: 800, lineHeight: 1.2 }}>{p.name}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{p.weight} · {p.cat}</div>
                </div>
                <Toggle small on={p.active} onChange={(v) => toggleActive(p.id, v)} />
              </div>

              {editing ? (
                <div style={{ marginTop: 13, display: "flex", flexDirection: "column", gap: 9 }}>
                  <label style={ffP2.editLabel}>Цена (лв)
                    <input autoFocus value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} style={ffP2.editInput} />
                  </label>
                  <label style={ffP2.editLabel}>Наличност (бр.)
                    <input value={draft.stock} onChange={(e) => setDraft((d) => ({ ...d, stock: e.target.value }))} style={ffP2.editInput} />
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                    <Btn variant="primary" icon={IconCheck} onClick={() => save(p.id)} style={{ flex: 1, padding: "8px 10px", fontSize: 13.5 }}>Запази</Btn>
                    <Btn variant="ghost" onClick={() => setEditId(null)} style={{ padding: "8px 12px", fontSize: 13.5 }}>Отказ</Btn>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 14 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>{FF.money(p.price)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 99, background: sm.c }}></span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: sm.c }}>{sm.label}</span>
                  </div>
                  <button className="ff-edit-btn" onClick={() => startEdit(p)} style={ffP2.editBtn}>
                    <IconEdit size={15} /> Редактирай
                  </button>
                </>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ============ SLOTS ============ */
function SlotsPage({ toast }) {
  const FF = window.FF;
  const [week, setWeek] = useState2(FF.slots);

  const slotColor = (s) => {
    if (s.booked >= s.cap) return { bg: "var(--gray-badge-bg)", ink: "var(--gray-badge-ink)", bar: "var(--muted-2)" };
    if (s.booked / s.cap >= 0.8) return { bg: "var(--amber-softer)", ink: "var(--amber-600)", bar: "var(--amber)" };
    return { bg: "var(--green-50)", ink: "var(--green-700)", bar: "var(--green-500)" };
  };

  return (
    <div style={{ animation: "ff-fade-up .3s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>Седмица 25 – 31 май 2026 · Варна</p>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12.5, fontWeight: 600, color: "var(--muted)" }}>
            <Legend c="var(--green-500)" t="свободно" />
            <Legend c="var(--amber)" t="почти пълно" />
            <Legend c="var(--muted-2)" t="пълно" />
          </div>
        </div>
      </div>

      <div className="ff-slots-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 12, alignItems: "start" }}>
        {week.map((day, di) => (
          <div key={day.day} className="ff-slot-day" style={{
            background: day.today ? "var(--surface)" : "var(--surface)", border: day.today ? "2px solid var(--green-600)" : "1px solid var(--border)",
            borderRadius: 14, overflow: "hidden", boxShadow: day.today ? "0 6px 20px rgba(44,85,48,0.14)" : "var(--shadow-sm)",
          }}>
            <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-2)", background: day.today ? "var(--green-50)" : "transparent", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: day.today ? "var(--green-800)" : "var(--ink)" }}>{day.short}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginTop: 1 }}>{day.date}</div>
              {day.today && <div style={{ fontSize: 10.5, fontWeight: 800, color: "var(--green-700)", marginTop: 4, letterSpacing: "0.03em" }}>ДНЕС</div>}
            </div>
            <div style={{ padding: 9, display: "flex", flexDirection: "column", gap: 7, minHeight: 90 }}>
              {day.slots.map((s, si) => {
                const c = slotColor(s);
                const pct = Math.round((s.booked / s.cap) * 100);
                return (
                  <div key={si} className="ff-slot-pill" style={{ background: c.bg, borderRadius: 10, padding: "8px 9px", cursor: "pointer" }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap" }}>{s.time}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                      <div style={{ flex: 1, height: 5, borderRadius: 99, background: "rgba(0,0,0,0.07)", marginRight: 7, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: c.bar, borderRadius: 99 }}></div>
                      </div>
                      <span style={{ fontSize: 11.5, fontWeight: 800, color: c.ink }}>{s.booked}/{s.cap}</span>
                    </div>
                  </div>
                );
              })}
              <button className="ff-add-slot" onClick={() => toast(`Нов слот за ${day.day}`, "info")} style={{
                marginTop: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                padding: "8px", borderRadius: 10, border: "1.5px dashed var(--border)", color: "var(--muted)",
                fontSize: 12, fontWeight: 700, transition: "border-color .15s, color .15s, background .15s",
              }}>
                <IconPlus size={15} /> Слот
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ c, t }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: c }}></span>{t}</span>;
}

/* ============ ROUTE ============ */
function RoutePage({ toast }) {
  const FF = window.FF;
  const stops = FF.route;
  const [activeStop, setActiveStop] = useState2(stops[0].id);

  return (
    <div style={{ animation: "ff-fade-up .3s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>{stops.length} спирки · 11.4 км · ориентир. 1 ч 25 мин</p>
        <div style={ffPageStyles.datePick}>
          <IconSlots size={17} /><span>събота, 30 май</span><IconChevronDown size={16} />
        </div>
      </div>

      <div className="ff-route-grid" style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 16, alignItems: "stretch", height: "calc(100vh - var(--topbar-h) - 152px)", minHeight: 460 }}>
        {/* stops list */}
        <Card className="ff-route-list" pad={0} style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "16px 18px 13px", borderBottom: "1px solid var(--border-2)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800 }}>Маршрут за доставка</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="outline" icon={IconNavigate} style={{ padding: "7px 11px", fontSize: 13 }} onClick={() => toast("Маршрутът се отваря в Google Maps", "info")}>Google Maps</Btn>
              <Btn variant="soft" icon={IconTruck} style={{ padding: "7px 11px", fontSize: 13 }} onClick={() => toast("Маршрутът е изпратен към навигацията", "ok")}>Старт</Btn>
            </div>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {stops.map((s, i) => (
              <div key={s.id} className="ff-stop" data-on={activeStop === s.id} onClick={() => setActiveStop(s.id)} style={{
                display: "flex", gap: 13, padding: "14px 18px", borderBottom: "1px solid var(--border-2)", cursor: "pointer",
                background: activeStop === s.id ? "var(--green-50)" : "transparent", transition: "background .14s",
              }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <span style={{ width: 28, height: 28, borderRadius: 99, background: activeStop === s.id ? "var(--green-700)" : "var(--green-100)", color: activeStop === s.id ? "#fff" : "var(--green-800)", display: "grid", placeItems: "center", fontSize: 13.5, fontWeight: 800, flexShrink: 0 }}>{i + 1}</span>
                  {i < stops.length - 1 && <span style={{ width: 2, flex: 1, background: "var(--border)", marginTop: 4, minHeight: 14 }}></span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700 }}>{s.customer}</div>
                    <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
                      <button className="ff-call" onClick={(e) => { e.stopPropagation(); toast(`Отваряне в Google Maps: ${s.address}`, "info"); }} title="Отвори в Google Maps" style={{
                        width: 32, height: 32, borderRadius: 9, background: "var(--green-100)", color: "var(--green-700)", display: "grid", placeItems: "center",
                      }}><IconNavigate size={16} /></button>
                      <button className="ff-call" onClick={(e) => { e.stopPropagation(); toast(`Обаждане до ${s.customer}…`, "info"); }} title="Обади се" style={{
                        width: 32, height: 32, borderRadius: 9, background: "var(--green-100)", color: "var(--green-700)", display: "grid", placeItems: "center",
                      }}><IconPhone size={16} /></button>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 2, display: "flex", alignItems: "center", gap: 5 }}><IconPin size={14} /> {s.address}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>{s.summary} · <span style={{ fontWeight: 600 }}>{s.slot}</span></div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* map placeholder */}
        <Card className="ff-route-map" pad={0} style={{ overflow: "hidden", position: "relative" }}>
          <MapPlaceholder stops={stops} activeStop={activeStop} onPick={setActiveStop} />
        </Card>
      </div>
    </div>
  );
}

function MapPlaceholder({ stops, activeStop, onPick }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#E9E7DF" }}>
      {/* subtle grid */}
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <defs>
          <pattern id="ffgrid" width="46" height="46" patternUnits="userSpaceOnUse">
            <path d="M46 0H0V46" fill="none" stroke="#D8D5CA" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ffgrid)" />
        {/* fake roads */}
        <path d="M-20 70 Q 200 40 420 130 T 900 180" fill="none" stroke="#D2CFC3" strokeWidth="11" strokeLinecap="round" />
        <path d="M120 -20 Q 180 200 120 460 T 260 900" fill="none" stroke="#D2CFC3" strokeWidth="9" strokeLinecap="round" />
        <path d="M-20 320 Q 320 300 620 380 T 1100 360" fill="none" stroke="#D2CFC3" strokeWidth="8" strokeLinecap="round" />
      </svg>

      {/* route line between pins */}
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} preserveAspectRatio="none" viewBox="0 0 100 100">
        <polyline points={stops.map((s) => `${s.lng},${s.lat}`).join(" ")} fill="none" stroke="var(--green-600)" strokeWidth="0.7" strokeDasharray="1.4 1.4" strokeLinecap="round" opacity="0.75" />
      </svg>

      {/* pins */}
      {stops.map((s, i) => (
        <button key={s.id} onClick={() => onPick(s.id)} style={{
          position: "absolute", left: `${s.lng}%`, top: `${s.lat}%`, transform: "translate(-50%, -100%)",
          transition: "transform .15s", zIndex: activeStop === s.id ? 3 : 1,
        }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: activeStop === s.id ? "scale(1.12)" : "scale(1)", transition: "transform .15s" }}>
            <span style={{
              width: 30, height: 30, borderRadius: "50% 50% 50% 2px", transform: "rotate(45deg)",
              background: activeStop === s.id ? "var(--amber)" : "var(--green-700)",
              boxShadow: "0 4px 10px rgba(0,0,0,0.25)", display: "grid", placeItems: "center",
            }}>
              <span style={{ transform: "rotate(-45deg)", color: activeStop === s.id ? "#3a2a08" : "#fff", fontWeight: 800, fontSize: 13.5 }}>{i + 1}</span>
            </span>
          </div>
        </button>
      ))}

      {/* Google Maps label */}
      <div style={{ position: "absolute", left: 14, bottom: 13, fontSize: 21, fontWeight: 700, color: "#9A9788", letterSpacing: "-0.01em", userSelect: "none" }}>Google Maps</div>
      <div style={{ position: "absolute", right: 14, top: 13, background: "rgba(255,255,255,0.82)", borderRadius: 9, padding: "7px 11px", fontSize: 12, fontWeight: 700, color: "var(--ink-2)", boxShadow: "var(--shadow-sm)" }}>
        Демо карта — място за Google Maps
      </div>
      {/* zoom controls */}
      <div style={{ position: "absolute", right: 14, bottom: 13, display: "flex", flexDirection: "column", borderRadius: 9, overflow: "hidden", boxShadow: "var(--shadow-md)", background: "#fff" }}>
        <button className="ff-bell" style={{ width: 36, height: 34, display: "grid", placeItems: "center", borderBottom: "1px solid var(--border-2)", color: "var(--ink-2)" }}><IconPlus size={17} /></button>
        <button className="ff-bell" style={{ width: 36, height: 34, display: "grid", placeItems: "center", color: "var(--ink-2)", fontSize: 20, fontWeight: 700 }}>−</button>
      </div>
    </div>
  );
}

Object.assign(window, { ProductsPage, SlotsPage, RoutePage, Legend, MapPlaceholder });

const ffP2 = {
  editLabel: { fontSize: 11.5, fontWeight: 700, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 },
  editInput: { border: "1px solid var(--border)", borderRadius: 8, padding: "8px 11px", fontSize: 14.5, fontWeight: 700, color: "var(--ink)", outline: "none", background: "var(--surface-2)" },
  editBtn: { marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px", borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--ink-2)", fontSize: 13, fontWeight: 700, width: "100%", transition: "background .14s" },
};
window.ffP2 = ffP2;
