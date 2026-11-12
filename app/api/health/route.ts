import { pool, query } from "@/lib/server/db";
import { neo4jStatus } from "@/lib/server/api";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Are MySQL and Neo4j reachable? (no login needed) */
export async function GET() {
  let mysql = true;
  try {
    await query(pool(), "SELECT 1 AS ok");
  } catch {
    mysql = false;
  }
  return json({ mysql, neo4j: (await neo4jStatus())[0] });
}
