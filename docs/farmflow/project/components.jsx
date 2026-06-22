/* ФермериБГ shared chrome & primitives */

const NAV = [
  { id: "dashboard", label: "Табло", Icon: IconDashboard },
  { id: "orders", label: "Поръчки", Icon: IconOrders },
  { id: "production", label: "Производство", Icon: IconBasket },
  { id: "products", label: "Продукти", Icon: IconProducts },
  { id: "slots", label: "Слотове", Icon: IconSlots },
  { id: "route", label: "Маршрут", Icon: IconRoute },
];

/* ---- Logo mark ---- */
const Logo = ({ size = 38 }) => (
  <div style={{
    width: size, height: size, borderRadius: 11, flexShrink: 0,
    background: "var(--green-700)",
    display: "grid", placeItems: "center", color: "#EAF1E4",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12)",
  }}>
    <IconLeaf size={size * 0.58} stroke={1.9} />
  </div>
);

/* ---- Sidebar ---- */
function Sidebar({ active, onNavigate, open, onClose }) {
  const pendingCount = window.FF.orders.filter((o) => o.status === "pending").length;
  return (
    <aside className="ff-sidebar" data-open={open ? "true" : "false"} style={ffStyles.sidebar}>
      <div style={ffStyles.brandRow}>
        <Logo />
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em", fontFamily: "var(--font-display)" }}>ФермериБГ</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, marginTop: 2 }}>Управление на фермата</div>
        </div>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
        {NAV.map((item) => {
          const on = active === item.id;
          return (
            <button key={item.id} onClick={() => onNavigate(item.id)}
              className="ff-nav-item" data-on={on}
              style={{
                display: "flex", alignItems: "center", gap: 13, padding: "11px 13px",
                borderRadius: 10, textAlign: "left", fontSize: 15, fontWeight: on ? 700 : 600,
                color: on ? "var(--green-800)" : "var(--ink-2)",
                background: on ? "var(--green-50)" : "transparent",
                borderLeft: on ? "3px solid var(--green-600)" : "3px solid transparent",
                transition: "background .15s, color .15s",
              }}>
              <item.Icon size={21} stroke={on ? 2 : 1.8} />
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.id === "orders" && pendingCount > 0 && (
                <span style={{
                  fontSize: 12, fontWeight: 800, minWidth: 21, height: 21, padding: "0 6px",
                  borderRadius: 99, display: "grid", placeItems: "center",
                  background: on ? "var(--green-100)" : "var(--amber-soft)",
                  color: on ? "var(--green-700)" : "var(--amber-600)",
                }}>{pendingCount}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        <div style={ffStyles.seasonCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: "var(--green-700)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--green-500)" }}></span>
            Сезон активен
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.45 }}>
            Прибиране на реколтата — пик. 9 продукта в наличност.
          </div>
        </div>
        <button className="ff-nav-item" onClick={() => onNavigate("login")} style={{
          display: "flex", alignItems: "center", gap: 13, padding: "10px 13px",
          borderRadius: 10, fontSize: 14.5, fontWeight: 600, color: "var(--muted)", width: "100%", marginTop: 6,
        }}>
          <IconLogout size={20} /> Изход
        </button>
      </div>
    </aside>
  );
}

/* ---- Top bar ---- */
function TopBar({ title, onMenu }) {
  const [open, setOpen] = React.useState(false);
  const pendingCount = window.FF.orders.filter((o) => o.status === "pending").length;
  return (
    <header className="ff-topbar" style={ffStyles.topbar}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
        <button className="ff-hamburger ff-bell" onClick={onMenu} aria-label="Меню" style={{
          width: 42, height: 42, borderRadius: 11, display: "none", placeItems: "center",
          background: "var(--surface)", border: "1px solid var(--border)", color: "var(--ink-2)", flexShrink: 0,
        }}>
          <IconMenu size={22} />
        </button>
        <h1 className="ff-page-title" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0 }}>{title}</h1>
      </div>
      <div className="ff-topbar-right" style={{ display: "flex", alignItems: "center", gap: 18, flexShrink: 0 }}>
        <div className="ff-tenant" style={{ textAlign: "right", lineHeight: 1.2 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>{window.FF.tenant}</div>
          <div className="ff-tenant-date" style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600, textTransform: "capitalize" }}>{window.FF.dateLabel}</div>
        </div>
        <div style={{ position: "relative" }}>
          <button className="ff-bell" onClick={() => setOpen((v) => !v)} style={{
            width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center",
            background: "var(--surface)", border: "1px solid var(--border)", color: "var(--ink-2)",
            boxShadow: "var(--shadow-sm)",
          }}>
            <IconBell size={21} />
            {pendingCount > 0 && (
              <span style={{
                position: "absolute", top: 8, right: 9, width: 9, height: 9, borderRadius: 99,
                background: "var(--amber)", border: "2px solid var(--surface)",
              }}></span>
            )}
          </button>
          {open && (
            <>
              <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }}></div>
              <div style={{
                position: "absolute", right: 0, top: 52, width: 320, zIndex: 31,
                background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16,
                boxShadow: "var(--shadow-lg)", padding: 8, animation: "ff-pop .14s ease",
              }}>
                <div style={{ padding: "8px 10px 10px", fontSize: 13, fontWeight: 700, color: "var(--muted)" }}>Известия</div>
                <NotifRow amber title={`${pendingCount} нови поръчки чакат потвърждение`} time="преди 5 мин" />
                <NotifRow title="Слот 09:00 – 10:00 е запълнен" time="преди 40 мин" />
                <NotifRow title="Ниска наличност: Малини 500 г (6 бр.)" time="преди 1 ч" />
              </div>
            </>
          )}
        </div>
        <div style={{
          width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center",
          background: "var(--green-100)", color: "var(--green-800)", fontWeight: 800, fontSize: 15,
        }}>ПЦ</div>
      </div>
    </header>
  );
}

