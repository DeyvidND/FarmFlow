'use client';

/** Operator-level toggles for the import checks, kept in localStorage so the choice
 *  sticks per browser. Both default ON to preserve the original "always check" behavior;
 *  only an explicit 'false' turns a check off. Read on upload and edited in Settings. */

export interface ImportPrefs {
  aiAudit: boolean;
  addressCheck: boolean;
}

const KEYS = {
  aiAudit: 'ff.import.aiAudit',
  addressCheck: 'ff.import.addressCheck',
} as const;

const read = (key: string) => {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(key) !== 'false';
};

export function getImportPrefs(): ImportPrefs {
  return { aiAudit: read(KEYS.aiAudit), addressCheck: read(KEYS.addressCheck) };
}

export function setImportPref(key: keyof ImportPrefs, value: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEYS[key], String(value));
}
