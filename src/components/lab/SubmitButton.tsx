"use client";

import { useFormStatus } from "react-dom";

import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui";

/**
 * A submit button that says it is working.
 *
 * Every control on a lab session is slow, and the reason is the product rather than the
 * code: ending a session destroys a machine, resetting one clones a fresh one, and a check
 * runs the grader inside the guest. A plain submit button says nothing at all while that
 * happens, so a click reads as a dead button and a student presses again — one real session
 * was recycled five times in four seconds by a student waiting for the first press.
 *
 * `useFormStatus` is the same mechanism the sign-in and certificate forms use (`AuthForms`,
 * `VerifyForm`), so the button disables and relabels the moment it is pressed, and the
 * label names the work: "Ending…" is an answer, an unresponsive button is not.
 *
 * It is a client component because the pending state is React's, not the server's — the
 * surrounding page stays a server component and imports this one just for the button.
 */
export function SubmitButton({
  pendingLabel,
  children,
  disabled,
  ...rest
}: {
  pendingLabel: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending} {...rest}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
