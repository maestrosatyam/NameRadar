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
const HIPHOP: AudienceInput = {
  label: "Young hip-hop & streetwear fans",
  anchors: ["Travis Scott", "Kendrick Lamar", "Nike"],
  ageBuckets: ["24_and_younger", "25_to_29"],
};
const COASTAL: AudienceInput = {
  label: "Older coastal & outdoors shoppers",
  anchors: ["Jimmy Buffett", "L.L.Bean", "Patagonia"],
  ageBuckets: ["55_and_older"],
};
const COZY: AudienceInput = {
  label: "Cozy gamers & anime fans",
  anchors: ["Stardew Valley", "Animal Crossing", "Studio Ghibli"],
};

export const PRESETS: Preset[] = [
  {
    id: "energy",
    title: "Energy drink · hip-hop fans",
    category: "a caffeinated sparkling energy drink",
    brief: "Bold, street-culture positioning; sold in convenience stores and at concerts.",
    names: ["Tidal", "Euphoria"],
    audience: HIPHOP,
    contrast: COZY,
  },
  {
    id: "game-studio",
    title: "Indie game studio · cozy gamers",
    category: "an indie studio making cozy narrative video games",
    names: ["Halo", "Hollow"],
    audience: COZY,
    contrast: COASTAL,
  },
  {
    id: "podcast",
    title: "Science podcast · older listeners",
    category: "a weekly science explainer podcast",
    brief: "Warm, curious, for lifelong learners.",
    names: ["Nova", "Atlas"],
    audience: COASTAL,
    contrast: HIPHOP,
  },
];
