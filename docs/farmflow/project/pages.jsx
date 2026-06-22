/* ФермериБГ pages */
const { useState, useMemo } = React;

/* ============ DASHBOARD ============ */
function DashboardPage({ orders, setOrders, toast, onNavigate, onOpenOrder }) {
  const FF = window.FF;
  const todayOrders = orders;
  const pending = orders.filter((o) => o.status === "pending");
  const revenue = orders.filter((o) => o.status !== "cancelled").reduce((s, o) => s + o.total, 0);
  const nextSlot = FF.slots.find((d) => d.today)?.slots.find((s) => s.booked < s.cap);

  const confirmAll = () => {
    if (!pending.length) { toast("Няма чакащи поръчки", "info"); return; }
    setOrders((prev) => prev.map((o) => o.status === "pending" ? { ...o, status: "confirmed" } : o));
    toast(`${pending.length} поръчки потвърдени`, "ok");
  };

  const stats = [
    { Icon: IconBox, label: "Поръчки днес", value: todayOrders.length, sub: "+4 спрямо вчера", tint: "var(--green-700)", bg: "var(--green-50)" },
    { Icon: IconCoins, label: "Оборот днес", value: FF.money(revenue), sub: "без отказани", tint: "var(--amber-600)", bg: "var(--amber-softer)" },
    { Icon: IconHourglass, label: "Чакат потвърждение", value: pending.length, sub: pending.length ? "изискват действие" : "всичко чисто", tint: "var(--amber-600)", bg: "var(--amber-softer)" },
    { Icon: IconClock, label: "Следващ слот", value: nextSlot ? `${nextSlot.booked}/${nextSlot.cap}` : "—", sub: nextSlot ? nextSlot.time : "няма свободни", tint: "var(--green-700)", bg: "var(--green-50)" },
  ];

  return (
    <div style={{ animation: "ff-fade-up .3s ease" }}>
      {/* stats */}
      <div className="ff-stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        {stats.map((s, i) => (
          <Card key={i} pad={18} style={{ borderTop: "3px solid var(--green-600)", animation: `ff-fade-up .35s ease ${i * 0.04}s both` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: s.bg, color: s.tint, display: "grid", placeItems: "center" }}>
                <s.Icon size={22} />
              </div>
            </div>
            <div className="ff-fig" style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 14, color: "var(--ink)" }}>{s.value}</div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink-2)", marginTop: 2 }}>{s.label}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{s.sub}</div>
          </Card>
        ))}
      </div>

      <div className="ff-dash-grid" style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
        {/* feed */}
        <Card pad={0} style={{ overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 14px", borderBottom: "1px solid var(--border-2)" }}>
            <h2 style={{ fontSize: 16.5, fontWeight: 800, whiteSpace: "nowrap" }}>Поръчки за днес</h2>
            <button onClick={() => onNavigate("orders")} style={{ fontSize: 13.5, fontWeight: 700, color: "var(--green-700)", display: "inline-flex", alignItems: "center", gap: 3 }}>
              Всички <IconChevron size={15} />
            </button>
          </div>
          <div>
            {todayOrders.map((o, idx) => (
              <button key={o.id} className="ff-feed-row" onClick={() => onOpenOrder(o.id)} style={{
                display: "grid", gridTemplateColumns: "52px 1fr auto auto", gap: 14, alignItems: "center",
                width: "100%", textAlign: "left", padding: "13px 20px", borderBottom: idx < todayOrders.length - 1 ? "1px solid var(--border-2)" : "none",
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)" }}>{o.time}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>{o.customer}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {o.items.map((it) => `${it.name} ×${it.qty}`).join(", ")}
                  </div>
                </div>
                <StatusBadge status={o.status} size="sm" />
                <div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)", textAlign: "right", minWidth: 76 }}>{FF.money(o.total)}</div>
              </button>
            ))}
          </div>
        </Card>

        {/* quick actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <h2 style={{ fontSize: 16.5, fontWeight: 800, marginBottom: 4 }}>Бързи действия</h2>
            <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16, lineHeight: 1.45 }}>Започни деня с няколко клика.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button className="ff-action" onClick={confirmAll} style={ffPageStyles.actionAmber}>
                <span style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(255,255,255,0.35)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <IconCheckAll size={22} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, textAlign: "left", minWidth: 0, lineHeight: 1.3 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 800 }}>Потвърди всички чакащи</span>
                  <span style={{ fontSize: 12.5, opacity: 0.8 }}>{pending.length} поръчки</span>
                </span>
              </button>
              <button className="ff-action" onClick={() => onNavigate("route")} style={ffPageStyles.actionGreen}>
                <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--green-100)", color: "var(--green-700)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <IconRoute size={22} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, textAlign: "left", minWidth: 0, lineHeight: 1.3 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)" }}>Виж маршрута за днес</span>
                  <span style={{ fontSize: 12.5, color: "var(--muted)" }}>5 спирки · 11.4 км</span>
                </span>
              </button>
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <h2 style={{ fontSize: 16.5, fontWeight: 800 }}>Капацитет днес</h2>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--muted)" }}>събота</span>
            </div>
            {FF.slots.find((d) => d.today).slots.map((s, i) => {
              const pct = Math.round((s.booked / s.cap) * 100);
              const c = s.booked >= s.cap ? "var(--muted-2)" : s.booked / s.cap >= 0.8 ? "var(--amber)" : "var(--green-500)";
              return (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                    <span style={{ fontWeight: 600, color: "var(--ink-2)" }}>{s.time}</span>
                    <span style={{ fontWeight: 700, color: c }}>{s.booked}/{s.cap}</span>
                  </div>
                  <div style={{ height: 7, borderRadius: 99, background: "var(--border-2)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: c, borderRadius: 99, transition: "width .4s" }}></div>
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ============ ORDERS ============ */
function OrdersPage({ orders, setOrders, toast, openId, setOpenId }) {
  const FF = window.FF;
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => orders.filter((o) => {
    if (statusFilter !== "all" && o.status !== statusFilter) return false;
    if (query && !o.customer.toLowerCase().includes(query.toLowerCase()) && !o.id.includes(query)) return false;
    return true;
  }), [orders, statusFilter, query]);

  const open = orders.find((o) => o.id === openId);
  const setStatus = (id, status) => {
    setOrders((prev) => prev.map((o) => o.id === id ? { ...o, status } : o));
    toast(`Поръчка #${id}: ${FF.statusMeta[status].label.toLowerCase()}`, "ok");
  };

  const filters = [
    { id: "all", label: "Всички" },
    { id: "pending", label: "Чакащи" },
    { id: "confirmed", label: "Потвърдени" },
    { id: "delivered", label: "Доставени" },
    { id: "cancelled", label: "Отказани" },
  ];

  return (
    <div style={{ animation: "ff-fade-up .3s ease" }}>
      {/* toolbar */}
      <div className="ff-orders-toolbar" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div className="ff-search" style={ffPageStyles.searchWrap}>
          <IconSearch size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Търси клиент или № поръчка…" style={ffPageStyles.searchInput} />
        </div>
        <div style={ffPageStyles.datePick}>
          <IconSlots size={17} />
          <span>30 май 2026</span>
          <IconChevronDown size={16} />
        </div>
        <div className="ff-filters" style={{ display: "flex", gap: 6, marginLeft: "auto", background: "var(--surface)", padding: 5, borderRadius: 12, border: "1px solid var(--border)", boxShadow: "var(--shadow-sm)" }}>
          {filters.map((f) => (
            <button key={f.id} onClick={() => setStatusFilter(f.id)} style={{
              padding: "7px 13px", borderRadius: 9, fontSize: 13.5, fontWeight: 700,
              background: statusFilter === f.id ? "var(--green-700)" : "transparent",
              color: statusFilter === f.id ? "#fff" : "var(--ink-2)", transition: "background .14s",
            }}>{f.label}</button>
          ))}
        </div>
      </div>

      {/* table (desktop) */}
      <Card className="ff-orders-table" pad={0} style={{ overflow: "hidden" }}>
        <div style={ffPageStyles.theadRow}>
          <div>Час</div><div>Клиент</div><div>Продукти</div><div>Доставка</div><div>Статус</div><div style={{ textAlign: "right" }}>Сума</div>
        </div>
        <div>
          {filtered.map((o) => (
            <button key={o.id} className="ff-feed-row" data-on={openId === o.id} onClick={() => setOpenId(o.id)} style={ffPageStyles.trow}>
              <div style={{ fontWeight: 700, color: "var(--muted)", fontSize: 13.5 }}>{o.time}</div>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 700 }}>{o.customer}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>#{o.id}</div>
              </div>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o.items.map((it) => it.name.replace(/\s\d.*/, "")).join(", ")}
                <span style={{ color: "var(--muted)" }}> · {o.items.reduce((s, it) => s + it.qty, 0)} бр.</span>
              </div>
              <div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: o.delivery === "Еконт" ? "var(--amber-600)" : "var(--green-700)" }}>
                  {o.delivery === "Еконт" ? <IconBox size={16} /> : <IconPin size={16} />}{o.delivery}
                </span>
              </div>
              <div><StatusBadge status={o.status} size="sm" /></div>
              <div style={{ textAlign: "right", fontSize: 14.5, fontWeight: 800 }}>{FF.money(o.total)}</div>
            </button>
          ))}
          {!filtered.length && (
            <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--muted)", fontSize: 14.5 }}>Няма поръчки за този филтър.</div>
          )}
        </div>
      </Card>

      {/* card list (mobile) */}
      <div className="ff-orders-cards" style={{ display: "none", flexDirection: "column", gap: 11 }}>
        {filtered.map((o) => (
          <button key={o.id} className="ff-order-card" onClick={() => setOpenId(o.id)} style={{
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-sm)",
            padding: 15, textAlign: "left", width: "100%", display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 800 }}>{o.customer}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 1 }}>{o.time} · #{o.id}</div>
              </div>
              <StatusBadge status={o.status} size="sm" />
            </div>
            <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.4 }}>
              {o.items.map((it) => `${it.name.replace(/\s\d.*/, "")} ×${it.qty}`).join(", ")}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 10, borderTop: "1px solid var(--border-2)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: o.delivery === "Еконт" ? "var(--amber-600)" : "var(--green-700)" }}>
                {o.delivery === "Еконт" ? <IconBox size={16} /> : <IconPin size={16} />}{o.delivery}
              </span>
              <span style={{ fontSize: 16.5, fontWeight: 800 }}>{FF.money(o.total)}</span>
            </div>
          </button>
        ))}
        {!filtered.length && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--muted)", fontSize: 14.5 }}>Няма поръчки за този филтър.</div>
        )}
      </div>

      {/* slide-out detail */}
      <OrderPanel order={open} onClose={() => setOpenId(null)} setStatus={setStatus} />
    </div>
  );
}

