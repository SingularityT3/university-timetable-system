/** Neo4j preconditions for the server tests (port of the neo4j_session / graph_loaded fixtures). */
import { getDriver, neo4jDownReason, nodeCounts } from "@/lib/server/neo4j";

/**
 * Why the Neo4j tests must skip ("" when they can run): Neo4j is unreachable, or
 * (with needGraph) the graph has not been loaded by the ETL yet.
 */
export async function neo4jSkipReason(needGraph = true): Promise<string> {
  try {
    await getDriver();
  } catch (e) {
    return `Neo4j not reachable (${neo4jDownReason(e) ?? (e as Error).name}). Start it, then run \`npm run etl\`.`;
  }
  if (needGraph && !(await nodeCounts()).Course) return "The Neo4j graph is empty. Run `npm run etl` first.";
  return "";
}
