"""Mesh-builder + material helpers on top of bpy/bmesh (v2: rig-friendly objects, instances, lightmap groups)."""
import bpy, bmesh, math, os, zlib, random
from contextlib import contextmanager
from mathutils import Matrix, Vector

TEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tex")
MATS = {}
STATS = {}
NM = {}          # object -> count of non-manifold / boundary edges
R = math.radians
LM = [None]          # current lightmap group for newly finished static objects
I4 = Matrix.Identity(4)


def lin(c):
    return tuple(((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c)


def _img(name, noncolor=False):
    key = name + ("_nc" if noncolor else "")
    if key in bpy.data.images:
        return bpy.data.images[key]
    im = bpy.data.images.load(os.path.join(TEX, name + ".jpg"))
    im.name = key
    if noncolor:
        im.colorspace_settings.name = "Non-Color"
    return im


def mat(name, color=(.8, .8, .8), rough=0.6, metal=0.0, tex=None, nrm=None, nstr=1.0, emit=None, emit_tex=None,
        estr=1.0, alpha=1.0, double=False, tile=1.0):
    """color / emit are sRGB 0..1."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*lin(color), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    uvn = nt.nodes.new("ShaderNodeUVMap"); uvn.uv_map = "UVMap"

    def teximg(nm, nc=False):
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = _img(nm, nc)
        nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
        return t
    if tex:
        nt.links.new(teximg(tex).outputs["Color"], b.inputs["Base Color"])
    if nrm:
        n = nt.nodes.new("ShaderNodeNormalMap"); n.inputs["Strength"].default_value = nstr; n.uv_map = "UVMap"
        nt.links.new(teximg(nrm, True).outputs["Color"], n.inputs["Color"])
        nt.links.new(n.outputs["Normal"], b.inputs["Normal"])
    if emit or emit_tex:
        b.inputs["Emission Strength"].default_value = estr
        b.inputs["Emission Color"].default_value = (*lin(emit or (1, 1, 1)), 1)
        if emit_tex:
            nt.links.new(teximg(emit_tex).outputs["Color"], b.inputs["Emission Color"])
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    m.use_backface_culling = not double
    MATS[name] = dict(mat=m, tile=tile)
    return m


def T(x, y, z):
    return Matrix.Translation((x, y, z))


def RZ(a): return Matrix.Rotation(R(a), 4, "Z")
def RX(a): return Matrix.Rotation(R(a), 4, "X")
def RY(a): return Matrix.Rotation(R(a), 4, "Y")


def align_z(d):
    """Rotation matrix taking +Z to direction d."""
    return Vector((0, 0, 1)).rotation_difference(Vector(d).normalized()).to_matrix().to_4x4()


def chaikin(pts, it=1, closed=True):
    for _ in range(it):
        out = []
        n = len(pts)
        for i in range(n if closed else n - 1):
            a, b = Vector(pts[i]), Vector(pts[(i + 1) % n])
            out += [tuple(a * .75 + b * .25), tuple(a * .25 + b * .75)]
        if not closed:
            out = [tuple(pts[0])] + out + [tuple(pts[-1])]
        pts = out
    return pts


def offset_poly(pts, d):
    """Inset (d>0) a CCW polygon."""
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
        e1, e2 = (p1 - p0), (p2 - p1)
        n1 = Vector((-e1.y, e1.x)).normalized() if e1.length > 1e-9 else Vector((0, 0))
        n2 = Vector((-e2.y, e2.x)).normalized() if e2.length > 1e-9 else n1
        nn = n1 + n2
        if nn.length < 1e-6:
            nn = n1
        nn.normalize()
        k = max(0.5, nn.dot(n1))
        out.append(tuple(p1 + nn * d / k))
    return out


def catmull(pts, per=6):
    pts = [Vector(p) for p in pts]
    P = [pts[0]] + pts + [pts[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(per):
            t = k / per
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(pts[-1])
    return out


class MB:
    """Accumulates primitives into one mesh, in the object's local frame (metres, Z up)."""

    def __init__(s, name):
        s.name = name
        s.bm = bmesh.new()
        s.mats = []
        s.stack = [Matrix.Identity(4)]
        s.uvl = s.bm.loops.layers.uv.new("UVMap")
        s.fm = s.bm.faces.layers.int.new("uvmode")
        rr = random.Random(zlib.crc32(name.encode()))
        s.uvoff = (rr.random(), rr.random())
        s.rnd = rr

    @property
    def M(s):
        return s.stack[-1]

    @contextmanager
    def at(s, pos=(0, 0, 0), rz=0, rx=0, ry=0):
        s.stack.append(s.M @ T(*pos) @ RZ(rz) @ RY(ry) @ RX(rx))
        try:
            yield
        finally:
            s.stack.pop()

    @contextmanager
    def frame(s, M):
        s.stack.append(s.M @ M)
        try:
            yield
        finally:
            s.stack.pop()

    def _mi(s, m):
        if m not in s.mats:
            assert m in MATS, m
            s.mats.append(m)
        return s.mats.index(m)

    def _fin(s, verts, m, smooth=None, uvmode=0):
        verts = [v for v in verts if v.is_valid]
        faces = set(f for v in verts for f in v.link_faces)
        mi = s._mi(m)
        for f in faces:
            f.material_index = mi
            if uvmode != -1:
                f[s.fm] = uvmode
            if smooth is not None:
                f.smooth = smooth(f) if callable(smooth) else smooth
        bmesh.ops.transform(s.bm, matrix=s.M, verts=verts)
        return faces

    # ---------- primitives
    def box(s, lo, hi, m, bevel=0, uvmode=0, skip="", seg=1):
        lo, hi = Vector(lo), Vector(hi)
        c, sz = (lo + hi) / 2, hi - lo
        r = bmesh.ops.create_cube(s.bm, size=1, matrix=T(*c) @ Matrix.Diagonal((*[abs(v) for v in sz], 1)))
        verts = r["verts"]
        if skip:
            dirs = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0), "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}
            want = [Vector(dirs[k]) for k in skip.split(",")]
            s.bm.normal_update()
            fs = set(f for v in verts for f in v.link_faces)
            kill = [f for f in fs if any(f.normal.dot(w) > 0.9 for w in want)]
            bmesh.ops.delete(s.bm, geom=kill, context="FACES_ONLY")
        if bevel:
            edges = list(set(e for v in verts for e in v.link_edges))
            rb = bmesh.ops.bevel(s.bm, geom=edges, offset=min(bevel, min(abs(v) for v in sz) * 0.45), segments=seg, affect="EDGES", profile=0.5, clamp_overlap=True)
            verts = list(set(list(verts) + rb["verts"]))
            if seg > 1:
                newf = set(rb["faces"])
                return s._fin(verts, m, lambda f: f in newf, uvmode)
        return s._fin(verts, m, False, uvmode)

    def boxc(s, c, size, m, **k):
        c, h = Vector(c), Vector(size) / 2
        return s.box(c - h, c + h, m, **k)

    def cyl(s, p0, p1, r, m, seg=12, r2=None, caps=True, uvmode=0):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        res = bmesh.ops.create_cone(s.bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r,
                                    radius2=r if r2 is None else r2, depth=d.length,
                                    matrix=Matrix.Translation((p0 + p1) / 2) @ align_z(d))
        return s._fin(res["verts"], m, lambda f: len(f.verts) == 4 and seg > 4, uvmode)

    def pipe(s, pts, r, m, seg=8):
        for a, b in zip(pts[:-1], pts[1:]):
            s.cyl(a, b, r, m, seg=seg)

    def tube(s, pts, r, m, seg=5, cap=True, phase=0.0):
        """Smooth swept tube through points (parallel-transport frame)."""
        pts = [Vector(p) for p in pts]
        rings = []
        up = Vector((0, 0, 1))
        prev_n = None
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            n = prev_n - t * prev_n.dot(t) if prev_n is not None else up.cross(t)
            if n.length < 1e-5:
                n = Vector((1, 0, 0)).cross(t)
            n.normalize(); prev_n = n
            bnm = t.cross(n)
            rings.append([s.bm.verts.new(p + (n * math.cos(2 * math.pi * k / seg + phase) + bnm * math.sin(2 * math.pi * k / seg + phase)) * r) for k in range(seg)])
        for a, b in zip(rings[:-1], rings[1:]):
            for k in range(seg):
                j = (k + 1) % seg
                s.bm.faces.new((a[k], a[j], b[j], b[k]))
        if cap:
            s.bm.faces.new(rings[0][::-1]); s.bm.faces.new(rings[-1])
        return s._fin([v for rg in rings for v in rg], m, lambda f: len(f.verts) == 4)

    def sphere(s, c, r, m, seg=12, rings=8, scale=(1, 1, 1)):
        res = bmesh.ops.create_uvsphere(s.bm, u_segments=seg, v_segments=rings, radius=r,
                                        matrix=T(*c) @ Matrix.Diagonal((*scale, 1)))
        return s._fin(res["verts"], m, True)

    def lathe(s, prof, m, seg=16, ML=None, smooth=True, uvmode=0, uvpolar=None, closed=False):
        """prof: list of (r, z); revolved about local Z. Order bottom-centre -> out -> up -> in for outward normals."""
        ML = ML or Matrix.Identity(4)
        rings, loc = [], {}
        for r, z in prof:
            if r < 1e-6:
                v = s.bm.verts.new(ML @ Vector((0, 0, z))); loc[v] = (0.0, 0.0); rings.append([v])
            else:
                rg = []
                for i in range(seg):
                    x, y = r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg)
                    v = s.bm.verts.new(ML @ Vector((x, y, z))); loc[v] = (x, y); rg.append(v)
                rings.append(rg)
        faces = []
        pairs = list(zip(rings[:-1], rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
        for a, b in pairs:
            for i in range(seg):
                j = (i + 1) % seg
                if len(a) == 1 and len(b) == 1:
                    continue
                if len(a) == 1:
                    faces.append(s.bm.faces.new((a[0], b[j], b[i])))
                elif len(b) == 1:
                    faces.append(s.bm.faces.new((a[i], a[j], b[0])))
                else:
                    faces.append(s.bm.faces.new((a[i], a[j], b[j], b[i])))
        if uvpolar:
            for f in faces:
                for l in f.loops:
                    x, y = loc[l.vert]
                    l[s.uvl].uv = (0.5 + x / (2 * uvpolar), 0.5 + y / (2 * uvpolar))
            uvmode = 1
        return s._fin([v for rg in rings for v in rg], m, smooth, uvmode)

    def extrude(s, outline, z0, z1, m, ML=None, caps=True, smooth=False, uvmode=0):
        """outline: CCW (x, y) list, prism from z0 to z1 in local frame ML."""
        ML = ML or Matrix.Identity(4)
        bot = [s.bm.verts.new(ML @ Vector((x, y, z0))) for x, y in outline]
        top = [s.bm.verts.new(ML @ Vector((x, y, z1))) for x, y in outline]
        n = len(outline)
        side = []
        for i in range(n):
            j = (i + 1) % n
            side.append(s.bm.faces.new((bot[i], bot[j], top[j], top[i])))
        if caps:
            s.bm.faces.new(top)
            s.bm.faces.new(bot[::-1])
        sset = set(side)
        return s._fin(bot + top, m, (lambda f: f in sset) if smooth else False, uvmode)

    def extrude_round(s, outline, z0, z1, m, r=0.006, ML=None, uvmode=0, cap_m=None):
        """Prism with chamfered/rounded top and bottom rims (smooth-shaded sides)."""
        ML = ML or Matrix.Identity(4)
        ins = offset_poly(outline, r)
        layers = [(ins, z0), (outline, z0 + r), (outline, z1 - r), (ins, z1)]
        rings = [[s.bm.verts.new(ML @ Vector((x, y, z))) for x, y in o] for o, z in layers]
        n = len(outline)
        side = set()
        for a, b in zip(rings[:-1], rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                side.add(s.bm.faces.new((a[i], a[j], b[j], b[i])))
        top = s.bm.faces.new(rings[-1]); bot = s.bm.faces.new(rings[0][::-1])
        fs = s._fin([v for rg in rings for v in rg], m, lambda f: f in side, uvmode)
        if cap_m:
            top.material_index = s._mi(cap_m)
        return fs

    def loft(s, sections, m, smooth=False, uvmode=0):
        """Closed solid through a list of rings (same vertex count each); all quads plus two end caps."""
        rings = [[s.bm.verts.new(Vector(p)) for p in sec] for sec in sections]
        n = len(rings[0])
        fs = []
        for a, b in zip(rings[:-1], rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                fs.append(s.bm.faces.new((a[i], a[j], b[j], b[i])))
        fs.append(s.bm.faces.new(rings[0][::-1])); fs.append(s.bm.faces.new(rings[-1]))
        bmesh.ops.recalc_face_normals(s.bm, faces=fs)
        return s._fin([v for rg in rings for v in rg], m, smooth, uvmode)

    def extrude_x(s, prof_yz, x0, x1, m, **k):
        ML = Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        return s.extrude(prof_yz, x0, x1, m, ML=ML, **k)

    def quad(s, pts, m, uvs=((0, 0), (1, 0), (1, 1), (0, 1))):
        vs = [s.bm.verts.new(Vector(p)) for p in pts]
        f = s.bm.faces.new(vs)
        for l, uv in zip(f.loops, uvs):
            l[s.uvl].uv = uv
        s._fin(vs, m, False, -1)
        f[s.fm] = 1
        return f

    # ---------- finish
    def finish(s, parent=None, origin=None, rot_z=0, sharp=38, loc=None, M=None, lm="auto", rig=None, props=None):
        bm = s.bm
        bm.normal_update()
        for f in bm.faces:
            mode = f[s.fm]
            if mode == 1:
                continue
            tile = MATS[s.mats[f.material_index]]["tile"]
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for l in f.loops:
                p = l.vert.co
                uv = (p.x, p.y) if ax == 2 else ((p.y, p.z) if ax == 0 else (p.x, p.z))
                if mode == 2:
                    uv = (uv[1], uv[0])
                l[s.uvl].uv = (uv[0] / tile + s.uvoff[0], uv[1] / tile + s.uvoff[1])
        o = Vector(origin) if origin is not None else Vector((0, 0, 0))
        if origin is not None:
            bmesh.ops.translate(bm, vec=-o, verts=bm.verts)
        nm = sum(1 for e in bm.edges if len(e.link_faces) != 2)
        me = bpy.data.meshes.new(s.name)
        bm.to_mesh(me)
        ntri = sum(len(f.verts) - 2 for f in bm.faces)
        bm.free()
        for m in s.mats:
            me.materials.append(MATS[m]["mat"])
        if hasattr(me, "set_sharp_from_angle"):
            me.set_sharp_from_angle(angle=R(sharp))
        ob = bpy.data.objects.new(s.name, me)
        bpy.context.scene.collection.objects.link(ob)
        if parent:
            ob.parent = parent
        if M is not None:
            ob.matrix_basis = M
        else:
            ob.location = Vector(loc) if loc is not None else o
            ob.rotation_euler = (0, 0, R(rot_z))
        grp = LM[0] if lm == "auto" else lm
        if grp:
            ob["lm"] = grp
        if rig:
            ob["rig"] = rig
        for k, v in (props or {}).items():
            ob[k] = v
        STATS[ob.name] = ntri
        NM[ob.name] = nm
        ob["closed"] = int(nm == 0)
        return ob


def inst(name, src, parent, M, rig=None):
    """Instance: new object sharing src's mesh (no lightmap; meant for moving parts)."""
    ob = bpy.data.objects.new(name, src.data)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.matrix_basis = M
    if rig:
        ob["rig"] = rig
    STATS[ob.name] = STATS.get(src.name, 0)
    return ob


def empty(name, parent=None, M=None):
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    ob.empty_display_size = 0.3
    if parent:
        ob.parent = parent
    if M is not None:
        ob.matrix_basis = M
    return ob


def light(name, kind, loc, power, color=(1, .84, .66), parent=None, size=0.1, cone=110, rot=(0, 0, 0)):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = power
    ld.color = lin(color)
    if kind == "SPOT":
        ld.spot_size = R(cone); ld.spot_blend = 0.6
    if kind == "AREA":
        ld.size = size
    else:
        ld.shadow_soft_size = size
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = [R(a) for a in rot]
    if parent:
        ob.parent = parent
    return ob
