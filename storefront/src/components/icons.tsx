/**
 * Storefront icon set — the exact inline SVGs from the template's `app.js`
 * (window.FFICON), ported to React so the chrome stays pixel-perfect. Sizing
 * comes from the parent CSS (e.g. `.icon-btn svg`), so these take no size prop.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

export function Leaf(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}

export function Berry(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <circle cx="8.5" cy="14" r="4" />
      <circle cx="15.5" cy="14" r="4" />
      <circle cx="12" cy="9" r="4" />
      <path d="M12 5c0-2 1-3 3-3" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

export function Cart(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2.5 3h2l2.2 12.4a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.3L21 7H6" />
    </svg>
  );
}

export function Menu(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function Close(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function Search(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function Facebook(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M14 9h3V5.5h-3c-2.2 0-4 1.8-4 4V12H7v3.5h3V22h3.5v-6.5H16L17 12h-3.5V9.5c0-.3.2-.5.5-.5Z" />
    </svg>
  );
}

export function Instagram(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TikTok(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M16 3c.3 2.3 1.9 4 4 4.2V10c-1.5 0-2.9-.5-4-1.3v6.1A5.8 5.8 0 1 1 10.2 9v3.1a2.7 2.7 0 1 0 2 2.6V3h3.8Z" />
    </svg>
  );
}

export function Check(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function Star(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="m12 2 2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.8 6.1 20.7l1.3-6.6L2.5 8.9l6.6-.8Z" />
    </svg>
  );
}

export function Truck(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2.5 6.5h11v9h-11z" />
      <path d="M13.5 9.5H18l3 3v3h-7.5" />
      <circle cx="6.5" cy="17.5" r="1.6" />
      <circle cx="17" cy="17.5" r="1.6" />
    </svg>
  );
}

export function Heart(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20s-7-4.4-9.2-9C1.3 8 2.6 4.8 6 4.8c2 0 3.2 1.2 4 2.4.8-1.2 2-2.4 4-2.4 3.4 0 4.7 3.2 3.2 6.2C19 15.6 12 20 12 20Z" />
    </svg>
  );
}
