"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { verifyCertificateNumber, type VerifyState } from "@/app/actions/certificates";
import { Alert, Button, Field, Input } from "@/components/ui";
import { useTranslator } from "@/lib/i18n-client";

/** A `"use server"` module may only export async functions, so the empty
 * state lives beside the form that starts from it. */
const EMPTY_VERIFY_STATE: VerifyState = { status: "idle" };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Checking…" : label}
    </Button>
  );
}

/**
 * The verification form.
 *
 * One field, and two possible answers: the certificate number printed on the
 * certificate goes in, and the page says whether it stands. A client component
 * because the answer belongs beside the number just typed — a redirect round trip
 * would throw it away, which is what somebody checking a second certificate wants
 * to keep.
 */
export function VerifyForm() {
  const t = useTranslator();
  const [state, action] = useActionState(verifyCertificateNumber, EMPTY_VERIFY_STATE);

  return (
    <form action={action} className="space-y-4">
      {state.status === "error" && state.error ? (
        <Alert tone="danger" title={t("verify.invalid.title")}>
          {state.error}
        </Alert>
      ) : null}

      {state.status === "verified" ? (
        <Alert tone="teal" title={t("verify.valid.title")}>
          <p>{t("verify.valid.body")}</p>
          {state.number ? (
            <p className="mt-2 font-mono text-sm font-semibold">{state.number}</p>
          ) : null}
          {state.summary ? <p className="mt-1 text-sm">{state.summary}</p> : null}
        </Alert>
      ) : null}

      {state.status === "unverified" ? (
        <Alert tone="danger" title={t("verify.unverified.title")}>
          <p>{t("verify.unverified.body")}</p>
          {state.number ? (
            <p className="mt-2 font-mono text-sm font-semibold">{state.number}</p>
          ) : null}
        </Alert>
      ) : null}

      <Field label={t("verify.label")} htmlFor="number" hint={t("verify.hint")}>
        <Input
          id="number"
          name="number"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono uppercase"
          placeholder={t("verify.placeholder")}
          required
        />
      </Field>

      <SubmitButton label={t("verify.submit")} />
    </form>
  );
}
