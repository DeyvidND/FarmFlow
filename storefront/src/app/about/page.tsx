import type { Metadata } from 'next';
import Link from 'next/link';
import { Leaf, Heart, Truck, Star } from '@/components/icons';

export const metadata: Metadata = { title: 'За нас' };

export default function AboutPage() {
  return (
    <main data-screen-label="About">
      {/* founder hero */}
      <section className="section">
        <div className="wrap split">
          <div>
            <span className="eyebrow">За нас</span>
            <h1 style={{ fontSize: 'clamp(36px,5.5vw,60px)', margin: '12px 0 18px' }}>
              Една градина,
              <br />
              отгледана с ръце
              <br />и търпение
            </h1>
            <p className="lead">
              Зад всяка кутийка малини стои семейство, което става преди изгрев и
              си ляга, когато последният ред е полят. Това не е фабрика — това е
              нашият двор, нашата работа и нашата гордост.
            </p>
            <div className="cta-row">
              <Link href="/products" className="btn btn--primary">
                Към продуктите
              </Link>
              <Link href="/contact" className="btn btn--ghost">
                Свържи се с нас
              </Link>
            </div>
          </div>
          <div className="ph ph--rounded" style={{ aspectRatio: '4 / 5' }}>
            <span className="ph__label">Портрет на стопанина · 4:5</span>
          </div>
        </div>
      </section>

      {/* narrative */}
      <section className="section--tight">
        <div className="wrap prose">
          <p>
            Започнахме през 2014-та с няколко реда малини зад къщата — повече като
            хоби, отколкото като бизнес. Първото лято раздадохме почти цялата
            реколта на съседи и приятели. Те се връщаха. После водеха свои познати.
          </p>
          <p>
            Днес гледаме над тридесет сорта горски плодове на близо два декара, но
            философията не се е променила. Не пръскаме. Не бързаме. Берем на ръка,
            рано сутрин, и доставяме същия ден — защото вярваме, че разликата се
            усеща още с първата хапка.
          </p>
          <p>
            Не сме най-големите и не искаме да бъдем. Искаме да познаваме клиентите
            си по име и да знаем, че когато отворят кутийката, ще се усмихнат.
          </p>
        </div>
      </section>

      {/* values */}
      <section className="section" style={{ background: 'var(--surface-2)' }}>
        <div className="wrap">
          <div className="section-head center" style={{ marginBottom: 36 }}>
            <span className="eyebrow">Нашите ценности</span>
            <h2 style={{ marginTop: 8 }}>В какво вярваме</h2>
          </div>
          <div className="grid grid--4">
            <div className="card value-card">
              <div className="ic">
                <Leaf />
              </div>
              <h3>Биологично чисти</h3>
              <p>Без химия, без изкуствени торове — само природа.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Heart />
              </div>
              <h3>Специално отношение</h3>
              <p>Всеки клиент е съсед, не номер на поръчка.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Truck />
              </div>
              <h3>Берем днес — доставяме днес</h3>
              <p>От храста до вратата ти за по-малко от 24 часа.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Star />
              </div>
              <h3>Качествата на плода</h3>
              <p>Сорт, зрялост и вкус — подбираме ги внимателно.</p>
            </div>
          </div>
        </div>
      </section>

      {/* gallery */}
      <section className="section">
        <div className="wrap">
          <div className="section-head" style={{ marginBottom: 28 }}>
            <span className="eyebrow">От градината</span>
            <h2 style={{ marginTop: 8 }}>Един обикновен ден при нас</h2>
          </div>
          <div className="gallery">
            <div className="ph wide">
              <span className="ph__label">Изгрев над насажденията · 2:1</span>
            </div>
            <div className="ph">
              <span className="ph__label">Ръце с малини</span>
            </div>
            <div className="ph tall">
              <span className="ph__label">Кошници · 1:2</span>
            </div>
            <div className="ph">
              <span className="ph__label">Цвят на къпина</span>
            </div>
            <div className="ph">
              <span className="ph__label">Поливане</span>
            </div>
            <div className="ph">
              <span className="ph__label">Пакетиране</span>
            </div>
            <div className="ph">
              <span className="ph__label">Доставка</span>
            </div>
          </div>
        </div>
      </section>

      {/* quote */}
      <section className="section--tight">
        <div className="wrap center">
          <p className="quote" style={{ marginInline: 'auto' }}>
            Не продаваме плодове. Продаваме сутрешната роса, слънцето и малко от
            нашето семейство — във всяка кутийка.
          </p>
          <div style={{ marginTop: 22, fontWeight: 600 }}>
            — стопанинът на {''}
            Горска Градина
          </div>
        </div>
      </section>
    </main>
  );
}
