import { api, ApiError, qs } from "@/lib/api";
import { go } from "@/lib/nav";
import { mockFetch } from "./helpers";

vi.mock("@/lib/nav", () => ({ go: vi.fn() }));

describe("api()", () => {
  it("prefixes /api and returns JSON", async () => {
    const fetch = mockFetch({ body: { ok: 1 } });
    await expect(api("/meta")).resolves.toEqual({ ok: 1 });
    expect(fetch.mock.calls[0][0]).toBe("/api/meta");
  });

  it("throws ApiError with the detail and joins validation errors", async () => {
    mockFetch({ status: 409, body: { detail: "already taken" } }, { status: 422, body: { detail: [{ msg: "a" }, { msg: "b" }] } });
    await expect(api("/x")).rejects.toEqual(new ApiError(409, "already taken"));
    await expect(api("/x")).rejects.toMatchObject({ status: 422, detail: "a; b" });
  });

  it("redirects to /login on 401 (except for the login call itself)", async () => {
    mockFetch({ status: 401, body: { detail: "Not logged in" } }, { status: 401, body: { detail: "bad" } });
    await expect(api("/meta")).rejects.toBeInstanceOf(ApiError);
    expect(go).toHaveBeenCalledWith("/login");
    vi.mocked(go).mockClear();
    await expect(api("/auth/login", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ApiError);
    expect(go).not.toHaveBeenCalled();
  });

  it("handles 204 No Content", async () => {
    mockFetch({ status: 204 });
    await expect(api("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });
});

describe("qs()", () => {
  it("skips empty values", () => {
    expect(qs("/absence", { faculty_id: 3, year: "2026-2027", day: "" })).toBe("/absence?faculty_id=3&year=2026-2027");
    expect(qs("/x", {})).toBe("/x");
  });
});
