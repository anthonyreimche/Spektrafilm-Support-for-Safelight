// Spektrafilm Support — SafeLight extension (GPL-3.0-or-later)
//
// Runs the Spektrafilm spectral film simulation LIVE per pixel on the GPU — not
// a frozen LUT. The 5-stage pipeline (expose → develop → print-expose → print-
// develop → scan) is transliterated to GLSL in film-glsl.ts (validated stage-by-
// stage against the engine), driven by per-stock spectral data (3 rgba16f
// textures + a GLSL const block) extracted by tools/extract_stock.py. Exposure
// and print exposure are live uniforms.
//
// Pair with the "Spektrafilm" display transform (registered below): the film IS
// the tone rendering, so the view transform is a plain encode with the base
// curve off.

import { FILM_HELPERS, FILM_GLSL } from "./film-glsl";
import { FILM_STOCKS, type FilmStockData, type FilmFx } from "./stocks_data.generated";

// ─── Minimal SafeLight API surface ───────────────────────────────────────────

type GlslType = "float" | "vec2" | "vec3" | "vec4" | "sampler2D";

interface UniformDeclaration {
  key: string;
  glslType: GlslType;
  default: number;
  range?: { min: number; max: number; step?: number };
  label?: string;
}

interface TextureRequirement {
  key: string;
  kind: "lut" | "coverage" | "dynamic";
  width?: number;
  height?: number;
  format?: "rgba8" | "r8" | "rgba16f" | "r16f";
}

interface StagePass {
  glsl: string;
  helpers?: string;
  iterations?: number;
  uniforms?: UniformDeclaration[];
}

interface ProcessingStageContribution {
  id: string;
  name: string;
  phase: "tone-map" | "scene-linear" | "effects" | string;
  priority?: number;
  glsl: string;
  helpers?: string;
  uniforms: UniformDeclaration[];
  passes?: StagePass[];
  textures?: TextureRequirement[];
}

interface StageTextureData {
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  format: "rgba8" | "r8" | "rgba16f" | "r16f";
  version: number;
}

interface PipelineContribution {
  id: string;
  name: string;
  description?: string;
  glsl?: string;
  skipBaseCurve?: boolean;
}

interface SafelightAPI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react: any;
  registerProcessingStage(c: ProcessingStageContribution): void;
  setStageTexture(stageId: string, key: string, tex: StageTextureData | null): void;
  registerPipeline(c: PipelineContribution): void;
  registerPanel(c: {
    id: string;
    title: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: any;
    defaultDock?: { module: "library" | "develop"; direction: "left" | "right"; order?: number; width?: number };
    onReset?: () => void;
  }): void;
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: Record<string, any>;
}

// ─── Stage ───────────────────────────────────────────────────────────────────

const STAGE_ID = "spektrafilm-support.film";
const HAL_ID = "spektrafilm-support.halation";
const GRAIN_ID = "spektrafilm-support.grain";

// Sentinel stock id meaning "off": the film stage becomes a passthrough, the
// effects go inert, and the spectral textures are dropped, so the extension
// costs nothing when you're not using it. See applyStock + the panel's picker.
const NONE_ID = "none";

// Grain cells across the frame HEIGHT at size 1.0 — the anchor that makes grain a
// constant physical size at any output resolution (see buildGrainStage). Chosen
// to look film-like at the default size; the Size slider tunes from there.
const GRAIN_REF = 2700;

// Effect character used when no stock data is bundled, so the halation/grain
// stages still compile (the panel shows the getting-started view in that case).
// Mirrors a typical negative: red-dominant halo, slightly coarser blue grain.
const DEFAULT_FX: FilmFx = {
  halTint: [1, 0.33, 0], halStrength: 0.015, halSizeFrac: 0.0019, halBounceDecay: 0.5,
  grainScale: [1, 1, 1.5], grainAreaUm2: 0.2, grainBlur: 0.65, glare: 0.03,
};

// Format a JS number triple as a GLSL vec3 literal (baked per-stock constants).
const vec3lit = (v: readonly [number, number, number]) =>
  `vec3(${v.map((x) => x.toFixed(4)).join(", ")})`;

// Slides (reversal) have no enlarger or print paper, so their bundle #defines
// SF_POSITIVE and the GLSL compiles out the print stages. Drop the print-only
// uniforms here too (Print Exposure / Filtration M+Y) and retarget Contrast to
// the film curve, so the panel and the shader agree on what exists.
const isSlide = (stock: FilmStockData) => stock.kind === "slide";

