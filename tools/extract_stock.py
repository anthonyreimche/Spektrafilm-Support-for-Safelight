#!/usr/bin/env python3
# Extract film+print stocks from the Spektrafilm engine into GLSL-ready data for
# the live GPU stage (src/film-glsl.ts). NOT an RGB->RGB look bake: emits the
# per-stage spectral primitives packed into 3 float textures + a per-stock GLSL
# const block (colour matrices, scalars, log-exposure ranges). Exposure / print
# exposure stay live uniforms. Validated stage-by-stage vs the engine taps
# (tools history); self-check below re-runs the whole pipeline from the packed
# data.
#
#   python tools/extract_stock.py kodak_portra_400 kodak_portra_endura   # one, self-check
#   python tools/extract_stock.py --emit                                 # curated set -> src/stocks_data.generated.ts

import base64
import json
import os
import sys

import numpy as np
import colour

from spektrafilm.runtime.params_builder import init_params, digest_params
from spektrafilm.runtime.params_schema import RuntimePhotoParams
from spektrafilm.profiles.io import profile_from_dict
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap
from spektrafilm.config import STANDARD_OBSERVER_CMFS
from spektrafilm.model.illuminants import standard_illuminant
from spektrafilm.model.couplers import compute_dir_couplers_matrix, compute_density_curves_before_dir_couplers
from spektrafilm.model.color_filters import custom_dichroic_filters
from spektrafilm.utils.morph_curves import apply_print_curves_morph
from spektrafilm.utils.spectral_upsampling import _illuminant_to_xy

TC = 64   # chromaticity LUT edge
NWL = 81

# Black-and-white stocks are authored locally (tools/bw_profiles/, channel_model
# "bw") as neutral silver emulsions encoded as three identical panchromatic
# layers + a neutral dye — see tools/make_bw_profiles.py. They run through the
# ordinary colour (negative) pipeline and GLSL and come out perfectly grey, so
# no engine or shader changes are needed; only the loader here differs.
BW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bw_profiles")


def _is_bw(spec):
    return os.path.exists(os.path.join(BW_DIR, str(spec) + ".json"))


def _load_profile(spec):
    if _is_bw(spec):
        with open(os.path.join(BW_DIR, spec + ".json"), encoding="utf-8") as f:
            return profile_from_dict(json.load(f))
    from spektrafilm.profiles.io import load_profile
    return load_profile(spec)


def _build_params(film, prnt):
    """Digested runtime params for a film+print pair. B&W stocks load from the
    local bw_profiles dir, disable the fitted Hanatos adaptation (tc_lut is built
    straight from the panchromatic sensitivity), skip the colour-only neutral
    print-filter database, and turn DIR couplers off (no inter-layer chemistry in
    a single silver emulsion). Colour/cine stocks keep the engine's defaults."""
    if not _is_bw(film):
        return digest_params(init_params(film, prnt))
    params = RuntimePhotoParams(film=_load_profile(film), print=_load_profile(prnt))
    params.settings.neutral_print_filters_from_database = False
    params.settings.apply_hanatos2025_adaptation_window = False
    params.settings.apply_hanatos2025_adaptation_surface = False
    params = digest_params(params)
    params.film_render.dir_couplers.amount = 0.0
    # B&W effect character must be neutral: equal per-channel grain scale (so the
    # extension's per-channel grain reads as monochrome, not coloured speckle) and
    # equal halation strength (a neutral glow, not the colour stocks' red halo).
    params.film_render.grain.particle_scale = (1.0, 1.0, 1.0)
    params.film_render.halation.halation_strength = (0.01, 0.01, 0.01)
    return params

