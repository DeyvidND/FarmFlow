'use client';

/**
 * Structured Bulgarian delivery address — region + town + street + number,
 * with optional block/entrance/apt and postcode. Composed into a single,
 * geocoder-friendly string (city + "обл. X" disambiguate same-named streets
 * across towns, so the server geocodes far more precisely than free text).
 */
import { useState } from 'react';

const OBLASTI = [
  'Благоевград', 'Бургас', 'Варна', 'Велико Търново', 'Видин', 'Враца', 'Габрово',
  'Добрич', 'Кърджали', 'Кюстендил', 'Ловеч', 'Монтана', 'Пазарджик', 'Перник',
  'Плевен', 'Пловдив', 'Разград', 'Русе', 'Силистра', 'Сливен', 'Смолян',
  'София (столица)', 'София област', 'Стара Загора', 'Търговище', 'Хасково',
  'Шумен', 'Ямбол',
];

export interface AddressParts {
  oblast: string;
  city: string;
  street: string;
  streetNo: string;
  extra: string;
  postcode: string;
}

const EMPTY: AddressParts = {
  oblast: '', city: '', street: '', streetNo: '', extra: '', postcode: '',
};

/** Compose the parts into one geocoder-friendly line. */
export function composeAddress(p: AddressParts): string {
  const streetLine = [p.street, p.streetNo].filter((s) => s.trim()).join(' ');
  return [streetLine, p.extra, p.city, p.oblast && `обл. ${p.oblast}`, p.postcode]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

export function AddressFields({
  onChange,
}: {
  onChange: (text: string, parts: AddressParts) => void;
}) {
  const [p, setP] = useState<AddressParts>(EMPTY);
  const upd = (k: keyof AddressParts, v: string) => {
    const next = { ...p, [k]: v };
    setP(next);
    onChange(composeAddress(next), next);
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="field-row">
        <div className="field">
          <label>Област</label>
          <select className="input" value={p.oblast} onChange={(e) => upd('oblast', e.target.value)}>
            <option value="">Избери…</option>
            {OBLASTI.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Град / село</label>
          <input
            className="input"
            placeholder="напр. Варна / с. Звездица"
            value={p.city}
            onChange={(e) => upd('city', e.target.value)}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field" style={{ flex: 2 }}>
          <label>Улица / булевард</label>
          <input
            className="input"
            placeholder="напр. ул. Драгоман"
            value={p.street}
            onChange={(e) => upd('street', e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>№</label>
          <input
            className="input"
            placeholder="15"
            value={p.streetNo}
            onChange={(e) => upd('streetNo', e.target.value)}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Блок / вход / ап. (по избор)</label>
          <input
            className="input"
            placeholder="бл. 5, вх. Б, ап. 12"
            value={p.extra}
            onChange={(e) => upd('extra', e.target.value)}
          />
        </div>
        <div className="field">
          <label>Пощенски код (по избор)</label>
          <input
            className="input"
            placeholder="9000"
            value={p.postcode}
            onChange={(e) => upd('postcode', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
