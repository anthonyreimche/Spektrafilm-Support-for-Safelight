// GLSL transliteration of the Spektrafilm per-pixel pipeline — a direct port of
// the validated `pipeline_from_bundle()` reference (tools/extract_stock.py),
// which matches the engine's per-stage taps (stages 1-4 to 0.0, stage 5 spectral
// exact). Runs the actual simulation per pixel with LIVE params, not a LUT.
//
// Per-stock data is uploaded as 3 float (rgba16f) textures + per-stock uniforms;
// live controls (exposure, print exposure, gamma) are separate uniforms.
//
// Texture packing (to fit the 4-stage-texture budget):
//   filmTc   : 64×64  rgb   — Hanatos chromaticity LUT (film raw layers)
//   filmCurves: 256×3 rgb   — row0 norm_dc, row1 dc0(before-couplers), row2 morphed print curves
//   filmSpec : 81×4   rgba  — row0 (chD_film.rgb, baseD_film)
//                             row1 (printKernel.rgb=filt×paperSens, _)
//                             row2 (chD_print.rgb, baseD_print)
//                             row3 (scanKernel.rgb=scanIllum×CMF, _)
//
// Per-stock uniforms (vec3 columns since mat3 isn't param-bag bindable):
//   sfRgb2xyz0..2, sfCoup0..2, sfXyz2rgb0..2  (matrix columns)
//   sfFactor, sfScanNorm, sfLeFilm(vec2 lo/hi), sfLePrint(vec2 lo/hi)
// Live uniforms: sfExposure, sfPrintExp, sfGamma.

export const N_WL = 81;

export const FILM_HELPERS = `
const float SF_LN10 = 2.302585093;

float sf_pow10neg(float x) { return exp(-x * SF_LN10); }   // 10^(-x)

vec2 sf_tri2quad(vec2 xy) {
  float tx = xy.x, ty = xy.y;
  return vec2(clamp((1.0 - tx) * (1.0 - tx), 0.0, 1.0),
              clamp(ty / max(1.0 - tx, 1e-10), 0.0, 1.0));
}

// Per-channel 1D curve lookup: sample curve row at the channel's normalized log
// position, take that channel's column. row in {0,1,2} mapped to texture v.
vec3 sf_curve(sampler2D curves, float row, vec2 le, vec3 logv) {
  vec3 t = clamp((logv - le.x) / (le.y - le.x), 0.0, 1.0);
  float v = (row + 0.5) / 3.0;
  return vec3(texture(curves, vec2(t.r, v)).r,
              texture(curves, vec2(t.g, v)).g,
              texture(curves, vec2(t.b, v)).b);
}

mat3 sf_mat(vec3 c0, vec3 c1, vec3 c2) { return mat3(c0, c1, c2); }
// result[j] = dot(rgb, column_j)  ==  rgb @ M  in the reference
vec3 sf_apply(vec3 rgb, vec3 c0, vec3 c1, vec3 c2) {
  return vec3(dot(rgb, c0), dot(rgb, c1), dot(rgb, c2));
}

// ACES Reference Gamut Compression v1.3 (hue-preserving, keeps RGB in cube).
// Stand-in for the engine's cam16ucs; faithful spectral stages feed it.
vec3 sf_reinhard_knee(vec3 d, float t, float l, float p) {
  vec3 s = vec3(l - t);
  vec3 x = max(d - t, 0.0) / s;
  vec3 y = x / pow(1.0 + pow(x, vec3(p)), vec3(1.0 / p));
  return mix(d, t + s * y, step(t, d));
}
vec3 sf_gamut_compress(vec3 rgb) {
  float ach = max(rgb.r, max(rgb.g, rgb.b));
  if (ach <= 1e-12) return rgb;
  vec3 d = (vec3(ach) - rgb) / ach;
  vec3 dc = sf_reinhard_knee(d, 0.0, 1.0, 6.0);
  return vec3(ach) * (1.0 - dc);
}
`;

/** The film transform on scene-linear sRGB `lin`. Writes scene-linear print
 *  colour (the "Spektrafilm" display transform then encodes it). Uniforms +
 *  textures are namespaced by the stage at registration. */
export const FILM_GLSL = `
  // ── Stage 1: expose ──
  vec3 sfXyz = sf_apply(max(lin, 0.0) * exp2(sfExposure), sfRgb2xyz0, sfRgb2xyz1, sfRgb2xyz2);
  float sfB = max(sfXyz.x + sfXyz.y + sfXyz.z, 1e-10);
  vec2 sfTc = sf_tri2quad(sfXyz.xy / sfB);
  vec3 sfRaw = texture(filmTc, sfTc).rgb * sfB;
  vec3 sfLogf = log2(max(sfRaw, 0.0) + 1e-10) * 0.301029996;   // log10

  // ── Stage 2: develop (curves + DIR couplers) ──
  vec3 sfDens = sf_curve(filmCurves, 0.0, sfLeFilm, sfLogf);             // norm_dc
  vec3 sfLog0 = sfLogf - sf_apply(sfDens, sfCoup0, sfCoup1, sfCoup2);
  vec3 sfCmyF = sf_curve(filmCurves, 1.0, sfLeFilm, sfLog0);             // dc0

  // ── Stage 3: print-expose (81-bin spectral) ──
  vec3 sfRawP = vec3(0.0);
  for (int i = 0; i < ${N_WL}; i++) {
    float u = (float(i) + 0.5) / float(${N_WL});
    vec4 fs = texture(filmSpec, vec2(u, 0.125));                         // row0 chD_film+baseD
    float dspec = dot(sfCmyF, fs.rgb) + fs.a;
    sfRawP += sf_pow10neg(dspec) * texture(filmSpec, vec2(u, 0.375)).rgb; // row1 printKernel
  }
  sfRawP *= sfFactor * sfPrintExp;
  vec3 sfLogP = log2(max(sfRawP, 0.0) + 1e-10) * 0.301029996;

  // ── Stage 4: print-develop ──
  vec3 sfCmyP = sf_curve(filmCurves, 2.0, sfLePrint, sfLogP);            // morphed print

  // ── Stage 5: scan (81-bin spectral → XYZ → RGB) ──
  vec3 sfXyz2 = vec3(0.0);
  for (int i = 0; i < ${N_WL}; i++) {
    float u = (float(i) + 0.5) / float(${N_WL});
    vec4 ps = texture(filmSpec, vec2(u, 0.625));                         // row2 chD_print+baseD
    float dspec = dot(sfCmyP, ps.rgb) + ps.a;
    sfXyz2 += sf_pow10neg(dspec) * texture(filmSpec, vec2(u, 0.875)).rgb; // row3 scanKernel
  }
  sfXyz2 /= sfScanNorm;
  vec3 sfRgb = sf_apply(sfXyz2, sfXyz2rgb0, sfXyz2rgb1, sfXyz2rgb2);
  lin = max(sf_gamut_compress(sfRgb), 0.0);
`;
