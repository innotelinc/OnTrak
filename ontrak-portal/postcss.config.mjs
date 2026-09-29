/**
 * No PostCSS plugins, and the file exists to say so.
 *
 * The stylesheet is hand-written CSS with custom properties (see `globals.css`) —
 * there is nothing to transform. But *some* PostCSS config has to be here, because
 * Next resolves one by walking up from the CSS file, and the next directory up is
 * the OnTrak monorepo root, whose `postcss.config.mjs` loads `@tailwindcss/postcss`
 * for the training app. Without this file the portal's build tries to require that
 * plugin, which is not installed here, and fails with a `Module not found` that
 * points at a stylesheet rather than at the real cause.
 */
const config = { plugins: {} };

export default config;
