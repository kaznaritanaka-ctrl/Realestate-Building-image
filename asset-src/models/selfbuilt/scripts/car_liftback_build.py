import bpy, math, sys
from mathutils import Vector

ASSET = "/home/hatch/workspace/repo-realestate/asset-src"
OUT_PREVIEW = "/home/hatch/workspace/your_files/car_liftback_v2_preview.png"
OUT_GLB = "/home/hatch/workspace/your_files/car_liftback_v2.glb"
PLATE_TEX = "/home/hatch/workspace/car_assets/plate_white.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

CAR_OBJS = []

# ---------------- materials ----------------
def mat_principled(name, color, rough=0.5, metallic=0.0, coat=0.0, coat_rough=0.25,
                   emission=None, emission_strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metallic
    if "Coat Weight" in b.inputs:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = coat_rough
    if emission is not None:
        b.inputs["Emission Color"].default_value = (*emission, 1.0)
        b.inputs["Emission Strength"].default_value = emission_strength
    return m

MAT_PAINT = mat_principled("paint_pearlwhite", (0.92, 0.93, 0.94), rough=0.34, metallic=0.45, coat=0.7, coat_rough=0.22)
MAT_GLASS = mat_principled("glass_dark", (0.045, 0.06, 0.075), rough=0.06, metallic=0.9)
MAT_BLACK = mat_principled("trim_black", (0.015, 0.015, 0.017), rough=0.62, metallic=0.1)
MAT_TIRE  = mat_principled("tire", (0.008, 0.008, 0.009), rough=0.90, metallic=0.0)
MAT_RIM   = mat_principled("rim_silver", (0.55, 0.56, 0.58), rough=0.35, metallic=0.85)
MAT_RIMD  = mat_principled("rim_dark", (0.05, 0.05, 0.055), rough=0.5, metallic=0.6)
MAT_HEAD  = mat_principled("headlight", (0.86, 0.92, 1.0), rough=0.10, metallic=0.15,
                           emission=(0.50, 0.62, 0.80), emission_strength=0.30)
MAT_DRL   = mat_principled("drl", (0.95, 0.98, 1.0), rough=0.25, metallic=0.1,
                           emission=(0.85, 0.92, 1.0), emission_strength=1.2)
MAT_REFL  = mat_principled("reflector", (0.93, 0.94, 0.96), rough=0.15, metallic=1.0)
MAT_TAIL  = mat_principled("taillight", (0.45, 0.015, 0.02), rough=0.22, metallic=0.2,
                           emission=(0.80, 0.02, 0.03), emission_strength=0.9)
MAT_LINER = mat_principled("wheelhouse", (0.004, 0.004, 0.005), rough=1.0, metallic=0.0)

# ---------------- body loft ----------------
# stations: y, halfW, zBot, zSide, zBelt, glassW, roofEdgeW, zRoof   (front = -Y)
STATIONS = [
    (-2.30, 0.760, 0.320, 0.460, 0.600, 0.580, 0.420, 0.640),
    (-2.15, 0.840, 0.200, 0.500, 0.700, 0.660, 0.500, 0.720),
    (-1.85, 0.875, 0.155, 0.540, 0.790, 0.710, 0.550, 0.790),
    (-1.45, 0.880, 0.145, 0.550, 0.870, 0.735, 0.565, 0.850),
    (-1.00, 0.880, 0.140, 0.550, 0.925, 0.755, 0.585, 1.100),
    (-0.55, 0.880, 0.140, 0.550, 0.955, 0.765, 0.600, 1.335),
    (-0.18, 0.880, 0.140, 0.550, 0.965, 0.770, 0.605, 1.420),
    ( 0.25, 0.880, 0.140, 0.550, 0.970, 0.770, 0.605, 1.415),
    ( 0.70, 0.880, 0.140, 0.550, 0.970, 0.765, 0.600, 1.385),
    ( 1.15, 0.875, 0.145, 0.550, 0.975, 0.755, 0.585, 1.345),
    ( 1.60, 0.865, 0.150, 0.550, 0.985, 0.740, 0.565, 1.255),
    ( 1.95, 0.855, 0.165, 0.550, 0.990, 0.715, 0.535, 1.155),
    ( 2.20, 0.835, 0.200, 0.550, 0.975, 0.680, 0.500, 1.090),
    ( 2.30, 0.800, 0.300, 0.540, 0.950, 0.640, 0.460, 1.050),
]
NP = 7  # params after y

def cr(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)

def params_at(y):
    ys = [s[0] for s in STATIONS]
    if y <= ys[0]:
        return STATIONS[0][1:]
    if y >= ys[-1]:
        return STATIONS[-1][1:]
    i = 0
    while ys[i + 1] < y:
        i += 1
    s0 = STATIONS[max(i - 1, 0)][1:]
    s1 = STATIONS[i][1:]
    s2 = STATIONS[i + 1][1:]
    s3 = STATIONS[min(i + 2, len(STATIONS) - 1)][1:]
    t = (y - ys[i]) / (ys[i + 1] - ys[i])
    out = []
    for k in range(NP):
        v = cr(s0[k], s1[k], s2[k], s3[k], t)
        out.append(v)
    # clamps against spline overshoot
    out[0] = min(out[0], 0.885)          # halfW
    out[6] = min(max(out[6], 0.60), 1.428)  # zRoof
    return tuple(out)

def ring_points(y):
    halfW, zBot, zSide, zBelt, glassW, roofEdgeW, zRoof = params_at(y)
    right = [
        (0.0, zRoof),
        (0.30, zRoof - 0.012),
        (roofEdgeW, zRoof - 0.060),
        (glassW, zBelt + 0.070),
        (halfW - 0.02, zBelt),
        (halfW, zSide),
        (halfW - 0.05, zBot + 0.050),
        (0.52, zBot + 0.010),
        (0.0, zBot),
    ]
    left = [(-x, z) for (x, z) in reversed(right[1:-1])]
    ring = right + left
    return [(x, y, z) for (x, z) in ring]

def build_loft(name, y_samples, ring_fn, mat, cap_front=True, cap_back=True):
    rings = [ring_fn(y) for y in y_samples]
    n = len(rings[0])
    verts = [v for ring in rings for v in ring]
    faces = []
    for r in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append((r * n + i, r * n + j, (r + 1) * n + j, (r + 1) * n + i))
    def centroid(ring, dy):
        cx = sum(v[0] for v in ring) / n
        cy = sum(v[1] for v in ring) / n + dy
        cz = sum(v[2] for v in ring) / n
        return (cx, cy, cz)
    ncap = [0]
    if cap_front:
        c = len(verts); verts.append(centroid(rings[0], -0.02))
        for i in range(n):
            j = (i + 1) % n
            faces.append((c, j, i))
        ncap[0] = n
    if cap_back:
        base = (len(rings) - 1) * n
        c = len(verts); verts.append(centroid(rings[-1], 0.02))
        for i in range(n):
            j = (i + 1) % n
            faces.append((c, base + i, base + j))
        ncap[0] += n
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for p in mesh.polygons:
        p.use_smooth = True
    for p in list(mesh.polygons)[len(mesh.polygons) - ncap[0]:]:
        p.use_smooth = False  # caps flat: avoids phantom point highlight at nose
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    if mat:
        mesh.materials.append(mat)
    CAR_OBJS.append(obj)
    return obj

# body: 57 rings along length (rings span 4.56m; caps round it to 4.60m overall)
ys_body = [-2.28 + 4.56 * i / 56 for i in range(57)]
body = build_loft("Body", ys_body, ring_points, MAT_PAINT)

# ---------------- wheel arch cutouts ----------------
def cut_arch(axle_y):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.435, depth=2.2, vertices=28,
                                        location=(0, axle_y, 0.33), rotation=(0, math.pi / 2, 0))
    cutter = bpy.context.object
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    mod = body.modifiers.new("arch", 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    body.select_set(False)
    bpy.data.objects.remove(cutter, do_unlink=True)

cut_arch(-1.35)
cut_arch(1.35)

# wheelhouse liners (dark, block see-through)
for ay in (-1.35, 1.35):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.40, depth=1.14, vertices=24,
                                        location=(0, ay, 0.35), rotation=(0, math.pi / 2, 0))
    o = bpy.context.object
    o.name = "Wheelhouse"
    o.scale = (0.85, 1.0, 1.0)  # local X maps to world Z after the Y-rotation: squash vertical radius so the liner never dips below ground
    o.data.materials.append(MAT_LINER)
    CAR_OBJS.append(o)

