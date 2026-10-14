// Checks the WCAG contrast of every colour pair DESIGN.md promises, in both themes and all accents.
//   node scripts/contrast.mjs
const oklchToRgb = (l, c, h) => {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b, m_ = l - 0.1055613458 * a - 0.0638541728 * b, s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
  return lin.map((v) => Math.min(1, Math.max(0, v)));
};
const lum = (spec) => {
  const [l, c, h] = spec.split(/\s+/).map(Number);
  const [r, g, b] = oklchToRgb(l / 100, c, h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const themes = {
  light: { bg: "97.8 .006 60", surface: "99.3 .004 60", surface2: "95.5 .009 60", text: "25 .015 50", text2: "45 .015 50", text3: "56 .012 50", line: "88.5 .010 60" },
  dark: { bg: "18.5 .010 50", surface: "22 .012 50", surface2: "26 .014 50", text: "94 .008 60", text2: "77 .012 60", text3: "64 .012 60", line: "34 .014 50" },
};
const accents = {
  terracotta: { light: ["56 .14 40", "98.5 .01 60", "50 .13 40", "93.5 .035 45"], dark: ["72 .12 40", "20 .03 40", "78 .10 40", "33 .05 40"] },
  amber: { light: ["66 .14 68", "22 .04 60", "50 .11 65", "94 .045 80"], dark: ["80 .13 78", "21 .03 60", "84 .11 80", "34 .05 70"] },
  sage: { light: ["50 .08 150", "98.5 .01 150", "45 .08 150", "93.5 .03 150"], dark: ["75 .08 150", "20 .02 150", "80 .07 150", "32 .04 150"] },
  plum: { light: ["48 .12 330", "98.5 .01 330", "45 .12 330", "94 .03 330"], dark: ["75 .10 330", "20 .03 330", "81 .08 330", "33 .05 330"] },
};
let failures = 0;
const check = (label, fg, bg, min) => {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${r.toFixed(2).padStart(5)} >= ${min}  ${label}`);
};
for (const [t, c] of Object.entries(themes)) {
  for (const surf of ["bg", "surface", "surface2"]) {
    check(`${t} text on ${surf}`, c.text, c[surf], 4.5);
    check(`${t} text-2 on ${surf}`, c.text2, c[surf], 4.5);
    check(`${t} text-3 on ${surf} (placeholder)`, c.text3, c[surf], 3);
  }
  for (const [name, a] of Object.entries(accents)) {
    const [fill, on, text, soft] = a[t];
    check(`${t} ${name} on-accent on accent`, on, fill, 4.5);
    check(`${t} ${name} accent-text on surface`, text, c.surface, 4.5);
    check(`${t} ${name} accent-text on bg`, text, c.bg, 4.5);
    check(`${t} ${name} text on accent-soft (chips)`, c.text, soft, 4.5);
    check(`${t} ${name} accent fill vs surface (indicator)`, fill, c.surface, 3);
  }
}
console.log(failures ? `\n${failures} pair(s) below target` : "\nall pairs meet their targets");
process.exit(failures ? 1 : 0);