function buildStage(stock: FilmStockData): ProcessingStageContribution {
  const slide = isSlide(stock);
  const uniforms: UniformDeclaration[] = [
    { key: "sfExposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Exposure" },
    ...(slide ? [] : [{ key: "sfPrintExp", glslType: "float", default: 1, range: { min: 0.2, max: 3, step: 0.01 }, label: "Print Exposure" } as UniformDeclaration]),
    { key: "sfCouplerAmt", glslType: "float", default: 1, range: { min: 0, max: 2, step: 0.01 }, label: "Coupler Amount" },
    { key: "sfContrast", glslType: "float", default: 1, range: { min: 0.5, max: 2, step: 0.01 }, label: slide ? "Contrast" : "Print Contrast" },
    ...(slide ? [] : [
      { key: "sfFiltM", glslType: "float", default: 0, range: { min: -100, max: 100, step: 1 }, label: "Filtration M" } as UniformDeclaration,
      { key: "sfFiltY", glslType: "float", default: 0, range: { min: -100, max: 100, step: 1 }, label: "Filtration Y" } as UniformDeclaration,
    ]),
  ];
  return {
    id: STAGE_ID,
    name: "Spektrafilm",
    phase: "tone-map",
    uniforms,
    textures: [
      { key: "filmTc", kind: "lut", format: "rgba16f" },
      { key: "filmCurves", kind: "lut", format: "rgba16f" },
      { key: "filmSpec", kind: "lut", format: "rgba16f" },
    ],
    // Per-stock spectral constants are inlined as GLSL consts; changing stock
    // re-registers (recompiles) — cheap and rare. Live params stay uniforms.
    helpers: FILM_HELPERS + "\n" + stock.consts,
    glsl: FILM_GLSL,
  };
}

