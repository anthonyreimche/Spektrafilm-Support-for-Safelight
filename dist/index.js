function p(e) {
  return e = Math.min(1, Math.max(0, e)), e <= 31308e-7 ? e * 12.92 : 1.055 * Math.pow(e, 1 / 2.4) - 0.055;
}
function v(e) {
  return Math.pow(2, e * 16 + -10);
}
function T() {
  const t = new Uint8Array(143748);
  for (let o = 0; o < 33; o++)
    for (let a = 0; a < 33; a++)
      for (let r = 0; r < 33; r++) {
        const S = o * 33 + r, i = (a * 1089 + S) * 4;
        t[i] = Math.round(p(v(r / 32)) * 255), t[i + 1] = Math.round(p(v(a / 32)) * 255), t[i + 2] = Math.round(p(v(o / 32)) * 255), t[i + 3] = 255;
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
`, y = [], l = "spektrafilm-support.film", c = [
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
  const o = c.find((a) => a.id === t) ?? c[0];
  e.setStageTexture(l, "filmLut", {
    data: o.atlas(),
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
  const t = c[0].id;
  e.settings.set("stock", t), _(e, t), u == null || u(t);
}
function V(e) {
  f = e;
  const t = e.react;
  e.registerProcessingStage(I), _(e, e.settings.get("stock", c[0].id));
  function o() {
    const a = e.components.Slider, r = e.stores.useDevelopStore, S = r((n) => n.paramBag), b = r((n) => n.setDynParam), [i, d] = t.useState(() => e.settings.get("stock", c[0].id));
    t.useEffect(() => (u = d, () => {
      u === d && (u = null);
    }), []);
    const E = (n, s) => {
      const m = S[`${l}.${n}`];
      return typeof m == "number" ? m : s;
    }, g = (n, s, m, A, x) => t.createElement(a, {
      label: s,
      value: E(n, x),
      min: m,
      max: A,
      step: 0.01,
      defaultValue: x,
      onChange: (L) => b(`${l}.${n}`, L)
    });
    return t.createElement(
      "div",
      { style: { padding: 8, display: "flex", flexDirection: "column", gap: 6 } },
      t.createElement(
        "label",
        { style: { fontSize: 11, color: "var(--color-text-secondary)" } },
        "Film stock"
      ),
      t.createElement(
        "select",
        {
          value: i,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (n) => {
            const s = n.target.value;
            d(s), e.settings.set("stock", s), _(e, s);
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
            fontSize: 11
          }
        },
        c.map(
          (n) => t.createElement("option", { key: n.id, value: n.id }, n.name)
        )
      ),
      g("exposure", "Print Exposure", -3, 3, 0),
      g("halation", "Halation", 0, 1, 0),
      g("grain", "Grain", 0, 1, 0)
    );
  }
  e.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: o,
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
