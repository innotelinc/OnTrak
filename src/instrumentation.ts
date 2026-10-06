/**
 * Next.js instrumentation: the one hook that runs when the server boots.
 *
 * Nothing here decides anything, and it holds no state — it is a place to say out
 * loud what the environment got wrong, once, before the first request arrives.
 *
 * Two registrations need it, and they fail the same way: silently.
 *
 *  * **LTI.** A half-wired `ONTRAK_LTI_*` block makes `/api/lti/login` and
 *    `/api/lti/launch` answer `503`, and without this line the only person who
 *    finds out is a learner who clicked a link in their LMS — who cannot tell a
 *    mis-configured deployment from a broken product.
 *  * **Single sign-on.** A half-wired `ONTRAK_OIDC_*` block quietly stops the
 *    sign-in page publishing an SSO button, so the deployment falls back to local
 *    passwords and looks, from the outside, exactly like one that never wanted
 *    single sign-on. The operator who set those variables believes otherwise.
 *
 * `ltiConfigWarning` and `ssoConfigWarning` turn each set of issues into one
 * sentence naming the variables at fault, and return `null` when that integration
 * is off or correct — the ordinary case, which prints nothing.
 *
 * Guarded on `NEXT_RUNTIME` for the same reason every other Next app does it: this
 * file is loaded for the edge runtime too, where `process.env` is not the whole
 * story, and the check is only meaningful where the server reads the environment.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Imported at call time so the module graph the edge runtime builds does not
  // include files that only the Node server needs.
  const { ltiConfigWarning } = await import("./lib/lti-rules");
  const { ssoConfigWarning } = await import("./lib/oidc-rules");
  for (const warning of [ltiConfigWarning(), ssoConfigWarning()]) {
    if (warning) console.warn(warning);
  }
}
