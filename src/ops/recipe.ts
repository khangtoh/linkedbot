import type { Locator, Page } from "playwright";
import { assertHealthy } from "../browser.js";
import { consume, humanDelay, isCapCategory, type CapCategory } from "../limits.js";
import { checkNavigation, LINKEDIN_POLICY, type Policy } from "../policy.js";
import { evalValue, exprError, exprsIn, isExpr, type Expr } from "./expr.js";
import type { KindHandler } from "./registry.js";
import { checkSchema } from "./run.js";
import type { RunContext, StoredOp } from "./types.js";

// A generated API is a recipe: a short list of read-only browser steps run by this interpreter.
// There is deliberately no step that types, submits, follows a link or runs page JavaScript; the
// network guard in policy.ts is the backstop if a page reacts to an `expand` click with a write.
export type FieldSpec = {
  selector: string | string[]; // Playwright selectors, tried in order; ":scope" is the list item itself
  attr?: string; // "text" (default), "lines", "href", "src", or any attribute name
  line?: number; // with attr "lines": which non-empty line, from 0
  pattern?: string; // regular expression; the first group (or the whole match) is kept
  required?: boolean; // the run fails if this field is not found
};
export type RecipeStep =
  | { type: "goto"; url: string | Expr }
  | { type: "waitFor"; selector: string; timeoutMs?: number }
  | { type: "scroll"; until?: { selector: string; count: number }; maxScrolls?: number }
  | { type: "expand"; selector: string; max?: number }
  | { type: "extract"; as: string; fields: Record<string, FieldSpec> }
  | { type: "extractList"; as: string; item: string; fields: Record<string, FieldSpec>; limit?: number; dedupeBy?: string };
export type RecipeDef = StoredOp & { kind: "api"; cost: CapCategory; steps: RecipeStep[]; output?: unknown };

export type RecipeRun = { output: unknown; vars: Record<string, unknown>; missing: string[]; log: string[] };

const NAME = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const MAX_LIST = 200;
// Class names like ".x7Fa9Q2" or "._3bc1f" are generated per LinkedIn release and break silently.
const GENERATED_CLASS = /\.(_[\w-]*|(?=[\w-]*\d)(?=[\w-]*[a-zA-Z])[\w-]{5,})(?![\w-])/;

const selectorsOf = (spec: FieldSpec) => (Array.isArray(spec.selector) ? spec.selector : [spec.selector]);

// ---------- validation ----------

function checkSelector(where: string, sel: unknown, errors: string[]): void {
  if (typeof sel !== "string" || !sel.trim() || sel.length > 500) return void errors.push(`${where}: selector must be a non-empty string`);
  const generated = GENERATED_CLASS.exec(sel.replace(/"[^"]*"|'[^']*'/g, ""));
  if (generated && !/^\.(text|pv|ph|mv|mh|t|artdeco|pvs|entity|link|inline|visually)-/.test(generated[0])) {
    errors.push(`${where}: "${generated[0]}" looks like a generated class name, which LinkedIn changes between releases; anchor on roles, text, links or ids instead`);
  }
}

function checkFields(where: string, fields: unknown, errors: string[]): void {
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) return void errors.push(`${where}: fields must name at least one field`);
  if (Object.keys(fields).length > 50) errors.push(`${where}: at most 50 fields`);
  for (const [name, spec] of Object.entries(fields as Record<string, FieldSpec>)) {
    const at = `${where}.${name}`;
    if (!NAME.test(name)) errors.push(`${at}: field names are letters, digits and underscores`);
    if (!spec || typeof spec !== "object") {
      errors.push(`${at}: must be an object with a selector`);
      continue;
    }
    const sels = selectorsOf(spec);
    if (!sels.length || sels.length > 5) errors.push(`${at}: give 1 to 5 selectors`);
    for (const s of sels) if (s !== ":scope") checkSelector(at, s, errors);
    if (spec.pattern !== undefined) {
      try {
        new RegExp(spec.pattern);
      } catch {
        errors.push(`${at}: pattern is not a valid regular expression`);
      }
    }
    if (spec.line !== undefined && (!Number.isInteger(spec.line) || spec.line < 0)) errors.push(`${at}: line must be a whole number from 0`);
  }
}

