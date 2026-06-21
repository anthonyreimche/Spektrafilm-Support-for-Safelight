function d(e) {
  return e = Math.min(1, Math.max(0, e)), e <= 31308e-7 ? e * 12.92 : 1.055 * Math.pow(e, 1 / 2.4) - 0.055;
}
function v(e) {
  return Math.pow(2, e * 16 + -10);
}
function T() {
  const t = new Uint8Array(143748);
  for (let a = 0; a < 33; a++)
    for (let s = 0; s < 33; s++)
      for (let o = 0; o < 33; o++) {
        const S = a * 33 + o, c = (s * 1089 + S) * 4;
        t[c] = Math.round(d(v(o / 32)) * 255), t[c + 1] = Math.round(d(v(s / 32)) * 255), t[c + 2] = Math.round(d(v(a / 32)) * 255), t[c + 3] = 255;
      }
  return t;
}
const h = `
const float SF_MIN_EV = ${(-10).toFixed(1)};
const float SF_MAX_EV = ${6 .toFixed(1)};
vec3 sfShaper(vec3 lv) {
  return clamp((log2(max(lv, vec3(1e-10))) - SF_MIN_EV) / (SF_MAX_EV - SF_MIN_EV), 0.0, 1.0);
}
float sfHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec3 sfSampleLut(sampler2D atlas, vec3 rgb, float n) {
  rgb = clamp(rgb, 0.0, 1.0);
  float bf = rgb.b * (n - 1.0);
  float b0 = floor(bf);
  float b1 = min(b0 + 1.0, n - 1.0);
  float fb = bf - b0;
  float gx = rgb.r * (n - 1.0);
  float gy = rgb.g * (n - 1.0);
  float u0 = (b0 * n + gx + 0.5) / (n * n);
  float u1 = (b1 * n + gx + 0.5) / (n * n);
  float v  = (gy + 0.5) / n;
  vec3 c0 = texture(atlas, vec2(u0, v)).rgb;
  vec3 c1 = texture(atlas, vec2(u1, v)).rgb;
  return mix(c0, c1, fb);
}
`, y = [], l = "spektrafilm-support.film", i = [
  { id: "neutral", name: "Neutral (no film baked)", atlas: T },
  ...y
], k = {
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
  `
}, M = `
  vec3 linExp = lin * exp2(exposure);
  vec3 film = srgbToLinear(sfSampleLut(filmLut, sfShaper(linExp), cubeSize));
  film += stageResult * vec3(1.0, 0.4, 0.15) * halation;
  float noise = (sfHash(srcUv * vec2(1543.0, 2087.0)) - 0.5) * grain * 0.08;
  lin = max(film * (1.0 + noise), vec3(0.0));
`, I = {
  id: l,
  name: "Spektrafilm",
  phase: "tone-map",
  uniforms: [
    { key: "exposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Print Exposure" },
    { key: "halation", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Halation" },
    { key: "grain", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Grain" },
    // Cube edge, fixed at the baked LUT size; not user-facing.
    { key: "cubeSize", glslType: "float", default: 33 }
  ],
  textures: [
    { key: "filmLut", kind: "lut", width: 1089, height: 33, format: "rgba8" }
  ],
  helpers: h,
  glsl: M,
  passes: [k]
};
let f = null, P = 1, u = null;
function _(e, t) {
  const a = i.find((s) => s.id === t) ?? i[0];
  e.setStageTexture(l, "filmLut", {
    data: a.atlas(),
    width: 1089,
    height: 33,
    format: "rgba8",
    version: P++
  });
}
function H(e) {
  e.stores.useDevelopStore.getState().setDynParams({
    [`${l}.exposure`]: 0,
    [`${l}.halation`]: 0,
    [`${l}.grain`]: 0
  });
  const t = i[0].id;
  e.settings.set("stock", t), _(e, t), u == null || u(t);
}
function V(e) {
  f = e;
  const t = e.react;
  e.registerProcessingStage(I), _(e, e.settings.get("stock", i[0].id));
  function a() {
    const s = e.components.Slider, o = e.stores.useDevelopStore, S = o((n) => n.paramBag), x = o((n) => n.setDynParam), [c, g] = t.useState(() => e.settings.get("stock", i[0].id));
    t.useEffect(() => (u = g, () => {
      u === g && (u = null);
    }), []);
    const A = (n, r) => {
      const m = S[`${l}.${n}`];
      return typeof m == "number" ? m : r;
    }, p = (n, r, m, b, E) => t.createElement(s, {
      label: r,
      value: A(n, E),
      min: m,
      max: b,
      step: 0.01,
      defaultValue: E,
      onChange: (L) => x(`${l}.${n}`, L)
    });
    return t.createElement(
      "div",
      { className: "flex flex-col gap-1.5 p-2" },
      t.createElement(
        "label",
        { className: "text-[11px] text-text-secondary" },
        "Film stock"
      ),
      t.createElement(
        "select",
        {
          value: c,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (n) => {
            const r = n.target.value;
            g(r), e.settings.set("stock", r), _(e, r);
          },
          className: "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3"
        },
        i.map(
          (n) => t.createElement("option", { key: n.id, value: n.id }, n.name)
        )
      ),
      p("exposure", "Print Exposure", -3, 3, 0),
      p("halation", "Halation", 0, 1, 0),
      p("grain", "Grain", 0, 1, 0)
    );
  }
  e.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: a,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 260 },
    onReset: () => H(e)
  });
}
function w() {
  f == null || f.setStageTexture(l, "filmLut", null), f = null;
}
export {
  V as activate,
  w as deactivate
};
//# sourceMappingURL=index.js.map
