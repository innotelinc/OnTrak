/**
 * No PostCSS plugins, and the file exists to say so.
 *
 * The dashboard's stylesheet is hand-written CSS with custom properties (see
 * `globals.css`) — there is nothing to transform. But *some* PostCSS config has to
 * be here, because Next resolves one by walking up from the CSS file, and the next
 * directory up is the OnTrak monorepo root, whose `postcss.config.mjs` loads
 * `@tailwindcss/postcss` for the training app. Without this file a webpack build of
 * this app tries to require that plugin, which is not installed here.
 *
 * Turbopack (the default build) pins its root and never reaches up, which is why
 * this only showed up when the app was moved into the monorepo — but a pinned root
 * is a Turbopack setting, and this file is what protects the webpack path too.
 */
const config = { plugins: {} };

export default config;