# (film, print, display name, kind, description). kind drives panel grouping;
# description is shown under the picker. The first seven keep their original
# print pairings (looks already tuned); newer entries use the engine's declared
# target_print. Slides (positive, target_print=None) take the reversal path:
# the print column is a placeholder (ignored — extract() forces io.scan_film=True
# for positive stocks, so the developed film is scanned directly with no enlarger
# or print paper). See extract().
CURATED = [
    # ── Colour negative (still) ──
    ("kodak_portra_400", "kodak_portra_endura", "Kodak Portra 400", "negative",
     "The modern portrait standard: fine grain, gentle contrast, forgiving skin tones with a warm lean."),
    ("kodak_portra_160", "kodak_portra_endura", "Kodak Portra 160", "negative",
     "Slower Portra: the finest grain of the family and the smoothest, most neutral skin rendering."),
    ("kodak_portra_800", "kodak_portra_endura", "Kodak Portra 800", "negative",
     "Fast Portra for low light: more grain and punch while holding Portra's natural skin tones."),
    ("kodak_ektar_100", "kodak_supra_endura", "Kodak Ektar 100", "negative",
     "The most saturated, finest-grained colour negative made — vivid landscapes, crisp blues and reds."),
    ("kodak_gold_200", "kodak_endura_premier", "Kodak Gold 200", "negative",
     "Consumer warmth: golden, nostalgic colour with friendly contrast and visible everyday grain."),
    ("kodak_ultramax_400", "kodak_supra_endura", "Kodak Ultramax 400", "negative",
     "Everyday 400-speed colour: bright, slightly punchy, with cheerful warm-leaning tones."),
    ("fujifilm_pro_400h", "kodak_portra_endura", "Fujifilm Pro 400H", "negative",
     "The discontinued cult favourite: airy pastels, minty greens and signature soft highlights."),
    ("fujifilm_c200", "fujifilm_crystal_archive_typeii", "Fujifilm C200", "negative",
     "Budget Fuji colour: cool, slightly green-leaning palette with crunchy, characterful grain."),
    ("fujifilm_xtra_400", "fujifilm_crystal_archive_typeii", "Fujifilm Superia X-tra 400", "negative",
     "Classic Superia: punchy consumer colour with the trademark Fuji emphasis on greens and reds."),
    # ── Cinema negative (print on cine stock) ──
    ("kodak_vision3_50d", "kodak_2383", "Kodak Vision3 50D", "cine",
     "Slow daylight cine stock: extremely fine grain and clean, true daylight colour."),
    ("kodak_vision3_250d", "kodak_2383", "Kodak Vision3 250D", "cine",
     "Daylight-balanced cinema negative printed to 2383 — the modern motion-picture look."),
    ("kodak_vision3_200t", "kodak_2383", "Kodak Vision3 200T", "cine",
     "Tungsten-balanced cine stock: cool, cinematic cast under daylight, rich shadow detail."),
    ("kodak_vision3_500t", "kodak_2383", "Kodak Vision3 500T", "cine",
     "Fast tungsten cinema stock: the low-light night look, more grain and pronounced halation."),
    ("kodak_verita_200d", "kodak_2383", "Kodak Verita 200D", "cine",
     "Still-photography cut of a daylight cine emulsion — clean colour with a motion-picture print."),
    # ── Colour reversal / slide (positive; developed film scanned directly) ──
    # The print column is a placeholder; positive stocks ignore it (scan_film).
    ("fujifilm_velvia_100", "kodak_portra_endura", "Fujifilm Velvia 100", "slide",
     "The legendary saturation slide: electric greens and reds, deep contrast — the landscape standard."),
    ("fujifilm_provia_100f", "kodak_portra_endura", "Fujifilm Provia 100F", "slide",
     "The neutral professional chrome: clean, accurate colour and gentler contrast where Velvia goes punchy."),
    ("kodak_ektachrome_100", "kodak_portra_endura", "Kodak Ektachrome E100", "slide",
     "Modern E-6 revival: crisp, slightly cool slide with fine grain and clean neutrals."),
    ("kodak_kodachrome_64", "kodak_portra_endura", "Kodak Kodachrome 64", "slide",
     "The iconic American chrome: warm reds, deep rich shadows — the National Geographic look."),
    # ── Black & white (silver negative printed on B&W paper) ──
    # film + paper are locally authored bw profiles (tools/bw_profiles).
    ("kodak_tri_x_400", "bw_enlarging_paper", "Kodak Tri-X 400", "bw",
     "The definitive reportage black-and-white: classic panchromatic tones and gutsy mid-contrast, printed on normal-grade glossy paper."),
    ("ilford_hp5_plus_400", "bw_enlarging_paper", "Ilford HP5 Plus 400", "bw",
     "Britain's reportage staple: a touch softer and more forgiving than Tri-X, with long, gentle tonal gradation."),
    ("ilford_fp4_plus_125", "bw_enlarging_paper", "Ilford FP4 Plus 125", "bw",
     "Classic medium-speed black-and-white: fine grain, crisp mid-contrast and beautifully clean highlights."),
    ("kodak_tmax_100", "bw_enlarging_paper", "Kodak T-Max 100", "bw",
     "Modern tabular-grain stock: exceptionally fine grain, high sharpness and a long, clean straight line."),
    ("kodak_tmax_400", "bw_enlarging_paper", "Kodak T-Max 400", "bw",
     "The modern 400: noticeably finer grain than Tri-X with a smoother, more neutral tonal scale."),
    ("fujifilm_acros_100", "bw_enlarging_paper", "Fujifilm Neopan Acros 100", "bw",
     "Famous for the smoothest grain of all: silky, almost grainless tones and superb reciprocity."),
    ("ilford_ortho_plus_80", "bw_enlarging_paper", "Ilford Ortho Plus 80", "bw",
     "Orthochromatic (red-blind): renders reds near-black and skies dramatically light — the vintage plate look."),
    ("ilford_delta_3200", "bw_enlarging_paper", "Ilford Delta 3200", "bw",
     "Fast and atmospheric: lower contrast, deep shadows and pronounced grain for available-light and night work."),
]


