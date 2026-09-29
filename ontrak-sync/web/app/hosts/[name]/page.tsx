import { HostDetail } from "@/components/HostDetail";

/**
 * The dynamic route is a server component whose only job is to resolve `params`,
 * which Next 15+ hands over as a promise. The view itself is client-side because it
 * authenticates with the token in `localStorage`, which the server cannot see.
 */
export default async function HostPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <HostDetail name={decodeURIComponent(name)} />;
}
