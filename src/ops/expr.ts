import jsonata from "jsonata";

// Values in a chain are literals, except objects of the exact shape { "$expr": "<JSONata>" }, which
// are evaluated against { input, steps } plus loop bindings such as $person and $index.
export type Expr = { $expr: string };
export const MAX_EXPR_LENGTH = 2000;

export const isExpr = (v: unknown): v is Expr =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Expr).$expr === "string";

const cache = new Map<string, jsonata.Expression>();

function compile(src: string): jsonata.Expression {
  let e = cache.get(src);
  if (!e) {
    if (src.length > MAX_EXPR_LENGTH) throw new Error(`expression is longer than ${MAX_EXPR_LENGTH} characters`);
    e = jsonata(src);
    if (cache.size > 1000) cache.clear();
    cache.set(src, e);
  }
  return e;
}

// Syntax check for validation; returns a readable message or null.
export function exprError(src: string): string | null {
  try {
    compile(src);
    return null;
  } catch (e) {
    const err = e as { message: string; position?: number };
    return err.position === undefined ? err.message : `${err.message} (at character ${err.position})`;
  }
}

// JSONata returns arrays with extra properties and unwraps one-element sequences; a JSON round trip
// gives plain data back.
const plain = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export async function evalValue(value: unknown, scope: object, bindings: Record<string, unknown> = {}): Promise<unknown> {
  if (isExpr(value)) {
    try {
      return plain(await compile(value.$expr).evaluate(scope, bindings));
    } catch (e) {
      throw new Error(`Expression "${value.$expr}" failed: ${(e as Error).message}`);
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => evalValue(v, scope, bindings)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = await evalValue(v, scope, bindings);
      if (r !== undefined) out[k] = r; // a missing value leaves the argument out, so its default applies
    }
    return out;
  }
  return value;
}

// Every expression inside a value, for validation.
export function exprsIn(value: unknown): string[] {
  if (isExpr(value)) return [value.$expr];
  if (Array.isArray(value)) return value.flatMap(exprsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(exprsIn);
  return [];
}

// Step ids an expression reads through `steps.<id>`.
export const stepRefs = (src: string) => [...src.matchAll(/\bsteps\.([a-z][a-z0-9_]*)/g)].map((m) => m[1]);
