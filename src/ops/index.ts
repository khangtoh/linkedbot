// Entry point for the operation registry with every stored kind registered.
import "./chain.js";
import { registerKind } from "./registry.js";
import { recipeKind } from "./recipe.js";

registerKind("api", recipeKind());

export * from "./registry.js";
export * from "./run.js";
