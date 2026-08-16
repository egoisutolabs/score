import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "score",
  description: "score console — the fleet at a glance",
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    // The console is a committed dark instrument (see globals.css); the class
    // keeps shadcn's dark-scoped styles in agreement with the overridden tokens.
    <html lang="en" className="dark">
      <body className="h-dvh overflow-hidden antialiased">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
