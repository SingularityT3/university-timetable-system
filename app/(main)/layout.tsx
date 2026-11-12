"use client";

import { Alert } from "@/components/Alert";
import { AppProvider } from "@/components/AppProvider";
import { Sidebar } from "@/components/Sidebar";
import { Spinner } from "@/components/Spinner";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider
      fallback={(error) => (
        <main className="content">
          {error ? (
            <>
              <Alert kind="error">Cannot reach the API: {error}</Alert>
              <Alert kind="info">
                Check that the FastAPI service is running (see README) and that MySQL is up, then reload this page.
              </Alert>
            </>
          ) : (
            <Spinner />
          )}
        </main>
      )}
    >
      <div className="shell">
        <Sidebar />
        <main className="content">{children}</main>
      </div>
    </AppProvider>
  );
}
