import type { Metadata, Viewport } from "next";
import "./globals.css";
import GlobalWorkflowNav from "@/components/GlobalWorkflowNav";
import { ThemeInit } from "@/components/ThemeInit";
import { UserIdentityInit } from "@/components/UserIdentityInit";

export const metadata: Metadata = {
  title: {
    default: "TPCharness",
    template: "%s · TPCharness",
  },
  description: "技术推广文档智能生成平台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{function migrate(storage){var keys=[];for(var i=0;i<storage.length;i++)keys.push(storage.key(i));keys.forEach(function(key){if(!key)return;var lower=key.toLowerCase();var next=null;if(lower.indexOf("tpdhermes")===0)next="TPCharness"+key.slice(9);else if(lower.indexOf("tphermes")===0)next="TPCharness"+key.slice(8);if(next&&storage.getItem(next)==null)storage.setItem(next,storage.getItem(key));});}migrate(localStorage);migrate(sessionStorage);var raw=localStorage.getItem("TPCharness-theme");var parsed=raw?JSON.parse(raw):null;var theme=parsed&&parsed.state?parsed.state.theme:null;if(theme==="light"){document.documentElement.classList.remove("dark");document.documentElement.setAttribute("data-theme","light");}else{document.documentElement.classList.add("dark");document.documentElement.setAttribute("data-theme","dark");}}catch(e){document.documentElement.classList.add("dark");document.documentElement.setAttribute("data-theme","dark");}})();`,
          }}
        />
      </head>
      <body className="flex h-dvh min-h-0 flex-col bg-slate-50 font-sans text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100" suppressHydrationWarning>
        <ThemeInit />
        <UserIdentityInit />
        <GlobalWorkflowNav />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </body>
    </html>
  );
}
