import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginPage from "@/app/login/page";
import { go } from "@/lib/nav";
import { mockFetch } from "./helpers";

vi.mock("@/lib/nav", () => ({ go: vi.fn() }));

function fillAndSubmit(username: string, password: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("login page", () => {
  beforeEach(() => vi.mocked(go).mockClear());

  it("posts the credentials and goes to the timetable", async () => {
    const fetch = mockFetch({ body: { user: { username: "admin", role: "admin" } } });
    render(<LoginPage />);
    fillAndSubmit("admin", "admin123");
    await waitFor(() => expect(go).toHaveBeenCalledWith("/timetable"));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "admin123" });
  });

  it("shows the API's error on 401 and stays on the page", async () => {
    mockFetch({ status: 401, body: { detail: "Invalid username or password" } });
    render(<LoginPage />);
    fillAndSubmit("admin", "wrong");
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password");
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("lists the demo accounts", () => {
    render(<LoginPage />);
    expect(screen.getByText(/admin \/ admin123/)).toBeInTheDocument();
  });
});
