import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import * as dotenv from 'dotenv';
import UnoCSS from 'unocss/vite';
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import { browserPolyfills } from './scripts/vite/browser-polyfills.ts';

/*
 * Prevent miniflare from making an external network request to workers.cloudflare.com
 * for Request.cf during local dev, which causes 3-second TimeoutError warnings.
 */
process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false';

// Load environment variables without duplicate loading or console noise
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export default defineConfig((config) => {
  return {
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),

      // Ensure process.cwd is defined as a function for path-browserify compatibility
      'process.cwd': '() => "/"',
    },
    resolve: {
      tsconfigPaths: true,
    },
    build: {
      target: 'esnext',
    },
    optimizeDeps: {
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'react-router',
        'react-router/dom',
        'remix-utils/client-only',
        '@nanostores/react',
        'nanostores',
        'zustand',
        'framer-motion',
        'ai',
        '@ai-sdk/react',
        '@ai-sdk/amazon-bedrock',
        '@ai-sdk/anthropic',
        '@ai-sdk/cerebras',
        '@ai-sdk/cohere',
        '@ai-sdk/deepseek',
        '@ai-sdk/fireworks',
        '@ai-sdk/google',
        '@ai-sdk/mistral',
        '@ai-sdk/mcp', // AI SDK 7 MCP integration
        '@modelcontextprotocol/sdk/client/index.js',
        '@modelcontextprotocol/sdk/inMemory.js',
        '@modelcontextprotocol/sdk/server/mcp.js',
        'zod',
        '@ai-sdk/openai',
        '@openrouter/ai-sdk-provider',
        'ollama-ai-provider-v2',
        '@radix-ui/react-checkbox',
        '@radix-ui/react-collapsible',
        '@radix-ui/react-context-menu',
        '@radix-ui/react-dialog',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-label',
        '@radix-ui/react-popover',
        '@radix-ui/react-scroll-area',
        '@radix-ui/react-switch',
        '@radix-ui/react-tabs',
        '@radix-ui/react-tooltip',
        'react-toastify',
        '@bjorn3/browser_wasi_shim',

        /*
         * These imports are added by Vite/React Router transforms, so the
         * dependency scanner cannot reliably see them before the browser does.
         * Pre-bundle them up front to avoid invalidating optimized URLs on the
         * first page load (504 "Outdated Optimize Dep").
         */
        '@octokit/rest',
        'vite-plugin-node-polyfills/shims/buffer',
        'vite-plugin-node-polyfills/shims/process',

        'class-variance-authority',
        'react-markdown',
        'remark-gfm',
        'rehype-raw',
        'rehype-sanitize',
        'unist-util-visit',
        'shiki',
        '@codemirror/autocomplete',
        '@codemirror/commands',
        '@codemirror/lang-cpp',
        '@codemirror/lang-css',
        '@codemirror/lang-html',
        '@codemirror/lang-javascript',
        '@codemirror/lang-json',
        '@codemirror/lang-markdown',
        '@codemirror/lang-python',
        '@codemirror/lang-sass',
        '@codemirror/lang-vue',
        '@codemirror/lang-wast',
        '@codemirror/language',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@uiw/codemirror-theme-vscode',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-web-links',
        '@webcontainer/api',
        'diff',
        'date-fns',
        'js-cookie',
        'jszip',
        'file-saver',
        'path-browserify',
        'chart.js',
        'react-chartjs-2',
        'react-resizable-panels',
        'react-dnd',
        'react-dnd-html5-backend',
        'react-window',
        'react-qrcode-logo',
        'isomorphic-git',
        'isomorphic-git/http/web',
        'istextorbinary',
        'ignore',
        'chalk',
        'lucide-react',
        'jspdf',
        'react-icons/bi',
        'react-icons/bs',
        'react-icons/fa',
        'react-icons/si',
        'react-icons/tb',
      ],
    },
    environments: {
      client: {
        /*
         * React Router reads `build/client/.vite/manifest.json` while bundling the
         * server build. Under `@cloudflare/vite-plugin` the server build runs in
         * parallel with the client build, so the client manifest has to be
         * requested explicitly or React Router fails with ENOENT.
         */
        build: { manifest: true },
      },
    },
    plugins: [
      /*
       * Browser polyfills for `Buffer` / `process` / `global`.
       *
       * This replaces `vite-plugin-node-polyfills`, which cannot be used here: its
       * `config()` hook applies `optimizeDeps` and resolve aliases globally, and
       * under `@cloudflare/vite-plugin` the `ssr` environment is evaluated inside
       * workerd, where the plugin's CommonJS shims fail with
       * `ReferenceError: module is not defined`. Remix v2 never hit this because
       * its (now removed) Cloudflare dev proxy ran the SSR environment in Node.
       *
       * The worker does not need these: `nodejs_compat` in wrangler.jsonc provides
       * the real Node builtins. Only the browser bundle needs shimming, so this is
       * restricted to the client environment.
       *
       * The shims are imported from `vite-plugin-node-polyfills/shims/*` because
       * those are real ESM builds with named exports; the underlying `buffer`
       * package is CommonJS and exposes no named `Buffer` export.
       */
      browserPolyfills(),
      /*
       * The Cloudflare plugin is what makes the SSR environment run in **workerd**,
       * and workerd is why a deployment built with it cannot read its own
       * environment: `process.env` is empty inside the worker, so a key supplied to
       * the container (`OPENAI_LIKE_API_KEY`, `docker compose --env-file`) is
       * invisible to every server route — `/api/check-env-key` answers `isSet:false`
       * and the model list comes back empty, with no error to explain it. Bindings
       * are the worker's answer to that; a container is not a worker.
       *
       * `BUILD_TARGET=node` builds the SSR bundle for Node instead, which is what
       * the container image does (see the Dockerfile). Upstream's Cloudflare path is
       * untouched and still the default: unset the variable and this is the same
       * plugin list upstream ships.
       */
      config.mode !== 'test' && process.env.BUILD_TARGET !== 'node' && cloudflare({ viteEnvironment: { name: 'ssr' } }),
      /*
       * Listed before `reactRouter()` on purpose: plugin `configurePreviewServer`
       * hooks run in this array's order, and this middleware has to see a request
       * before the router handler does.
       */
      config.mode !== 'test' && process.env.BUILD_TARGET === 'node' && previewClientAddressPlugin(),
      config.mode !== 'test' && reactRouter(),
      UnoCSS(),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
    ],
    /*
     * `vite preview` answers only the hosts it was told about, and answers 403 to any
     * other: `Blocked request. This host ("bolt-app") is not allowed.` The image is
     * served by name, never by `localhost` — the sign-in proxy in front of it forwards
     * `bolt.ontrak.technology`, and the service name is what the proxy dials — so both
     * are named here. `PREVIEW_ALLOWED_HOSTS` is the deployment's own additions,
     * comma-separated, for a stack that publishes a second name.
     */
    preview: {
      allowedHosts: [
        'bolt-app',
        ...(process.env.PREVIEW_ALLOWED_HOSTS ?? 'bolt.ontrak.technology')
          .split(',')
          .map((host) => host.trim())
          .filter(Boolean),
      ],
    },
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OPENAI_LIKE_API_MODELS',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
    ],

    /*
     * Test configuration lives in vitest.config.ts.
     *
     * It used to live here, which meant the test runner loaded this file and
     * therefore the whole application build - the Cloudflare plugin, the React
     * Router plugin, UnoCSS and the browser-polyfill transform. Those are
     * individually guarded by `config.mode !== 'test'`, but keeping them in one
     * file couples the test environment to the build graph: a plugin added for
     * the app can change how tests behave. Split apart, the runner never reads
     * this file at all.
     */
  };
});

