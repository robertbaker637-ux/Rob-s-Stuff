import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0b0d12",
          raised: "#12151c",
          border: "#232733",
        },
        status: {
          good: "#22c55e",
          bad: "#ef4444",
        },
      },
    },
  },
  plugins: [],
};

export default config;