function OrderPanel({ order, onClose, setStatus }) {
  const FF = window.FF;
  if (!order) return null;
  const actions = [
    { status: "confirmed", label: "Потвърди", variant: "primary", Icon: IconCheck },
    { status: "delivered", label: "Маркирай доставена", variant: "soft", Icon: IconTruck },
    { status: "cancelled", label: "Откажи", variant: "danger", Icon: IconClose },
  ].filter((a) => a.status !== order.status);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(30,28,15,0.32)", zIndex: 40, animation: "ff-fade .2s ease" }}></div>
      <div className="ff-order-panel" style={ffPageStyles.panel}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "22px 24px 18px", borderBottom: "1px solid var(--border-2)" }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--muted)", marginBottom: 3 }}>ПОРЪЧКА #{order.id}</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em" }}>{order.customer}</h2>
          </div>
          <button className="ff-bell" onClick={onClose} style={{ width: 40, height: 40, borderRadius: 11, background: "var(--surface-2)", border: "1px solid var(--border)", display: "grid", placeItems: "center", color: "var(--ink-2)" }}>
            <IconClose size={20} />
          </button>
        </div>

        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <StatusBadge status={order.status} />
            <span style={{ fontSize: 13, color: "var(--muted)" }}>· приета в {order.time}</span>
          </div>

          {/* contact */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
            <InfoRow Icon={IconPhone} label="Телефон" value={order.phone} />
            <InfoRow Icon={order.delivery === "Еконт" ? IconBox : IconPin} label={order.delivery === "Еконт" ? "Еконт офис" : "Адрес за доставка"} value={order.address} />
            <InfoRow Icon={IconClock} label="Слот за доставка" value={order.slot} />
          </div>

          {order.note && (
            <div style={{ background: "var(--amber-softer)", border: "1px solid var(--amber-soft)", borderRadius: 12, padding: "12px 14px", marginBottom: 22 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--amber-600)", marginBottom: 3 }}>БЕЛЕЖКА ОТ КЛИЕНТА</div>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{order.note}</div>
            </div>
          )}

          {/* items */}
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)", marginBottom: 10 }}>ПРОДУКТИ</div>
          <div style={{ border: "1px solid var(--border-2)", borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
            {order.items.map((it, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: i < order.items.length - 1 ? "1px solid var(--border-2)" : "none" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{it.name}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--muted)" }}>× {it.qty}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 4px 0" }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>Общо</span>
            <span className="ff-fig" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>{FF.money(order.total)}</span>
          </div>
        </div>

        {/* actions */}
        <div style={{ padding: "16px 24px 22px", borderTop: "1px solid var(--border-2)", display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--muted)", marginBottom: 2 }}>ПРОМЕНИ СТАТУС</div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            {actions.map((a) => (
              <Btn key={a.status} variant={a.variant} icon={a.Icon} onClick={() => setStatus(order.id, a.status)} style={{ flex: a.variant === "primary" ? "1 1 100%" : "1 1 auto" }}>
                {a.label}
              </Btn>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function InfoRow({ Icon, label, value }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--border-2)", display: "grid", placeItems: "center", color: "var(--green-700)", flexShrink: 0 }}>
        <Icon size={18} />
      </span>
      <div style={{ paddingTop: 1 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginTop: 1 }}>{value}</div>
      </div>
    </div>
  );
}

Object.assign(window, { DashboardPage, OrdersPage, OrderPanel, InfoRow });

const ffPageStyles = {
  actionAmber: { display: "flex", alignItems: "center", gap: 13, padding: 13, borderRadius: 13, background: "var(--amber)", color: "#3a2a08", width: "100%" },
  actionGreen: { display: "flex", alignItems: "center", gap: 13, padding: 13, borderRadius: 13, background: "var(--surface-2)", border: "1px solid var(--border)", width: "100%" },
  searchWrap: { display: "flex", alignItems: "center", gap: 9, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "0 14px", height: 44, width: 300, color: "var(--muted)", boxShadow: "var(--shadow-sm)" },
  searchInput: { border: "none", outline: "none", background: "transparent", fontSize: 14.5, color: "var(--ink)", width: "100%" },
  datePick: { display: "flex", alignItems: "center", gap: 8, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "0 14px", height: 44, fontSize: 14, fontWeight: 600, color: "var(--ink-2)", boxShadow: "var(--shadow-sm)", cursor: "pointer" },
  theadRow: { display: "grid", gridTemplateColumns: "70px 1.3fr 1.6fr 1fr 1fr 100px", gap: 14, padding: "14px 30px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)", fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.03em" },
  trow: { display: "grid", gridTemplateColumns: "70px 1.3fr 1.6fr 1fr 1fr 100px", gap: 14, alignItems: "center", width: "calc(100% - 16px)", textAlign: "left", padding: "22px", margin: "2px 8px", borderRadius: 10 },
  panel: { position: "fixed", top: 0, right: 0, height: "100%", width: 460, maxWidth: "94vw", background: "var(--surface)", zIndex: 41, boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", animation: "ff-slide-in .26s cubic-bezier(.32,.72,0,1)" },
};
window.ffPageStyles = ffPageStyles;