def _mask_spectral(chD, baseD):
    chD = np.asarray(chD, float); baseD = np.asarray(baseD, float)
    m = np.isnan(baseD) | np.isnan(chD).any(1)
    return np.nan_to_num(chD), np.where(m, 1e6, np.nan_to_num(baseD))


def _lin_mat(fn):
    return np.asarray(fn(np.eye(3))).reshape(3, 3)


def _resample(lut, size):
    src = np.asarray(lut); n = src.shape[0]
    x = np.clip(np.linspace(0, n - 1, size), 0, n - 1)
    i0 = np.floor(x).astype(int); i1 = np.minimum(i0 + 1, n - 1); f = x - i0
    rows = src[i0] * (1 - f)[:, None, None] + src[i1] * f[:, None, None]
    return rows[:, i0] * (1 - f)[None, :, None] + rows[:, i1] * f[None, :, None]


def extract(film, prnt):
    p = _build_params(film, prnt)
    p.io.input_color_space = "sRGB"; p.io.input_cctf_decoding = False
    p.io.output_color_space = "sRGB"; p.io.output_cctf_encoding = False
    p.camera.auto_exposure = False; p.camera.exposure_compensation_ev = 0.0
    for fld in (p.film_render.grain, p.film_render.halation, p.film_render.glare, p.print_render.glare):
        fld.active = False
    p.film_render.dir_couplers.diffusion_size_um = 0.0
    # Reversal (slide) path: the engine scans the developed FILM directly — no
    # enlarger, no print paper (topology drops the two printing nodes). The
    # printing lanes below become inert placeholders and the GLSL skips stages
    # 3-4 via #ifdef SF_POSITIVE. Black/white scan corrections are image-global,
    # so disable them (as auto_exposure already is) to keep the per-pixel port
    # exact against the engine.
    positive = bool(p.film.is_positive)
    if positive:
        p.io.scan_film = True
        p.scanner.black_correction = False
        p.scanner.white_correction = False
    pipe = SimulationPipeline(p); fd, pd = p.film.data, p.print.data

    illu_xy = _illuminant_to_xy(p.film.info.reference_illuminant)
    M1 = _lin_mat(lambda e: colour.RGB_to_XYZ(e, "sRGB", apply_cctf_decoding=False, illuminant=illu_xy, chromatic_adaptation_transform="CAT16"))
    sens_f = np.nan_to_num(10.0 ** np.asarray(fd.log_sensitivity))
    tc = _resample(pipe._lut_service.get_filming_tc_lut(sens_f), TC)         # (TC,TC,3)

    dc_f = np.asarray(fd.density_curves); le_f = np.asarray(fd.log_exposure)
    norm_dc = dc_f - np.nanmin(dc_f, 0)
    Mc = compute_dir_couplers_matrix(p.film_render.dir_couplers) * p.film_render.dir_couplers.amount
    dc0 = compute_density_curves_before_dir_couplers(norm_dc, le_f, Mc, positive=positive)

    chD_f, bD_f = _mask_spectral(fd.channel_density, fd.base_density)
    cmfs = np.asarray(STANDARD_OBSERVER_CMFS[:])

    if positive:
        # Scan the developed film directly under its own viewing illuminant.
        # Print-expose / print-develop are skipped; their lanes ship as zeros
        # so old/new readers stay layout-compatible. Scan dye = film dye.
        pkern = np.zeros((NWL, 3)); dichM = np.zeros(NWL); dichY = np.zeros(NWL)
        factor = 1.0; neutralMY = [0.0, 0.0]
        le_p = le_f
        morph = np.zeros((dc_f.shape[0], 3))          # filmCurves row2 inert
        chD_p, bD_p = chD_f, bD_f                      # scan dye = film dye
        scan_il = standard_illuminant(p.film.info.viewing_illuminant)
    else:
        lamp = standard_illuminant(p.enlarger.illuminant)
        filt = np.asarray(pipe._enlarger_service.enlarger_filtered_illuminant(lamp))
        psens = np.nan_to_num(10.0 ** np.asarray(pd.log_sensitivity))
        pkern = filt[:, None] * psens
        factor = float(np.asarray(pipe._printing_stage._compute_exposure_factor_midgray(psens, filt)).reshape(-1)[0])
        # Enlarger dichroic M/Y spectra + the stock's neutral filter pack, so the
        # shader can recompute filtration LIVE relative to neutral (C held, as on a
        # real colour head). custom_dichroic_filters.filters columns are C,M,Y; the
        # baked pkern already carries the neutral pack, so we only ship what's needed
        # to form the live/neutral dimming ratio. Packed into the spare alpha lanes
        # of the print/scan kernels (filmSpec row1.a = dichM, row3.a = dichY).
        dich = np.asarray(custom_dichroic_filters.filters)
        dichM = dich[:, 1]; dichY = dich[:, 2]
        neutralMY = [float(p.enlarger.m_filter_neutral), float(p.enlarger.y_filter_neutral)]

        le_p = np.asarray(pd.log_exposure)
        morph = np.asarray(apply_print_curves_morph(le_p, pd.density_curves_model, p.print_render.density_curves_morph, profile_type=p.print.info.type))

        chD_p, bD_p = _mask_spectral(pd.channel_density, pd.base_density)
        scan_il = standard_illuminant(p.print.info.viewing_illuminant)

    snorm = float(np.sum(scan_il * cmfs[:, 1])); skern = scan_il[:, None] * cmfs
    ixy = colour.XYZ_to_xy(np.einsum("k,kl->l", scan_il, cmfs) / snorm)
    M2 = _lin_mat(lambda e: colour.XYZ_to_RGB(e, colourspace="sRGB", apply_cctf_encoding=False, illuminant=ixy))

    # Pack 3 rgba16f textures (Float32, a-pad to 4 channels):
    filmTc = np.zeros((TC, TC, 4), np.float32); filmTc[..., :3] = tc
    filmCurves = np.zeros((3, 256, 4), np.float32)
    filmCurves[0, :, :3] = norm_dc; filmCurves[1, :, :3] = dc0; filmCurves[2, :, :3] = morph
    filmSpec = np.zeros((4, NWL, 4), np.float32)
    filmSpec[0, :, :3] = chD_f; filmSpec[0, :, 3] = bD_f
    filmSpec[1, :, :3] = pkern; filmSpec[1, :, 3] = dichM
    filmSpec[2, :, :3] = chD_p; filmSpec[2, :, 3] = bD_p
    filmSpec[3, :, :3] = skern; filmSpec[3, :, 3] = dichY

    def col(M, j): return [float(M[0, j]), float(M[1, j]), float(M[2, j])]
    consts = {
        "rgb2xyz": [col(M1, 0), col(M1, 1), col(M1, 2)],
        "coup": [col(Mc, 0), col(Mc, 1), col(Mc, 2)],
        "xyz2rgb": [col(M2, 0), col(M2, 1), col(M2, 2)],
        "factor": factor, "scanNorm": snorm,
        "leFilm": [float(le_f[0]), float(le_f[-1])],
        "lePrint": [float(le_p[0]), float(le_p[-1])],
        "neutralMY": neutralMY,
        # Per-channel max of the normalised film density curve. Reversal develop
        # releases couplers from the SILVER image (density_max − dye density), so
        # the positive GLSL needs this to invert the coupler donor term.
        "densMax": [float(x) for x in np.nanmax(norm_dc, axis=0)],
    }
    # Per-stock effect parameters for the live halation/grain/glare approximations.
    # The engine models these in full (multi-bounce halation, binomial grain); the
    # extension reproduces the *character* — per-channel tint/balance and a film-
    # plane spatial scale — so each stock's effects differ authentically instead of
    # using one hardcoded look. Spatial scales are film-plane micrometres; we ship
    # them as a fraction of the frame width (format_mm) so the shader can map to
    # any output resolution. (These fields are inert in the engine sim above —
    # active=False — and only read here for the extension's own effect layer.)
    hal, grain, glare = p.film_render.halation, p.film_render.grain, p.film_render.glare
    fmt_um = float(p.camera.film_format_mm) * 1000.0
    hstr = [float(x) for x in hal.halation_strength]
    hmax = max(hstr) or 1.0
    fx = {
        # Normalised per-channel halation strength → tint; absolute max as the
        # natural amount. Portra ≈ (0.015,0.005,0) → tint (1,0.33,0).
        "halTint": [s / hmax for s in hstr],
        "halStrength": hmax,
        "halSizeFrac": float(np.mean(hal.halation_first_sigma_um)) / fmt_um,
        "halBounceDecay": float(hal.halation_bounce_decay),
        # Per-channel grain particle scale (blue coarser) + particle area (∝ speed).
        "grainScale": [float(x) for x in grain.particle_scale],
        "grainAreaUm2": float(grain.particle_area_um2),
        "grainBlur": float(grain.blur),
        "glare": float(glare.percent),
    }
    return pipe, p, dict(filmTc=filmTc, filmCurves=filmCurves, filmSpec=filmSpec, consts=consts, fx=fx, positive=positive)


