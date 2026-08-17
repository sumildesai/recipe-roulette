import type { Cuisine, MealType } from "../lib/types";

export interface ClassificationRule<T extends string> {
  value: T;
  aliases: readonly string[];
  exclusions?: readonly string[];
}

export const MEAL_TYPE_RULES = [
  { value: "breakfast", aliases: ["breakfast", "nashta", "morning", "brunch"] },
  { value: "lunch", aliases: ["lunch", "tiffin", "midday", "midday meal"] },
  { value: "dinner", aliases: ["dinner", "supper", "evening meal", "date night"] },
  {
    value: "snack",
    aliases: ["snack", "snacks", "chaat", "starter", "appetizer", "tea time", "evening snack"],
    exclusions: ["starter pack"]
  }
] as const satisfies readonly ClassificationRule<MealType>[];

// Signals that a recipe is a generic entree/main dish without saying which
// main meal it belongs to. When this matches and neither lunch nor dinner
// is explicitly detected, the recipe should be tagged as both.
export const ENTREE_RULE = {
  value: "entree",
  aliases: [
    "main course",
    "main dish",
    "entree",
    "entrée",
    "sabzi",
    "sabji",
    "curry",
    "dal",
    "gravy",
    "sabzi curry"
  ]
} as const satisfies ClassificationRule<"entree">;

export const CUISINE_RULES = [
  {
    value: "Indo-Chinese",
    aliases: [
      "indo chinese",
      "indochinese",
      "chinese",
      "schezwan",
      "sichuan",
      "manchurian",
      "hakka",
      "chilli garlic",
      "chowmein",
      "chinese fried rice"
    ]
  },
  { value: "Italian", aliases: ["italian", "pasta", "pizza", "risotto", "alfredo", "arrabbiata", "lasagna"] },
  { value: "Mexican", aliases: ["mexican", "taco", "burrito", "quesadilla", "enchilada", "nachos", "salsa"] },
  {
    value: "Middle Eastern",
    aliases: ["middle eastern", "arabic", "falafel", "hummus", "shawarma", "tahini", "pita", "zaatar", "labneh"]
  },
  {
    value: "Indian",
    aliases: [
      "indian",
      "masala",
      "paneer",
      "biryani",
      "dal",
      "sabzi",
      "paratha",
      "chaat",
      "tikka",
      "curry",
      "pulao",
      "dosa",
      "idli",
      "sambar",
      "rasam",
      "chettinad",
      "korma",
      "kadhi",
      "thepla",
      "undhiyu",
      "poha",
      "misal",
      "upma",
      "pongal",
      "appam",
      "puttu",
      "avial",
      "litti",
      "bati",
      "chole",
      "rajma",
      "sarson",
      "makki",
      "kashmiri",
      "awadhi",
      "goan",
      "mangalorean",
      "hyderabadi",
      "amritsari",
      "gujarati",
      "rajasthani",
      "maharashtrian",
      "bengali",
      "punjabi",
      "south indian",
      "north indian"
    ]
  },
  {
    value: "Global",
    aliases: [
      "thai",
      "japanese",
      "korean",
      "vietnamese",
      "french",
      "spanish",
      "greek",
      "turkish",
      "american",
      "continental",
      "mediterranean",
      "sushi",
      "ramen",
      "kimchi",
      "paella"
    ]
  }
] as const satisfies readonly ClassificationRule<Cuisine>[];

export const CUISINE_POLICY = {
  unclassified: "Return null when no cuisine aliases are detected.",
  global: "Use the Global cuisine for explicit non-core cuisine aliases that do not map to a specific supported cuisine."
} as const;
