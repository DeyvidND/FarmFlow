import { Test } from '@nestjs/testing';
import { RecommendationsService } from './recommendations.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ProductsService } from '../products/products.service';
import { AvailabilityService } from '../availability/availability.service';

/** Gating tests: a disabled feature must return empty without querying Postgres. */
describe('RecommendationsService gating', () => {
  const makeService = async (merchandising: {
    bestSellers: { show: boolean };
    recommendations: { show: boolean };
  }) => {
    const db = {} as never; // must never be touched when the feature is off
    const publicCache = {
      resolveTenant: jest.fn().mockResolvedValue({ id: 't1', merchandising }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const products = { findPublicBySlug: jest.fn() };
    const availability = { findPublicActiveBySlug: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        RecommendationsService,
        { provide: DB_TOKEN, useValue: db },
        { provide: PublicCacheService, useValue: publicCache },
        { provide: ProductsService, useValue: products },
        { provide: AvailabilityService, useValue: availability },
      ],
    }).compile();

    return { svc: mod.get(RecommendationsService), products, availability };
  };

  it('returns [] for best-sellers when the chip is toggled off', async () => {
    const { svc } = await makeService({
      bestSellers: { show: false },
      recommendations: { show: true },
    });
    expect(await svc.bestSellerIdsBySlug('shop')).toEqual([]);
  });

  it('returns [] for cart picks when recommendations are toggled off (no catalog read)', async () => {
    const { svc, products, availability } = await makeService({
      bestSellers: { show: true },
      recommendations: { show: false },
    });
    expect(await svc.boughtTogetherBySlug('shop', ['00000000-0000-4000-8000-000000000000'])).toEqual(
      [],
    );
    expect(products.findPublicBySlug).not.toHaveBeenCalled();
    expect(availability.findPublicActiveBySlug).not.toHaveBeenCalled();
  });
});
