'use client';

/** "Остави ревю" form — interactive star rating + posts to the public reviews
 *  endpoint. Submissions are moderated, so we tell the user it appears after approval. */
import { useMemo, useState, type FormEvent } from 'react';
import { submitReview, resolveSlug, ApiError } from '@/lib/api';
import { toast } from './toast';
import { Star } from './icons';

export function ReviewForm() {
  const slug = useMemo(() => resolveSlug(), []);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !body.trim()) {
      toast('Попълни име и ревю');
      return;
    }
    if (rating < 1) {
      toast('Избери оценка');
      return;
    }
    setBusy(true);
    try {
      await submitReview(slug, {
        authorName: name.trim(),
        authorLocation: location.trim() || undefined,
        rating,
        body: body.trim(),
      });
      toast('Благодарим за ревюто! Ще се появи след одобрение.');
      setName('');
      setLocation('');
      setRating(0);
      setBody('');
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
          <label>Град</label>
          <input
            className="input"
            placeholder="напр. Варна"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label>Оценка</label>
        <div style={{ display: 'flex', gap: 6, color: 'var(--accent)' }}>
          {Array.from({ length: 5 }, (_, i) => {
            const v = i + 1;
            return (
              <button
                key={v}
                type="button"
                className="star"
                aria-label={`${v} звезди`}
                onClick={() => setRating(v)}
                style={{
                  width: 30,
                  height: 30,
                  display: 'inline-flex',
                  background: 'none',
                  border: 0,
                  cursor: 'pointer',
                  padding: 0,
                  opacity: v <= rating ? 1 : 0.3,
                }}
              >
                <Star style={{ width: 28, height: 28 }} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <label>Твоето ревю</label>
        <textarea
          className="textarea"
          placeholder="Разкажи ни..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
        />
      </div>

      <button className="btn btn--primary" type="submit" disabled={busy} style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Изпращане…' : 'Изпрати ревю'}
      </button>
    </form>
  );
}
