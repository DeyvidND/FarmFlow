import { FarmersController } from './farmers.controller';

// The invite endpoint sends an email per call, so it must carry a tighter
// per-route throttle than the global default. Assert the @Throttle metadata is
// present on grantAccess and absent on a plain read handler (version-agnostic:
// we match any throttler metadata key rather than a library-internal constant).
const throttleKeys = (fn: object) =>
  Reflect.getMetadataKeys(fn).filter((k) => String(k).toLowerCase().includes('throttler'));

describe('FarmersController — invite throttle', () => {
  it('throttles POST :id/access (grantAccess)', () => {
    expect(throttleKeys(FarmersController.prototype.grantAccess).length).toBeGreaterThan(0);
  });

  it('does not throttle a plain read handler (findAll)', () => {
    expect(throttleKeys(FarmersController.prototype.findAll)).toHaveLength(0);
  });
});
