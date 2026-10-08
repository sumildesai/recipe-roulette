import { cuisineJevQuestions, cuisineResponseFromJev, type AiCuisineResponse } from "./cuisine-classification";
import { decideWithJev, mapWithConcurrency, type JevClientOptions, type JevQuestions } from "./jev-client";
import { mealJevQuestions, mealResponseFromJev, type AiMealResponse, type MealClassificationInput } from "./meal-classification";

export interface AiClassificationRequest {
  id: string;
  input: MealClassificationInput;
  needsMeal: boolean;
  needsCuisine: boolean;
}

export interface AiClassificationResult {
  meal?: AiMealResponse;
  cuisine?: AiCuisineResponse;
}

export interface ClassifyWithJevOptions extends JevClientOptions {
  concurrency?: number;
  decide?: typeof decideWithJev;
}

export function buildJevQuestions(request: Pick<AiClassificationRequest, "needsMeal" | "needsCuisine">): JevQuestions {
  return {
    ...(request.needsMeal ? mealJevQuestions() : {}),
    ...(request.needsCuisine ? cuisineJevQuestions() : {})
  };
}

/**
 * Sends one Jev request per recipe, containing only the questions that recipe
 * still needs. Recipes whose request fails are omitted from the result.
 */
export async function classifyWithJev(
  requests: AiClassificationRequest[],
  { concurrency = 4, decide = decideWithJev, ...clientOptions }: ClassifyWithJevOptions
): Promise<Map<string, AiClassificationResult>> {
  const results = new Map<string, AiClassificationResult>();
  await mapWithConcurrency(requests.filter((request) => request.needsMeal || request.needsCuisine), concurrency, async (request) => {
    const answers = await decide(
      { state: { title: request.input.title, description: request.input.description }, questions: buildJevQuestions(request) },
      clientOptions
    );
    if (!answers) return;
    const result: AiClassificationResult = {};
    const meal = request.needsMeal ? mealResponseFromJev(answers) : null;
    const cuisine = request.needsCuisine ? cuisineResponseFromJev(answers) : null;
    if (meal) result.meal = meal;
    if (cuisine) result.cuisine = cuisine;
    if (meal || cuisine) results.set(request.id, result);
  });
  return results;
}
