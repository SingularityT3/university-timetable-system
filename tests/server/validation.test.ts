/** Request validation (lib/server/http.ts Fields): lenient coercion and 422 error types (no database). */
import { describe, expect, it } from "vitest";
import { Fields, HttpError } from "@/lib/server/http";

/** The value read for `name`, or the 422 issue types when it is rejected. */
function read<T>(data: Record<string, unknown>, get: (f: Fields) => T): T | string[] {
  const f = new Fields(data, ["query"]);
  const value = get(f);
  try {
    f.check();
    return value;
  } catch (e) {
    return ((e as HttpError).detail as { type: string }[]).map((i) => i.type);
  }
}

describe("integers", () => {
  const int = (v: unknown) => read({ id: v }, (f) => f.int("id"));

  it("accepts numeric strings, \"7.0\" and booleans", () => {
    for (const [v, n] of [["7", 7], [" 7 ", 7], ["+7", 7], ["01", 1], ["1_000", 1000], ["1.0", 1],
      ["-1.000", -1], [true, 1], [false, 0], [2, 2], [2.0, 2]] as const) expect(int(v), String(v)).toBe(n);
  });

  it("rejects anything else, with a typed error", () => {
    for (const v of ["1.5", "1.", ".0", "1e3", "0x10", "1__0", "_1", "abc", "", "1.0e0"]) expect(int(v), v).toEqual(["int_parsing"]);
    expect(int(2.5)).toEqual(["int_from_float"]);
    expect(int(null)).toEqual(["int_type"]);
    expect(int([1])).toEqual(["int_type"]);
  });

  it("range checks apply after coercion", () => {
    expect(read({ p: "9.0" }, (f) => f.int("p", { ge: 1, le: 8 }))).toEqual(["less_than_equal"]);
    expect(read({ p: false }, (f) => f.int("p", { ge: 1, le: 8 }))).toEqual(["greater_than_equal"]);
  });
});

describe("floats", () => {
  it("accept booleans and numeric strings (then range-checked)", () => {
    expect(read({ t: true }, (f) => f.float("t", { default: 30, ge: 5 }))).toEqual(["greater_than_equal"]);
    expect(read({ t: "12.5" }, (f) => f.float("t", { default: 30, ge: 5 }))).toBe(12.5);
  });
});
