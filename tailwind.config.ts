import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#17202b",
          700: "#425466",
          500: "#66788a",
        },
        cloud: {
          50: "#f7f9fc",
          100: "#edf2f7",
        },
        signal: {
          green: "#16a34a",
          amber: "#d97706",
          red: "#dc2626",
        },
      },
      boxShadow: {
        card: "0 18px 45px rgba(23, 32, 43, 0.08)",
      },
      keyframes: {
        "hint-nudge": {
          "0%, 100%": { transform: "translateX(0)" },
          "50%": { transform: "translateX(3px)" },
        },
      },
      animation: {
        "hint-nudge": "hint-nudge 1.4s ease-in-out infinite",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
