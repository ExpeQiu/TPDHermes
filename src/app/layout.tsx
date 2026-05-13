import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TPDHermes",
  description: "技术推广文档智能生成平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
