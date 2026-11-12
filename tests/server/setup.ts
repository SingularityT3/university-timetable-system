import { afterAll } from "vitest";
import { closePools } from "@/lib/server/db";
import { loadEnv } from "@/lib/server/env";

loadEnv();
afterAll(closePools);
