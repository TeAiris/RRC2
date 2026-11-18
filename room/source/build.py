"""Drum circle room for Rhythms Re-Connected: round earthen hall + West African ensemble kit.
Usage: python3 build.py room|kit      (same conventions as the percussion room: metres, Z up, rig hints as custom props)
Kit convention: every instrument is built at the origin with the PLAYER at -Y looking toward +Y."""
import sys, os, math, csv
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
from lib import *

WHAT = sys.argv[-1] if sys.argv[-1] in ("room", "kit") else "room"
RR, RH = 6.2, 4.0


def materials():
    M = mat
    M("clay", tex="clay", nrm="clay_n", nstr=.5, rough=.95, tile=2.2); M("clay_dark", tex="clay_dark", nrm="clay_dark_n", nstr=.6, rough=.9, tile=1.6)
    M("floor", tex="walnut_floor", nrm="planks_n", nstr=.6, rough=.5, tile=1.3); M("mat", tex="mat", nrm="mat_n", nstr=.5, rough=.95)
    M("walnut", tex="walnut", rough=.5, tile=.8); M("wood_dark", tex="maple_dark", rough=.48, tile=.8); M("rosewood", tex="rosewood", rough=.36, tile=.5)
    M("oak", tex="oak", rough=.5, tile=.7); M("carved", tex="carved", nrm="carved_n", nstr=1.0, rough=.55, tile=.22)
    for n in "abc":
        M("cloth_" + n, tex="cloth_" + n, nrm="fabric_n", nstr=.5, rough=1.0, tile=1.0)
    M("wrap_red", (.62, .09, .08), rough=.95, nrm="fabric_n", nstr=.8, tile=.05); M("wrap_gold", (.86, .62, .1), rough=.95, nrm="fabric_n", nstr=.8, tile=.05)
    M("wrap_green", (.07, .4, .2), rough=.95, nrm="fabric_n", nstr=.8, tile=.05); M("wrap_black", (.04, .04, .045), rough=.95, nrm="fabric_n", nstr=.8, tile=.05)
    M("goatskin", tex="goatskin", rough=.62); M("cowhide", tex="cowhide", rough=.7)
    M("rope", tex="rope", rough=.9, tile=.03); M("rope_dark", (.1, .09, .085), rough=.9)
    M("iron", (.16, .15, .14), rough=.5, metal=1, nrm="hammer_n", nstr=.8, tile=.12); M("brass", (.86, .67, .32), rough=.26, metal=1)
    M("gourd", tex="gourd", rough=.42, tile=.3); M("bead_red", (.7, .1, .08), rough=.3); M("bead_gold", (.9, .68, .15), rough=.3); M("bead_green", (.08, .45, .22), rough=.3); M("bead_black", (.03, .03, .035), rough=.25); M("bead_white", (.93, .92, .9), rough=.3)
    M("ceiling", (.07, .055, .045), rough=.95)
    M("lamp", (1, .9, .74), emit=(1, .84, .6), estr=9); M("led_warm", (1, .7, .3), emit=(1, .66, .26), estr=5)


def ring(b, r0, r1, z0, z1, m, seg=48, ML=None):
    b.lathe([(r0, z0), (r1, z0), (r1, z1), (r0, z1)], m, seg=seg, closed=True, ML=ML)


def head_mesh(b, Rr, m, seg=48, ML=None):
    """Hide with a folded collar: thin closed solid, playing surface at local z=0 facing +Z, polar UVs."""
    b.lathe([(0, -0.004), (Rr + 0.003, -0.004), (Rr + 0.003, -0.03), (Rr + 0.009, -0.03), (Rr + 0.009, -0.002), (Rr + 0.004, 0), (0, 0)],
            m, seg=seg, ML=ML, uvpolar=Rr + 0.012)


def interp(prof, z):
    for (r0, z0), (r1, z1) in zip(prof[:-1], prof[1:]):
        if z0 <= z <= z1 and z1 > z0:
            return r0 + (r1 - r0) * (z - z0) / (z1 - z0)
    return prof[-1][0]


# ------------------------------------------------------------------ djembe
DJ_PROF = [(0.118, 0.0), (0.123, 0.02), (0.110, 0.07), (0.086, 0.16), (0.075, 0.235), (0.079, 0.295), (0.104, 0.355), (0.140, 0.425),
           (0.161, 0.51), (0.166, 0.58), (0.161, 0.604)]


