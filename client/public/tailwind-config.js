// Tailwind Play CDN theme. Lives in its own file (not an inline <script>)
// so the Content-Security-Policy can forbid inline scripts.
tailwind.config = {
  theme: {
    extend: {
      colors: {
        ink: '#1B2036',
        'ink-light': '#262C46',
        mist: '#EEF1F0',
        signal: '#D9A62E',
        'signal-dark': '#B5871F',
        harmony: '#3E8E7E',
        ember: '#C1523B',
        slate: { DEFAULT: '#5B6472' },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        sans: ['Manrope', 'sans-serif'],
      },
    },
  },
};
