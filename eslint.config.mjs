import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: ["e2e-results/", "playwright-report/", ".next/", "dist/", "node_modules/", "next-env.d.ts"] },
];

export default eslintConfig;
