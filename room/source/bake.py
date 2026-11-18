"""Lightmap UVs (TEXCOORD_1), per-room atlas packing, and Cycles lightmap baking.
Usage: python3 bake.py [GROUPS...]   env: SPP, RES_<GROUP>"""
import sys, os, math, time
HERE = os.path.dirname(os.path.abspath(__file__))
import bpy, bmesh
import numpy as np
SRC = os.path.join(HERE, "room_baked.blend" if os.path.exists(os.path.join(HERE, "room_baked.blend")) and "--fresh" not in sys.argv else "room.blend")
bpy.ops.wm.open_mainfile(filepath=SRC)
sc = bpy.context.scene
vl = bpy.context.view_layer
RES = {"DC": int(os.environ.get("RES_DC", 2048))}
groups = {}
for ob in bpy.data.objects:
    if ob.type == "MESH" and "lm" in ob.keys():
        groups.setdefault(ob["lm"], []).append(ob)


def make_uvs():
    for g, obs in groups.items():
        res = RES[g]
        areas = []
        for ob in obs:
            me = ob.data
            lm = me.uv_layers.new(name="Lightmap")
            me.uv_layers.active = lm
            for o in bpy.data.objects:
                o.select_set(False)
            ob.select_set(True); vl.objects.active = ob
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0025 if len(me.polygons) > 400 else 0.008)
            bpy.ops.object.mode_set(mode="OBJECT")
            areas.append(max(sum(p.area for p in me.polygons), 1e-4))
        side = np.sqrt(np.array(areas))
        order = np.argsort(-side)
        minside = 20 / res

        def pack(s):
            x = y = rowh = 0.0
            cells = {}
            for i in order:
                d = max(side[i] * s, minside)
                if x + d > 1.0:
                    x = 0.0; y += rowh; rowh = 0.0
                cells[i] = (x, y, d)
                x += d; rowh = max(rowh, d)
            return cells, y + rowh
        lo, hi = 1e-4, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if pack(mid)[1] <= 1.0:
                lo = mid
            else:
                hi = mid
        cells, _ = pack(lo)
        pad = 2.5 / res
        for i, ob in enumerate(obs):
            x, y, d = cells[i]
            me = ob.data
            uv = me.uv_layers["Lightmap"].data
            arr = np.zeros(len(uv) * 2, dtype=np.float32); uv.foreach_get("uv", arr)
            arr = arr.reshape(-1, 2)
            arr[:, 0] = x + pad + np.clip(arr[:, 0], 0, 1) * (d - 2 * pad)
            arr[:, 1] = y + pad + np.clip(arr[:, 1], 0, 1) * (d - 2 * pad)
            uv.foreach_set("uv", arr.ravel())
            me.uv_layers.active = me.uv_layers["UVMap"]; me.uv_layers["UVMap"].active_render = True
        print(f"group {g}: {len(obs)} objects, {sum(areas):.0f} m2, texel density ~{lo * res:.0f} px/m")


def bake(g):
    res = RES[g]
    sc.render.engine = "CYCLES"
    c = sc.cycles
    c.samples = int(os.environ.get("SPP", 48)); c.max_bounces = 4; c.diffuse_bounces = 3; c.glossy_bounces = 2; c.transmission_bounces = 4
    c.transparent_max_bounces = 6; c.sample_clamp_indirect = 8; c.caustics_reflective = False; c.caustics_refractive = False
    c.use_adaptive_sampling = False
    try:
        c.use_denoising = True
    except Exception:
        pass
    sc.render.threads_mode = "FIXED"; sc.render.threads = 2
    img = bpy.data.images.new("LM_" + g, res, res, float_buffer=True, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        n = m.node_tree.nodes.get("BAKE") or m.node_tree.nodes.new("ShaderNodeTexImage")
        n.name = "BAKE"; n.image = img
        for k in m.node_tree.nodes:
            k.select = False
        n.select = True; m.node_tree.nodes.active = n
    for o in bpy.data.objects:
        o.select_set(False)
    for ob in groups[g]:
        ob.data.uv_layers.active = ob.data.uv_layers["Lightmap"]
        ob.select_set(True)
    vl.objects.active = groups[g][0]
    t = time.time()
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=8, use_clear=True)
    for ob in groups[g]:
        ob.data.uv_layers.active = ob.data.uv_layers["UVMap"]
    px = np.zeros(res * res * 4, dtype=np.float32); img.pixels.foreach_get(px)
    px = px.reshape(res, res, 4)[::-1, :, :3]
    np.save(os.path.join(HERE, "lm", f"lm_{g}.npy"), px.astype(np.float16))
    print(f"BAKED {g} in {time.time() - t:.0f}s  mean {px.mean():.3f}  p99 {np.percentile(px, 99):.2f}  max {px.max():.1f}", flush=True)


os.makedirs(os.path.join(HERE, "lm"), exist_ok=True)
if "Lightmap" not in groups["DC"][0].data.uv_layers:
    make_uvs()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "room_baked.blend"))
for g in [a for a in sys.argv[1:] if a in RES]:
    bake(g)
