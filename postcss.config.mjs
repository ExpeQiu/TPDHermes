/** PostCSS：让 `@import "tailwindcss"` 与工具类 JIT 完整展开（否则会出现无样式页面） */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