def djembe(parent, name, wrap, wood="rosewood", scale=1.0):
    root = empty(name, parent)
    root["instrument"] = name
    b = MB(name + "_Body")
    fs = b.lathe([(0, 0.0)] + DJ_PROF + [(0, 0.604)], wood, seg=48)
    mi = b._mi("carved")
    for f in fs:                                                # carved band round the stem
        if 0.105 < f.calc_center_median().z < 0.30:
            f.material_index = mi
    Rh = 0.166
    ring(b, Rh + 0.010, Rh + 0.026, 0.566, 0.59, wrap)          # crown ring
    ring(b, Rh + 0.008, Rh + 0.024, 0.538, 0.562, wrap)         # flesh ring
    ring(b, 0.094, 0.110, 0.325, 0.347, wrap)                   # waist ring
    N = 26
    zs = [0.548, 0.50, 0.44, 0.39, 0.342]
    for k in range(N * 2):                                      # rope verticals, zig-zagging crown -> waist
        a0 = math.pi * k / N; a1 = math.pi * (k + 1) / N
        pts = []
        for i, z in enumerate(zs if k % 2 == 0 else zs[::-1]):
            t = i / (len(zs) - 1)
            a = a0 + (a1 - a0) * t
            r = interp(DJ_PROF, z) + 0.007 + (0.012 if z > 0.54 else 0) + (0.004 if z < 0.35 else 0)
            pts.append((r * math.cos(a), r * math.sin(a), z))
        b.tube(pts, 0.0032, "rope", seg=4, cap=True)
    for z in (0.455, 0.47):                                     # two turns of horizontal weave
        r = interp(DJ_PROF, z) + 0.011
        ring(b, r - 0.004, r + 0.004, z - 0.004, z + 0.004, "rope_dark", seg=32)
    b.finish(root)
    b = MB(name + "_Head")
    head_mesh(b, Rh, "goatskin")
    b.finish(root, M=T(0, 0, 0.607), rig="membrane", props={"instrument": name, "radius": Rh})
    root.scale = (scale, scale, scale)
    return root


DJEMBE_FBX = os.path.join(HERE, "src", "djembe.fbx")


def djembe_model(parent, name, wrap, wood="rosewood", scale=1.0):
    """Djembe from the supplied model (djembe.fbx): shell, rope and rings get the kit's materials,
    one joined mesh per drum, plus the kit's own playing head on top (rig: membrane)."""
    root = empty(name, parent)
    root["instrument"] = name
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=DJEMBE_FBX)
    objs = [o for o in bpy.data.objects if o not in before]
    for o in objs:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    meshes = [o for o in objs if o.type == "MESH"]
    for o in objs:
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        n = o.name.lower()
        m = wood if n.startswith("body") else (wrap if any(k in n for k in ("topring", "bottomrings", "middle_ring")) else "rope")
        o.data = o.data.copy()
        o.data.materials.clear(); o.data.materials.append(MATS[m]["mat"])
        if o.data.uv_layers: o.data.uv_layers[0].name = "UVMap"
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = name + "_Body"; body.data.name = name + "_Body"
    for c in list(body.users_collection):
        c.objects.unlink(body)
    root.users_collection[0].objects.link(body)
    body.parent = root
    STATS[body.name] = len(body.data.polygons)
    b = MB(name + "_Head")
    head_mesh(b, 0.186, "goatskin")
    b.finish(root, M=T(0, 0, 0.652), rig="membrane", props={"instrument": name, "radius": 0.186})
    root.scale = (scale, scale, scale)
    return root


