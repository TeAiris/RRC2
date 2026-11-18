"""Procedural textures for the drum circle room (numpy + PIL). West African palette: red, gold, green on earth tones."""
import os, sys, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
sys.path.insert(0, "/home/claude/proom")
from textures import fnoise, save, save_img, normal_from_height, rgb

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tex")
import textures as T0
T0.OUT = OUT

RED, GOLD, GREEN, INK, CREAM = (178, 34, 34), (232, 176, 40), (28, 122, 70), (24, 20, 18), (236, 222, 190)


def clay(name, nrm, base=(196, 140, 92), n=512):
    a = fnoise(n, beta=2.2, seed=3); b = fnoise(n, beta=1.2, seed=4); c = fnoise(n, beta=3.0, seed=5)
    v = 0.84 + 0.2 * a + 0.08 * (b - 0.5) + 0.12 * (c - 0.5)
    col = rgb(base) * v[..., None]
    col[..., 0] *= 1.0 + 0.04 * (c - 0.5)
    save(name, col)
    save(nrm, normal_from_height(a * 0.6 + b * 0.4, 5.0))


def skin(name, n=512, patches=False, seed=7):
    """Drum head hide: cream with soft mottling; goat spine line or cowhide patches."""
    yy, xx = np.mgrid[0:n, 0:n] / n - 0.5
    r = np.sqrt(xx ** 2 + yy ** 2)
    a = fnoise(n, beta=2.6, seed=seed); b = fnoise(n, beta=1.4, seed=seed + 1)
    col = rgb((232, 214, 178)) * (0.9 + 0.14 * a + 0.05 * (b - 0.5))[..., None]
    if patches:
        m = fnoise(n, beta=3.2, seed=seed + 2)
        mask = np.clip((m - 0.56) * 9, 0, 1)[..., None]
        col = col * (1 - mask) + rgb((104, 66, 40)) * (0.85 + 0.3 * b)[..., None] * mask
    else:
        pass                                                    # no spine line: it read as a mark on the head
    wear = np.exp(-(r / 0.2) ** 2) * 0.07                     # lighter where hands land
    col = np.clip(col + wear[..., None], 0, 1)
    edge = np.clip((r - 0.44) / 0.06, 0, 1)[..., None]
    col = col * (1 - 0.25 * edge)
    save(name, col)


