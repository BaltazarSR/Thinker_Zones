import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thinkers Zones",
  description: "A casual, persistent, GPS-based territory game.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="antialiased">
      <body>{children}</body>
    </html>
  );
}
