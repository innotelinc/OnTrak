/**
 * Next.js instrumentation: the one hook that runs when the server boots.
 *
 * Nothing here decides anything, and it holds no state — it is a place to say out
 * loud what the environment got wrong, once, before the first request arrives.
 *
 * The training app's LTI registration is the case that needs it. A half-wired
 * `ONTRAK_LTI_*` block makes `/api/lti/login` and `/api/lti/launch` answer `503`,
 * and without this line the only person who finds out is a learner who clicked a
 * link in their LMS — who cannot tell a mis-configured deployment from a broken
 * product. `ltiConfigWarning` turns the issues into one sentence naming the
 * variables at fault, and `null` when LTI is off or correct, which is the ordinary
 * case and prints nothing.
 *
 * Guarded on `NEXT_RUNTIME` for the same reason every other Next app does it: this
 * file is loaded for the edge runtime too, where `process.env` is not the whole
 * story, and the check is only meaningful where the server reads the environment.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Imported at call time so the module graph the edge runtime builds does not
  // include a file that only the Node server needs.
  const { ltiConfigWarning } = await import("./lib/lti-rules");
  const warning = ltiConfigWarning();
  if (warning) console.warn(warning);
}
