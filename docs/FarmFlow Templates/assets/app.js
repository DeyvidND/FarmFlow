/* =========================================================
   FarmFlow — shared app script
   - injects header / promo / footer / mobile drawer
   - cart state (localStorage) + count badge + add-to-cart
   - home theme switcher, optional-module toggle
   - qty steppers, FAQ accordion, category tabs
   ========================================================= */
(function () {
  "use strict";

  /* ---------- icons ---------- */
  const I = {
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
    berry: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8.5" cy="14" r="4"/><circle cx="15.5" cy="14" r="4"/><circle cx="12" cy="9" r="4"/><path d="M12 5c0-2 1-3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3h2l2.2 12.4a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.3L21 7H6"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>',
    fb: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 9h3V5.5h-3c-2.2 0-4 1.8-4 4V12H7v3.5h3V22h3.5v-6.5H16L17 12h-3.5V9.5c0-.3.2-.5.5-.5Z"/></svg>',
    ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
    tt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 3c.3 2.3 1.9 4 4 4.2V10c-1.5 0-2.9-.5-4-1.3v6.1A5.8 5.8 0 1 1 10.2 9v3.1a2.7 2.7 0 1 0 2 2.6V3h3.8Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.8 6.1 20.7l1.3-6.6L2.5 8.9l6.6-.8Z"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5h11v9h-11z"/><path d="M13.5 9.5H18l3 3v3h-7.5"/><circle cx="6.5" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.4-9.2-9C1.3 8 2.6 4.8 6 4.8c2 0 3.2 1.2 4 2.4.8-1.2 2-2.4 4-2.4 3.4 0 4.7 3.2 3.2 6.2C19 15.6 12 20 12 20Z"/></svg>',
  };
  window.FFICON = I;

  const PHONE = "+359 88 123 4567";
  const EMAIL = "zdravei@example.bg";
  const FARM = "Горска Градина";

  /* ---------- nav config ---------- */
  const NAV = [
    ["Начало", "home.html"],
    ["Продукти", "products.html"],
    ["За нас", "about.html"],
    ["Сезонни пакети", "bundles.html"],
    ["Влог", "blog.html"],
    ["Отзиви", "reviews.html"],
    ["Контакти", "contact.html"],
    ["ЧЗВ", "faq.html"],
  ];

  /* ---------- cart store ---------- */
  const Cart = {
    key: "ff_cart",
    get() { try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch (e) { return []; } },
    set(items) { localStorage.setItem(this.key, JSON.stringify(items)); updateCount(); },
    count() { return this.get().reduce((n, it) => n + it.qty, 0); },
    add(item, qty) {
      const items = this.get();
      const found = items.find((it) => it.id === item.id);
      if (found) found.qty += qty; else items.push(Object.assign({ qty }, item));
      this.set(items);
    },
    setQty(id, qty) {
      let items = this.get();
      if (qty <= 0) items = items.filter((it) => it.id !== id);
      else { const f = items.find((it) => it.id === id); if (f) f.qty = qty; }
      this.set(items);
    },
    remove(id) { this.set(this.get().filter((it) => it.id !== id)); },
    subtotal() { return this.get().reduce((s, it) => s + it.price * it.qty, 0); },
  };
  window.FFCart = Cart;
  window.FFmoney = (n) => n.toFixed(2).replace(".", ",") + " лв";

  function updateCount() {
    const n = Cart.count();
    document.querySelectorAll(".cart-count").forEach((el) => {
      el.textContent = n;
      el.classList.toggle("is-zero", n === 0);
    });
  }

  /* ---------- header ---------- */
  function buildHeader() {
    const host = document.getElementById("site-header");
    if (!host) return;
    const active = host.getAttribute("data-active") || "";
    const links = NAV.map(([t, h]) =>
      `<a href="${h}" class="${h === active ? "active" : ""}">${t}</a>`).join("");

    const promoHidden = localStorage.getItem("ff_promo_closed") === "1";
    host.innerHTML = `
      <div class="promo${promoHidden ? " hide" : ""}" id="promo">
        🍓 Специални отстъпки за <b>сезонните ни пакети</b>! Безплатна доставка над 40,00 лв.
        <button class="promo__close" id="promoClose" aria-label="Затвори">${I.close}</button>
      </div>
      <header class="site-header">
        <div class="wrap">
          <nav class="nav">
            <a href="home.html" class="brand">
              <span class="brand__mark">${I.berry}</span>
              <span>
                <span class="brand__name">${FARM}</span>
                <span class="brand__tag" style="display:block">био плодове · Варна</span>
              </span>
            </a>
            <div class="nav__links">${links}</div>
            <div class="nav__actions">
              <button class="icon-btn" aria-label="Търсене">${I.search}</button>
              <a href="cart.html" class="icon-btn" aria-label="Количка">
                ${I.cart}<span class="cart-count is-zero">0</span>
              </a>
              <button class="icon-btn hamburger" id="hamburger" aria-label="Меню">${I.menu}</button>
            </div>
          </nav>
        </div>
      </header>`;

    const close = document.getElementById("promoClose");
    if (close) close.addEventListener("click", () => {
      document.getElementById("promo").classList.add("hide");
      localStorage.setItem("ff_promo_closed", "1");
    });
    buildDrawer(active);
    const ham = document.getElementById("hamburger");
    if (ham) ham.addEventListener("click", openDrawer);
  }

  function buildDrawer(active) {
    const links = NAV.map(([t, h]) =>
      `<a href="${h}" class="${h === active ? "active" : ""}">${t}</a>`).join("");
    const el = document.createElement("div");
    el.innerHTML = `
      <div class="drawer-backdrop" id="drawerBackdrop"></div>
      <aside class="drawer" id="drawer" aria-hidden="true">
        <div class="drawer__head">
          <span class="brand"><span class="brand__mark">${I.berry}</span>
            <span class="brand__name">${FARM}</span></span>
          <button class="icon-btn" id="drawerClose" aria-label="Затвори">${I.close}</button>
        </div>
        ${links}
        <a href="cart.html" style="display:flex;align-items:center;gap:10px">${I.cart} Количка</a>
        <div style="margin-top:auto;padding-top:18px;color:var(--muted);font-size:14px">
          <a href="tel:${PHONE.replace(/\s/g, "")}">${PHONE}</a>
        </div>
      </aside>`;
    document.body.appendChild(el);
    document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);
    document.getElementById("drawerClose").addEventListener("click", closeDrawer);
  }
  function openDrawer() {
    document.getElementById("drawer").classList.add("open");
    document.getElementById("drawerBackdrop").classList.add("open");
  }
  function closeDrawer() {
    document.getElementById("drawer").classList.remove("open");
    document.getElementById("drawerBackdrop").classList.remove("open");
  }

  /* ---------- footer ---------- */
  function buildFooter() {
    const host = document.getElementById("site-footer");
    if (!host) return;
    const quick = NAV.map(([t, h]) => `<a href="${h}">${t}</a>`).join("");
    host.innerHTML = `
      <footer class="site-footer">
        <div class="wrap footer-grid">
          <div>
            <span class="brand">
              <span class="brand__mark">${I.berry}</span>
              <span class="brand__name">${FARM}</span>
            </span>
            <p style="margin-top:14px;opacity:.85;max-width:30ch;font-size:15px">
              Малко семейно стопанство. Берем сутрин, доставяме до вечерта — свежи био плодове от Варна и региона.
            </p>
            <div class="socials">
              <a href="#" aria-label="Facebook">${I.fb}</a>
              <a href="#" aria-label="Instagram">${I.ig}</a>
              <a href="#" aria-label="TikTok">${I.tt}</a>
            </div>
          </div>
          <div>
            <h4>Магазин</h4>
            <div class="footer-links">
              <a href="products.html">Продукти</a>
              <a href="bundles.html">Сезонни пакети</a>
              <a href="cart.html">Количка</a>
              <a href="reviews.html">Отзиви</a>
            </div>
          </div>
          <div>
            <h4>Информация</h4>
            <div class="footer-links">
              <a href="about.html">За нас</a>
              <a href="blog.html">Влог</a>
              <a href="faq.html">ЧЗВ</a>
              <a href="contact.html">Контакти</a>
            </div>
          </div>
          <div>
            <h4>Контакти</h4>
            <div class="footer-contact">
              <a href="tel:${PHONE.replace(/\s/g, "")}">${PHONE}</a><br>
              <a href="mailto:${EMAIL}">${EMAIL}</a><br>
              гр. Варна, България<br>
              Пон–Съб · 9:00–18:00
            </div>
          </div>
        </div>
        <div class="wrap footer-bottom">
          <span>© 2026 ${FARM}. Всички права запазени.</span>
          <span>Шаблон FarmFlow · демо съдържание</span>
        </div>
      </footer>`;
  }

  /* ---------- qty steppers (event delegation) ---------- */
  function bindSteppers() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".stepper button");
      if (!btn) return;
      const input = btn.parentElement.querySelector("input");
      let v = parseInt(input.value, 10) || 1;
      v += btn.dataset.dir === "up" ? 1 : -1;
      const min = parseInt(input.min, 10) || 1;
      if (v < min) v = min;
      input.value = v;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /* ---------- add to cart (event delegation) ---------- */
  function bindAddToCart() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-add-cart]");
      if (!btn) return;
      e.preventDefault();
      const scope = btn.closest("[data-product]") || document;
      const qtyInput = scope.querySelector(".stepper input");
      const qty = qtyInput ? parseInt(qtyInput.value, 10) || 1 : 1;
      const item = {
        id: btn.dataset.id,
        name: btn.dataset.name,
        price: parseFloat(btn.dataset.price),
        weight: btn.dataset.weight || "",
      };
      Cart.add(item, qty);
      flyToast(`„${item.name}“ е добавен в количката`);
      pulseCart();
    });
  }
  function pulseCart() {
    document.querySelectorAll(".cart-count").forEach((el) => {
      el.animate([{ transform: "scale(1)" }, { transform: "scale(1.5)" }, { transform: "scale(1)" }], { duration: 350 });
    });
  }
  let toastTimer;
  function flyToast(msg) {
    let t = document.getElementById("ff-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "ff-toast";
      t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--primary);color:#fff;padding:14px 22px;border-radius:999px;font-weight:600;font-size:15px;z-index:90;box-shadow:0 16px 40px -10px rgba(0,0,0,.35);opacity:0;transition:opacity .25s,transform .25s;display:flex;gap:10px;align-items:center;max-width:90vw";
      document.body.appendChild(t);
    }
    t.innerHTML = I.check + "<span>" + msg + "</span>";
    requestAnimationFrame(() => { t.style.opacity = "1"; t.style.transform = "translateX(-50%) translateY(0)"; });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(20px)"; }, 2400);
  }
  window.FFtoast = flyToast;

  /* ---------- FAQ accordion ---------- */
  function bindAccordion() {
    document.addEventListener("click", (e) => {
      const head = e.target.closest(".acc__head");
      if (!head) return;
      const item = head.parentElement;
      const open = item.classList.contains("open");
      if (!item.closest(".acc")?.dataset.multi) {
        item.parentElement.querySelectorAll(".acc__item.open").forEach((i) => { if (i !== item) i.classList.remove("open"); });
      }
      item.classList.toggle("open", !open);
    });
  }

  /* ---------- category tabs (generic) ---------- */
  function bindTabs() {
    document.querySelectorAll("[data-tabs]").forEach((group) => {
      group.addEventListener("click", (e) => {
        const tab = e.target.closest("[data-tab]");
        if (!tab) return;
        group.querySelectorAll("[data-tab]").forEach((t) => t.classList.toggle("is-active", t === tab));
        const key = tab.dataset.tab;
        const target = document.querySelector(group.dataset.tabsTarget || "[data-tab-panels]");
        if (!target) return;
        target.querySelectorAll("[data-cat]").forEach((card) => {
          const show = key === "all" || card.dataset.cat === key;
          card.style.display = show ? "" : "none";
        });
      });
    });
  }

  /* ---------- theme switcher (all pages, global) ---------- */
  const THEMES = [
    ["priroda", "Природа", "#2C5530"],
    ["svezho",  "Свежо",   "#E63950"],
    ["klasik",  "Класик",  "#C8826A"],
  ];
  function buildThemeBar() {
    const bar = document.createElement("div");
    bar.className = "theme-bar";
    bar.id = "themeBar";
    bar.innerHTML = `
      <div class="wrap theme-bar__inner">
        <span class="theme-bar__label">Тема</span>
        <div class="theme-tabs">
          ${THEMES.map(([id, label, c]) =>
            `<button class="theme-tab" data-theme="${id}"><span class="dot" style="background:${c}"></span>${label}</button>`).join("")}
        </div>
        <span class="theme-bar__note">Демо превключвател — стилът важи за целия сайт →</span>
      </div>`;
    document.body.insertBefore(bar, document.body.firstChild);
    return bar;
  }
  function bindThemeSwitcher() {
    const bar = buildThemeBar();
    // keep the sticky header docked right below the (possibly wrapping) theme bar
    const syncH = () => document.documentElement.style.setProperty("--themebar-h", bar.offsetHeight + "px");
    syncH();
    window.addEventListener("resize", syncH);
    setTheme(localStorage.getItem("ff_theme") || "priroda");
    bar.querySelectorAll(".theme-tab").forEach((tab) => {
      tab.addEventListener("click", () => { setTheme(tab.dataset.theme); syncH(); });
    });
    function setTheme(name) {
      document.documentElement.setAttribute("data-theme", name);
      localStorage.setItem("ff_theme", name);
      bar.querySelectorAll(".theme-tab").forEach((t) => t.classList.toggle("active", t.dataset.theme === name));
    }
  }

  /* ---------- module toggle (all pages) ---------- */
  function bindModuleToggle() {
    const btn = document.createElement("button");
    btn.className = "module-toggle";
    btn.id = "moduleToggle";
    btn.innerHTML = `<span class="sw"></span> Опционални модули`;
    document.body.appendChild(btn);
    if (localStorage.getItem("ff_show_modules") === "1") document.body.classList.add("show-modules");
    btn.addEventListener("click", () => {
      const on = document.body.classList.toggle("show-modules");
      localStorage.setItem("ff_show_modules", on ? "1" : "0");
    });
  }

  /* ---------- init ---------- */
  function init() {
    buildHeader();
    buildFooter();
    updateCount();
    bindSteppers();
    bindAddToCart();
    bindAccordion();
    bindTabs();
    bindThemeSwitcher();
    bindModuleToggle();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
