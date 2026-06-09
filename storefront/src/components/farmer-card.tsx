/**
 * Farmer listing card — React port of `farmerCard` (farms.js): photo, location/
 * since eyebrow, name, role, bio, a product/category count and a button to the
 * farmer's storefront. Pure markup → server component. Image falls back to the
 * `.ph` placeholder when the farmer has no photo.
 */
import Link from 'next/link';
import type { PublicFarmer } from '@/lib/api';
import { farmerEyebrow } from '@/lib/farmers';
import { coverCropStyle } from '@/lib/cover-crop';

export function FarmerCard({
  farmer,
  productCount,
  subcatCount,
}: {
  farmer: PublicFarmer;
  productCount: number;
  subcatCount: number;
}) {
  const href = `/farmers/${farmer.id}`;
  const eyebrow = farmerEyebrow(farmer);

  return (
    <article className="card farmer-card">
      <Link href={href} className="ph farmer-card__photo" style={{ display: 'block' }}>
        {farmer.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={farmer.imageUrl}
            alt={farmer.name}
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', ...coverCropStyle(farmer.coverCrop) }}
          />
        ) : (
          <span className="ph__label">{farmer.name}</span>
        )}
      </Link>
      <div className="farmer-card__body">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <Link href={href}>
          <h3 className="farmer-card__name">{farmer.name}</h3>
        </Link>
        {farmer.bio && <p className="farmer-card__blurb">{farmer.bio}</p>}
        <div className="farmer-card__foot">
          <span className="farmer-card__count">
            {productCount} продукта · {subcatCount} категории
          </span>
          <Link href={href} className="btn btn--primary btn--sm">
            Виж продуктите →
          </Link>
        </div>
      </div>
    </article>
  );
}
