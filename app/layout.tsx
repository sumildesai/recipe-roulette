import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recipe Roulette",
  description: "Spin for a recipe from Your Food Lab and Ranveer Brar.",
  openGraph: {
    title: "Recipe Roulette",
    description: "Spin the wheel for your next recipe.",
    images: [{ url: "/recipe-roulette-social-preview.svg", width: 1200, height: 630, alt: "Recipe Roulette" }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Recipe Roulette",
    description: "Spin the wheel for your next recipe.",
    images: ["/recipe-roulette-social-preview.svg"]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
