import type { Metadata } from "next";
import { ClassificationStats } from "@/components/classification-stats";

export const metadata: Metadata = {
  title: "Classification stats · Recipe Roulette",
  description: "How Jev classified every recipe's meal type and cuisine."
};

export default function StatsPage() {
  return (
    <main>
      <ClassificationStats />
    </main>
  );
}
