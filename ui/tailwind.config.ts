import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../src/**/*.js"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: {
        "2xl": "1440px",
      },
    },
    extend: {
      fontFamily: {
        display: ["Poppins", "Inter", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        night: {
          950: "#080c18",
          900: "#10172b",
          800: "#172240",
          700: "#1f2c54",
          650: "#253567",
        },
        accent: {
          primary: "#8D54FF",
          secondary: "#2CD4FA",
          tertiary: "#FE7FBF",
          warning: "#FFB648",
          danger: "#FF5572",
          success: "#29D17F",
        },
        slate: {
          50: "#F5F7FB",
          200: "#C8D0E3",
          400: "#96A0C4",
          600: "#5E6890",
          700: "#485279",
          900: "#0F1426",
        },
      },
      boxShadow: {
        card: "0 18px 32px rgba(5, 10, 23, 0.55)",
        glow: "0 0 30px rgba(118, 58, 236, 0.35)",
      },
      borderRadius: {
        xl: "1.25rem",
      },
    },
  },
  plugins: [animate],
};

export default config;
