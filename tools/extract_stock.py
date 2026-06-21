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
import sys

import numpy as np
import colour

from spektrafilm.runtime.params_builder import init_params, digest_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap
from spektrafilm.config import STANDARD_OBSERVER_CMFS
from spektrafilm.model.illuminants import standard_illuminant
from spektrafilm.model.couplers import compute_dir_couplers_matrix, compute_density_curves_before_dir_couplers
from spektrafilm.utils.morph_curves import apply_print_curves_morph
from spektrafilm.utils.spectral_upsampling import _illuminant_to_xy

TC = 64   # chromaticity LUT edge
NWL = 81

CURATED = [
    ("kodak_portra_400", "kodak_portra_endura", "Kodak Portra 400"),
    ("kodak_portra_160", "kodak_portra_endura", "Kodak Portra 160"),
    ("kodak_ektar_100", "kodak_supra_endura", "Kodak Ektar 100"),
    ("kodak_gold_200", "kodak_endura_premier", "Kodak Gold 200"),
    ("kodak_ultramax_400", "kodak_supra_endura", "Kodak Ultramax 400"),
    ("fujifilm_pro_400h", "kodak_portra_endura", "Fujifilm Pro 400H"),
    ("kodak_vision3_250d", "kodak_2383", "Kodak Vision3 250D"),
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
    p = digest_params(init_params(film, prnt))
    p.io.input_color_space = "sRGB"; p.io.input_cctf_decoding = False
    p.io.output_color_space = "sRGB"; p.io.output_cctf_encoding = False
    p.camera.auto_exposure = False; p.camera.exposure_compensation_ev = 0.0
    for fld in (p.film_render.grain, p.film_render.halation, p.film_render.glare, p.print_render.glare):
        fld.active = False
    p.film_render.dir_couplers.diffusion_size_um = 0.0
    pipe = SimulationPipeline(p); fd, pd = p.film.data, p.print.data

    illu_xy = _illuminant_to_xy(p.film.info.reference_illuminant)
    M1 = _lin_mat(lambda e: colour.RGB_to_XYZ(e, "sRGB", apply_cctf_decoding=False, illuminant=illu_xy, chromatic_adaptation_transform="CAT16"))
    sens_f = np.nan_to_num(10.0 ** np.asarray(fd.log_sensitivity))
    tc = _resample(pipe._lut_service.get_filming_tc_lut(sens_f), TC)         # (TC,TC,3)

    dc_f = np.asarray(fd.density_curves); le_f = np.asarray(fd.log_exposure)
    norm_dc = dc_f - np.nanmin(dc_f, 0)
    Mc = compute_dir_couplers_matrix(p.film_render.dir_couplers) * p.film_render.dir_couplers.amount
    dc0 = compute_density_curves_before_dir_couplers(norm_dc, le_f, Mc, positive=(p.film.info.type == "positive"))

    chD_f, bD_f = _mask_spectral(fd.channel_density, fd.base_density)
    lamp = standard_illuminant(p.enlarger.illuminant)
    filt = np.asarray(pipe._enlarger_service.enlarger_filtered_illuminant(lamp))
    psens = np.nan_to_num(10.0 ** np.asarray(pd.log_sensitivity))
    pkern = filt[:, None] * psens
    factor = float(np.asarray(pipe._printing_stage._compute_exposure_factor_midgray(psens, filt)).reshape(-1)[0])

    le_p = np.asarray(pd.log_exposure)
    morph = np.asarray(apply_print_curves_morph(le_p, pd.density_curves_model, p.print_render.density_curves_morph, profile_type=p.print.info.type))

    chD_p, bD_p = _mask_spectral(pd.channel_density, pd.base_density)
    scan_il = standard_illuminant(p.print.info.viewing_illuminant); cmfs = np.asarray(STANDARD_OBSERVER_CMFS[:])
    snorm = float(np.sum(scan_il * cmfs[:, 1])); skern = scan_il[:, None] * cmfs
    ixy = colour.XYZ_to_xy(np.einsum("k,kl->l", scan_il, cmfs) / snorm)
    M2 = _lin_mat(lambda e: colour.XYZ_to_RGB(e, colourspace="sRGB", apply_cctf_encoding=False, illuminant=ixy))

    # Pack 3 rgba16f textures (Float32, a-pad to 4 channels):
    filmTc = np.zeros((TC, TC, 4), np.float32); filmTc[..., :3] = tc
    filmCurves = np.zeros((3, 256, 4), np.float32)
    filmCurves[0, :, :3] = norm_dc; filmCurves[1, :, :3] = dc0; filmCurves[2, :, :3] = morph
    filmSpec = np.zeros((4, NWL, 4), np.float32)
    filmSpec[0, :, :3] = chD_f; filmSpec[0, :, 3] = bD_f
    filmSpec[1, :, :3] = pkern
    filmSpec[2, :, :3] = chD_p; filmSpec[2, :, 3] = bD_p
    filmSpec[3, :, :3] = skern

    def col(M, j): return [float(M[0, j]), float(M[1, j]), float(M[2, j])]
    consts = {
        "rgb2xyz": [col(M1, 0), col(M1, 1), col(M1, 2)],
        "coup": [col(Mc, 0), col(Mc, 1), col(Mc, 2)],
        "xyz2rgb": [col(M2, 0), col(M2, 1), col(M2, 2)],
        "factor": factor, "scanNorm": snorm,
        "leFilm": [float(le_f[0]), float(le_f[-1])],
        "lePrint": [float(le_p[0]), float(le_p[-1])],
    }
    return pipe, p, dict(filmTc=filmTc, filmCurves=filmCurves, filmSpec=filmSpec, consts=consts)


def _selfcheck(pipe, p, t):
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
    logf = np.log10(np.fmax(raw, 0) + 1e-10); cmyf = itp(dc0, lef, logf - itp(norm_dc, lef, logf) @ Mc)
    rp = np.zeros(grid.shape)
    for i in range(NWL): rp += 10 ** (-(cmyf @ chDf[i] + bDf[i]))[..., None] * pk[i]
    rp *= c["factor"] * float(p.enlarger.print_exposure)
    logp = np.log10(np.fmax(rp, 0) + 1e-10); cmyp = itp(morph, lep, logp)
    xy2 = np.zeros(grid.shape)
    for i in range(NWL): xy2 += 10 ** (-(cmyp @ chDp[i] + bDp[i]))[..., None] * sk[i]
    rgb = (xy2 / c["scanNorm"]) @ M2
    ref = np.asarray(pipe.process(grid, inject=Tap.RGB_PRE, collect=Tap.RGB_OUT)).reshape(-1, 3)
    return float(np.abs(rgb.reshape(-1, 3) - ref).max())


def _b64(a):
    return base64.b64encode(np.ascontiguousarray(a, np.float32).tobytes()).decode("ascii")


def _vec3(v): return f"vec3({v[0]:.8g},{v[1]:.8g},{v[2]:.8g})"


def _const_block(c):
    L = []
    for nm, key in (("sfRgb2xyz", "rgb2xyz"), ("sfCoup", "coup"), ("sfXyz2rgb", "xyz2rgb")):
        for j in range(3): L.append(f"const vec3 {nm}{j} = {_vec3(c[key][j])};")
    L.append(f"const float sfFactor = {c['factor']:.8g};")
    L.append(f"const float sfScanNorm = {c['scanNorm']:.8g};")
    L.append(f"const vec2 sfLeFilm = vec2({c['leFilm'][0]:.8g},{c['leFilm'][1]:.8g});")
    L.append(f"const vec2 sfLePrint = vec2({c['lePrint'][0]:.8g},{c['lePrint'][1]:.8g});")
    return "\\n".join(L)


def emit():
    entries = []
    for film, prnt, name in CURATED:
        pipe, p, t = extract(film, prnt)
        err = _selfcheck(pipe, p, t)
        sid = film
        print(f"  {sid}: self-check max err {err:.4f}", file=sys.stderr)
        entries.append((sid, name, t))
    lines = [
        "// AUTO-GENERATED by tools/extract_stock.py --emit — do not edit.",
        "// Per-stock Spektrafilm data: GLSL const block + 3 packed rgba16f textures",
        "// (Float32, base64). LUT/spectral data derived from Spektrafilm profiles (CC BY-SA 4.0).",
        'import { decodeF32 } from "./film-data";',
        "",
        "export interface FilmStockData {",
        "  id: string; name: string; consts: string;",
        "  filmTc: () => Float32Array; tcSize: number;",
        "  filmCurves: () => Float32Array; filmSpec: () => Float32Array;",
        "}",
        "",
        "export const FILM_STOCKS: FilmStockData[] = [",
    ]
    for sid, name, t in entries:
        lines.append(
            f'  {{ id: {sid!r}, name: {name!r}, tcSize: {TC},\n'
            f'    consts: "{_const_block(t["consts"])}",\n'
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
    print(f"self-check max err {_selfcheck(pipe, p, t):.4f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