export function validateRecipe(def: RecipeDef, policy: Policy = LINKEDIN_POLICY): string[] {
  const errors: string[] = [...checkSchema(def.inputSchema)];
  if (!isCapCategory(String(def.cost)) || def.cost === "connect" || def.cost === "message") errors.push('cost must be "view_profile" or "search": the daily cap each page load counts against');
  if (!Array.isArray(def.steps) || !def.steps.length) return [...errors, "an API needs at least one step"];
  if (def.steps[0]?.type !== "goto") errors.push('the first step must be "goto"');
  if (def.steps.length > 30) errors.push("at most 30 steps");
  const vars = new Set<string>();
  def.steps.forEach((step, i) => {
    const at = `step ${i + 1} (${step?.type})`;
    switch (step?.type) {
      case "goto":
        if (isExpr(step.url)) {
          const err = exprError(step.url.$expr);
          if (err) errors.push(`${at}: ${err}`);
        } else if (typeof step.url !== "string") errors.push(`${at}: url must be a string or an expression`);
        else {
          const nav = checkNavigation(step.url, policy);
          if (!nav.ok) errors.push(`${at}: ${nav.reason}`);
        }
        break;
      case "waitFor":
        checkSelector(at, step.selector, errors);
        if (step.timeoutMs !== undefined && !(Number.isInteger(step.timeoutMs) && step.timeoutMs >= 100 && step.timeoutMs <= 30_000)) errors.push(`${at}: timeoutMs must be 100-30000`);
        break;
      case "scroll":
        if (step.until) {
          checkSelector(at, step.until.selector, errors);
          if (!Number.isInteger(step.until.count) || step.until.count < 1) errors.push(`${at}: until.count must be a whole number from 1`);
        }
        if (step.maxScrolls !== undefined && !(Number.isInteger(step.maxScrolls) && step.maxScrolls >= 1 && step.maxScrolls <= 10)) errors.push(`${at}: maxScrolls must be 1-10`);
        break;
      case "expand":
        checkSelector(at, step.selector, errors);
        if (step.max !== undefined && !(Number.isInteger(step.max) && step.max >= 1 && step.max <= 10)) errors.push(`${at}: max must be 1-10`);
        break;
      case "extract":
      case "extractList":
        if (typeof step.as !== "string" || !NAME.test(step.as)) errors.push(`${at}: "as" names the result, e.g. "company"`);
        else if (vars.has(step.as)) errors.push(`${at}: "${step.as}" is already used`);
        else vars.add(step.as);
        checkFields(at, step.fields, errors);
        if (step.type === "extractList") {
          checkSelector(`${at} item`, step.item, errors);
          if (step.limit !== undefined && !(Number.isInteger(step.limit) && step.limit >= 1 && step.limit <= MAX_LIST)) errors.push(`${at}: limit must be 1-${MAX_LIST}`);
          if (step.dedupeBy !== undefined && !(step.dedupeBy in (step.fields ?? {}))) errors.push(`${at}: dedupeBy must name one of its fields`);
        }
        break;
      default:
        errors.push(`${at}: unknown step type (supported: goto, waitFor, scroll, expand, extract, extractList)`);
    }
  });
  if (!vars.size) errors.push("an API needs at least one extract or extractList step");
  for (const src of exprsIn(def.output)) {
    const err = exprError(src);
    if (err) errors.push(`output: ${err}`);
  }
  return errors;
}

// ---------- running ----------

async function readField(root: Locator, spec: FieldSpec, pageUrl: string): Promise<string | null> {
  for (const sel of selectorsOf(spec)) {
    const loc = sel === ":scope" ? root : root.locator(sel).first();
    if (sel !== ":scope" && (await loc.count()) === 0) continue;
    const attr = spec.attr ?? "text";
    let value: string | null;
    if (attr === "text" || attr === "lines") {
      const text = (await loc.innerText({ timeout: 2_000 }).catch(() => loc.textContent({ timeout: 2_000 }))) ?? "";
      value = attr === "lines" ? (text.split("\n").map((s) => s.trim()).filter(Boolean)[spec.line ?? 0] ?? null) : text.replace(/\s+\n/g, "\n").trim();
    } else {
      value = await loc.getAttribute(attr, { timeout: 2_000 }).catch(() => null);
      if (value && (attr === "href" || attr === "src")) {
        try {
          value = new URL(value, pageUrl).href;
        } catch { /* keep as is */ }
      }
    }
    if (value && spec.pattern) {
      const m = new RegExp(spec.pattern).exec(value);
      value = m ? (m[1] ?? m[0]) : null;
    }
    if (value) return value;
  }
  return null;
}

async function readFields(root: Locator, fields: Record<string, FieldSpec>, page: Page, missing: string[], where: string) {
  const out: Record<string, string | null> = {};
  for (const [name, spec] of Object.entries(fields)) {
    out[name] = await readField(root, spec, page.url());
    if (out[name] === null) {
      if (spec.required) throw new Error(`Could not find ${where}${name} (${selectorsOf(spec).join(" or ")}) on ${page.url()}`);
      missing.push(`${where}${name}`);
    }
  }
  return out;
}

