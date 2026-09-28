"use client";

import { Button } from "@/components/ui";

/**
 * A print button.
 *
 * A client component for the one thing only the browser can do: hand the page to
 * the print dialog, where the certificate becomes a PDF or a sheet of paper. The
 * sheet itself is styled for paper (see `.certificate-sheet` in `globals.css`),
 * so the fallback — Ctrl-P, or the browser menu — produces the same result.
 */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" size="sm" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
