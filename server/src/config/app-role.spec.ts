import { parseAppRole, runsWorkers } from './app-role';

describe('app-role', () => {
  it('defaults to "all" when unset or unknown', () => {
    expect(parseAppRole(undefined)).toBe('all');
    expect(parseAppRole('')).toBe('all');
    expect(parseAppRole('nonsense')).toBe('all');
  });

  it('passes through valid roles', () => {
    expect(parseAppRole('web')).toBe('web');
    expect(parseAppRole('worker')).toBe('worker');
    expect(parseAppRole('all')).toBe('all');
  });

  it('runsWorkers is true for all + worker, false for web', () => {
    expect(runsWorkers('all')).toBe(true);
    expect(runsWorkers('worker')).toBe(true);
    expect(runsWorkers(undefined)).toBe(true);
    expect(runsWorkers('web')).toBe(false);
  });
});
