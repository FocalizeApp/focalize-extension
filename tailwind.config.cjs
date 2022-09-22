const config = {
  content: ["./src/**/*.{html,js,svelte,ts}"],

  theme: {
    extend: {
      colors: {
        'orange': {
          DEFAULT: '#FF6014',
          '50': '#FFDCCC',
          '100': '#FFCEB7',
          '200': '#FFB38E',
          '300': '#FF9766',
          '400': '#FF7C3D',
          '500': '#FF6014',
          '600': '#DB4700',
          '700': '#A33500',
          '800': '#6B2300',
          '900': '#331000'
        }
      },
    },
  },

  plugins: [
    require('@tailwindcss/typography')
  ],

  darkMode: 'class',
};

module.exports = config;
