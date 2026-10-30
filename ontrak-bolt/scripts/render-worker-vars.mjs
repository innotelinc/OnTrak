#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Put the deployment's environment where the worker can see it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Bolt is built as a **Cloudflare Worker** (`workers/app.ts`, `wrangler.jsonc`) and
 * `vite preview` — what `dockerstart` runs — serves that worker through Cloudflare's
 * Vite plugin, which executes it in workerd. That isolate **cannot see the
 * container's environment**: `docker exec … printenv OPENAI_LIKE_API_KEY` shows the
 * key, and `/api/check-env-key?provider=OpenAILike` answers `{"isSet":false}`. The
 * deployment looks configured and offers no models, and nothing is logged anywhere —
 * an empty model list is a valid answer.
 *
 * What the isolate *can* see is the `vars` block of `wrangler.jsonc`, which the
 * plugin publishes to the worker as its environment (measured: `process.env` inside
 * the preview worker carries exactly those vars, while `context.cloudflare.env` is
 * empty on this path). So this script copies the deployment's model settings from
 * the container's environment into that block at start, before the server runs.
 * Nothing secret is baked into the image — the key arrives as an environment
 * variable and is written to the container's own copy of the config on boot.
 *
 * Run: node scripts/render-worker-vars.mjs   (the entrypoint does, on every start)
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/** The keys the app reads from `serverEnv`, and the only ones copied across. */
const KEYS = ['OPENAI_LIKE_API_BASE_URL', 'OPENAI_LIKE_API_KEY', 'OPENAI_LIKE_API_MODELS'];

const CONFIG = process.env.WRANGLER_CONFIG || '/app/wrangler.jsonc';

/**
 * Strip JSONC comments and trailing commas so a config a human edited still parses.
 *
 * `wrangler.jsonc` is JSON with comments by definition — wrangler accepts both — and
 * a `JSON.parse` that fails here would take the container down at boot over a
 * comment. Only what is needed for this file's shape is handled.
 */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }

      continue;
    }

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }

      continue;
    }

    if (inString) {
      out += char;

      if (char === '\\') {
        out += next;
        i++;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }

    out += char;
  }

  // Trailing commas before a closing brace or bracket.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function main() {
  let raw;

  try {
    raw = readFileSync(CONFIG, 'utf8');
  } catch (error) {
    console.error(`render-worker-vars: cannot read ${CONFIG}: ${error.message}`);
    return 1;
  }

  let config;

  try {
    config = JSON.parse(parseJsonc(raw));
  } catch (error) {
    console.error(`render-worker-vars: ${CONFIG} is not valid JSONC: ${error.message}`);
    return 1;
  }

  const vars = { ...(config.vars ?? {}) };
  const applied = [];

  for (const key of KEYS) {
    const value = process.env[key];

    if (typeof value === 'string' && value.length > 0) {
      vars[key] = value;
      applied.push(key);
    }
  }

  if (applied.length === 0) {
    // An unconfigured deployment is a valid state: the console then offers no
    // provider and says so. Leaving the file alone keeps the stderr quiet.
    return 0;
  }

  config.vars = vars;

  const temporary = `${CONFIG}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, CONFIG);

  console.log(`render-worker-vars: worker vars set from the environment: ${applied.join(', ')}`);

  return 0;
}

process.exit(main());
