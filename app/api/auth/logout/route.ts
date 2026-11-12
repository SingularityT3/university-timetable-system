import { NextResponse } from "next/server";
import { COOKIE } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clear the session cookie (no login needed). */
export async function POST() {
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(COOKIE, "", { maxAge: 0, httpOnly: true, sameSite: "lax", path: "/" });
  return res;
}
