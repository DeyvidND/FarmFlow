function importApp() {
  return {
    email: '', password: '', token: localStorage.getItem('econt_token') || '', loginError: '',
    settings: { carrier: 'econt', currency: 'EUR', weightGrams: 1000, speedyServiceId: null },
    file: null, batchId: null, rows: [], ai: '', error: '', committing: false, createdIds: [],

    async api(path, opts = {}) {
      const res = await fetch(path, {
        ...opts,
        headers: { Authorization: `Bearer ${this.token}`, ...(opts.headers || {}) },
      });
      if (res.status === 401) { this.logout(); throw new Error('Сесията изтече'); }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
      return res;
    },
    async login() {
      this.loginError = '';
      try {
        const res = await fetch('/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.email, password: this.password }),
        });
        if (!res.ok) throw new Error('Грешен вход');
        const data = await res.json();
        this.token = data.accessToken || data.token;
        localStorage.setItem('econt_token', this.token);
      } catch (e) { this.loginError = e.message; }
    },
    logout() { this.token = ''; localStorage.removeItem('econt_token'); },
    pick(e) { this.file = e.target.files[0] || null; },
    count(s) { return this.rows.filter((r) => r.validationStatus === s).length; },

    async upload() {
      this.error = ''; this.ai = '';
      try {
        const fd = new FormData();
        fd.append('file', this.file);
        Object.entries(this.settings).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
        const res = await this.api('/import/batches', { method: 'POST', body: fd });
        const data = await res.json();
        this.batchId = data.batch.id;
        this.rows = data.rows;
        this.ai = data.batch.aiReport?.aiAvailable ? '' : 'AI проверка недостъпна — само базова проверка.';
      } catch (e) { this.error = e.message; }
    },
    async save(r) {
      try {
        const res = await this.api(`/import/batches/${this.batchId}/rows/${r.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            receiverName: r.receiverName, receiverPhone: r.receiverPhone, deliveryMode: r.deliveryMode,
            city: r.city, office: r.office, address: r.address, weightGrams: r.weightGrams,
            codAmountStotinki: r.codAmountStotinki, carrier: r.carrier,
          }),
        });
        const updated = await res.json();
        Object.assign(r, updated);
      } catch (e) { this.error = e.message; }
    },
    async del(r) {
      try {
        await this.api(`/import/batches/${this.batchId}/rows/${r.id}`, { method: 'DELETE' });
        this.rows = this.rows.filter((x) => x.id !== r.id);
      } catch (e) { this.error = e.message; }
    },
    async commit() {
      this.committing = true; this.error = '';
      try {
        const res = await this.api(`/import/batches/${this.batchId}/commit`, { method: 'POST' });
        const data = await res.json();
        this.createdIds = data.results.filter((x) => x.status === 'created').map((x) => x.shipmentId);
        await this.refresh();
        if (data.failed) this.error = `${data.failed} реда не успяха — виж колоната „Проблеми".`;
      } catch (e) { this.error = e.message; } finally { this.committing = false; }
    },
    async refresh() {
      const res = await this.api(`/import/batches/${this.batchId}`);
      this.rows = (await res.json()).rows;
    },
    // Committed shipment ids for one carrier (read from refreshed rows, which carry
    // both shipmentId + carrier). Each carrier has its own label-merge route.
    labelIds(carrier) {
      return this.rows.filter((r) => r.shipmentId && r.carrier === carrier).map((r) => r.shipmentId);
    },
    // Fetch the merged label PDF WITH the auth header (a plain <a href> can't send
    // Authorization, so the guarded endpoint would 401), then open the blob.
    async downloadLabels(carrier) {
      this.error = '';
      try {
        const ids = this.labelIds(carrier).join(',');
        const path = carrier === 'speedy' ? `/speedy/labels.pdf?ids=${ids}` : `/shipping/labels.pdf?ids=${ids}`;
        const res = await this.api(path);
        const blob = await res.blob();
        window.open(URL.createObjectURL(blob), '_blank');
      } catch (e) { this.error = e.message; }
    },
    async downloadTemplate() {
      const res = await this.api('/import/template.xlsx');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'import-template.xlsx'; a.click();
    },
  };
}