# ---------------- glass canopy ----------------
def glass_ring(y):
    halfW, zBot, zSide, zBelt, glassW, roofEdgeW, zRoof = params_at(y)
    pts = [
        (-(halfW - 0.004), zBelt + 0.015),
        (-glassW * 1.012, zBelt + 0.088),
        (-roofEdgeW * 1.012, zRoof - 0.050),
        (-0.30, zRoof + 0.004),
        (0.0, zRoof + 0.006),
        (0.30, zRoof + 0.004),
        (roofEdgeW * 1.012, zRoof - 0.050),
        (glassW * 1.012, zBelt + 0.088),
        ((halfW - 0.004), zBelt + 0.015),
    ]
    return [(x, y, z) for (x, z) in pts]

ys_glass = [-1.02 + 2.74 * i / 22 for i in range(23)]
canopy = build_loft("GlassCanopy", ys_glass, glass_ring, MAT_GLASS)

# ---------------- roof panel (body colour) ----------------
def build_roof_panel():
    ys = [-0.30 + 1.20 * i / 8 for i in range(9)]
    xs = [-0.46, -0.34, -0.20, 0.0, 0.20, 0.34, 0.46]
    verts, faces = [], []
    for y in ys:
        zR = params_at(y)[6]
        for x in xs:
            z = zR + 0.013 - 0.021 * (x / 0.46) ** 2
            verts.append((x, y, z))
    nx = len(xs)
    for r in range(len(ys) - 1):
        for i in range(nx - 1):
            faces.append((r * nx + i, r * nx + i + 1, (r + 1) * nx + i + 1, (r + 1) * nx + i))
    mesh = bpy.data.meshes.new("RoofPanel_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for p in mesh.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new("RoofPanel", mesh)
    scene.collection.objects.link(obj)
    mesh.materials.append(MAT_PAINT)
    # solidify a touch so edges are not invisible
    mod = obj.modifiers.new("solid", 'SOLIDIFY')
    mod.thickness = 0.006
    CAR_OBJS.append(obj)
    return obj

build_roof_panel()

# ---------------- small box parts ----------------
def add_box(name, dims, loc, mat, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.dimensions = dims
    o.location = loc
    o.rotation_euler = rot
    if mat:
        o.data.materials.append(mat)
    if bevel > 0:
        mod = o.modifiers.new("bev", 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        o.select_set(False)
    for p in o.data.polygons:
        p.use_smooth = True
    CAR_OBJS.append(o)
    return o

# ---- v2 helpers: layered headlight unit + textured license plate ----
def add_headlight_unit(cx, cy, cz, w=0.44, h=0.085, sweep=0.26):
    s = 1 if cx >= 0 else -1
    rotz = -sweep * s
    tilt = (-0.30, 0, rotz)  # tip the lens face up-forward so it reads from a front 3/4 view
    # dark housing (slightly larger, set back), bright reflector core, lens, DRL strip
    add_box("HeadHousing", (w + 0.03, 0.13, h + 0.025), (cx, cy + 0.020, cz), MAT_BLACK, rot=tilt, bevel=0.018)
    add_box("HeadReflector", (w * 0.86, 0.10, h * 0.72), (cx, cy - 0.004, cz), MAT_REFL, rot=tilt, bevel=0.015)
    add_box("HeadLens", (w, 0.085, h), (cx, cy - 0.014, cz), MAT_HEAD, rot=tilt, bevel=0.022)
    add_box("HeadDRL", (w * 0.80, 0.09, 0.020), (cx, cy - 0.018, cz + h * 0.30), MAT_DRL, rot=tilt, bevel=0.008)

def plate_material(tex_path):
    m = bpy.data.materials.new("plate")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.45
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(tex_path)
    nt.links.new(n.outputs["Color"], bsdf.inputs["Base Color"])
    return m

MAT_PLATE = plate_material(PLATE_TEX)
MAT_PLATE_BACK = mat_principled("plate_back", (0.94, 0.94, 0.92), rough=0.5, metallic=0.05)

def add_plate(cy, cz, facing, tex_mat=MAT_PLATE):
    # backing plate body
    add_box("PlateBack", (0.36, 0.016, 0.185), (0, cy, cz), MAT_PLATE_BACK, bevel=0.006)
    # textured face, oriented with an explicit basis (normal = facing * +Y, up = +Z)
    from mathutils import Matrix
    n = Vector((0, facing, 0)); u = Vector((0, 0, 1)); r = u.cross(n)
    R = Matrix((r, u, n)).transposed()
    bpy.ops.mesh.primitive_plane_add(size=1)
    o = bpy.context.object
    o.name = "PlateFace"
    o.dimensions = (0.335, 0.168, 0)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = R.to_quaternion()
    o.location = (0, cy + facing * 0.010, cz)
    o.data.materials.append(tex_mat)
    CAR_OBJS.append(o)

# headlights: plausible swept-back LED units at the nose corners (v2)
add_headlight_unit(-0.485, -2.185, 0.645)
add_headlight_unit(0.485, -2.185, 0.645)
# front intake
add_box("FrontIntake", (1.02, 0.10, 0.16), (0, -2.245, 0.40), MAT_BLACK, bevel=0.02)
# taillight: full-width red bar with corner wraps, more presence (v2)
add_box("Taillight", (1.44, 0.06, 0.115), (0, 2.288, 1.008), MAT_TAIL, bevel=0.025)
add_box("TailWrap_L", (0.20, 0.10, 0.095), (-0.70, 2.252, 1.002), MAT_TAIL, bevel=0.02)
add_box("TailWrap_R", (0.20, 0.10, 0.095), (0.70, 2.252, 1.002), MAT_TAIL, bevel=0.02)
# license plates (fictional number, procedural texture)
add_plate(-2.308, 0.44, -1)
add_plate(2.308, 0.72, 1)
# rear valance
add_box("RearValance", (1.46, 0.06, 0.15), (0, 2.265, 0.33), MAT_BLACK, bevel=0.02)
# mirrors
for sgn in (-1, 1):
    add_box("MirrorStalk", (0.10, 0.09, 0.035), (sgn * 0.895, -0.84, 1.005), MAT_BLACK)
    add_box("MirrorHead", (0.14, 0.09, 0.09), (sgn * 0.95, -0.84, 1.03), MAT_PAINT, bevel=0.03)
# shark-fin antenna (generic)
add_box("AntennaFin", (0.055, 0.17, 0.075), (0, 1.06, 1.315), MAT_PAINT, rot=(0.25, 0, 0), bevel=0.02)

# ---------------- wheels ----------------
def build_wheel(side, axle_y, name, R, W, xoff):
    from mathutils import Quaternion
    grp = []
    rimR = R * 0.60
    bead = rimR + 0.006
    # ---- tire: lathe profile (rounded shoulders, sidewall step, 3 tread grooves) ----
    prof = [
        (0.460 * W, bead), (0.505 * W, 0.760 * R), (0.478 * W, 0.880 * R),
        (0.450 * W, 0.960 * R), (0.385 * W, 0.997 * R), (0.270 * W, R),
        (0.225 * W, R - 0.006), (0.170 * W, R), (0.045 * W, R),
        (0.000 * W, R - 0.006), (-0.045 * W, R), (-0.170 * W, R),
        (-0.225 * W, R - 0.006), (-0.270 * W, R), (-0.385 * W, 0.997 * R),
        (-0.450 * W, 0.960 * R), (-0.478 * W, 0.880 * R), (-0.505 * W, 0.760 * R),
        (-0.460 * W, bead),
    ]
    SEG = 22
    NP_ = len(prof)
    verts, faces = [], []
    for i in range(SEG):
        th = 2 * math.pi * i / SEG
        c, s = math.cos(th), math.sin(th)
        for (a, r) in prof:
            verts.append((a, c * r, s * r))
    for i in range(SEG):
        ni = (i + 1) % SEG
        for j in range(NP_ - 1):
            faces.append((i * NP_ + j, i * NP_ + j + 1, ni * NP_ + j + 1, ni * NP_ + j))
    mesh = bpy.data.meshes.new(name + "_tire_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for p in mesh.polygons:
        p.use_smooth = True
    tire = bpy.data.objects.new(name + "_tire", mesh)
    scene.collection.objects.link(tire)
    tire.data.materials.append(MAT_TIRE)
    grp.append(tire)
    # ---- rim barrel + brake disc (dark, fills the gaps between spokes) ----
    def _cyl(r, depth, x, mat, verts_n, nm):
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts_n,
                                            location=(x, 0, 0), rotation=(0, math.pi / 2, 0))
        o = bpy.context.object
        o.name = nm
        o.data.materials.append(mat)
        grp.append(o)
        return o
    _cyl(rimR - 0.004, W * 0.80, 0, MAT_RIMD, 16, name + "_barrel")
    _cyl(rimR * 0.90, 0.018, side * (W / 2 - 0.062), MAT_RIMD, 16, name + "_disc")
    # ---- rim lip ring at the recessed face ----
    bpy.ops.mesh.primitive_torus_add(major_radius=rimR - 0.004, minor_radius=0.012,
                                     major_segments=18, minor_segments=4,
                                     location=(side * (W / 2 - 0.024), 0, 0), rotation=(0, math.pi / 2, 0))
    lip = bpy.context.object
    lip.name = name + "_lip"
    lip.data.materials.append(MAT_RIM)
    grp.append(lip)
    # ---- 5 thick tapered spokes + hub (recessed so the sidewall sits proud) ----
    face_x = side * (W / 2 - 0.026)
    hubR = R * 0.155
    spoke_len = rimR - hubR * 0.45
    for k in range(5):
        th = k * 2 * math.pi / 5 + 0.31
        d = Vector((0, math.cos(th), math.sin(th)))
        bpy.ops.mesh.primitive_cone_add(radius1=R * 0.118, radius2=R * 0.084, depth=spoke_len,
                                        vertices=4,
                                        location=Vector((face_x, 0, 0)) + d * (hubR * 0.45 + spoke_len / 2))
        sp = bpy.context.object
        sp.name = name + "_spoke"
        q = Vector((0, 0, 1)).rotation_difference(d)
        qa = Quaternion(d, math.pi / 4)  # flat faces to the axial/tangential planes
        sp.rotation_mode = 'QUATERNION'
        sp.rotation_quaternion = qa @ q
        sp.data.materials.append(MAT_RIM)
        grp.append(sp)
    _cyl(hubR, 0.036, face_x, MAT_RIM, 12, name + "_hub")
    # ---- place the whole wheel ----
    for o in grp:
        o.location.x += side * xoff
        o.location.y += axle_y
        o.location.z += R
        CAR_OBJS.append(o)
    return grp

build_wheel(-1, -1.35, "Wheel_FL", 0.33, 0.215, 0.70)
build_wheel(1, -1.35, "Wheel_FR", 0.33, 0.215, 0.70)
build_wheel(-1, 1.35, "Wheel_RL", 0.33, 0.215, 0.70)
build_wheel(1, 1.35, "Wheel_RR", 0.33, 0.215, 0.70)

# ---------------- stats + GLB export ----------------
bpy.context.view_layer.update()
mn = Vector((1e18,) * 3); mx = Vector((-1e18,) * 3)
polys = 0
for o in CAR_OBJS:
    if o.type == 'MESH':
        polys += len(o.data.polygons)
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
dims = mx - mn
print(f"CAR_DIMS x={dims.x:.3f} y={dims.y:.3f} z={dims.z:.3f}  min={tuple(round(v,3) for v in mn)} max={tuple(round(v,3) for v in mx)}")
print(f"CAR_POLYGONS {polys}")

bpy.ops.object.select_all(action='DESELECT')
for o in CAR_OBJS:
    o.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_apply=True)
print("GLB_EXPORTED ->", OUT_GLB)
bpy.ops.object.select_all(action='DESELECT')

# ---------------- preview stage ----------------
def load_img(path):
    return bpy.data.images.load(path)

def simple_tex_mat(name, folder, base, repeat):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (repeat, repeat, 1.0)
    nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
    for suffix, cs, inp in (("diff", "sRGB", "Base Color"), ("rough", "Non-Color", "Roughness")):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = load_img(f"{folder}/{base}_{suffix}_1k.jpg")
        n.image.colorspace_settings.name = cs
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
        nt.links.new(n.outputs["Color"], bsdf.inputs[inp])
    nor = nt.nodes.new("ShaderNodeTexImage")
    nor.image = load_img(f"{folder}/{base}_nor_gl_1k.jpg")
    nor.image.colorspace_settings.name = "Non-Color"
    nt.links.new(mp.outputs["Vector"], nor.inputs["Vector"])
    nrm = nt.nodes.new("ShaderNodeNormalMap")
    nrm.inputs["Strength"].default_value = 0.7
    nt.links.new(nor.outputs["Color"], nrm.inputs["Color"])
    nt.links.new(nrm.outputs["Normal"], bsdf.inputs["Normal"])
    return m

mat_ground = simple_tex_mat("ground", ASSET + "/textures/ground_asphalt", "clean_asphalt", 9.0)
bpy.ops.mesh.primitive_plane_add(size=1)
g = bpy.context.object
g.name = "Stage"
g.dimensions = (34, 34, 0)
g.location = (0, 0, -0.005)
g.data.materials.append(mat_ground)

if scene.world is None:
    scene.world = bpy.data.worlds.new("World")
world = scene.world
world.use_nodes = True
wnt = world.node_tree
bg = wnt.nodes["Background"]
env = wnt.nodes.new("ShaderNodeTexEnvironment")
env.image = load_img(ASSET + "/hdri/suburban_garden_2k.hdr")
wnt.links.new(env.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0

bpy.ops.object.light_add(type='SUN', location=(18, -22, 26))
sun = bpy.context.object
sun.data.energy = 3.2
sun.data.angle = 1.5
sun.rotation_euler = (Vector((-18, 22, -26))).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=(5.6, -6.1, 1.95))
cam = bpy.context.object
target = Vector((0, 0.15, 0.55))
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.lens = 40
scene.camera = cam

scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 32
scene.render.resolution_x = 1280
scene.render.resolution_y = 960
scene.render.resolution_percentage = 100
scene.render.filepath = OUT_PREVIEW
scene.render.image_settings.file_format = 'PNG'
bpy.ops.render.render(write_still=True)
print("RENDERED ->", OUT_PREVIEW)
