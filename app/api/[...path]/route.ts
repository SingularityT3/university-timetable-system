import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unknown API paths answer like FastAPI did. */
const notFound = async () => json({ detail: "Not Found" }, 404);
export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