# ------------------------------------------------------------------ dunun (kenkeni / sangban / doundoun)
def dunun(parent, name, D, L, wrap, zc):
    """Horizontal drum on a cradle; drum axis along X, struck head at +X, bell on top."""
    root = empty(name, parent)
    root["instrument"] = name
    Rr = D / 2
    AX = T(0, 0, zc) @ RY(90)                                   # local Z -> world X
    b = MB(name + "_Body")
    prof = [(0, -L / 2), (Rr * 0.97, -L / 2), (Rr, -L / 4), (Rr * 1.01, 0), (Rr, L / 4), (Rr * 0.97, L / 2), (0, L / 2)]
    b.lathe(prof, "walnut", seg=40, ML=AX)
    for sgn in (-1, 1):
        ring(b, Rr + 0.006, Rr + 0.022, sgn * (L / 2 - 0.004) - 0.011, sgn * (L / 2 - 0.004) + 0.011, wrap, seg=40, ML=AX)
    N = 16
    for k in range(N * 2):                                      # lacing between the hoops
        a0 = math.pi * k / N; a1 = math.pi * (k + 1) / N
        x0, x1 = (-(L / 2 - 0.012), (L / 2 - 0.012)) if k % 2 == 0 else ((L / 2 - 0.012), -(L / 2 - 0.012))
        pts = []
        for i in range(5):
            t = i / 4
            a = a0 + (a1 - a0) * t; x = x0 + (x1 - x0) * t
            r = Rr * (1.01 - 0.04 * abs(2 * t - 1) ** 2) + 0.008 + (0.012 if i in (0, 4) else 0)
            pts.append((x, r * math.cos(a), zc + r * math.sin(a)))
        b.tube(pts, 0.0034, "rope", seg=4)
    # folding stand, like a tray / luggage rack: two U frames hinged where they cross (an X seen
    # from the drum's end), top rails along the drum, webbing straps slung between the rails.
    wt = Rr * 0.78                                              # top rails, either side of the drum
    zt = zc - Rr * math.sqrt(1 - 0.78 ** 2) - 0.012             # just under the shell
    wb = wt + 0.10                                              # feet, wider than the rails
    xo, xi = L * 0.42, L * 0.42 - 0.04                          # outer and inner frame
    for fx, s_ in ((xo, 1), (xi, -1)):
        for x in (-fx, fx):
            b.tube([(x, s_ * wb, 0.0), (x, -s_ * wt, zt)], 0.014, "wood_dark", seg=6)
        b.tube([(-fx - 0.02, -s_ * wt, zt), (fx + 0.02, -s_ * wt, zt)], 0.016, "wood_dark", seg=6)      # top rail
        b.tube([(-fx, s_ * wb, 0.018), (fx, s_ * wb, 0.018)], 0.014, "wood_dark", seg=6)                # foot rail
    hz = zt * (wb / (wb + wt))                                   # hinge where the legs cross
    for sg in (-1, 1):
        b.cyl((sg * (xi - 0.016), 0, hz), (sg * (xo + 0.016), 0, hz), 0.009, "iron", seg=10)
    for x in (-L * 0.28, 0.0, L * 0.28):                        # straps follow the shell between the rails
        sweep = math.asin(min(1.0, wt / (Rr + 0.006)))
        pts = []
        for i in range(13):
            t = i / 12
            th = (t * 2 - 1) * sweep                             # angle from straight down
            pts.append((x, (Rr + 0.006) * math.sin(th), zc - (Rr + 0.006) * math.cos(th)))
        pts = [(x, -wt, zt + 0.012)] + pts + [(x, wt, zt + 0.012)]
        b.tube(pts, 0.006, wrap, seg=4, phase=math.pi / 4)
    # bell mount: rope saddle
    b.box((-0.05, -0.012, zc + Rr), (0.05, 0.012, zc + Rr + 0.02), "rope_dark", bevel=0.003)
    b.finish(root)
    for tag, sgn in (("A", 1), ("B", -1)):
        b = MB(f"{name}_Head_{tag}")
        head_mesh(b, Rr, "cowhide", seg=40)
        b.finish(root, M=T(sgn * (L / 2 + 0.003), 0, zc) @ RY(90 * sgn), rig="membrane" if tag == "A" else None,
                 props={"instrument": name, "radius": Rr} if tag == "A" else None)
    # bell (kenken): folded iron, open slot underneath, widening toward the mouth
    bl = min(0.30, L * 0.62)
    b = MB(name + "_Bell")
    secs = []
    for i in range(7):
        t = i / 6
        x = -bl / 2 + bl * t
        rw = 0.022 + 0.020 * t; rh = 0.020 + 0.012 * t
        secs.append([(x, rw * math.cos(2 * math.pi * k / 12), rh * math.sin(2 * math.pi * k / 12)) for k in range(12)])
    b.loft(secs, "iron", smooth=True)
    b.finish(root, M=T(0, 0, zc + Rr + 0.045), rig="swing", props={"instrument": name + "_bell"})
    b = MB(name + "_Stick")                                      # drum stick, resting across the shell toward the struck head
    b.cyl((0, 0, 0), (0.36, 0, 0), 0.011, "oak", seg=10, r2=0.009)
    b.finish(root, M=T(L / 2 - 0.30, -Rr * 0.55, zc + Rr * 0.86) @ RZ(8), rig="mallet")
    b = MB(name + "_BellBeater")
    b.cyl((0, 0, 0), (0.16, 0, 0), 0.005, "iron", seg=8)
    b.finish(root, M=T(-0.2, Rr * 0.35, zc + Rr * 0.97) @ RZ(-20), rig="mallet")
    return root


