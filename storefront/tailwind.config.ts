import type { Config } from 'tailwindcss';

/**
 * Storefront Tailwind config. The design system lives in `globals.css` (ported
 * from the template's theme.css/main.css/home-themes.css) and is driven by
 * CSS custom properties that flip per `[data-theme]`. These mappings just make
 * the same tokens reachable as Tailwind utilities (`bg-ff-surface`,
 * `text-ff-primary`, `font-head`, …). Pixel-perfect work uses the ported
 * component classes; utilities are for new glue markup.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ff: {
          bg: 'var(--bg)',
          'bg-tint': 'var(--bg-tint)',
          surface: 'var(--surface)',
          'surface-2': 'var(--surface-2)',
          ink: 'var(--ink)',
          'ink-soft': 'var(--ink-soft)',
          muted: 'var(--muted)',
          primary: 'var(--primary)',
          'primary-600': 'var(--primary-600)',
          'primary-050': 'var(--primary-050)',
          accent: 'var(--accent)',
          'accent-600': 'var(--accent-600)',
          'accent-050': 'var(--accent-050)',
          line: 'var(--line)',
          'line-strong': 'var(--line-strong)',
        },
      },
      fontFamily: {
        head: ['var(--font-head)'],
        body: ['var(--font-body)'],
      },
      borderRadius: {
        ff: 'var(--radius)',
        'ff-lg': 'var(--radius-lg)',
        'ff-sm': 'var(--radius-sm)',
        btn: 'var(--btn-radius)',
        chip: 'var(--chip-radius)',
      },
      boxShadow: {
        ff: 'var(--shadow)',
        'ff-sm': 'var(--shadow-sm)',
        'ff-lg': 'var(--shadow-lg)',
      },
      maxWidth: {
        wrap: 'var(--maxw)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
