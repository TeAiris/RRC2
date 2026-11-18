"""Denoise + encode baked lightmaps: lm/lm_<G>.npy (linear float) -> lm/lm_<G>.jpg (sRGB-encoded, value = light / K)."""
import os, sys, numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
K = 4.0


def blur(a, sigma):
    r = max(1, int(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * np.roll(a, i - r, 0)
    a2 = np.zeros_like(a)
    for i, w in enumerate(k):
        a2 += w * np.roll(out, i - r, 1)
    return a2


def proc(g, sigma):
    a = np.load(os.path.join(HERE, "lm", f"lm_{g}.npy")).astype(np.float32)
    mask = (a.sum(-1) > 0).astype(np.float32)
    lum = a.mean(-1)
    st = np.stack([np.roll(np.roll(lum, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1)], 0)
    med = np.median(st, 0)
    hot = lum > (med * 2.5 + 0.02)                       # fireflies
    a[hot] *= (med[hot] / np.maximum(lum[hot], 1e-6))[:, None]
    bm = blur(mask, sigma)
    sm = np.stack([blur(a[..., c] * mask, sigma) for c in range(3)], -1) / np.maximum(bm, 1e-4)[..., None]
    out = np.where(mask[..., None] > 0, sm, 0)
    for s in (2.0, 5.0, 12.0):                            # dilate into empty texels so bilinear/mips never pull in black
        bm = blur(mask, s)
        fill = np.stack([blur(out[..., c], s) for c in range(3)], -1) / np.maximum(bm, 1e-4)[..., None]
        newm = (bm > 0.02).astype(np.float32)
        out = np.where(mask[..., None] > 0, out, np.where(newm[..., None] > 0, fill, 0))
        mask = np.maximum(mask, newm)
    v = np.clip(out / K, 0, 1)
    v = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
    Image.fromarray((v * 255 + 0.5).astype(np.uint8)).save(os.path.join(HERE, "lm", f"lm_{g}.jpg"), quality=93, subsampling=0)
    print(g, "valid", round(float((a.sum(-1) > 0).mean()), 2), "mean", round(float(out.mean()), 3))


for g, s in (("DC", 1.6),):
    if os.path.exists(os.path.join(HERE, "lm", f"lm_{g}.npy")) and (len(sys.argv) < 2 or g in sys.argv):
        proc(g, s)