function NotifRow({ title, time, amber }) {
  return (
    <div className="ff-notif" style={{
      display: "flex", gap: 11, padding: "10px 10px", borderRadius: 11, cursor: "pointer",
    }}>
      <span style={{
        width: 9, height: 9, borderRadius: 99, marginTop: 5, flexShrink: 0,
        background: amber ? "var(--amber)" : "var(--green-500)",
      }}></span>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", lineHeight: 1.35 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{time}</div>
      </div>
    </div>
  );
}

/* ---- Status badge ---- */
function StatusBadge({ status, size = "sm" }) {
  const meta = window.FF.statusMeta[status];
  const pal = {
    pending:   { bg: "var(--amber-soft)", ink: "var(--amber-600)", dot: "var(--amber)" },
    confirmed: { bg: "var(--green-100)", ink: "var(--green-700)", dot: "var(--green-500)" },
    delivered: { bg: "var(--gray-badge-bg)", ink: "var(--gray-badge-ink)", dot: "var(--muted-2)" },
    cancelled: { bg: "transparent", ink: "var(--muted)", dot: "var(--muted-2)", outline: true, strike: true },
  }[status];
  const sm = size === "sm";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: sm ? "3px 9px" : "5px 11px", borderRadius: 99,
      background: pal.bg, color: pal.ink, fontWeight: 700,
      fontSize: sm ? 12 : 13, whiteSpace: "nowrap",
      border: pal.outline ? "1px dashed var(--muted-2)" : "1px solid transparent",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: pal.dot }}></span>
      <span style={{ textDecoration: pal.strike ? "line-through" : "none" }}>{meta.label}</span>
    </span>
  );
}

