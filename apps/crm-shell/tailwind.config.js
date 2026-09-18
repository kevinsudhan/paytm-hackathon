/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          accent: "var(--text-accent)",
          success: "var(--text-success)",
          warning: "var(--text-warning)",
          danger: "var(--text-danger)",
        },
        border: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        bg: {
          accent: "var(--bg-accent)",
          success: "var(--bg-success)",
          warning: "var(--bg-warning)",
          danger: "var(--bg-danger)",
        },
        brand: {
          DEFAULT: "var(--brand)",
          dark: "var(--brand-dark)",
        },
      },
      borderRadius: {
        DEFAULT: "8px",
        card: "12px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
