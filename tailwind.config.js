/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/client/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        runny: {
          accent: "var(--color-accent)",
          green: "#16a34a",
          red: "var(--color-danger)",
          yellow: "#ca8a04",
        },
      },
    },
  },
  plugins: [],
};
