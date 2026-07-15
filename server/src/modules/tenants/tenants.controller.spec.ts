import { TenantsController } from './tenants.controller';

// Task C4 — GET /tenants/me is the server-side auth gate every admin-panel page
// load hits (client/src/app/(admin)/layout.tsx); a driver login must not 403
// here or it gets bounced back to /login before any client-side route work runs.
describe('TenantsController me role metadata', () => {
  it('allows admin, farmer, and driver', () => {
    expect(Reflect.getMetadata('roles', TenantsController.prototype.me)).toEqual([
      'admin',
      'farmer',
      'driver',
    ]);
  });
});
