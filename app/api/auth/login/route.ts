import type { NextRequest } from "next/server";
import { appSecret, authenticate, COOKIE, makeToken, SESSION_SECONDS } from "@/lib/server/auth";
import { errorResponse, Fields, HttpError, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Check the AppUser login (PBKDF2 hash) and set the signed session cookie. */
export async function POST(req: NextRequest) {
  try {
    const body = await Fields.body(req);
    const username = body.str("username", { maxLength: 50 });
    const password = body.str("password", { maxLength: 200 });
    body.check();
    const user = await authenticate(username.trim(), password);
    if (!user) throw new HttpError(401, "Wrong username or password.");
    const res = json({ user });
    // not "secure" so it works on http://localhost; serve over HTTPS (and set secure) in production
    res.cookies.set(COOKIE, makeToken(user, appSecret()), {
      maxAge: SESSION_SECONDS, httpOnly: true, sameSite: "lax", path: "/",
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
