import { trackingUrl } from './shipment-email.service';

describe('trackingUrl', () => {
  it('builds the Econt public tracking link, stripping spaces', () => {
    expect(trackingUrl('1051 0000 0001')).toBe(
      'https://www.econt.com/services/track-shipment/105100000001/',
    );
  });
});
