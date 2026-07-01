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
//                             row1 (printKernel.rgb=filt×paperSens, dichroicM)
//                             row2 (chD_print.rgb, baseD_print)
//                             row3 (scanKernel.rgb=scanIllum×CMF, dichroicY)
//
// Per-stock uniforms (vec3 columns since mat3 isn't param-bag bindable):
//   sfRgb2xyz0..2, sfCoup0..2, sfXyz2rgb0..2  (matrix columns)
//   sfFactor, sfScanNorm, sfLeFilm(vec2 lo/hi), sfLePrint(vec2 lo/hi),
//   sfNeutralMY(vec2 neutral CC for M/Y), sfDensMax(vec3, positive silver donor)
// Live uniforms: sfExposure, sfPrintExp, sfCouplerAmt, sfContrast, sfFiltM, sfFiltY.
//
// Reversal (slide) bundles bake `const bool sfPositive = true` in their const
// block (negatives bake false): stages 3-4 (enlarger print) are branched out, the
// developed film is scanned directly, and the scan textures (filmSpec row2/row3)
// carry the FILM's own dye + viewing illuminant instead of a print paper's. Print-
// only uniforms (sfPrintExp, sfFiltM/Y) are then unused, but STILL declared so the
// untaken print branch compiles; sfContrast retargets to the film curve.
//
// The paths are gated by baked `const bool` constants (sfPositive, sfHasNeutral),
// NOT #define/#ifdef: the host splices stage GLSL into the monolith by substring
// rewriting, not a preprocessor, so #ifdef gates don't survive. A const-bool is a
// compile-time constant, so the driver still folds the branch away — same cost as
// the old #ifdef, but it actually takes effect.

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
  // filmTc is row-major tc_lut[i=tc.x][j=tc.y]; texture() maps .x→column/.y→row,
  // so sample at .yx to hit tc_lut[i=tc.x][j=tc.y] (not the transpose).
  vec3 sfRaw = texture(filmTc, sfTc.yx).rgb * sfB;
  vec3 sfLogf = log2(max(sfRaw, 0.0) + 1e-10) * 0.301029996;   // log10

  // ── Stage 2: develop (curves + DIR couplers) ──
  // sfCouplerAmt scales the DIR-coupler cross-talk (1.0 = engine default, 0 =
  // couplers off → flatter, less saturated; >1 = stronger inter-layer effect).
  vec3 sfDens = sf_curve(filmCurves, 0.0, sfLeFilm, sfLogf);             // norm_dc
  // Reversal (slide) film releases the coupler inhibitor from the SILVER image
  // (sfDensMax − developed dye), negative film from the dye density itself. The
  // before-couplers curve (dc0) already bakes the positive inversion; only this
  // live donor term differs between the two paths.
  vec3 sfSilver = sfPositive ? (sfDensMax - sfDens) : sfDens;
  vec3 sfLog0 = sfLogf - sfCouplerAmt * sf_apply(sfSilver, sfCoup0, sfCoup1, sfCoup2);
  if (sfPositive) {
    // Slides have no print to grade, so Print Contrast becomes a film-curve
    // contrast: warp developed log-exposure around the film midpoint (1.0 = the
    // engine's straight reversal curve; >1 harder, <1 softer).
    float sfFilmMid = 0.5 * (sfLeFilm.x + sfLeFilm.y);
    sfLog0 = sfFilmMid + (sfLog0 - sfFilmMid) * sfContrast;
  }
  vec3 sfCmyF = sf_curve(filmCurves, 1.0, sfLeFilm, sfLog0);             // dc0

  // Reversal (slide): no enlarger or print paper — the developed slide is scanned
  // directly (engine scan_film), so the scanned densities ARE the film's. Negative
  // / print: run the full enlarger print (stages 3-4). Gated on the baked
  // sfPositive constant so the driver folds away the branch this stock skips.
  vec3 sfCmyP;
  if (sfPositive) {
    sfCmyP = sfCmyF;
  } else {
    // ── Stage 3: print-expose (81-bin spectral) ──
    // Live enlarger filtration is active ONLY when the stock bundle ships the
    // neutral filter pack + dichroic spectra — a re-extraction that bakes
    // sfHasNeutral = true (see extract_stock.py). Without it we take the plain
    // neutral kernel (identical to before), so old bundles keep working. When
    // present: re-balance the baked neutral print kernel by the live/neutral ratio
    // of the M and Y dichroic dimming factors (C held, as on a real colour head).
    // dim = 1-(1-dich)*(1-t), t = 10^(-cc/100) [Kodak CC units]; the wavelength-
    // independent t terms hoist out; M/Y dichroic spectra ride in the print/scan
    // kernel alpha lanes.
    float sfTmL = sf_pow10neg((sfNeutralMY.x + sfFiltM) * 0.01);
    float sfTmN = sf_pow10neg(sfNeutralMY.x * 0.01);
    float sfTyL = sf_pow10neg((sfNeutralMY.y + sfFiltY) * 0.01);
    float sfTyN = sf_pow10neg(sfNeutralMY.y * 0.01);
    vec3 sfRawP = vec3(0.0);
    for (int i = 0; i < ${N_WL}; i++) {
      float u = (float(i) + 0.5) / float(${N_WL});
      vec4 fs = texture(filmSpec, vec2(u, 0.125));                       // row0 chD_film+baseD
      float dspec = dot(sfCmyF, fs.rgb) + fs.a;
      vec4 pk = texture(filmSpec, vec2(u, 0.375));                       // row1 printKernel.rgb + dichM(a)
      if (sfHasNeutral) {
        float dichY = texture(filmSpec, vec2(u, 0.875)).a;              // row3 scanKernel.rgb + dichY(a)
        float ratioM = (1.0 - (1.0 - pk.a) * (1.0 - sfTmL)) / (1.0 - (1.0 - pk.a) * (1.0 - sfTmN));
        float ratioY = (1.0 - (1.0 - dichY) * (1.0 - sfTyL)) / (1.0 - (1.0 - dichY) * (1.0 - sfTyN));
        sfRawP += sf_pow10neg(dspec) * pk.rgb * (ratioM * ratioY);
      } else {
        sfRawP += sf_pow10neg(dspec) * pk.rgb;
      }
    }
    sfRawP *= sfFactor * sfPrintExp;
    vec3 sfLogP = log2(max(sfRawP, 0.0) + 1e-10) * 0.301029996;

    // ── Stage 4: print-develop ──
    // sfContrast warps print log-exposure around the curve midpoint (1.0 = engine
    // default; >1 = harder paper grade, <1 = softer). Pivoting on the mid keeps
    // mid-grey put while steepening/flattening the toe and shoulder.
    float sfPrintMid = 0.5 * (sfLePrint.x + sfLePrint.y);
    sfLogP = sfPrintMid + (sfLogP - sfPrintMid) * sfContrast;
    sfCmyP = sf_curve(filmCurves, 2.0, sfLePrint, sfLogP);              // morphed print
  }

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