def _selfcheck(pipe, p, t, verbose=False):
    c = t["consts"]; M1 = np.array(c["rgb2xyz"]).T; Mc = np.array(c["coup"]).T; M2 = np.array(c["xyz2rgb"]).T
    tc = t["filmTc"][..., :3]; norm_dc = t["filmCurves"][0, :, :3]; dc0 = t["filmCurves"][1, :, :3]; morph = t["filmCurves"][2, :, :3]
    chDf = t["filmSpec"][0, :, :3]; bDf = t["filmSpec"][0, :, 3]; pk = t["filmSpec"][1, :, :3]
    chDp = t["filmSpec"][2, :, :3]; bDp = t["filmSpec"][2, :, 3]; sk = t["filmSpec"][3, :, :3]
    lef = c["leFilm"]; lep = c["lePrint"]
    def itp(rowc, le, lv):
        o = np.zeros_like(lv); n = rowc.shape[0]; tt = np.clip((lv - le[0]) / (le[1] - le[0]), 0, 1) * (n - 1)
        i0 = np.floor(tt).astype(int); i1 = np.minimum(i0 + 1, n - 1); f = tt - i0
        for ch in range(3): o[..., ch] = rowc[i0[..., ch], ch] * (1 - f[..., ch]) + rowc[i1[..., ch], ch] * f[..., ch]
        return o
    def t2q(xy):
        tx, ty = xy[..., 0], xy[..., 1]; return np.stack((np.clip((1 - tx) ** 2, 0, 1), np.clip(ty / np.fmax(1 - tx, 1e-10), 0, 1)), -1)
    def bil(l, uv):
        S = l.shape[0]; cc = np.clip(uv, 0, 1) * (S - 1); x0 = np.floor(cc[..., 0]).astype(int); y0 = np.floor(cc[..., 1]).astype(int)
        x1 = np.minimum(x0 + 1, S - 1); y1 = np.minimum(y0 + 1, S - 1); fx = cc[..., 0] - x0; fy = cc[..., 1] - y0
        a = l[x0, y0]; b = l[x1, y0]; d = l[x0, y1]; e = l[x1, y1]
        return (a * (1 - fx)[..., None] + b * fx[..., None]) * (1 - fy)[..., None] + (d * (1 - fx)[..., None] + e * fx[..., None]) * fy[..., None]
    ax = [0.05, 0.184, 0.4, 0.7, 1.0]; grid = np.array([[r, g, b] for r in ax for g in ax for b in ax]).reshape(1, -1, 3)
    xyz = grid @ M1; bb = np.fmax(xyz.sum(-1), 1e-10); raw = bil(tc, t2q(xyz[..., :2] / bb[..., None])) * bb[..., None]
    logf = np.log10(np.fmax(raw, 0) + 1e-10)
    dens = itp(norm_dc, lef, logf)
    # Reversal develop releases couplers from the silver image (dMax − dye); the
    # negative releases them from the dye density directly. dc0 already bakes the
    # positive curve inversion; this is the per-pixel donor term.
    silver = (np.nanmax(norm_dc, axis=0) - dens) if t["positive"] else dens
    cmyf = itp(dc0, lef, logf - silver @ Mc)
    if t["positive"]:
        # Reversal: the developed film is scanned directly, no print stage.
        cmyp = cmyf
    else:
        rp = np.zeros(grid.shape)
        for i in range(NWL): rp += 10 ** (-(cmyf @ chDf[i] + bDf[i]))[..., None] * pk[i]
        rp *= c["factor"] * float(p.enlarger.print_exposure)
        logp = np.log10(np.fmax(rp, 0) + 1e-10); cmyp = itp(morph, lep, logp)
    xy2 = np.zeros(grid.shape)
    for i in range(NWL): xy2 += 10 ** (-(cmyp @ chDp[i] + bDp[i]))[..., None] * sk[i]
    rgb = (xy2 / c["scanNorm"]) @ M2
    ref = np.asarray(pipe.process(grid, inject=Tap.RGB_PRE, collect=Tap.RGB_OUT)).reshape(-1, 3)
    err = np.abs(rgb.reshape(-1, 3) - ref)
    if verbose:
        print(f"    err mean {err.mean():.4f} median {np.median(err):.4f} "
              f"p95 {np.percentile(err, 95):.4f} max {err.max():.4f}", file=sys.stderr)
    return float(err.max())


