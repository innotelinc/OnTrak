"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { verifyEvidence, type VerifyState } from "@/app/actions/certificates";
import { Alert, Badge, Button, Field, Textarea } from "@/components/ui";
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
 * A client component because the result belongs beside the text the user just
 * pasted — a redirect round-trip would throw that paste away, which is exactly
 * what someone re-checking a suspicious record needs to look at again.
 */
export function VerifyForm() {
  const t = useTranslator();
  const [state, action] = useActionState(verifyEvidence, EMPTY_VERIFY_STATE);

  return (
    <form action={action} className="space-y-4">
      {state.status === "error" && state.error ? (
        <Alert tone="danger" title={t("verify.invalid.title")}>
          {state.error}
        </Alert>
      ) : null}

      {state.status === "valid" ? (
        <Alert tone="teal" title={t("verify.valid.title")}>
          <p>{t("verify.valid.body")}</p>
          {state.code ? (
            <p className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">{state.code}</span>
              <Badge tone="teal">{state.kind === "packet" ? t("verify.kind.packet") : t("verify.kind.record")}</Badge>
            </p>
          ) : null}
          {state.summary ? <p className="mt-1 text-sm">{state.summary}</p> : null}
        </Alert>
      ) : null}

      {state.status === "invalid" ? (
        <Alert tone="danger" title={t("verify.invalid.title")}>
          <p>{t("verify.invalid.body")}</p>
          {state.code ? <p className="mt-2 font-mono text-sm font-semibold">{state.code}</p> : null}
          {state.summary ? <p className="mt-1 text-sm">{state.summary}</p> : null}
        </Alert>
      ) : null}

      <Field label={t("verify.label")} htmlFor="evidence" hint={t("verify.hint")}>
        <Textarea
          id="evidence"
          name="evidence"
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={t("verify.placeholder")}
          required
        />
      </Field>

      <SubmitButton label={t("verify.submit")} />
    </form>
  );
}
