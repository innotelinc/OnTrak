import { GateFrame } from "@/components/GateFrame";
import { familyDomain } from "@/lib/family";

import { LoginRoute } from "./LoginRoute";

/**
 * `/login` — the same panel the shell draws, on its own page, inside the family's
 * front door.
 *
 * The route exists so that a link, a bookmark, or the Cerulean SSO callback can name a
 * destination. The frame it draws is the same one the shell draws for a signed-out
 * visitor on every other route, so `/` and `/login` are the same front door under two
 * addresses — and neither is two headers over one screen, because the shell hands the
 * sign-in routes their own children untouched.
 *
 * The address under the product's name comes from `familyDomain()` (`lib/family.ts`),
 * which the signed-in console's masthead reads as well — the same value in both, so a
 * product cannot print one name at its front door and another inside it.
 */
export default function LoginPage() {
  return (
    <GateFrame domain={familyDomain()}>
      <LoginRoute />
    </GateFrame>
  );
}
