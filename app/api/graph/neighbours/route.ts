import { route } from "@/lib/server/http";
import { nodeNeighbours } from "@/lib/server/neo4j";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every relationship of one node. */
export const GET = route(async ({ query: q }) => {
  const label = q.str("label");
  const key = q.str("key");
  const limit = q.int("limit", { default: 200, ge: 1, le: 500 });
  q.check();
  return nodeNeighbours(label, key, limit);
});
