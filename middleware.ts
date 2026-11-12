import { NextResponse, type NextRequest } from "next/server";

/** Send visitors without a session cookie to /login. Real authorisation happens in the API. */
export function middleware(req: NextRequest) {
  if (req.cookies.has("tt_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (req.nextUrl.pathname !== "/") url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // everything except the login page, the API proxy, Next.js internals and static files
  matcher: ["/((?!login|api/|_next/|favicon\\.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)"],
};
