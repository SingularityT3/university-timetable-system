import { route } from "@/lib/server/http";
import { browseNodes } from "@/lib/server/neo4j";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Node browser: nodes of one label, optionally filtered by key/name. */
export const GET = route(async ({ query: q }) => {
  const label = q.str("label");
  const search = q.optStr("search");
  const limit = q.int("limit", { default: 50, ge: 1, le: 500 });
  q.check();
  return browseNodes(label, search, limit);
});
