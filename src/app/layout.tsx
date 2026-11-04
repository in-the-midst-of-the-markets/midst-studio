import { withBasePath } from "@/lib/config/base-path";
import { GeistMono } from "geist/font/mono";
// Montserrat is the marketing face (weights 300, 400, 500, 700, 800). The files
// are vendored under src/fonts so the build never fetches fonts.googleapis.com.
// The CSS variable name stays --font-geist-sans: globals.css maps that name to
// --font-sans, and the editor keeps Geist Mono on --font-geist-mono.
import localFont from "next/font/local";
import type { Metadata } from "next";
import "./globals.css";

const Montserrat = localFont({
  src: [
    { path: "../fonts/montserrat/montserrat-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "../fonts/montserrat/montserrat-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/montserrat/montserrat-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/montserrat/montserrat-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../fonts/montserrat/montserrat-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
});
import { SessionEndedRedirect } from "@/components/auth/SessionEndedRedirect";
import { SubscriptionRelease } from "@/components/marketplace/SubscriptionRelease";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const title = "in the KnowSQL of the markets";
const description =
  "A self-hosted database management platform for SQL and NoSQL databases, with schema exploration, query tools, data import, and AI-assisted database development.";
// Project previews use the public demo documented in README, including on private deployments.
const siteUrl = "https://libredb.org";
const previewImage = {
  url: `https://raw.githubusercontent.com/libredb/libredb-studio/main/public/screenshots/hero-editor.png`,
  alt: "KnowSQL SQL editor and query results",
};

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    type: "website",
    url: siteUrl,
    title,
    description,
    siteName: "KnowSQL",
    images: [{ ...previewImage, width: 1440, height: 900 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [previewImage],
  },
  manifest: withBasePath("/site.webmanifest"),
  icons: {
    icon: [
      { url: withBasePath("/favicon.ico?v=6"), sizes: "any" },
      { url: withBasePath("/favicon.png"), type: "image/png" },
    ],
    shortcut: withBasePath("/favicon.ico?v=6"),
    apple: [{ url: withBasePath("/apple-touch-icon.png"), sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning is scoped to <html>/<body> only: browser extensions
    // (Grammarly, dark-mode injectors, ...) mutate attributes on these two elements
    // before React hydrates. It suppresses attribute/text mismatches on THESE nodes
    // alone — real hydration bugs inside {children} are still reported.
    <html lang="en" suppressHydrationWarning>
      {/*
        The `dark` class used to be written here, which pinned standalone studio to
        one theme. It is now owned by ThemeProvider, which writes it onto <html>
        (`attribute="class"`) and restores the user's choice before paint.
      */}
      <body suppressHydrationWarning className={`${Montserrat.variable} ${GeistMono.variable} antialiased font-sans`}>
        <ThemeProvider>
          {children}
          <SessionEndedRedirect />
          <SubscriptionRelease />
          {/* No `theme` prop: Toaster reads next-themes itself, so it follows. */}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
