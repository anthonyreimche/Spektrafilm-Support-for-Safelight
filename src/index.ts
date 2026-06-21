// Spektrafilm Support — SafeLight extension (GPL-3.0-or-later)
//
// Brings the look of the GPLv3 Spektrafilm spectral film simulation
// (https://github.com/andreavolpato/spektrafilm) into SafeLight as a real-time
// GPU stage. The expensive part — reconstructing a spectrum per pixel, exposing
// a virtual emulsion, developing dye densities, printing and scanning — is NOT
// done per frame. It is baked offline into a 3D LUT (tools/bake_luts.py) and
// uploaded to a processing stage as a texture. The per-frame hot path is then a
// single tetrahedral LUT lookup + an optional halation prepass + grain.
//
// The film transform runs at the `tone-map` phase on scene-linear `lin` and
// writes scene-linear print colour, which SafeLight's display transform then
// encodes — so pick the default ("Linear") rendering transform, not AgX/ACES,
// to avoid a second tone map on top of the film.

import {
  ATLAS_W,
  ATLAS_H,
  LUT_SIZE,
  LUT_GLSL_HELPERS,
  buildIdentityAtlas,
  type Stock,
} from "./lut";
import { BAKED_STOCKS } from "./stocks.generated";

// ─── Minimal SafeLight API surface (the host injects the real thing) ─────────

type GlslType = "float" | "int" | "bool" | "vec2" | "vec3" | "vec4" | "sampler2D";

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
  format?: "rgba8" | "r8";
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
  data: Uint8Array;
  width: number;
  height: number;
  format: "rgba8" | "r8";
  version: number;
}

interface SafelightAPI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react: any;
  registerProcessingStage(c: ProcessingStageContribution): void;
  setStageTexture(stageId: string, key: string, tex: StageTextureData | null): void;
  registerPanel(c: {
    id: string;
    title: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: any;
    defaultDock?: {
      module: "library" | "develop";
      direction: "left" | "right";
      order?: number;
      width?: number;
    };
    onReset?: () => void;
  }): void;
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: Record<string, any>;
}

// ─── Stage definition ────────────────────────────────────────────────────────

const STAGE_ID = "spektrafilm-support.film";

// Available film stocks: the neutral placeholder, plus whatever the bake tool
// has generated. With no baked stocks the image renders ~normally.
const STOCKS: Stock[] = [
  { id: "neutral", name: "Neutral (no film baked)", atlas: buildIdentityAtlas },
  ...BAKED_STOCKS,
];

// Halation prepass: threshold highlights (pass 0), then separable Gaussian blur
// (horizontal pass 0, vertical pass 1). The blurred highlight mask is exposed to
// the film stage's inline glsl as `stageResult`. Skipped entirely (zero cost)
// when Halation is 0 — the engine only runs prepasses for stages with a non-zero
// param, and the inline glsl multiplies the result by the halation amount.
const HALATION_PASS: StagePass = {
  iterations: 2,
  glsl: `
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = -6; i <= 6; i++) {
      float w = exp(-float(i * i) / 18.0);
      vec2 off = (uPassIndex == 0) ? vec2(float(i), 0.0) : vec2(0.0, float(i));
      vec3 s = readPrev(vUv + off * uTexel * 3.0);
      if (uPassIndex == 0) s = max(s - 0.7, vec3(0.0));
      sum += s * w;
      wsum += w;
    }
    c = sum / wsum;
  `,
};

// Inline film transform on scene-linear `lin`. Print Exposure scales the input;
// the shaper maps it into the LUT domain; the LUT output (sRGB-encoded print
// colour, for 8-bit precision) is decoded back to linear so SafeLight's display
// transform encodes it once. Halation adds the blurred highlight mask, tinted
// red-orange; grain is a luminance-neutral multiplicative dither.
const FILM_GLSL = `
  vec3 linExp = lin * exp2(exposure);
  vec3 film = srgbToLinear(sfSampleLut(filmLut, sfShaper(linExp), cubeSize));
  film += stageResult * vec3(1.0, 0.4, 0.15) * halation;
  float noise = (sfHash(srcUv * vec2(1543.0, 2087.0)) - 0.5) * grain * 0.08;
  lin = max(film * (1.0 + noise), vec3(0.0));
`;

