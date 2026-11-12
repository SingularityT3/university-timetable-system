import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the API (app/api/**/route.ts) talks to MySQL and Neo4j from the Node.js runtime
  serverExternalPackages: ["mysql2", "neo4j-driver"],
};

export default nextConfig;
