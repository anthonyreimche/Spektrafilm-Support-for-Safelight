# Spektrafilm Support for SafeLight

A [SafeLight](https://github.com/anthonyreimche/SafeLight) extension that runs
[**Spektrafilm**](https://github.com/andreavolpato/spektrafilm) — Andrea
Volpato's physically-based *spectral* simulation of analog photography
(expose → develop → enlarger → print → scan) — **live, per pixel, on the GPU**.
Not a baked LUT: it runs the actual spectral pipeline with adjustable exposure
and print exposure.

It adds a **Spektrafilm** panel to the Develop module with **26 stocks** across
four families — colour negative, cinema, **slide/reversal**, and **black &
white** — and live controls for exposure, print exposure, coupler strength,
contrast/grade, enlarger filtration, halation and grain.

Three light paths run through the one engine port:

- **Colour negative / cinema** — the full five-stage negative→enlarger→print→scan.
- **Slide / reversal** — the engine's positive path: expose → develop → scan the
  developed film directly (no enlarger or print paper).
- **Black & white** — a real silver neg printed on B&W paper. Modelled as a
  neutral emulsion (three identical panchromatic layers + neutral dye), so it
  runs the real neg→paper→scan path and comes out perfectly grey, with the
  colour→grey rendering coming from each stock's spectral sensitivity.

## How it works

Spektrafilm's pipeline is five per-pixel stages: spectral expose → develop
(characteristic curves + DIR couplers) → print-expose (spectral, through the
enlarger) → print-develop → scan (spectral → XYZ → RGB). This extension runs all
five **live in a GLSL processing stage** ([src/film-glsl.ts](src/film-glsl.ts)):

- The expensive spectral data (the Hanatos chromaticity LUT, dye-density and
  sensitivity spectra, characteristic curves, colour matrices) is **extracted
  from the engine per stock** and uploaded as 3 float (`rgba16f`) textures + a
  GLSL const block. This is *not* an RGB→RGB look bake — the per-pixel pipeline
  is run in full, so **exposure and print exposure stay live**.
- The two spectral stages integrate over 81 wavelength bins per pixel; the rest
  is matrix + 1D-curve + chromaticity-LUT lookups.
- The extraction self-checks the whole packed pipeline against the engine
  (`tools/extract_stock.py`). It reproduces normal photographic colour closely
  (mean ≈ 5%); error rises on near-primary, out-of-gamut inputs, where the
  engine's perceptual gamut mapping (a `cam16ucs` stand-in here) diverges.

The stage runs at the `tone-map` phase on scene-linear `lin` and writes
scene-linear print colour.

> **Select the "Spektrafilm" rendering transform** (Preferences ▸ Rendering).
> The extension registers it — a plain encode with the RAW base curve off — as
> the correct view transform: the film stock *is* the tone rendering, so AgX/ACES
> would tone-map on top of it.

## Controls

Per-stock, all live (no re-bake):

- **Exposure / Print Exposure** — negative exposure and enlarger lamp time.
- **Coupler Amount** — DIR inter-layer coupler strength (0 = off → flatter, less
  saturated; >1 = stronger cross-talk).
- **Print Contrast** — warps print log-exposure around the curve midpoint (paper
  grade): >1 harder, <1 softer.
- **Filtration M / Y** — live enlarger colour-head filtration, re-balanced against
  the stock's neutral pack (C held, as on a real colour head).
- **Halation** (Amount / Size / Threshold) — back-reflection highlight glow,
  tinted by the stock's own anti-halation balance, resolution-independent.
- **Grain** (Amount / Size) — midtone-peaked, per-channel film grain at the
  stock's grain character, resolution-independent (monochrome for B&W stocks).

Halation and grain default to 0 (off) until dialled in. The control set follows
the stock: **slides** drop Print Exposure / filtration (no enlarger) and expose a
film-curve **Contrast**; **black & white** shows the darkroom essentials —
Exposure, Print Exposure and **Paper Grade** (couplers and colour-head filtration
are meaningless for a neutral silver emulsion).

## Bundled film stocks

Twenty-six stocks ship in the picker, grouped by family.

**Colour negative**

| Stock | Film → Print |
|---|---|
| Kodak Portra 400 | kodak_portra_400 → kodak_portra_endura |
| Kodak Portra 160 | kodak_portra_160 → kodak_portra_endura |
| Kodak Portra 800 | kodak_portra_800 → kodak_portra_endura |
| Kodak Ektar 100 | kodak_ektar_100 → kodak_supra_endura |
| Kodak Gold 200 | kodak_gold_200 → kodak_endura_premier |
| Kodak Ultramax 400 | kodak_ultramax_400 → kodak_supra_endura |
| Fujifilm Pro 400H | fujifilm_pro_400h → kodak_portra_endura |
| Fujifilm C200 | fujifilm_c200 → fujifilm_crystal_archive_typeii |
| Fujifilm Superia X-tra 400 | fujifilm_xtra_400 → fujifilm_crystal_archive_typeii |

**Cinema**

| Stock | Film → Print |
|---|---|
| Kodak Vision3 50D | kodak_vision3_50d → kodak_2383 |
| Kodak Vision3 250D | kodak_vision3_250d → kodak_2383 |
| Kodak Vision3 200T | kodak_vision3_200t → kodak_2383 |
| Kodak Vision3 500T | kodak_vision3_500t → kodak_2383 |
| Kodak Verita 200D | kodak_verita_200d → kodak_2383 |

**Slide / reversal** (positive path — the developed film is scanned directly)

| Stock | Profile |
|---|---|
| Fujifilm Velvia 100 | fujifilm_velvia_100 |
| Fujifilm Provia 100F | fujifilm_provia_100f |
| Kodak Ektachrome E100 | kodak_ektachrome_100 |
| Kodak Kodachrome 64 | kodak_kodachrome_64 |

**Black & white** (silver negative printed on B&W paper)

| Stock | Sensitisation |
|---|---|
| Kodak Tri-X 400 | classic panchromatic |
| Ilford HP5 Plus 400 | classic panchromatic |
| Ilford FP4 Plus 125 | classic panchromatic |
| Kodak T-Max 100 | tabular-grain |
| Kodak T-Max 400 | tabular-grain |
| Fujifilm Neopan Acros 100 | fine-grain panchromatic |
| Ilford Ortho Plus 80 | orthochromatic (red-blind) |
| Ilford Delta 3200 | fast panchromatic |

The B&W stocks are **datasheet-*shaped* parametric models** (sensitisation class +
published gamma/toe/shoulder), not measured spectral traces — see
[tools/make_bw_profiles.py](tools/make_bw_profiles.py). They share one normal-grade
glossy paper and differ by spectral sensitivity (colour→grey rendering) and
characteristic curve (contrast). The orthochromatic stock renders reds near-black
and skies light — the classic plate look.

## Adding your own stocks

Want a different film/print combo? Regenerate the data from the engine.
SafeLight never links the GPLv3 engine — the extraction runs offline and only the
extracted spectral data ships.

**1. Install Spektrafilm** from <https://github.com/andreavolpato/spektrafilm>.
The whole dependency set is pip-installable with wheels on Python 3.13 (numpy,
scipy, colour-science, scikit-image, numba, OpenImageIO, rawpy, exiv2, lensfunpy,
pyfftw); skip the GUI extras (PySide6/napari). List what's available with
`spektrafilm-lut list film` / `list print`.

**2. Edit the `CURATED` list** in [tools/extract_stock.py](tools/extract_stock.py)
(film slug, print slug, display name, kind `negative|cine|slide|bw`, one-line
description). Slide stocks are auto-detected from the engine profile (`positive`
type, scanned directly). **Black & white** stocks load from locally-authored
profiles in `tools/bw_profiles/` — run `python tools/make_bw_profiles.py` to
(re)generate them, and edit the `FILMS` table in
[tools/make_bw_profiles.py](tools/make_bw_profiles.py) to add or tune a stock.

**3. Regenerate + rebuild:**

```bash
python tools/make_bw_profiles.py       # (B&W only) writes tools/bw_profiles/*.json
python tools/extract_stock.py --emit   # runs the engine → src/stocks_data.generated.ts
npm run build                          # bundles the data into dist/index.js
```

`--emit` self-checks each stock (the whole pipeline re-run from the packed data
vs the engine). Commit `dist/index.js` and `src/stocks_data.generated.ts`, then
install/reload.

## Status / limitations

- Gamut compression uses ACES RGC as a stand-in for the engine's perceptual
  `cam16ucs` — the spectral stages are exact; only extreme out-of-gamut colours
  differ slightly. (B&W output is neutral, so it has no such residual.)
- Halation and grain are real-time approximations, not the engine's full physical
  models. Halation is an inline mip-chain bloom of the source highlights (Size =
  blur LOD), screen-blended and tinted to the stock's anti-halation balance
  (neutral for B&W); grain is binomial-statistics noise peaking in the midtones.
  Both run inline in the effects phase.
- **Black & white** stocks are datasheet-*shaped* parametric models, not measured
  spectral data, and use a single normal-grade paper: grade/contrast is the Paper
  Grade control, not true variable-contrast (two-emulsion) filtration.

## Installation

Search for **Spektrafilm Support** in SafeLight's Extensions panel, or paste the
repo URL into the panel.

## Development

```bash
npm install
npm run build      # → dist/index.js   (commit this — installs load the prebuilt bundle)
npm run typecheck  # tsc --noEmit
```

Requires the host's **rgba16f stage-texture API** (`api.setStageTexture` with
float textures) — hence `minAppVersion`.

## Licensing

- **This extension's code: GPL-3.0-or-later** ([LICENSE](LICENSE)) — it implements
  the Spektrafilm pipeline and its extractor drives the GPLv3 engine.
- **Bundled spectral data** (`src/stocks_data.generated.ts`) is mixed-source:
  - *Colour negative, cinema and slide* stocks are **CC BY-SA 4.0** — extracted
    from profiles © 2026 Andrea Volpato and repacked (float textures + GLSL
    constants). Under ShareAlike, redistributions must keep the CC BY-SA 4.0
    licence and this attribution. <https://creativecommons.org/licenses/by-sa/4.0/>
  - *Black & white* stocks (`tools/bw_profiles/`, generated by
    `tools/make_bw_profiles.py`) are **GPL-3.0-or-later**, © 2026 Anthony Reimche —
    original datasheet-shaped models authored for this extension, not derived from
    the CC BY-SA profiles.

Spektrafilm © Andrea Volpato — https://github.com/andreavolpato/spektrafilm