// ─── Halation (post-effect) ────────────────────────────────────────────────
// Back-reflection halation: bright scene light scatters through the film base
// and reflects back, blooming a glow around highlights whose HUE is the stock's
// own anti-halation balance (Portra ≈ (1,0.33,0); other stocks differ — extracted
// per stock into fx.halTint).
//
// Implemented as a MIP-CHAIN bloom done entirely INLINE — deliberately NOT the
// host's multi-pass prepass framework, which was silently falling back to the raw
// source on some setups (capped prepass-stage budget) and washing the frame with
// tint. The source `uImage` already carries a mip chain the core itself samples
// for blur (textureLod(uImage, uv, lod)); sampling it at a Size-derived LOD gives
// a blurred copy of the source per pixel with zero extra passes, so Size/Threshold
// always respond and there's nothing to fall back. Threshold isolates highlights;
// Amount screen-blends the tinted glow over the film output `c` (bright areas
// barely change, so the halo spreads into darker surroundings). Default amount
// 0 → off until dialled in.
function buildHalationStage(fx: FilmFx, mono = false): ProcessingStageContribution {
  const lumaW = "vec3(0.2126, 0.7152, 0.0722)";
  // B&W desaturates the blurred highlights so the halo is neutral grey; colour
  // stocks keep the source colour and tint it by the stock's halation balance.
  const desat = mono ? `sfBlur = vec3(dot(max(sfBlur, 0.0), ${lumaW}));` : "";
  const tint = mono ? "vec3(1.0)" : vec3lit(fx.halTint);
  return {
    id: HAL_ID,
    name: "Halation",
    phase: "effects",
    priority: 50,
    uniforms: [
      { key: "sfHalAmount", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Halation" },
      // Size = blur LOD into the source mip chain (0 = sharp highlights, 8 = very
      // wide glow). Trilinear (fractional LOD) keeps the spread smooth.
      { key: "sfHalSize", glslType: "float", default: 4, range: { min: 0, max: 8, step: 0.1 }, label: "Size" },
      // Only source values above the threshold bloom; range past 1.0 so it can
      // gate bright (HDR) highlights on the RAW float path.
      { key: "sfHalThreshold", glslType: "float", default: 0.6, range: { min: 0, max: 2, step: 0.01 }, label: "Threshold" },
    ],
    glsl: `
      vec3 sfBlur = textureLod(uImage, srcUv, clamp(sfHalSize, 0.0, 8.0)).rgb;
      ${desat}
      vec3 sfHi = max(sfBlur - sfHalThreshold, 0.0);
      // Gain (×4): the mip blur box-averages, so a highlight's energy is diluted by
      // its surroundings — a unit of Amount needs a multiplier to read. ×4 puts the
      // useful range around a natural halo; the screen-blend keeps bright areas from
      // blowing out, so it glows into darker surroundings rather than washing.
      vec3 hgl = clamp(sfHalAmount * 4.0 * ${tint} * sfHi, 0.0, 1.0);
      c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - hgl);`,
  };
}

// ─── Grain (post-effect) ───────────────────────────────────────────────────
// Film grain as a particle-statistics approximation: amplitude ∝ sqrt(p(1-p)) so
// it peaks in MIDTONES (matches the engine's binomial model). Per-channel,
// DECORRELATED value noise (independent grain per channel, not a tinted luma
// grain) at per-channel coarseness from the stock's particle scale (fx.grainScale
// — blue is physically coarser). Grain cells are placed in frame-relative,
// aspect-corrected coordinates (srcUv × uImageAspect) anchored to GRAIN_REF, so
// the grain is a CONSTANT size at any output resolution — Develop, thumbnail and
// export match (gl_FragCoord, the old coordinate, scaled with the render size and
// made grain coarser on small thumbnails). Default amount 0 → off until dialled in.
function buildGrainStage(fx: FilmFx, mono = false): ProcessingStageContribution {
  // Normalise per-channel scale to mean 1 so it only sets RELATIVE coarseness
  // (overall size stays on the Size slider); larger scale → coarser → fewer cells.
  const gm = (fx.grainScale[0] + fx.grainScale[1] + fx.grainScale[2]) / 3 || 1;
  const gs = fx.grainScale.map((x) => (x / gm).toFixed(4));
  // Two octaves of value noise (fine + finer) read more like real silver grain
  // than a single octave, which looks blobby/cellular. B&W grain is monochrome
  // (ONE shared noise → luminance grain); colour stocks use decorrelated
  // per-channel noise (coloured grain) at per-channel coarseness.
  const grainNoise = mono
    ? "vec3 gn = vec3(sfGrain2(gbase) - 0.5);"
    : `vec3 gn = vec3(
        sfGrain2(gbase / ${gs[0]}),
        sfGrain2(gbase / ${gs[1]} + vec2(37.0, 11.0)),
        sfGrain2(gbase / ${gs[2]} + vec2(91.0, 53.0))
      ) - 0.5;`;
  return {
    id: GRAIN_ID,
    name: "Grain",
    phase: "effects",
    priority: 60,
    uniforms: [
      { key: "sfGrainAmount", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Grain" },
      { key: "sfGrainSize", glslType: "float", default: 1.5, range: { min: 0.5, max: 5, step: 0.1 }, label: "Grain Size" },
    ],
    helpers: `
      float sfHash1(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float sfValNoise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sfHash1(i), sfHash1(i + vec2(1.0, 0.0)), f.x),
                   mix(sfHash1(i + vec2(0.0, 1.0)), sfHash1(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      // Two-octave grain: a fine base plus a finer, rotated detail octave, biased
      // toward the high frequency so the texture is crisp rather than cloudy.
      float sfGrain2(vec2 p) {
        float a = sfValNoise(p);
        float b = sfValNoise(p * 2.17 + vec2(19.0, 7.0));
        return clamp(0.5 + (a - 0.5) * 0.55 + (b - 0.5) * 0.85, 0.0, 1.0);
      }`,
    glsl: `
      // Frame-relative, square-celled, resolution-independent grain coordinate.
      vec2 gbase = vec2(srcUv.x * uImageAspect, srcUv.y) * (${GRAIN_REF}.0 / max(sfGrainSize, 0.5));
      // Per-channel coarseness (÷scale) + a per-channel offset so the three
      // channels are independent (coloured grain), not one luminance grain tinted.
      // B&W stocks override this with a single shared noise (monochrome grain).
      ${grainNoise}
      float glum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float genv = 2.0 * sqrt(max(glum * (1.0 - glum), 0.0));
      c += sfGrainAmount * genv * gn;`,
  };
}

let theApi: SafelightAPI | null = null;
let texVersion = 1;

// Per-image film-stock selection. The chosen stock lives in the develop paramBag
// (like the sliders) so it round-trips PER PHOTO, stored as a numeric index into
// FILM_STOCKS (-1 = None/off). Untouched photos default to None — the film is
// strictly opt-in per image, never inherited from another photo. `appliedStockId`
// tracks what's currently registered on the GPU so we re-apply only when the
// active photo asks for a different stock (re-registering recompiles). A store
// subscription re-runs this on every photo switch (loadEdit updates paramBag).
const K_STOCK = STAGE_ID + ".__stock";
let appliedStockId: string | null = null;
let storeUnsub: (() => void) | null = null;

function stockIndexForId(id: string): number {
  if (id === NONE_ID) return -1;
  const i = FILM_STOCKS.findIndex((s) => s.id === id);
  return i >= 0 ? i : 0;
}

function stockIdFromBag(bag: Record<string, unknown>): string {
  const idx = bag[K_STOCK];
  if (typeof idx === "number") return idx < 0 ? NONE_ID : (FILM_STOCKS[idx]?.id ?? NONE_ID);
  return NONE_ID; // untouched photo → off
}

function applyStock(api: SafelightAPI, id: string): void {
  if (id === NONE_ID) {
    // Off: re-register all three stages as no-ops (empty glsl leaves scene-linear
    // `lin` untouched, regardless of any slider values) and drop the spectral
    // textures so nothing stays resident. The extension is fully inert until a
    // stock is chosen again.
    api.registerProcessingStage({ id: STAGE_ID, name: "Spektrafilm", phase: "tone-map", uniforms: [], glsl: "" });
    api.registerProcessingStage({ id: HAL_ID, name: "Halation", phase: "effects", priority: 50, uniforms: [], glsl: "" });
    api.registerProcessingStage({ id: GRAIN_ID, name: "Grain", phase: "effects", priority: 60, uniforms: [], glsl: "" });
    api.setStageTexture(STAGE_ID, "filmTc", null);
    api.setStageTexture(STAGE_ID, "filmCurves", null);
    api.setStageTexture(STAGE_ID, "filmSpec", null);
    return;
  }
  const stock = FILM_STOCKS.find((s) => s.id === id) ?? FILM_STOCKS[0];
  const isBw = stock.kind === "bw";
  api.registerProcessingStage(buildStage(stock));
  // Re-register the effect stages so halation tint / grain balance follow the
  // selected stock (cheap recompile, same as swapping the film stage). B&W gets
  // a neutral (monochrome) halation glow and grain.
  api.registerProcessingStage(buildHalationStage(stock.fx, isBw));
  api.registerProcessingStage(buildGrainStage(stock.fx, isBw));
  const v = ++texVersion;
  api.setStageTexture(STAGE_ID, "filmTc", { data: stock.filmTc(), width: stock.tcSize, height: stock.tcSize, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmCurves", { data: stock.filmCurves(), width: 256, height: 3, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmSpec", { data: stock.filmSpec(), width: 81, height: 4, format: "rgba16f", version: v });
}

// Apply the stock the active photo's paramBag asks for, but only when it actually
// changed — re-registering stages recompiles, so a photo switch that keeps the
// same stock is a no-op. Called once on activate and on every develop-store change.
function ensureStockApplied(api: SafelightAPI, bag: Record<string, unknown>): void {
  const id = stockIdFromBag(bag);
  if (id === appliedStockId) return;
  appliedStockId = id;
  applyStock(api, id);
}

// ─── Panel control layout ───────────────────────────────────────────────────
// One source of truth for the panel's sliders, their defaults, AND the reset
// maps — grouped into the collapsible sections the panel renders, so a control,
// its default and its section can never drift apart.
interface Ctrl { stage: string; key: string; label: string; min: number; max: number; dflt: number; step: number; }
interface PanelSection { id: string; title: string; hint: string; ctrls: Ctrl[]; }

// Film controls differ by path: negatives expose the full enlarger-print chain;
// slides (reversal) have no print, so only Exposure / Coupler Amount / a film-
// curve Contrast apply (mirrors buildStage's per-path uniform set).
const FILM_CTRLS_NEG: Ctrl[] = [
  { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
  { stage: STAGE_ID, key: "sfPrintExp", label: "Print Exposure", min: 0.2, max: 3, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfCouplerAmt", label: "Coupler Amount", min: 0, max: 2, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfContrast", label: "Print Contrast", min: 0.5, max: 2, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfFiltM", label: "Filtration M", min: -100, max: 100, dflt: 0, step: 1 },
  { stage: STAGE_ID, key: "sfFiltY", label: "Filtration Y", min: -100, max: 100, dflt: 0, step: 1 },
];
const FILM_CTRLS_POS: Ctrl[] = [
  { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
  { stage: STAGE_ID, key: "sfCouplerAmt", label: "Coupler Amount", min: 0, max: 2, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfContrast", label: "Contrast", min: 0.5, max: 2, dflt: 1, step: 0.01 },
];
// B&W runs the full negative→print path, so the bundle keeps the negative uniform
// set, but DIR couplers and colour-head filtration are meaningless for a neutral
// silver emulsion. The panel shows just the darkroom essentials: film exposure,
// print exposure (print lightness) and Print Contrast (the paper grade).
const FILM_CTRLS_BW: Ctrl[] = [
  { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
  { stage: STAGE_ID, key: "sfPrintExp", label: "Print Exposure", min: 0.2, max: 3, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfContrast", label: "Paper Grade", min: 0.5, max: 2, dflt: 1, step: 0.01 },
];
const HAL_CTRLS: Ctrl[] = [
  { stage: HAL_ID, key: "sfHalAmount", label: "Amount", min: 0, max: 1, dflt: 0, step: 0.01 },
  { stage: HAL_ID, key: "sfHalSize", label: "Size", min: 0, max: 8, dflt: 4, step: 0.1 },
  { stage: HAL_ID, key: "sfHalThreshold", label: "Threshold", min: 0, max: 2, dflt: 0.6, step: 0.01 },
];
const GRAIN_CTRLS: Ctrl[] = [
  { stage: GRAIN_ID, key: "sfGrainAmount", label: "Amount", min: 0, max: 1, dflt: 0, step: 0.01 },
  { stage: GRAIN_ID, key: "sfGrainSize", label: "Size", min: 0.5, max: 5, dflt: 1.5, step: 0.1 },
];

function filmCtrlsFor(kind: string): Ctrl[] {
  if (kind === "slide") return FILM_CTRLS_POS;
  if (kind === "bw") return FILM_CTRLS_BW;
  return FILM_CTRLS_NEG;
}
function sectionsFor(kind: string): PanelSection[] {
  const filmHint =
    kind === "slide" ? "Slide exposure, development and contrast (reversal film, scanned directly — no enlarger print)."
    : kind === "bw" ? "Darkroom black & white: film exposure, print exposure (print lightness) and paper grade (contrast)."
    : "Negative exposure, enlarger print, development and live colour-head filtration.";
  return [
    { id: "film", title: "Film", hint: filmHint, ctrls: filmCtrlsFor(kind) },
    { id: "halation", title: "Halation", hint: "Back-reflection highlight glow, tinted to the selected stock. Off at 0.", ctrls: HAL_CTRLS },
    { id: "grain", title: "Grain", hint: "Midtone-peaked, per-channel film grain at the stock's coarseness. Off at 0.", ctrls: GRAIN_CTRLS },
  ];
}
// Flat { "stage.key": default } map for a full reset — union across every path
// (FILM_CTRLS_NEG is a superset of the slide/bw film keys) so reset clears every
// control regardless of the current stock.
const ALL_DEFAULTS: Record<string, number> = Object.fromEntries(
  [...FILM_CTRLS_NEG, ...HAL_CTRLS, ...GRAIN_CTRLS].map((c) => [`${c.stage}.${c.key}`, c.dflt]),
);

function resetPanel(api: SafelightAPI): void {
  // Reset every slider AND turn the stock off (None is the per-image default),
  // then apply + persist so the reset survives a library round-trip / reload.
  api.stores.useDevelopStore.getState().setDynParams({ ...ALL_DEFAULTS, [K_STOCK]: -1 });
  ensureStockApplied(api, api.stores.useDevelopStore.getState().paramBag);
  void api.stores.useDevelopStore.getState().commitEdit("Spektrafilm Reset");
}

const ENGINE_URL = "https://github.com/andreavolpato/spektrafilm";
const GUIDE_URL =
  "https://github.com/anthonyreimche/Spektrafilm-Support-for-Safelight#adding-your-own-stocks";
const REGEN_CMD = "python tools/extract_stock.py --emit\nnpm run build";

// Shown in place of the controls when no film-stock data is bundled. The looks
// are generated offline from Andrea Volpato's spectral engine (GPLv3) and baked
// into the extension; this guides the user through producing them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function GettingStarted({ React }: { React: any }) {
  const [copied, setCopied] = React.useState(false);
  const h = React.createElement;
  // Reuse only class tokens already present in this panel (so they're in the
  // scanned bundle); everything else is inline styles per the runtime-extension
  // styling constraint.
  const actionStyle = {
    display: "block", width: "100%", textAlign: "left" as const, textDecoration: "none",
    cursor: "pointer", border: "none", marginTop: 2,
  };
  const link = (href: string, label: string) =>
    h("a", { href, target: "_blank", rel: "noreferrer",
      className: "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary hover:bg-surface-3",
      style: actionStyle }, label);
  const step = (n: number, text: string) =>
    h("div", { style: { display: "flex", gap: 6 } },
      h("span", { className: "text-text-secondary" }, `${n}.`),
      h("span", { className: "text-text-primary" }, text));
  return h(
    "div",
    { className: "flex flex-col gap-1.5 p-2 text-[11px] text-text-secondary" },
    h("div", { className: "text-text-primary", style: { fontWeight: 600 } }, "Spektrafilm not set up"),
    h("p", { style: { lineHeight: 1.4, margin: 0 } },
      "No film-stock data is bundled. Spektrafilm's looks are generated offline from the spectral engine, then baked into the extension. To get started:"),
    step(1, "Install the Spektrafilm engine (pip-installable, Python 3.13)."),
    step(2, "Run the extractor to generate the film stocks."),
    step(3, "Rebuild the extension and reload it."),
    h("button",
      {
        className: "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary hover:bg-surface-3",
        style: actionStyle,
        onClick: () => {
          void navigator.clipboard?.writeText(REGEN_CMD);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
      },
      copied ? "Copied ✓" : "Copy generate command"),
    link(ENGINE_URL, "Spektrafilm engine (GitHub) ↗"),
    link(GUIDE_URL, "Setup guide ↗"),
  );
}

export function activate(api: SafelightAPI): void {
  theApi = api;
  const React = api.react;

  // No bundled film-stock data → don't register the film stage (it can't be
  // built); the panel shows a getting-started view instead.
  if (FILM_STOCKS.length > 0) {
    // Apply the active photo's stock now, then follow per-photo changes: a photo
    // switch (loadEdit) replaces the develop-store paramBag, so re-resolve the
    // stock on every store change (ensureStockApplied no-ops when unchanged).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = api.stores.useDevelopStore;
    ensureStockApplied(api, store.getState().paramBag ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeUnsub = store.subscribe((state: any) => ensureStockApplied(api, state?.paramBag ?? {}));
  } else {
    // Still register the effects (fallback character) so they compile and the
    // panel's getting-started view shows. Both default to amount 0 → inert.
    api.registerProcessingStage(buildHalationStage(DEFAULT_FX));
    api.registerProcessingStage(buildGrainStage(DEFAULT_FX));
  }

  api.registerPipeline({
    id: "spektrafilm-support.transform",
    name: "Spektrafilm",
    description:
      "Plain sRGB encode with the RAW base curve off — the correct view transform for the Spektrafilm film stage (the film provides the tone rendering).",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return linearToSrgbU(lin); }",
    skipBaseCurve: true,
  });

  function SpektrafilmPanel() {
    const Slider = api.components.Slider;
    const useDevelopStore = api.stores.useDevelopStore;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paramBag: Record<string, unknown> = useDevelopStore((s: any) => s.paramBag);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setDynParam: (k: string, v: number) => void = useDevelopStore((s: any) => s.setDynParam);
    // Section open/closed state (Film open; effects collapsed since they're off by
    // default). One object so the number of hooks stays constant — no per-section
    // useState in a loop.
    const [open, setOpen] = React.useState({ film: true, halation: false, grain: false });

    // The selected stock is DERIVED from the per-image paramBag (re-rendered on
    // every photo switch), not local/global state — so the picker follows the
    // active photo. The store subscription (activate) keeps the GPU stage in sync.
    const stock = stockIdFromBag(paramBag);

    // No bundled film-stock data → the film controls are useless; show a
    // getting-started view instead (the looks are generated offline from the
    // Spektrafilm engine, then baked into the extension).
    if (FILM_STOCKS.length === 0) {
      return React.createElement(GettingStarted, { React });
    }

    const h = React.createElement;
    // Persist on gesture end (mirrors core panels): setDynParam only mutates the
    // in-memory bag, so without committing the values reset on a library round-trip.
    const commit = () => { void useDevelopStore.getState().commitEdit("Spektrafilm"); };
    const valOf = (c: Ctrl): number => {
      const v = paramBag[`${c.stage}.${c.key}`];
      return typeof v === "number" ? v : c.dflt;
    };
    const renderCtrl = (c: Ctrl) =>
      h(Slider, {
        key: c.key, label: c.label, value: valOf(c), min: c.min, max: c.max, step: c.step,
        defaultValue: c.dflt,
        onChange: (v: number) => setDynParam(`${c.stage}.${c.key}`, v),
        onCommit: commit,
      });
    // Has any control in the section moved off its default? Drives the per-section
    // Reset affordance (shown only when there's something to reset).
    const sectionDirty = (sec: PanelSection) =>
      sec.ctrls.some((c) => valOf(c) !== c.dflt);
    const resetSection = (sec: PanelSection) => {
      useDevelopStore.getState().setDynParams(
        Object.fromEntries(sec.ctrls.map((c) => [`${c.stage}.${c.key}`, c.dflt])),
      );
      commit();
    };

    const renderSection = (sec: PanelSection) => {
      const isOpen = open[sec.id];
      const header = h("div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginTop: 4 },
          title: sec.hint, onClick: () => setOpen({ ...open, [sec.id]: !isOpen }) },
        h("span", { className: "text-[11px] text-text-primary", style: { fontWeight: 600 } },
          `${isOpen ? "▾" : "▸"} ${sec.title}`),
        sectionDirty(sec)
          ? h("button",
              { className: "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3",
                style: { border: "none", cursor: "pointer" },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick: (e: any) => { e.stopPropagation(); resetSection(sec); } },
              "Reset")
          : null);
      return h("div", { key: sec.id, className: "flex flex-col gap-1.5" },
        header,
        isOpen ? sec.ctrls.map(renderCtrl) : null);
    };

    // Group the picker by film family and surface the selected stock's blurb.
    const KIND_LABEL: Record<string, string> = {
      negative: "Colour negative", cine: "Cinema", slide: "Slide / reversal", bw: "Black & white",
    };
    const kinds = FILM_STOCKS.map((s) => s.kind).filter((k, i, a) => a.indexOf(k) === i);
    const stockOptions = kinds.map((k) =>
      h("optgroup", { key: k, label: KIND_LABEL[k] ?? k },
        FILM_STOCKS.filter((s) => s.kind === k).map((s) =>
          h("option", { key: s.id, value: s.id }, s.name))));
    const activeStock = FILM_STOCKS.find((s) => s.id === stock) ?? FILM_STOCKS[0];
    const isNone = stock === NONE_ID;
    const sections = sectionsFor(activeStock.kind);

    return h(
      "div",
      { className: "flex flex-col gap-1.5 p-2" },
      h("label", { className: "text-[11px] text-text-secondary" }, "Film stock"),
      h(
        "select",
        {
          value: stock,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (e: any) => {
            const id = e.target.value as string;
            useDevelopStore.getState().setDynParam(K_STOCK, stockIndexForId(id)); // per-image selection
            ensureStockApplied(api, useDevelopStore.getState().paramBag);
            commit();                                                            // persist on this photo
          },
          className: "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3",
        },
        // "None" turns the whole extension off; real stocks follow, grouped by family.
        h("option", { key: NONE_ID, value: NONE_ID }, "None (off)"),
        ...stockOptions,
      ),
      isNone
        ? h("p",
            { className: "text-[11px] text-text-secondary", style: { lineHeight: 1.35, margin: "4px 0" } },
            "Spektrafilm is off. Choose a film stock to enable it, and switch your rendering transform back from “Spektrafilm”.")
        : h("p",
            { className: "text-[11px] text-text-secondary", style: { lineHeight: 1.35, margin: "2px 0 4px" } },
            activeStock.description),
      isNone ? null : sections.map(renderSection),
    );
  }

  api.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: SpektrafilmPanel,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 260 },
    onReset: () => resetPanel(api),
  });
}

export function deactivate(): void {
  storeUnsub?.();
  storeUnsub = null;
  appliedStockId = null;
  theApi?.setStageTexture(STAGE_ID, "filmTc", null);
  theApi?.setStageTexture(STAGE_ID, "filmCurves", null);
  theApi?.setStageTexture(STAGE_ID, "filmSpec", null);
  theApi = null;
}
