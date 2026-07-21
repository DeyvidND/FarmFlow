import type { Config } from 'tailwindcss';
// Static ESM import, NOT `require(...)`. This file is ESM (import/export default),
// and Node >=22 loads such a file through loadESMFromCJS, where `require` is not
// defined — a bare require() here crashes the dev server with "require is not
// defined" the moment PostCSS loads this config.
import tailwindcssAnimate from 'tailwindcss-animate';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // ФермериБГ raw design tokens (exact hex from the design prototype)
        ff: {
          bg: 'var(--ff-bg)',
          surface: 'var(--ff-surface)',
          'surface-2': 'var(--ff-surface-2)',
          'green-950': 'var(--ff-green-950)',
          'green-900': 'var(--ff-green-900)',
          'green-800': 'var(--ff-green-800)',
          'green-700': 'var(--ff-green-700)',
          'green-600': 'var(--ff-green-600)',
          'green-500': 'var(--ff-green-500)',
          'green-100': 'var(--ff-green-100)',
          'green-50': 'var(--ff-green-50)',
          amber: 'var(--ff-amber)',
          'amber-600': 'var(--ff-amber-600)',
          'amber-soft': 'var(--ff-amber-soft)',
          'amber-softer': 'var(--ff-amber-softer)',
          ink: 'var(--ff-ink)',
          'ink-2': 'var(--ff-ink-2)',
          muted: 'var(--ff-muted)',
          'muted-2': 'var(--ff-muted-2)',
          border: 'var(--ff-border)',
          'border-2': 'var(--ff-border-2)',
          'badge-bg': 'var(--ff-gray-badge-bg)',
          'badge-ink': 'var(--ff-gray-badge-ink)',
          red: 'var(--ff-red)',
        },
      },
      fontFamily: {
        sans: ['var(--font-commissioner)', 'system-ui', 'sans-serif'],
        display: ['var(--font-bitter)', 'Georgia', 'serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'var(--radius-sm)',
      },
      boxShadow: {
        'ff-sm': '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'ff-md': '0 4px 16px rgba(40, 35, 20, 0.08)',
        'ff-lg': '0 12px 40px rgba(30, 28, 15, 0.16)',
      },
      keyframes: {
        'ff-fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'ff-fade': { from: { opacity: '0' }, to: { opacity: '1' } },
        'ff-slide-in': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'ff-slide-in-right': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'ff-pop': {
          '0%': { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'ff-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
      },
      animation: {
        'ff-fade-up': 'ff-fade-up .3s ease',
        'ff-fade': 'ff-fade .2s ease',
        'ff-slide-in': 'ff-slide-in .26s cubic-bezier(.32,.72,0,1)',
        'ff-slide-in-right': 'ff-slide-in-right .26s cubic-bezier(.32,.72,0,1)',
        'ff-pop': 'ff-pop .18s ease',
        'ff-pulse': 'ff-pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
