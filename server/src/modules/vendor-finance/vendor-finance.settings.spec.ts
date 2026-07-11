import { readVendorFinance } from './vendor-finance.settings';

describe('readVendorFinance', () => {
  it('is fully dormant on absent/garbage settings', () => {
    for (const input of [undefined, null, {}, { vendorFinance: null }, { vendorFinance: 'x' }, 42]) {
      expect(readVendorFinance(input)).toEqual({
        commissionEnabled: false,
        defaultCommissionRateBps: 0,
        subscriptionEnabled: false,
        defaultSubscriptionFeeStotinki: 0,
      });
    }
  });

  it('reads a full config', () => {
    expect(
      readVendorFinance({
        vendorFinance: {
          commissionEnabled: true,
          defaultCommissionRateBps: 500,
          subscriptionEnabled: true,
          defaultSubscriptionFeeStotinki: 1200,
        },
      }),
    ).toEqual({
      commissionEnabled: true,
      defaultCommissionRateBps: 500,
      subscriptionEnabled: true,
      defaultSubscriptionFeeStotinki: 1200,
    });
  });

  it('rejects negative/NaN numbers and truthy-but-not-true flags', () => {
    const out = readVendorFinance({
      vendorFinance: {
        commissionEnabled: 1,
        defaultCommissionRateBps: -5,
        subscriptionEnabled: 'yes',
        defaultSubscriptionFeeStotinki: NaN,
      },
    });
    expect(out).toEqual({
      commissionEnabled: false,
      defaultCommissionRateBps: 0,
      subscriptionEnabled: false,
      defaultSubscriptionFeeStotinki: 0,
    });
  });
});
