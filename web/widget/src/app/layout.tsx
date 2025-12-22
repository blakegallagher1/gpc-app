import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IND_ACQ Underwriting Widget",
  description: "Industrial Acquisition Underwriting Tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