const FILM_STAGE: ProcessingStageContribution = {
  id: STAGE_ID,
  name: "Spektrafilm",
  phase: "tone-map",
  uniforms: [
    { key: "exposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Print Exposure" },
    { key: "halation", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Halation" },
    { key: "grain", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Grain" },
    // Cube edge, fixed at the baked LUT size; not user-facing.
    { key: "cubeSize", glslType: "float", default: LUT_SIZE },
  ],
  textures: [
    { key: "filmLut", kind: "lut", width: ATLAS_W, height: ATLAS_H, format: "rgba8" },
  ],
  helpers: LUT_GLSL_HELPERS,
  glsl: FILM_GLSL,
  passes: [HALATION_PASS],
};

// ─── Activation ────────────────────────────────────────────────────────────

let theApi: SafelightAPI | null = null;
let texVersion = 1;
// Bound by the mounted panel so the dock-header "Reset to defaults" action can
// also sync the stock dropdown's local state.
let setPanelStock: ((id: string) => void) | null = null;

function uploadStock(api: SafelightAPI, id: string): void {
  const stock = STOCKS.find((s) => s.id === id) ?? STOCKS[0];
  api.setStageTexture(STAGE_ID, "filmLut", {
    data: stock.atlas(),
    width: ATLAS_W,
    height: ATLAS_H,
    format: "rgba8",
    version: texVersion++,
  });
}

// Restore the panel's controls to their defaults: the sliders to 0 (one undoable
// action) and the stock back to the first entry. Wired to the panel's `onReset`,
// so right-clicking the panel's dock header offers "Reset to defaults" — the same
// mechanism the built-in panels use.
function resetPanel(api: SafelightAPI): void {
  api.stores.useDevelopStore.getState().setDynParams({
    [`${STAGE_ID}.exposure`]: 0,
    [`${STAGE_ID}.halation`]: 0,
    [`${STAGE_ID}.grain`]: 0,
  });
  const def = STOCKS[0].id;
  api.settings.set("stock", def);
  uploadStock(api, def);
  setPanelStock?.(def);
}

export function activate(api: SafelightAPI): void {
  theApi = api;
  const React = api.react;

  api.registerProcessingStage(FILM_STAGE);
  uploadStock(api, api.settings.get("stock", STOCKS[0].id));

  function SpektrafilmPanel() {
    const Slider = api.components.Slider;
    const useDevelopStore = api.stores.useDevelopStore;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paramBag: Record<string, unknown> = useDevelopStore((s: any) => s.paramBag);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setDynParam: (k: string, v: number) => void = useDevelopStore((s: any) => s.setDynParam);
    const [stock, setStock] = React.useState(() => api.settings.get("stock", STOCKS[0].id));

    // Expose this panel's stock setter to resetPanel while it's mounted.
    React.useEffect(() => {
      setPanelStock = setStock;
      return () => {
        if (setPanelStock === setStock) setPanelStock = null;
      };
    }, []);

    const val = (k: string, d: number): number => {
      const v = paramBag[`${STAGE_ID}.${k}`];
      return typeof v === "number" ? v : d;
    };
    const slider = (key: string, label: string, min: number, max: number, dflt: number) =>
      React.createElement(Slider, {
        label,
        value: val(key, dflt),
        min,
        max,
        step: 0.01,
        defaultValue: dflt,
        onChange: (v: number) => setDynParam(`${STAGE_ID}.${key}`, v),
      });

    return React.createElement(
      "div",
      { style: { padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
      React.createElement(
        "label",
        { style: { fontSize: 11, color: "var(--color-text-secondary)" } },
        "Film stock",
      ),
      React.createElement(
        "select",
        {
          value: stock,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (e: any) => {
            const id = e.target.value as string;
            setStock(id);
            api.settings.set("stock", id);
            uploadStock(api, id);
          },
          style: {
            width: "100%",
            boxSizing: "border-box",
            background: "var(--color-surface-2)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
            padding: "2px 4px",
            fontFamily: "inherit",
            fontSize: 11,
          },
        },
        STOCKS.map((s) =>
          React.createElement("option", { key: s.id, value: s.id }, s.name),
        ),
      ),
      slider("exposure", "Print Exposure", -3, 3, 0),
      slider("halation", "Halation", 0, 1, 0),
      slider("grain", "Grain", 0, 1, 0),
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
  // Release the uploaded LUT; SafeLight sweeps the stage + panel itself.
  theApi?.setStageTexture(STAGE_ID, "filmLut", null);
  theApi = null;
}
