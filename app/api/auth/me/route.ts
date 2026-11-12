import { route } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The logged-in user. */
export const GET = route(async ({ user }) => user);
