import type { AudienceInput } from "@/lib/radar/types";

export interface Preset {
  id: string;
  title: string;
  category: string;
  brief?: string;
  names: string[];
  audience: AudienceInput;
  /** A contrasting audience for the "flip" comparison. */
  contrast: AudienceInput;
}

/**
 * Demo scenarios. They are starting points only: every verdict is computed live
 * from Qloo at request time, nothing here is a cached result.
 */
export const PRESETS: Preset[] = [
  {
    id: "energy",
    title: "Energy drink · hip-hop fans",
    category: "a caffeinated sparkling energy drink",
    brief: "Bold, street-culture positioning; sold in convenience stores and at concerts.",
    names: ["Tidal", "Utopia"],
    audience: { label: "Young hip-hop fans", anchors: ["Travis Scott", "Kendrick Lamar", "Nike"], ageBuckets: ["24_and_younger", "25_to_29"] },
    contrast: { label: "Coastal boomers", anchors: ["Jimmy Buffett", "L.L.Bean", "Patagonia"], ageBuckets: ["55_and_older"] },
  },
  {
    id: "game-studio",
    title: "Indie game studio",
    category: "an indie video game studio making cozy narrative games",
    names: ["Hollow", "Ember"],
    audience: { label: "Cozy gamers", anchors: ["Stardew Valley", "Animal Crossing", "Studio Ghibli"] },
    contrast: { label: "Finance professionals", anchors: ["The Wall Street Journal", "Bloomberg", "Rolex"], ageBuckets: ["35_to_44", "45_to_54"] },
  },
  {
    id: "skincare",
    title: "Clean skincare · Gen Z",
    category: "a clean, minimalist skincare line",
    brief: "DTC, TikTok-first.",
    names: ["Euphoria", "Glow"],
    audience: { label: "Gen Z beauty fans", anchors: ["Glossier", "Olivia Rodrigo", "Sephora"], ageBuckets: ["24_and_younger"] },
    contrast: { label: "Classic-rock dads", anchors: ["Led Zeppelin", "Harley-Davidson", "Top Gear"], ageBuckets: ["45_to_54", "55_and_older"] },
  },
];