/* ---- Product thumbnail placeholder (neutral + green only) ---- */
function ProductThumb({ tint, size = "card" }) {
  const isCard = size === "card";
  const h = isCard ? 132 : 52;
  const g = "#4C8A54";
  return (
    <div style={{
      position: "relative", width: isCard ? "100%" : 52, height: h, borderRadius: isCard ? 12 : 10,
      overflow: "hidden", flexShrink: 0,
      background: `linear-gradient(150deg, var(--green-50), var(--surface-2))`,
      border: `1px solid var(--border-2)`,
      display: "grid", placeItems: "center",
    }}>
      {/* berry motif */}
      <svg viewBox="0 0 60 40" width="62%" height="62%" style={{ opacity: 0.7 }}>
        <circle cx="24" cy="22" r="8" fill={hexA(g, 0.30)} />
        <circle cx="36" cy="20" r="6.5" fill={hexA(g, 0.20)} />
        <circle cx="31" cy="28" r="5" fill={hexA(g, 0.26)} />
        <path d="M24 14c-1-4 1-7 4-8" stroke={hexA(g, 0.6)} strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
      {isCard && (
        <span style={{
          position: "absolute", bottom: 7, right: 8, display: "inline-flex", alignItems: "center", gap: 4,
          fontSize: 10.5, fontWeight: 600, color: "var(--muted)", background: "rgba(255,255,255,0.8)",
          padding: "2px 7px", borderRadius: 99,
        }}><IconImage size={12} /> снимка</span>
      )}
    </div>
  );
}

/* helper: hex + alpha */
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---- Toggle switch ---- */
function Toggle({ on, onChange, small }) {
  const w = small ? 38 : 46, h = small ? 22 : 26, k = h - 6;
  return (
    <button onClick={(e) => { e.stopPropagation(); onChange(!on); }} style={{
      width: w, height: h, borderRadius: 99, padding: 3, flexShrink: 0,
      background: on ? "var(--green-600)" : "#D9D2C2",
      transition: "background .18s", position: "relative",
    }}>
      <span style={{
        position: "absolute", top: 3, left: on ? w - k - 3 : 3, width: k, height: k, borderRadius: 99,
        background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "left .18s ease",
      }}></span>
    </button>
  );
}

/* ---- Generic button ---- */
function Btn({ children, variant = "primary", icon: I, onClick, style, ...rest }) {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    padding: "10px 16px", borderRadius: 8, fontSize: 14.5, fontWeight: 700,
    transition: "transform .08s, background .15s, box-shadow .15s", whiteSpace: "nowrap",
  };
  const variants = {
    primary: { background: "var(--green-700)", color: "#fff", boxShadow: "0 2px 6px rgba(40,35,20,0.14)" },
    amber: { background: "var(--amber)", color: "#3a2a08", boxShadow: "0 2px 6px rgba(40,35,20,0.14)" },
    ghost: { background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--border)", boxShadow: "var(--shadow-sm)" },
    outline: { background: "var(--surface)", color: "var(--green-700)", border: "1.5px solid var(--green-600)" },
    soft: { background: "var(--green-100)", color: "var(--green-800)" },
    danger: { background: "var(--surface-2)", color: "var(--ink-2)", border: "1px solid var(--border)" },
  };
  return (
    <button className="ff-btn" onClick={onClick} style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {I && <I size={18} />}{children}
    </button>
  );
}

/* ---- Card shell ---- */
function Card({ children, style, pad = 20, ...rest }) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
      boxShadow: "var(--shadow-sm)", padding: pad, ...style,
    }} {...rest}>{children}</div>
  );
}

Object.assign(window, {
  NAV, Logo, Sidebar, TopBar, NotifRow, StatusBadge, ProductThumb, hexA, Toggle, Btn, Card,
});

/* ---- shared style object (unique name) ---- */
const ffStyles = {
  sidebar: {
    width: "var(--sidebar-w)", flexShrink: 0, height: "100%", padding: "22px 16px 18px",
    background: "var(--surface)", borderRight: "1px solid var(--border)",
    display: "flex", flexDirection: "column", position: "relative", zIndex: 5,
  },
  brandRow: { display: "flex", alignItems: "center", gap: 11, padding: "2px 6px 18px" },
  seasonCard: {
    background: "var(--green-50)", border: "1px solid var(--green-100)", borderRadius: 13, padding: "12px 13px",
  },
  topbar: {
    height: "var(--topbar-h)", flexShrink: 0, display: "flex", alignItems: "center",
    justifyContent: "space-between", padding: "0 32px", borderBottom: "1px solid var(--border)",
    background: "rgba(251,248,241,0.85)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 10,
  },
};
window.ffStyles = ffStyles;
