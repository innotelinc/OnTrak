/**
 * `GET /api/scim/v2/ServiceProviderConfig` — what this deployment supports.
 *
 * Deliberately readable **without a token**: it describes the server rather than
 * anybody's people, and a connector that authenticates before it can read what the
 * provider supports cannot report a useful error when its credential is wrong. The
 * answer is honest rather than optimistic — `bulk`, `changePassword` and `sort` are
 * declared unsupported, because a connector that reads `true` for a feature this
 * surface does not have will use it and fail on somebody's first real sync.
 */

import type { NextRequest } from "next/server";

import { serviceProviderConfig } from "@/lib/scim-rules";
import { scimJson, methodNotAllowed } from "../_scim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest): Promise<Response> {
  return scimJson(200, serviceProviderConfig());
}

export async function POST(): Promise<Response> {
  return methodNotAllowed(["GET"]);
}
