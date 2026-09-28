import Link from "next/link";

import { VerifyPacketForm } from "../../components/VerifyPacketForm";

export const metadata = { title: "Verify an assurance packet" };

/**
 * Packet verification (M3), open on purpose.
 *
 * The whole claim of the Assurance Packet is that someone who holds nothing but
 * the file and the key can check it. A verifier behind a sign-in would undercut
 * that, so this page is outside the desk shell, reads no session and touches no
 * database — it takes a document and a key and answers a question about them.
 *
 * For the same job without a browser, `npm run verify:packet -- packet.json`
 * runs the identical check offline.
 */
export default function VerifyPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-10">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold text-ink">Verify an assurance packet</h1>
        <p className="text-sm text-ink-soft">
          Load the packet you were given and the deployment&apos;s signing key. The check recomputes the packet&apos;s
          digests and its signature locally — nothing is stored, and a packet that has been edited since it was signed
          will fail.
        </p>
      </div>

      <VerifyPacketForm />

      <p className="text-xs text-ink-faint">
        Offline, from a checkout: <code className="font-mono">npm run verify:packet -- packet.json</code>. The key is read
        from <code className="font-mono">ONTRAK_TIX_ASSURANCE_SECRET</code> or passed with{" "}
        <code className="font-mono">--key</code>. No database, session or network is involved.
      </p>

      <p className="text-xs text-ink-faint">
        <Link href="/sign-in" className="font-semibold text-brand hover:underline">
          Sign in
        </Link>{" "}
        to the desk.
      </p>
    </main>
  );
}
