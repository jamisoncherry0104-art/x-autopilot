/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // 侧边栏深色体系（跟随 X 品牌色的中性灰阶）
        ink: {
          900: '#0b0d10',
          850: '#101317',
          800: '#15181e',
          700: '#1c2027',
          600: '#262b34',
          500: '#39404b',
          400: '#5b6472',
          300: '#8b95a5',
          200: '#b9c2cf',
          100: '#e6eaf0',
        },
        brand: {
          DEFAULT: '#1d9bf0',
          dim: '#1a8cd8',
          glow: '#4fb8f7',
        },
        danger: '#f4212e',
        warn: '#ffd400',
        ok: '#00ba7c',
      },
      fontFamily: {
        sans: ['"Segoe UI"', 'system-ui', '-apple-system', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(0,186,124,0.5)' },
          '70%': { boxShadow: '0 0 0 6px rgba(0,186,124,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(0,186,124,0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.18s ease-out',
        'pulse-ring': 'pulse-ring 1.8s infinite',
      },
    },
  },
  plugins: [],
};
