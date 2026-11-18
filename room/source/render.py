"""Quick preview renders (Cycles, low spp). Usage: python3 render.py kit|room"""
import sys, os, math, time
HERE = os.path.dirname(os.path.abspath(__file__))
import bpy
from mathutils import Vector
what = sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=os.path.join(HERE, what + ".blend"))
sc = bpy.context.scene
sc.render.engine = "CYCLES"; sc.cycles.samples = int(os.environ.get("SPP", 24)); sc.cycles.use_denoising = True
sc.render.threads_mode = "FIXED"; sc.render.threads = 2
sc.render.resolution_x, sc.render.resolution_y = 1100, 620
def cam(name, pos, tgt, lens=28):
    cd = bpy.data.cameras.new(name); cd.lens = lens
    c = bpy.data.objects.new(name, cd); sc.collection.objects.link(c)
    c.location = pos; c.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
    sc.camera = c
    sc.render.filepath = os.path.join(HERE, "renders", name + ".png")
    t = time.time(); bpy.ops.render.render(write_still=True); print("RENDERED", name, round(time.time() - t), "s")
if what == "kit":
    xs = {"Djembe": -1.6, "DjembeLead": -0.95, "Kenkeni": -0.1, "Sangban": 0.85, "Doundoun": 1.95, "Shekere": 2.85, "Stool": 3.4}
    for o in bpy.data.objects:
        if o.parent and o.parent.name == "EnsembleKit" and o.name in xs: o.location.x = xs[o.name]
    w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (.5, .45, .4, 1); w.node_tree.nodes["Background"].inputs[1].default_value = 1.2
    ld = bpy.data.lights.new("k", "AREA"); ld.energy = 500; ld.size = 3
    lo = bpy.data.objects.new("k", ld); sc.collection.objects.link(lo); lo.location = (0.5, -3, 3.5); lo.rotation_euler = (math.radians(40), 0, 0)
    bpy.ops.mesh.primitive_plane_add(size=30)
    cam("kit", (0.7, -3.4, 1.7), (0.8, 0, 0.45), 30)
else:
    cam("room", (0, -5.6, 1.7), (0, 0.5, 1.3), 18)
