import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "University Timetable",
  description: "Clash-free university timetable generation (MySQL + Neo4j)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
