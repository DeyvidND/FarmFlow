'use client';

/** Newsletter sign-up — posts to the public intake endpoint, toasts the result. */
import { useMemo, useState, type FormEvent } from 'react';
import { subscribeNewsletter, resolveSlug, ApiError } from '@/lib/api';
import { toast } from './toast';

export function NewsletterForm() {
  const slug = useMemo(() => resolveSlug(), []);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast('Въведи имейл адрес');
      return;
    }
    setBusy(true);
    try {
      await subscribeNewsletter(slug, email.trim());
      toast('Благодарим! Записахме те за бюлетина.');
      setEmail('');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Грешка. Опитай отново.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
      <input
        className="input"
        type="email"
        placeholder="Твоят имейл"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ flex: '1 1 200px', minWidth: 0 }}
      />
      <button className="btn btn--primary" type="submit" disabled={busy}>
        {busy ? '…' : 'Абонирай се'}
      </button>
    </form>
  );
}
