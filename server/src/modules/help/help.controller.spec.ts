import { HelpController } from './help.controller';

// Task C4 — /route and /help are the only two pages a driver login can reach
// (client middleware DRIVER_ALLOWED); the AI-ask box on /help must not 403 on
// submit for a driver, or the page is half-broken for the one role that lands there.
describe('HelpController ask role metadata', () => {
  it('allows admin, farmer, and driver', () => {
    expect(Reflect.getMetadata('roles', HelpController.prototype.ask)).toEqual([
      'admin',
      'farmer',
      'driver',
    ]);
  });
});
