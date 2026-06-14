/** @type {import('tailwindcss').Config} */
export default {
  // Kept as "class" with no `.dark` ever set on <html>, so any stray `dark:`
  // variant stays inert (the console is light-only per the easy·bpmn design system).
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // easy·bpmn light design-system palette. Hex literals (not var()) so the
        // pervasive `bg-…/15` opacity modifiers keep working. Mirrors the semantic
        // aliases in src/styles/tokens.css — keep the two in sync.
        surface: {
          page: "#f6f8fa", // --gray-50
          canvas: "#f4f7f9", // --surface-canvas
          card: "#ffffff", // --gray-0
          raised: "#ffffff",
          sunken: "#eef2f6", // --gray-100
          hover: "#eef2f6",
          active: "#e3e9f0", // --gray-200
        },
        line: {
          subtle: "#e3e9f0", // --gray-200
          DEFAULT: "#d3dbe5", // --gray-300
          strong: "#aab6c4", // --gray-400
        },
        content: {
          strong: "#181d24", // --gray-900
          DEFAULT: "#2a323c", // --gray-800
          secondary: "#5b6776", // --gray-600
          muted: "#7d8b9b", // --gray-500
        },
        accent: {
          DEFAULT: "#109b86", // --teal-500
          hover: "#0c7e6e", // --teal-600
          press: "#0a6457", // --teal-700
          soft: "#e6f7f3", // --teal-50
        },
        // Runtime / status state colours — drive the Tone system (statusTone()).
        ok: "#1f9d57", // completed (green-500)
        info: "#2f74e0", // running / intermediate (blue-500)
        warn: "#cf8a18", // warning (amber-500)
        danger: "#e0524a", // end / error (coral red-500)
        // BPMN category accents (canvas markers + legend chips).
        cat: {
          event: "#1f9d57",
          inter: "#2f74e0",
          boundary: "#7c5ce0",
          end: "#e0524a",
          gateway: "#4d6e6a",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        task: "12px",
        lg: "14px",
        card: "16px",
        xl: "20px",
      },
      boxShadow: {
        xs: "0 1px 2px rgba(20,30,45,0.06)",
        sm: "0 1px 3px rgba(20,30,45,0.08), 0 1px 2px rgba(20,30,45,0.04)",
        md: "0 4px 12px rgba(20,30,45,0.10), 0 1px 3px rgba(20,30,45,0.06)",
        lg: "0 12px 32px rgba(20,30,45,0.14), 0 2px 8px rgba(20,30,45,0.06)",
        node: "0 1px 2px rgba(20,30,45,0.06), 0 2px 6px rgba(20,30,45,0.05)",
        glass: "0 8px 28px rgba(20,30,45,0.12), inset 0 1px 0 rgba(255,255,255,0.6)",
      },
    },
  },
  plugins: [],
};
