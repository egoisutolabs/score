import type { Metadata } from "next";
// Bundled fonts (the design file's pair): the console must render
// identically with no network, so no Google Fonts <link>.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
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
