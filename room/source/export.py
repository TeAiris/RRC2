"""Export the baked hall as a lean GLB for the web (lightmap UVs in TEXCOORD_1; lightmap shipped as a separate JPG)."""
import os, bpy
HERE = os.path.dirname(os.path.abspath(__file__))
src = "room_baked.blend" if os.path.exists(os.path.join(HERE, "room_baked.blend")) else "room.blend"
bpy.ops.wm.open_mainfile(filepath=os.path.join(HERE, src))
for m in bpy.data.materials:
    if m.node_tree and m.node_tree.nodes.get("BAKE"):
        m.node_tree.nodes.remove(m.node_tree.nodes["BAKE"])
out = os.path.join(HERE, "out")
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "DrumCircleRoom.glb"), export_format="GLB", export_cameras=False, export_apply=False, export_yup=True,
                          export_image_format="JPEG", export_jpeg_quality=85, export_texcoords=True, export_normals=True, export_extras=True, export_lights=False)
print(src, "DrumCircleRoom.glb", round(os.path.getsize(os.path.join(out, "DrumCircleRoom.glb")) / 1e6, 2), "MB")