export type RecipeOptions = { policy?: Policy; delay?: [number, number] };

export async function runRecipeOnPage(def: RecipeDef, input: unknown, page: Page, opts: RecipeOptions & { skipNavigation?: boolean } = {}): Promise<RecipeRun> {
  const policy = opts.policy ?? LINKEDIN_POLICY;
  const [dMin, dMax] = opts.delay ?? [2000, 5000];
  const vars: Record<string, unknown> = {};
  const missing: string[] = [];
  const log: string[] = [];
  for (const step of def.steps) {
    switch (step.type) {
      case "goto": {
        if (opts.skipNavigation) break; // re-checking extraction on a page that is already loaded
        const url = String(await evalValue(step.url, { input, vars }));
        const nav = checkNavigation(url, policy);
        if (!nav.ok) throw new Error(`Refusing to open ${url}: ${nav.reason}`);
        consume(def.cost);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await humanDelay(dMin, dMax);
        assertHealthy(page);
        const landed = checkNavigation(page.url(), policy);
        if (!landed.ok) throw new Error(`LinkedIn sent the browser to ${page.url()}, which generated APIs may not read`);
        log.push(`opened ${page.url()}`);
        break;
      }
      case "waitFor":
        await page.locator(step.selector).first().waitFor({ timeout: step.timeoutMs ?? 15_000 }).catch(() => {
          throw new Error(`Timed out waiting for ${step.selector} on ${page.url()}`);
        });
        break;
      case "scroll": {
        const max = step.maxScrolls ?? 3;
        let n = 0;
        for (; n < max; n++) {
          if (step.until && (await page.locator(step.until.selector).count()) >= step.until.count) break;
          await page.mouse.wheel(0, 2500);
          await humanDelay(Math.min(dMin, 800), Math.min(dMax, 1500));
        }
        log.push(`scrolled ${n} time(s)`);
        break;
      }
      case "expand": {
        const targets = page.locator(step.selector);
        const count = Math.min(await targets.count(), step.max ?? 3);
        for (let i = 0; i < count; i++) {
          const el = targets.nth(i);
          // Buttons only: never a link, never inside a form.
          const safe = await el.evaluate((n) => (n.tagName === "BUTTON" || n.getAttribute("role") === "button") && !n.closest("form") && !n.closest("a[href]")).catch(() => false);
          if (!safe) {
            log.push(`skipped expanding ${step.selector} #${i}: not a plain button`);
            continue;
          }
          const before = page.url();
          await el.click({ timeout: 3_000 }).catch(() => {});
          await humanDelay(Math.min(dMin, 500), Math.min(dMax, 1200));
          if (page.url() !== before) throw new Error(`Expanding ${step.selector} navigated to ${page.url()}; generated APIs may only expand content in place`);
        }
        log.push(`expanded ${count} element(s)`);
        break;
      }
      case "extract":
        vars[step.as] = await readFields(page.locator("body"), step.fields, page, missing, `${step.as}.`);
        break;
      case "extractList": {
        const items = page.locator(step.item);
        const n = Math.min(await items.count(), step.limit ?? 50, MAX_LIST);
        const rows: Record<string, string | null>[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < n; i++) {
          const row = await readFields(items.nth(i), step.fields, page, missing, `${step.as}[${i}].`);
          const key = step.dedupeBy ? row[step.dedupeBy] : null;
          if (key !== null && step.dedupeBy) {
            if (seen.has(key)) continue;
            seen.add(key);
          }
          rows.push(row);
        }
        vars[step.as] = rows;
        log.push(`${step.as}: ${rows.length} item(s)`);
        break;
      }
    }
  }
  const names = Object.keys(vars);
  const output = def.output !== undefined ? await evalValue(def.output, { input, vars }) : names.length === 1 ? vars[names[0]] : vars;
  return { output, vars, missing, log };
}

export function recipeKind(opts: RecipeOptions = {}): KindHandler {
  return {
    validate: (def) => validateRecipe(def as RecipeDef, opts.policy),
    cost: (def) => ({ [(def as RecipeDef).cost]: (def as RecipeDef).steps.filter((s) => s.type === "goto").length }),
    usesLinkedIn: () => true,
    run: async (def, input, ctx: RunContext) => (await runRecipeOnPage(def as RecipeDef, input, await ctx.page(), opts)).output,
  };
}
