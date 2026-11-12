import { toCsv } from "@/lib/csv";

describe("toCsv", () => {
  it("writes a header and rows in the given column order", () => {
    const csv = toCsv([{ b: 2, a: 1, c: "x" }], ["a", "b"]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  it("quotes commas, quotes and newlines; leaves null/undefined empty", () => {
    const rows = [{ name: 'Rao, "Ravi"', note: "line1\nline2", n: null, u: undefined, ok: true }];
    const csv = toCsv(rows, ["name", "note", "n", "u", "ok"]);
    expect(csv).toBe('name,note,n,u,ok\r\n"Rao, ""Ravi""","line1\nline2",,,true\r\n');
  });

  it("returns only the header for no rows", () => {
    expect(toCsv([] as { a: number }[], ["a"])).toBe("a\r\n");
  });
});
