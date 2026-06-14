/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Operator-console surface palette (dense, dark-friendly).
        ink: {
          950: "#0a0c10",
          900: "#0f1218",
          850: "#151922",
          800: "#1b212c",
          700: "#273141",
          600: "#3a4659",
          500: "#5a6781",
        },
        accent: { DEFAULT: "#5b9dff", muted: "#2f4d80" },
        ok: "#3fb950",
        warn: "#d29922",
        danger: "#f85149",
        info: "#58a6ff",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
