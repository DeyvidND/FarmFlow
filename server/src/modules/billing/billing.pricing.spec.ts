import { priceForRecipients, emailCostStotinki } from './billing.pricing';

describe('newsletter pricing', () => {
  // 555 micro-€/recipient = 0.0555 stotinki; rounded to whole stotinki per send.
  it('prices a send at round(n * 555 / 10000) stotinki', () => {
    expect(priceForRecipients(0, 555)).toBe(0);
    expect(priceForRecipients(50, 555)).toBe(3); // 2.775 → 3
    expect(priceForRecipients(200, 555)).toBe(11); // 11.1 → 11
    expect(priceForRecipients(1000, 555)).toBe(56); // 55.5 → 56
  });

  it('treats non-positive recipients as zero', () => {
    expect(priceForRecipients(-5, 555)).toBe(0);
  });

  it('computes the Resend cost basis the same way', () => {
    expect(emailCostStotinki(1000, 370)).toBe(37); // 37.0
    expect(emailCostStotinki(200, 370)).toBe(7); // 7.4 → 7
    expect(emailCostStotinki(0, 370)).toBe(0);
  });
});