/*
 * Give the Node-served app a client address it can trust.
 *
 * Every route wrapped in `withSecurity` rate limits per client, and it refuses the
 * request outright (503) when it cannot name the client: a deployment with no
 * address is a deployment where `/api/chat` and `/api/llmcall` answer nothing. The
 * Cloudflare build gets the address from the runtime (`context.clientAddress`); the
 * Node build has no such binding, and `vite preview` — what `dockerstart` runs —
 * hands the app an empty load context, so `context.clientAddress` is `undefined` and
 * the model list loads while every turn is refused.
 *
 * The address is taken from the connection, and from a proxy's forwarding header only
 * where the connection is a proxy's. This middleware copies it onto `x-real-ip` and
 * the deployment sets `BUG_REPORT_TRUSTED_IP_HEADER=x-real-ip` (see the compose file),
 * which is what makes the header trustworthy: this server writes it on *every*
 * request, so a client that sends its own `x-real-ip` is overwritten rather than
 * believed.
 *
 * `x-forwarded-for` is read for its **last** hop, and only that one. The deployment's
 * only way in is `bolt-sso`, the oauth2-proxy container in front of this one — with it
 * every turn arrives from the proxy's address, so keying on the socket would put every
 * person in one bucket, and two people working at once would rate limit each other.
 * A proxy *appends* the address it saw a request come from, so the last hop is the one
 * the proxy itself added; anything a client wrote is earlier in the list and is never
 * read. That is also why the header is then dropped: nothing downstream should be able
 * to be told where a request came from by the request itself. As a belt to that brace,
 * only a private-network peer is believed at all — a direct caller on the compose
 * network is the proxy or one of this stack's own containers, never the internet.
 */
function previewClientAddressPlugin(): Plugin {
  return {
    name: 'ontrak-preview-client-address',
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((req, _res, next) => {
        const peer = req.socket?.remoteAddress;

        if (peer) {
          // `::ffff:172.17.0.1` and `172.17.0.1` are the same client; keying them
          // as two would double that client's allowance.
          const direct = peer.replace(/^::ffff:/, '');
          const forwarded = String(req.headers['x-forwarded-for'] ?? '')
            .split(',')
            .pop()
            ?.trim();

          /*
           * A borrowed hop still has to be an address: a proxy that fills the header
           * with `unknown`, or a chain that ends in something that is not an IP, must
           * fall back to the peer rather than hand the app a value it will reject —
           * a rejected value is the 503 this middleware exists to prevent.
           */
          const usable = isPrivateAddress(direct) && looksLikeAddress(forwarded) ? forwarded! : direct;

          req.headers['x-real-ip'] = usable.replace(/^::ffff:/, '');
        }

        delete req.headers['x-forwarded-for'];
        next();
      });
    },
  };
}

/** A bare IPv4 or IPv6 literal, which is all a rate-limit key needs. */
function looksLikeAddress(value: string | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-fA-F:.]+$/.test(value) && /[.:]/.test(value);
}

/** Loopback and RFC 1918 peers — where this stack's own proxy sits. */
function isPrivateAddress(address: string): boolean {
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}
