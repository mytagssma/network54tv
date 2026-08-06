import type { Metadata } from "next";
import "@fontsource/iosevka/latin.css";
import "./globals.css";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "n54tv // network54tv",
  description: "Stream anime — sub & dub, subtitles, any episode.",
  keywords: ["anime", "streaming", "subtitles", "dub", "sub"],
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    other: [
      { url: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  openGraph: {
    title: "n54tv // network54tv",
    description: "Stream anime — sub & dub, subtitles, any episode.",
    type: "website",
  },
};

// Script to apply accent color from localStorage before paint
const accentScript = `
  (function() {
    try {
      var stored = localStorage.getItem('n54tv-accent');
      if (stored) {
        document.documentElement.style.setProperty('--accent', stored);
        // Convert hex to RGB for inline rgba() usage
        var r = parseInt(stored.slice(1, 3), 16);
        var g = parseInt(stored.slice(3, 5), 16);
        var b = parseInt(stored.slice(5, 7), 16);
        document.documentElement.style.setProperty('--accent-rgb', r + ', ' + g + ', ' + b);
      }
    } catch(e) {}
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: accentScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-[var(--background)] text-white cyber-grid-bg">
        <Navbar />
        <main className="relative z-10 flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
