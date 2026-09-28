"use server";

/**
 * Certificate verification.
 *
 * Deliberately public and database-free: a completion record or an assurance
 * packet carries everything needed to check it, so an auditor with the file can
 * confirm it without an account and without trusting this deployment's data.
 * Nothing is written, and the decision itself lives in `interpretEvidence` so it
 * can be unit-tested away from the framework.
 */

import { interpretEvidence } from "@/lib/certificates";

export interface VerifyState {
  /** `idle` before the first submission; `error` when the pasted text is unusable. */
  status: "idle" | "valid" | "invalid" | "error";
  kind?: "record" | "packet";
  code?: string;
  summary?: string;
  error?: string;
}

export async function verifyEvidence(
  _previous: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  return interpretEvidence(String(formData.get("evidence") ?? ""));
}
