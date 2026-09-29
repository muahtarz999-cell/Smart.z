/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        base: {
          bg: '#0B0D12',
          panel: '#12151C',
          card: '#171B23',
          border: '#2A2E38',
        },
        gold: {
          light: '#F0D48A',
          DEFAULT: '#C9A868',
          dark: '#8A6E3E',
        },
        petrol: {
          light: '#4A7A78',
          DEFAULT: '#3E5C66',
          dark: '#2E5C55',
        },
        text: {
          primary: '#EDEDED',
          secondary: '#8A8F99',
        },
      },
    },
  },
  plugins: [],
};