def _b64(a):
    return base64.b64encode(np.ascontiguousarray(a, np.float32).tobytes()).decode("ascii")


def _vec3(v): return f"vec3({v[0]:.8g},{v[1]:.8g},{v[2]:.8g})"


# GLSL ES has no implicit int→float conversion, so a bare-integer scalar float
# const (`const float x = 1;` when %g drops the ".0") is a COMPILE ERROR that
# fails the whole shader. (vec constructors are fine — they convert int args.)
# So scalar float consts must always carry a decimal point.
def _glf(x):
    s = f"{x:.8g}"
    return s if ("." in s or "e" in s or "E" in s) else s + ".0"


def _const_block(c, positive=False):
    # Baked gate constants read by film-glsl.ts — NOT #define/#ifdef. The host
    # splices stage GLSL into the monolith by substring rewriting, not a C
    # preprocessor, so #ifdef guards never take effect (slides silently ran the
    # print path over their zeroed print lanes → a white frame). A `const bool` is
    # a compile-time constant, so the driver still folds away the dead branch.
    #   sfHasNeutral: bundle carries the neutral filter pack + dichroic spectra for
    #     the live enlarger-filtration path (older bundles would set this false).
    #   sfPositive: reversal (slide) bundle — skip the print stages (3-4) and scan
    #     the developed film directly.
    L = ["const bool sfHasNeutral = true;",
         f"const bool sfPositive = {'true' if positive else 'false'};"]
    for nm, key in (("sfRgb2xyz", "rgb2xyz"), ("sfCoup", "coup"), ("sfXyz2rgb", "xyz2rgb")):
        for j in range(3): L.append(f"const vec3 {nm}{j} = {_vec3(c[key][j])};")
    L.append(f"const float sfFactor = {_glf(c['factor'])};")
    L.append(f"const float sfScanNorm = {_glf(c['scanNorm'])};")
    L.append(f"const vec2 sfLeFilm = vec2({c['leFilm'][0]:.8g},{c['leFilm'][1]:.8g});")
    L.append(f"const vec2 sfLePrint = vec2({c['lePrint'][0]:.8g},{c['lePrint'][1]:.8g});")
    L.append(f"const vec2 sfNeutralMY = vec2({c['neutralMY'][0]:.8g},{c['neutralMY'][1]:.8g});")
    L.append(f"const vec3 sfDensMax = {_vec3(c['densMax'])};")
    return "\\n".join(L)