# ------------------------------------------------------------------ shekere, stool
def stool_mesh(b, h=0.43, r=0.17, m="wood_dark"):
    b.lathe([(0, 0), (r * 0.95, 0), (r, 0.03), (r * 0.5, h * 0.42), (r * 0.46, h * 0.52), (r * 0.9, h - 0.05), (r, h - 0.035), (r, h - 0.01), (r * 0.94, h), (0, h)], m, seg=28)


def shekere(parent, name="Shekere"):
    root = empty(name, parent)
    root["instrument"] = name
    b = MB(name + "_Stand")
    stool_mesh(b, h=0.5, r=0.16)
    ring(b, 0.085, 0.105, 0.5, 0.52, "wrap_gold", seg=24)        # cloth nest the gourd sits in
    b.finish(root)
    # Gourd: round bulb, narrow neck, open mouth with a slight lip.
    prof = [(0, 0), (0.045, 0.003), (0.085, 0.022), (0.11, 0.055), (0.122, 0.095), (0.123, 0.13), (0.114, 0.168),
            (0.094, 0.2), (0.066, 0.224), (0.05, 0.242), (0.044, 0.27), (0.043, 0.31), (0.045, 0.34), (0.048, 0.352),
            (0.042, 0.354), (0.037, 0.345), (0.036, 0.31), (0, 0.31)]
    b = MB(name + "_Gourd")
    b.lathe(prof, "gourd", seg=40)
    # Bead net, as on a real shekere: a cord ring round the base of the neck, a short band of bare
    # diamond mesh under it, then the mesh carries pony beads on every cord between knots, all the
    # way down to a cord ring under the bulb. Every cord starts and ends on a knot.
    mer = prof[:9]                                               # bottom centre to neck base, along the skin
    acc = [0.0]
    for (r0, z0), (r1, z1) in zip(mer[:-1], mer[1:]):
        acc.append(acc[-1] + math.hypot(r1 - r0, z1 - z0))
    def at(sv):                                                   # arc length -> (r, z), with a normal lift
        for i in range(len(mer) - 1):
            if acc[i] <= sv <= acc[i + 1] or i == len(mer) - 2:
                t = (sv - acc[i]) / max(1e-9, acc[i + 1] - acc[i]); t = min(1, max(0, t))
                r = mer[i][0] + (mer[i + 1][0] - mer[i][0]) * t; z = mer[i][1] + (mer[i + 1][1] - mer[i][1]) * t
                dr, dz = mer[i + 1][0] - mer[i][0], mer[i + 1][1] - mer[i][1]; L = math.hypot(dr, dz) or 1
                return r + 0.004 * dz / L, z - 0.004 * dr / L
    N = 24
    s_top, s_bot = acc[-1] - 0.004, 0.035
    rows = 8
    sv = [s_top - (s_top - s_bot) * j / rows for j in range(rows + 1)]
    def node(j, k):
        a = 2 * math.pi * (k + 0.5 * (j % 2)) / N
        r, z = at(sv[j]); return a, sv[j]
    def P(a, s_):
        r, z = at(s_); return (r * math.cos(a), r * math.sin(a), z)
    BEAD_L, BEAD_R = 0.0072, 0.0056
    for j in range(rows):
        bare = j < 1                                              # bare mesh just under the neck ring
        for k in range(N):
            a0, s0 = node(j, k)
            for kk in ((k - 1, k) if j % 2 == 0 else (k, k + 1)):
                a1, s1 = node(j + 1, kk)
                fam = 0 if kk == k - (1 if j % 2 == 0 else 0) else 1   # which diagonal this cord runs on
                pts = [P(a0 + (a1 - a0) * t / 6, s0 + (s1 - s0) * t / 6) for t in range(7)]
                b.tube(pts, 0.0011, "rope", seg=4, cap=False)
                if bare:
                    continue
                seglen = sum(math.dist(pts[i], pts[i + 1]) for i in range(6))
                nb = max(1, round((seglen - 0.006) / BEAD_L))
                t_in = 0.003 / seglen
                diag = (k + j // 2 * (1 if fam else -1)) % N
                col = "bead_black" if (diag // 2 + fam) % 2 else "bead_white"
                for q in range(nb):
                    t0 = t_in + (1 - 2 * t_in) * (q + 0.06) / nb; t1 = t_in + (1 - 2 * t_in) * (q + 0.94) / nb                  # beads sit end to end along the cord
                    c0 = P(a0 + (a1 - a0) * t0, s0 + (s1 - s0) * t0); c1 = P(a0 + (a1 - a0) * t1, s0 + (s1 - s0) * t1)
                    b.cyl(c0, c1, BEAD_R, col, seg=10, caps=False)
        for k in range(N):                                        # knots
            a, s_ = node(j, k); b.sphere(P(a, s_), 0.0024, "rope", seg=5, rings=3)
    r_top, z_top = at(sv[0]); r_bot, z_bot = at(sv[-1])
    ring(b, r_top - 0.001, r_top + 0.003, z_top - 0.002, z_top + 0.002, "rope", seg=40)     # neck cord ring
    ring(b, r_bot - 0.001, r_bot + 0.003, z_bot - 0.002, z_bot + 0.002, "rope", seg=24)     # base ring
    for k in range(N):                                            # last row to the base ring
        a, s_ = node(rows, k)
        b.sphere(P(a, s_), 0.0024, "rope", seg=5, rings=3)
    b.finish(root, M=T(0, 0, 0.5), rig="shake", props={"instrument": name})
    return root


def stool(parent, name="Stool"):
    b = MB(name)
    stool_mesh(b)
    return b.finish(parent)


# ------------------------------------------------------------------ room
def build_room(root, lights):
    LM[0] = "DC"
    b = MB("Hall_Shell")
    ring(b, RR, RR + 0.25, 0.0, RH, "clay", seg=48)
    b.bm.normal_update()
    kill = [f for f in b.bm.faces if not (abs(f.normal.z) < 0.5 and Vector((f.calc_center_median().x, f.calc_center_median().y, 0)).dot(f.normal) < 0)]
    bmesh.ops.delete(b.bm, geom=kill, context="FACES")           # keep the interior skin only
    b.lathe([(RR + 0.2, 0.0), (0, 0.0)], "floor", seg=48, smooth=False)
    b.finish(root)
    b = MB("Hall_Ceiling")
    b.lathe([(0, RH), (RR + 0.2, RH)], "ceiling", seg=48, smooth=False)
    b.finish(root)

    b = MB("Hall_Mat")                                           # round woven mat the circle sits on
    b.lathe([(0, 0.0), (3.55, 0.0), (3.55, 0.012), (3.5, 0.016), (0, 0.016)], "mat", seg=64, uvpolar=3.55)
    b.finish(root)

    b = MB("Hall_Treatment")
    ring(b, RR - 0.05, RR + 0.02, 0.0, 0.62, "clay_dark", seg=48)                       # plinth band
    ring(b, RR - 0.07, RR + 0.02, 0.62, 0.68, "wood_dark", seg=48)
    ring(b, RR - 0.09, RR + 0.02, 3.28, 3.36, "wood_dark", seg=48)                      # cove shelf
    ring(b, RR - 0.075, RR - 0.045, 3.36, 3.375, "led_warm", seg=48)                    # warm light cove
    cloth = ("cloth_a", "cloth_b", "cloth_c")
    for k in range(12):
        with b.frame(RZ(30 * k)):                                # posts
            b.box((RR - 0.19, -0.085, 0.0), (RR - 0.02, 0.085, RH), "walnut", bevel=0.012)
            b.box((RR - 0.22, -0.11, 0.0), (RR - 0.02, 0.11, 0.14), "wood_dark", bevel=0.01)
            b.box((RR - 0.22, -0.11, 3.22), (RR - 0.02, 0.11, 3.36), "wood_dark", bevel=0.01)
        with b.frame(RZ(30 * k + 15)):                           # hanging cloths between the posts
            rp = RR * math.cos(math.radians(15)) - 0.03
            b.box((rp - 0.03, -1.05, 0.95), (rp, 1.05, 2.95), cloth[k % 3], bevel=0.006)
            b.cyl((rp - 0.045, -1.14, 2.99), (rp - 0.045, 1.14, 2.99), 0.02, "wood_dark", seg=10)
    b.finish(root)

    b = MB("Hall_Beams")
    for k in range(12):
        with b.frame(RZ(30 * k)):
            b.box((1.05, -0.07, RH - 0.24), (RR - 0.02, 0.07, RH - 0.02), "walnut", bevel=0.008)
    ring(b, 0.95, 1.13, RH - 0.30, RH - 0.02, "wood_dark", seg=40)
    b.finish(root)
    b = MB("Hall_Lamp")                                          # woven shade with a warm disc
    ring(b, 0.78, 0.84, 3.32, 3.62, "mat", seg=40)
    b.lathe([(0.78, 3.36), (0, 3.36)], "lamp", seg=40, smooth=False)
    b.lathe([(0, 3.6), (0.84, 3.6)], "wood_dark", seg=40, smooth=False)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        b.cyl((0.8 * math.cos(a), 0.8 * math.sin(a), 3.6), (0.8 * math.cos(a), 0.8 * math.sin(a), RH - 0.02), 0.006, "rope_dark", seg=6)
    b.finish(root)

    b = MB("Globe_Plinth")                                       # carved drum-like plinth under the globe
    b.lathe([(0, 0.016), (0.52, 0.016), (0.55, 0.05), (0.46, 0.13), (0.42, 0.26), (0.47, 0.37), (0.56, 0.42), (0.56, 0.46), (0.5, 0.47), (0, 0.47)], "carved", seg=48)
    ring(b, 0.5, 0.57, 0.455, 0.475, "brass", seg=48)
    b.finish(root)

    light("L_Lamp", "POINT", (0, 0, 3.2), 1500, color=(1, .86, .66), parent=lights, size=0.5)
    for k in range(6):
        a = math.radians(60 * k + 30)
        light(f"L_Fill_{k}", "POINT", (4.2 * math.cos(a), 4.2 * math.sin(a), 3.0), 260, color=(1, .8, .58), parent=lights, size=0.35)


materials()
if WHAT == "room":
    root = empty("DrumCircleRoom"); lights = empty("Lights", root)
    build_room(empty("Architecture", root), lights)
else:
    LM[0] = None
    root = empty("EnsembleKit")
    djembe_model(root, "Djembe", "wrap_red")
    djembe_model(root, "DjembeLead", "wrap_gold", wood="walnut", scale=1.06)
    dunun(root, "Kenkeni", 0.25, 0.40, "wrap_green", zc=0.70)
    dunun(root, "Sangban", 0.31, 0.50, "wrap_gold", zc=0.68)
    dunun(root, "Doundoun", 0.39, 0.62, "wrap_red", zc=0.66)
    shekere(root)
    stool(root)

print("TOTAL TRIANGLES", sum(STATS.values()), "objects", len(STATS), "materials", len(MATS))
rig = [o for o in bpy.data.objects if o.type == "MESH" and "rig" in o.keys()]
bad = [o.name for o in rig if NM.get(o.name, 0)]
print("rig parts:", len(rig), "| not watertight:", len(bad), bad)
print("other meshes with open edges:", {k: v for k, v in NM.items() if v and k not in bad})
out = os.path.join(HERE, "out")
if WHAT == "kit":
    with open(os.path.join(out, "EnsembleKit_rig_parts.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["object", "parent", "rig_hint", "instrument", "watertight", "faces"])
        for o in sorted(rig, key=lambda o: o.name):
            w.writerow([o.name, o.parent.name if o.parent else "", o["rig"], o.get("instrument", ""), int(NM.get(o.name, 0) == 0), len(o.data.polygons)])
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, "EnsembleKit.glb"), export_format="GLB", export_cameras=False, export_apply=False, export_yup=True,
                              export_image_format="JPEG", export_jpeg_quality=85, export_texcoords=True, export_normals=True, export_extras=True, export_lights=False)
    print("EnsembleKit.glb", round(os.path.getsize(os.path.join(out, "EnsembleKit.glb")) / 1e6, 2), "MB")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, WHAT + ".blend"))
