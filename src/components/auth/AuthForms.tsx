"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signIn, signUp, type AuthState } from "@/app/actions/auth";
import { Alert, Button, Field, Input } from "@/components/ui";

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? (
        <>
          <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          Working…
        </>
      ) : (
        children
      )}
    </Button>
  );
}

const EMPTY: AuthState = {};

export function SignInForm({ next }: { next?: string }) {
  const [state, action] = useActionState(signIn, EMPTY);

  return (
    <form action={action} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error ? <Alert tone="danger" title="Sign-in failed">{state.error}</Alert> : null}

      <Field label="Email" htmlFor="email" error={state.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@college.edu" />
      </Field>

      <Field label="Password" htmlFor="password" error={state.fieldErrors?.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required placeholder="••••••••" />
      </Field>

      <SubmitButton>Sign in</SubmitButton>
    </form>
  );
}

export function RegisterForm({ showJoinCode }: { showJoinCode: boolean }) {
  const [state, action] = useActionState(signUp, EMPTY);

  return (
    <form action={action} className="space-y-4">
      {state.error ? <Alert tone="danger" title="Could not create the account">{state.error}</Alert> : null}

      <Field label="Full name" htmlFor="name" error={state.fieldErrors?.name}>
        <Input id="name" name="name" autoComplete="name" required placeholder="Alex Rivera" />
      </Field>

      <Field label="Email" htmlFor="reg-email" error={state.fieldErrors?.email}>
        <Input id="reg-email" name="email" type="email" autoComplete="email" required placeholder="you@college.edu" />
      </Field>

      <Field label="Password" htmlFor="reg-password" hint="8 characters minimum" error={state.fieldErrors?.password}>
        <Input id="reg-password" name="password" type="password" autoComplete="new-password" required placeholder="••••••••" />
      </Field>

      {showJoinCode ? (
        <Field label="Class code" htmlFor="joinCode" hint="optional" error={state.fieldErrors?.joinCode}>
          <Input id="joinCode" name="joinCode" placeholder="e.g. NET101" className="uppercase" />
        </Field>
      ) : null}

      <SubmitButton>Create my student account</SubmitButton>

      <p className="text-center text-xs text-ink-faint">
        Staff accounts (instructor, administrator) are created by an administrator from the{" "}
        <span className="font-semibold text-ink-soft">Admin → People</span> screen.
      </p>
    </form>
  );
}