def textile(name, pal, n=512, seed=1):
    """Strip-woven cloth: vertical bands of simple geometric motifs."""
    img = Image.new("RGB", (n, n), INK); d = ImageDraw.Draw(img)
    r = np.random.default_rng(seed)
    bands = 8; bw = n // bands
    for i in range(bands):
        x0 = i * bw; kind = (i + seed) % 4
        bg = pal[i % len(pal)]; fg = pal[(i + 1) % len(pal)]
        d.rectangle([x0, 0, x0 + bw - 1, n], fill=bg)
        u = n // 8
        for k in range(8):
            y0 = k * u
            if kind == 0:                                           # stacked chevrons
                d.polygon([(x0, y0 + u), (x0 + bw / 2, y0 + u * 0.35), (x0 + bw, y0 + u), (x0 + bw, y0 + u * 0.65), (x0 + bw / 2, y0), (x0, y0 + u * 0.65)], fill=fg)
            elif kind == 1:                                         # diamonds
                d.polygon([(x0 + bw / 2, y0 + 3), (x0 + bw - 5, y0 + u / 2), (x0 + bw / 2, y0 + u - 3), (x0 + 5, y0 + u / 2)], fill=fg)
                d.polygon([(x0 + bw / 2, y0 + u * .3), (x0 + bw * .68, y0 + u / 2), (x0 + bw / 2, y0 + u * .7), (x0 + bw * .32, y0 + u / 2)], fill=INK)
            elif kind == 2:                                         # bars
                d.rectangle([x0 + 5, y0 + u * .15, x0 + bw - 6, y0 + u * .4], fill=fg)
                d.rectangle([x0 + 5, y0 + u * .6, x0 + bw - 6, y0 + u * .85], fill=INK)
            else:                                                   # checker
                h = bw // 2
                d.rectangle([x0, y0, x0 + h - 1, y0 + u // 2 - 1], fill=fg); d.rectangle([x0 + h, y0 + u // 2, x0 + bw - 1, y0 + u - 1], fill=fg)
        d.line([(x0, 0), (x0, n)], fill=INK, width=3)
    a = np.asarray(img).astype(float) / 255
    weave = 0.92 + 0.08 * np.sin(np.arange(n) * math.pi / 2)[None, :, None] * np.sin(np.arange(n) * math.pi / 2)[:, None, None]
    a = a * weave * (0.92 + 0.12 * fnoise(n, beta=1.2, seed=seed + 9))[..., None]
    save(name, a)


def raffia(name, nrm, n=1024):
    """Round woven mat, polar: concentric coils with radial stitches and three colour rings. Not tileable."""
    yy, xx = np.mgrid[0:n, 0:n] / n - 0.5
    r = np.sqrt(xx ** 2 + yy ** 2) * 2; th = np.arctan2(yy, xx)
    coil = 0.5 + 0.5 * np.sin(r * 2 * math.pi * 46)
    stitch = 0.5 + 0.5 * np.sin(th * 150 + r * 60)
    h = coil * 0.7 + stitch * 0.3
    base = rgb((206, 170, 108)) * (0.78 + 0.26 * h + 0.1 * (fnoise(n, beta=2, seed=2) - 0.5))[..., None]
    for r0, r1, c in ((0.30, 0.335, RED), (0.60, 0.635, GREEN), (0.86, 0.90, RED), (0.905, 0.94, INK)):
        m = ((r > r0) & (r < r1))[..., None]
        base = np.where(m, rgb(c) * (0.7 + 0.35 * h)[..., None], base)
    tri = (((th * 12 / math.pi) % 2) < 1) & (r > 0.64) & (r < 0.86) & (((r - 0.64) / 0.22) < (1 - np.abs(((th * 12 / math.pi) % 2) - 0.5) * 2))
    base = np.where(tri[..., None], rgb(GOLD) * (0.72 + 0.3 * h)[..., None], base)
    base = np.where((r > 1.0)[..., None], rgb((60, 44, 30)), base)
    save(name, base, q=90)
    save(nrm, normal_from_height(h, 3.0))


def rope(name, n=128):
    yy, xx = np.mgrid[0:n, 0:n] / n
    tw = 0.5 + 0.5 * np.sin((xx * 6 + yy * 6) * 2 * math.pi)
    save(name, rgb((226, 214, 184)) * (0.72 + 0.3 * tw)[..., None])


def carved(name, nrm, base_tex, n=512):
    """Dark carved wood band: notched geometric relief on a wood base."""
    im = np.asarray(Image.open(os.path.join(OUT, base_tex + ".jpg")).convert("RGB").resize((n, n))).astype(float) / 255
    yy, xx = np.mgrid[0:n, 0:n] / n
    zig = np.abs(((xx * 12) % 1) - 0.5) * 2
    h = np.clip(1 - np.abs(((yy * 4) % 1) - (0.2 + 0.6 * zig)) * 6, 0, 1)
    save(name, im * (0.55 + 0.45 * (1 - h))[..., None] * 0.9)
    save(nrm, normal_from_height(1 - h, 6.0))


def gourd(name, n=256):
    a = fnoise(n, beta=2.4, seed=21); b = fnoise(n, beta=1.3, seed=22)
    save(name, rgb((176, 118, 58)) * (0.82 + 0.26 * a + 0.08 * (b - 0.5))[..., None])


if __name__ == "__main__":
    clay("clay", "clay_n"); clay("clay_dark", "clay_dark_n", base=(112, 70, 46))
    skin("goatskin"); skin("cowhide", patches=True, seed=31)
    textile("cloth_a", [RED, GOLD, GREEN, CREAM], seed=1); textile("cloth_b", [GOLD, GREEN, INK, RED], seed=2); textile("cloth_c", [GREEN, CREAM, RED, GOLD], seed=3)
    raffia("mat", "mat_n"); rope("rope"); carved("carved", "carved_n", "maple_dark"); gourd("gourd")
    print(sorted(os.listdir(OUT)))
