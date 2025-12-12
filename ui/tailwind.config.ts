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
        display: ["Space Grotesk", "Inter", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        night: {
          950: "#030510",
          900: "#050A17",
          800: "#0B1221",
          700: "#101932",
        },
        accent: {
          primary: "#763AEC",
          secondary: "#1ECAB8",
          warning: "#FFAB00",
          danger: "#FF5572",
          success: "#15BE50",
        },
        slate: {
          50: "#F4F6FC",
          200: "#C2CAE1",
          400: "#99A3C2",
          600: "#5C6587",
          900: "#11162A",
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
