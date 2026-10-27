import type { Metadata } from "next";
import "./globals.css";

const siteUrl = new URL("https://sumildesai.github.io/recipe-roulette/");
const socialPreviewUrl = new URL("recipe-roulette-social-preview.png", siteUrl).toString();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "Recipe Roulette",
  description: "Spin for a recipe from Your Food Lab and Ranveer Brar.",
  openGraph: {
    title: "Recipe Roulette",
    description: "What's for dinner? Let the wheel decide.",
    images: [{ url: socialPreviewUrl, width: 1200, height: 630, alt: "A dinner ticket asking what's for dinner, with a roulette wheel to decide." }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Recipe Roulette",
    description: "What's for dinner? Let the wheel decide.",
    images: [socialPreviewUrl]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
