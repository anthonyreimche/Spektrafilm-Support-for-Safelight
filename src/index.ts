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
import { FILM_STOCKS, type FilmStockData } from "./stocks_data.generated";

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

interface ProcessingStageContribution {
  id: string;
  name: string;
  phase: "tone-map" | "scene-linear" | "effects" | string;
  priority?: number;
  glsl: string;
  helpers?: string;
  uniforms: UniformDeclaration[];
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

function buildStage(stock: FilmStockData): ProcessingStageContribution {
  return {
    id: STAGE_ID,
    name: "Spektrafilm",
    phase: "tone-map",
    uniforms: [
      { key: "sfExposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Exposure" },
      { key: "sfPrintExp", glslType: "float", default: 1, range: { min: 0.2, max: 3, step: 0.01 }, label: "Print Exposure" },
    ],
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

let theApi: SafelightAPI | null = null;
let texVersion = 1;
let setPanelStock: ((id: string) => void) | null = null;

function applyStock(api: SafelightAPI, id: string): void {
  const stock = FILM_STOCKS.find((s) => s.id === id) ?? FILM_STOCKS[0];
  api.registerProcessingStage(buildStage(stock));
  const v = ++texVersion;
  api.setStageTexture(STAGE_ID, "filmTc", { data: stock.filmTc(), width: stock.tcSize, height: stock.tcSize, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmCurves", { data: stock.filmCurves(), width: 256, height: 3, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmSpec", { data: stock.filmSpec(), width: 81, height: 4, format: "rgba16f", version: v });
}

function resetPanel(api: SafelightAPI): void {
  api.stores.useDevelopStore.getState().setDynParams({
    [`${STAGE_ID}.sfExposure`]: 0,
    [`${STAGE_ID}.sfPrintExp`]: 1,
  });
  const def = FILM_STOCKS[0].id;
  api.settings.set("stock", def);
  applyStock(api, def);
  setPanelStock?.(def);
}

export function activate(api: SafelightAPI): void {
  theApi = api;
  const React = api.react;

  applyStock(api, api.settings.get("stock", FILM_STOCKS[0].id));

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
    const [stock, setStock] = React.useState(() => api.settings.get("stock", FILM_STOCKS[0].id));

    React.useEffect(() => {
      setPanelStock = setStock;
      return () => { if (setPanelStock === setStock) setPanelStock = null; };
    }, []);

    const val = (k: string, d: number): number => {
      const v = paramBag[`${STAGE_ID}.${k}`];
      return typeof v === "number" ? v : d;
    };
    const slider = (key: string, label: string, min: number, max: number, dflt: number) =>
      React.createElement(Slider, {
        label, value: val(key, dflt), min, max, step: 0.01, defaultValue: dflt,
        onChange: (v: number) => setDynParam(`${STAGE_ID}.${key}`, v),
      });

    return React.createElement(
      "div",
      { className: "flex flex-col gap-1.5 p-2" },
      React.createElement("label", { className: "text-[11px] text-text-secondary" }, "Film stock"),
      React.createElement(
        "select",
        {
          value: stock,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (e: any) => {
            const id = e.target.value as string;
            setStock(id);
            api.settings.set("stock", id);
            applyStock(api, id);
          },
          className: "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3",
        },
        FILM_STOCKS.map((s) => React.createElement("option", { key: s.id, value: s.id }, s.name)),
      ),
      slider("sfExposure", "Exposure", -3, 3, 0),
      slider("sfPrintExp", "Print Exposure", 0.2, 3, 1),
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
  theApi?.setStageTexture(STAGE_ID, "filmTc", null);
  theApi?.setStageTexture(STAGE_ID, "filmCurves", null);
  theApi?.setStageTexture(STAGE_ID, "filmSpec", null);
  theApi = null;
}
