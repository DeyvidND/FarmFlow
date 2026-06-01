'use client';

/** Contact message form — posts to the public intake endpoint, toasts + resets. */
import { useMemo, useState, type FormEvent } from 'react';
import { submitContact, resolveSlug, ApiError } from '@/lib/api';
import { toast } from './toast';

export function ContactForm() {
  const slug = useMemo(() => resolveSlug(), []);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) {
      toast('Попълни име, имейл и съобщение');
      return;
    }
    setBusy(true);
    try {
      await submitContact(slug, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        message: message.trim(),
      });
      toast('Съобщението е изпратено!');
      setName('');
      setPhone('');
      setEmail('');
      setMessage('');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Грешка. Опитай отново.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
      <div className="field-row">
        <div className="field">
          <label>Име</label>
          <input
            className="input"
            placeholder="Твоето име"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Телефон</label>
          <input
            className="input"
            type="tel"
            placeholder="+359 ..."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>Имейл</label>
        <input
          className="input"
          type="email"
          placeholder="ime@example.bg"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label>Съобщение</label>
        <textarea
          className="textarea"
          placeholder="Как можем да помогнем?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
        />
      </div>
      <button className="btn btn--primary" type="submit" disabled={busy} style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Изпращане…' : 'Изпрати'}
      </button>
    </form>
  );
}
