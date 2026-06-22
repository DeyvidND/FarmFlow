/* ФермериБГ — app shell, nav, shared state, toasts, hover styles */
const { useEffect } = React;

const PAGE_TITLES = {
  dashboard: "Табло",
  orders: "Поръчки",
  production: "За приготвяне днес",
  products: "Продукти",
  slots: "Слотове за доставка",
  route: "Маршрут за днес",
};

function App() {
  const [page, setPage] = React.useState("dashboard");
  const [orders, setOrders] = React.useState(window.FF.orders);
  const [products, setProducts] = React.useState(window.FF.products);
  const [openOrderId, setOpenOrderId] = React.useState(null);
  const [toasts, setToasts] = React.useState([]);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const toast = (msg, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };

  const navigate = (p) => { setPage(p); setOpenOrderId(null); setDrawerOpen(false); };
  const openOrder = (id) => { setPage("orders"); setOpenOrderId(id); };

  // ---- Auth screens render full-bleed (no admin shell) ----
  if (page === "login") return <LoginPage onNavigate={navigate} />;
  if (page === "register") return <RegisterPage onNavigate={navigate} />;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <Sidebar active={page} onNavigate={navigate} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      {drawerOpen && (
        <div className="ff-drawer-backdrop" onClick={() => setDrawerOpen(false)} style={{
          position: "fixed", inset: 0, background: "rgba(30,28,15,0.4)", zIndex: 49, animation: "ff-fade .2s ease",
        }}></div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <TopBar title={PAGE_TITLES[page]} onMenu={() => setDrawerOpen(true)} />
        <main className="ff-main" style={{ flex: 1, overflowY: "auto", padding: "32px 32px 40px" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            {page === "dashboard" && <DashboardPage orders={orders} setOrders={setOrders} toast={toast} onNavigate={navigate} onOpenOrder={openOrder} />}
            {page === "orders" && <OrdersPage orders={orders} setOrders={setOrders} toast={toast} openId={openOrderId} setOpenId={setOpenOrderId} />}
            {page === "production" && <ProductionPage orders={orders} toast={toast} />}
            {page === "products" && <ProductsPage products={products} setProducts={setProducts} toast={toast} />}
            {page === "slots" && <SlotsPage toast={toast} />}
            {page === "route" && <RoutePage toast={toast} />}
          </div>
        </main>
      </div>

      {/* toasts */}
      <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 60, display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderRadius: 12,
            background: "var(--green-900)", color: "#fff", fontSize: 14, fontWeight: 600,
            boxShadow: "var(--shadow-lg)", animation: "ff-pop .22s ease",
          }}>
            <span style={{ width: 20, height: 20, borderRadius: 99, display: "grid", placeItems: "center", background: t.kind === "ok" ? "var(--green-500)" : "var(--amber)", color: t.kind === "ok" ? "#fff" : "#3a2a08", flexShrink: 0 }}>
              {t.kind === "ok" ? <IconCheck size={13} stroke={2.6} /> : <IconBell size={12} />}
            </span>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

/* ---- hover styles injected once ---- */
const ffHover = document.createElement("style");
ffHover.textContent = `
  .ff-nav-item:hover:not([data-on="true"]) { background: var(--green-50); color: var(--ink); }
  .ff-feed-row { cursor: pointer; transition: background .13s; }
  .ff-feed-row:hover { background: var(--surface-2); }
  .ff-feed-row[data-on="true"] { background: var(--green-50); }
  .ff-btn:hover { transform: translateY(-1px); filter: brightness(1.03); }
  .ff-btn:active { transform: translateY(0); }
  .ff-action { transition: transform .1s, box-shadow .15s, background .15s; }
  .ff-action:hover { transform: translateY(-1px); }
  .ff-action:active { transform: translateY(0); }
  .ff-bell:hover { background: var(--surface-2); border-color: var(--muted-2); }
  .ff-notif:hover { background: var(--surface-2); }
  .ff-edit-btn:hover { background: var(--green-50); color: var(--green-700); border-color: var(--green-100); }
  .ff-slot-pill { transition: transform .12s, filter .12s; }
  .ff-slot-pill:hover { transform: translateY(-1px); filter: brightness(0.98); }
  .ff-add-slot:hover { border-color: var(--green-500); color: var(--green-700); background: var(--green-50); }
  .ff-stop:hover { background: var(--surface-2) !important; }
  .ff-prep-row { cursor: pointer; }
  .ff-prep-row:hover:not([data-on="true"]) { background: var(--surface-2); }
  .ff-prep-row[data-on="true"] { background: var(--green-50); }
  .ff-call:hover { background: var(--green-600); color: #fff; }
  .ff-order-card { cursor: pointer; transition: transform .1s, box-shadow .15s, border-color .15s; }
  .ff-order-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); border-color: var(--muted-2); }
  input:focus { border-color: var(--green-500) !important; }
`;
document.head.appendChild(ffHover);
