/* FarmFlow — auth screens (Login, Register) */
const { useState: useAuthState } = React;

function AuthField({ label, type = "text", placeholder, value, onChange }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-2)" }}>{label}</span>
      <input type={type} placeholder={placeholder} value={value} onChange={onChange} style={{
        border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px",
        fontSize: 15, color: "var(--ink)", background: "var(--surface-2)", outline: "none",
        transition: "border-color .14s, background .14s",
      }} />
    </label>
  );
}

function AuthShell({ children, footer }) {
  return (
    <div style={{
      minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "40px 20px", background: "var(--bg)", position: "relative", overflowY: "auto",
    }}>
      {/* faint field texture top */}
      <div style={{ position: "absolute", inset: 0, opacity: 0.5, pointerEvents: "none", background:
        "radial-gradient(60% 50% at 50% -10%, var(--green-50), transparent 70%)" }}></div>

      <div style={{ width: 420, maxWidth: "100%", position: "relative", animation: "ff-fade-up .35s ease" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 22 }}>
          <Logo size={52} />
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 14, fontFamily: "var(--font-display)" }}>FarmFlow</div>
          <div style={{ fontSize: 14, color: "var(--muted)", fontWeight: 600, marginTop: 2 }}>Управление на фермата</div>
        </div>

        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16,
          boxShadow: "var(--shadow-md)", padding: 30,
        }}>
          {children}
        </div>

        <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--muted-2)", marginTop: 20 }}>{footer}</div>
      </div>
    </div>
  );
}

function LoginPage({ onNavigate }) {
  const [email, setEmail] = useAuthState("ivan@ferma-petrovi.bg");
  const [pass, setPass] = useAuthState("");

  const submit = (e) => { e.preventDefault(); onNavigate("dashboard"); };

  return (
    <AuthShell footer="FarmFlow © 2026">
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Влез в профила си</h1>
      <p style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 22 }}>Продължи към управлението на фермата.</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <AuthField label="Имейл" type="email" placeholder="ime@ferma.bg" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div>
          <AuthField label="Парола" type="password" placeholder="••••••••" value={pass} onChange={(e) => setPass(e.target.value)} />
          <div style={{ textAlign: "right", marginTop: 7 }}>
            <a href="#" onClick={(e) => e.preventDefault()} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--green-700)", textDecoration: "none" }}>Забравена парола?</a>
          </div>
        </div>
        <Btn variant="primary" type="submit" style={{ width: "100%", padding: "13px", fontSize: 15.5, marginTop: 2 }}>Влез</Btn>
      </form>
      <div style={{ textAlign: "center", fontSize: 13.5, color: "var(--ink-2)", marginTop: 20 }}>
        Нямаш акаунт? <a href="#" onClick={(e) => { e.preventDefault(); onNavigate("register"); }} style={{ fontWeight: 700, color: "var(--green-700)", textDecoration: "none" }}>Регистрирай се</a>
      </div>
    </AuthShell>
  );
}

function RegisterPage({ onNavigate }) {
  const [f, setF] = useAuthState({ farm: "", email: "", phone: "", pass: "", pass2: "" });
  const up = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = (e) => { e.preventDefault(); onNavigate("dashboard"); };

  return (
    <AuthShell footer="FarmFlow © 2026">
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Създай акаунт</h1>
      <p style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 22 }}>Започни да управляваш поръчките си днес.</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 15 }}>
        <AuthField label="Име на фермата" placeholder="Ферма Петрови" value={f.farm} onChange={up("farm")} />
        <AuthField label="Имейл" type="email" placeholder="ime@ferma.bg" value={f.email} onChange={up("email")} />
        <AuthField label="Телефон" type="tel" placeholder="+359 88 000 0000" value={f.phone} onChange={up("phone")} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <AuthField label="Парола" type="password" placeholder="••••••••" value={f.pass} onChange={up("pass")} />
          <AuthField label="Потвърди парола" type="password" placeholder="••••••••" value={f.pass2} onChange={up("pass2")} />
        </div>
        <Btn variant="primary" type="submit" style={{ width: "100%", padding: "13px", fontSize: 15.5, marginTop: 4 }}>Създай акаунт</Btn>
        <p style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", lineHeight: 1.5, marginTop: 2 }}>
          С регистрацията приемаш условията за ползване
        </p>
      </form>
      <div style={{ textAlign: "center", fontSize: 13.5, color: "var(--ink-2)", marginTop: 16 }}>
        Вече имаш акаунт? <a href="#" onClick={(e) => { e.preventDefault(); onNavigate("login"); }} style={{ fontWeight: 700, color: "var(--green-700)", textDecoration: "none" }}>Влез</a>
      </div>
    </AuthShell>
  );
}

Object.assign(window, { AuthField, AuthShell, LoginPage, RegisterPage });
