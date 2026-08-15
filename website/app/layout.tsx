import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const siteUrl = "https://lectio-sync.johannespeulicke.chatgpt.site";

export const metadata: Metadata = {
  title: "Lectio Sync — Your timetable in your calendar",
  description: "Privately synchronize your Lectio timetable to a dedicated calendar from Chrome, Brave, Firefox or Safari.",
  icons: { icon: "/icon-128.png", shortcut: "/icon-128.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <meta property="og:title" content="Lectio Sync — Your timetable in your calendar" />
        <meta property="og:description" content="Private, automatic Lectio timetable synchronization for your desktop browser." />
        <meta property="og:url" content={siteUrl} />
        <meta property="og:image" content={`${siteUrl}/og.png`} />
        <meta name="twitter:card" content="summary_large_image" />
      </head>
      <body className={geist.variable}>{children}</body>
    </html>
  );
}