def _fx_ts(fx):
    def v3(a): return f"[{a[0]:.6g}, {a[1]:.6g}, {a[2]:.6g}]"
    return (
        "{ halTint: %s, halStrength: %.6g, halSizeFrac: %.6g, halBounceDecay: %.6g, "
        "grainScale: %s, grainAreaUm2: %.6g, grainBlur: %.6g, glare: %.6g }"
    ) % (
        v3(fx["halTint"]), fx["halStrength"], fx["halSizeFrac"], fx["halBounceDecay"],
        v3(fx["grainScale"]), fx["grainAreaUm2"], fx["grainBlur"], fx["glare"],
    )


def emit():
    entries = []
    for film, prnt, name, kind, desc in CURATED:
        pipe, p, t = extract(film, prnt)
        err = _selfcheck(pipe, p, t)
        sid = film
        print(f"  {sid}: self-check max err {err:.4f}", file=sys.stderr)
        entries.append((sid, name, kind, desc, t))
    lines = [
        "// AUTO-GENERATED by tools/extract_stock.py --emit — do not edit.",
        "// Per-stock Spektrafilm data: GLSL const block + 3 packed rgba16f textures",
        "// (Float32, base64) + per-stock effect parameters (halation/grain/glare).",
        "// LUT/spectral data derived from Spektrafilm profiles (CC BY-SA 4.0).",
        'import { decodeF32 } from "./film-data";',
        "",
        "// Per-stock effect character for the live halation/grain/glare layer.",
        "// halTint: normalised per-channel halation strength (the stock's glow hue).",
        "// halSizeFrac: halation sigma as a fraction of frame width (resolution-free).",
        "// grainScale: per-channel grain particle scale (blue is coarser).",
        "export interface FilmFx {",
        "  halTint: [number, number, number]; halStrength: number;",
        "  halSizeFrac: number; halBounceDecay: number;",
        "  grainScale: [number, number, number]; grainAreaUm2: number;",
        "  grainBlur: number; glare: number;",
        "}",
        "",
        "export interface FilmStockData {",
        '  id: string; name: string; kind: "negative" | "cine" | "slide" | "bw"; description: string;',
        "  consts: string; fx: FilmFx;",
        "  filmTc: () => Float32Array; tcSize: number;",
        "  filmCurves: () => Float32Array; filmSpec: () => Float32Array;",
        "}",
        "",
        "export const FILM_STOCKS: FilmStockData[] = [",
    ]
    for sid, name, kind, desc, t in entries:
        lines.append(
            f'  {{ id: {sid!r}, name: {name!r}, kind: {kind!r}, description: {desc!r}, tcSize: {TC},\n'
            f'    fx: {_fx_ts(t["fx"])},\n'
            f'    consts: "{_const_block(t["consts"], t["positive"])}",\n'
            f'    filmTc: () => decodeF32("{_b64(t["filmTc"])}"),\n'
            f'    filmCurves: () => decodeF32("{_b64(t["filmCurves"])}"),\n'
            f'    filmSpec: () => decodeF32("{_b64(t["filmSpec"])}") }},'
        )
    lines.append("];\n")
    with open("src/stocks_data.generated.ts", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"wrote src/stocks_data.generated.ts ({len(entries)} stocks)", file=sys.stderr)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--emit":
        emit(); return 0
    if len(sys.argv) < 3:
        print("usage: extract_stock.py <film> <print> | --emit", file=sys.stderr); return 2
    pipe, p, t = extract(sys.argv[1], sys.argv[2])
    print(f"self-check max err {_selfcheck(pipe, p, t, verbose=True):.4f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
