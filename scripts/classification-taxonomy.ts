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
  },
  {
    value: "drink",
    aliases: [
      "drink",
      "drinks",
      "beverage",
      "beverages",
      "mocktail",
      "cocktail",
      "smoothie",
      "juice",
      "lemonade",
      "milkshake",
      "milk shake",
      "lassi",
      "sharbat",
      "shikanji",
      "panna",
      "aam panna",
      "jaljeera",
      "chaas",
      "buttermilk",
      "nimbu pani",
      "thandai",
      "cooler",
      "tea",
      "chai",
      "iced tea",
      "masala tea",
      "green tea",
      "coffee"
    ],
    exclusions: ["tea cake", "tea time", "panna cotta"]
  },
  {
    value: "dessert",
    aliases: [
      "dessert",
      "desserts",
      "sweet dish",
      "mithai",
      "cake",
      "brownie",
      "brownies",
      "cookie",
      "cookies",
      "pudding",
      "ice cream",
      "kulfi",
      "kheer",
      "halwa",
      "ladoo",
      "laddu",
      "barfi",
      "burfi",
      "gulab jamun",
      "jalebi",
      "rasmalai"
    ]
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
    "sabzi curry",
    "soup",
    "paneer",
    "kofta",
    "tikka",
    "korma"
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

// Descriptions used as criteria for the Jev AI fallback. Keyed by the
// supported taxonomy values so adding a meal type or cuisine requires a description.
export const MEAL_TYPE_DESCRIPTIONS = {
  breakfast: "Typically eaten in the morning or at brunch, such as poha, upma, parathas, pancakes, or porridge.",
  lunch: "A main midday meal, such as curries, dals, rice dishes, sandwiches, salads, or tiffin dishes.",
  dinner: "A main evening meal, such as curries, dals, rice dishes, pasta, or other substantial entrees.",
  snack: "A light bite, appetizer, starter, chaat, or tea-time item rather than a full meal.",
  drink: "A beverage that is drunk, such as tea, coffee, lassi, juices, smoothies, mocktails, or coolers.",
  dessert: "A sweet dish served after a meal or as a treat, such as cakes, cookies, kheer, halwa, or mithai."
} as const satisfies Record<MealType, string>;

export const CUISINE_DESCRIPTIONS = {
  Indian: "Dishes from any Indian regional tradition, such as curries, dals, biryanis, dosas, parathas, or chaat.",
  "Indo-Chinese": "Indian-style Chinese and Himalayan street food, such as manchurian, hakka noodles, schezwan fried rice, chilli paneer, momos, or dumplings.",
  Italian: "Italian dishes, such as pasta, pizza, risotto, lasagna, or focaccia.",
  "Middle Eastern": "Middle Eastern dishes, such as falafel, hummus, shawarma, tabbouleh, or za'atar flatbreads.",
  Mexican: "Mexican dishes, such as tacos, burritos, quesadillas, enchiladas, or salsas.",
  Global: "A clearly identifiable cuisine not listed above, such as Thai, Japanese, Korean, French, Greek, or American."
} as const satisfies Record<Cuisine, string>;

export const CUISINE_UNCLEAR_DESCRIPTION =
  "The recipe does not clearly belong to one cuisine, for example generic baking, basic techniques, or fusion without a dominant tradition.";

export const CUISINE_POLICY = {
  unclassified: "Return null when no cuisine aliases are detected.",
  global: "Use the Global cuisine for explicit non-core cuisine aliases that do not map to a specific supported cuisine."
} as const;
