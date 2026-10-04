"""Turn an FBX car (Sketchfab download) into a GLB for the aero lab.

First convert the FBX with FBX2glTF (npm i fbx2gltf):
    FBX2glTF --binary --input "Red Bull Final.fbx" --output rb_raw
Then:
    python3 fbx_car_to_glb.py redbull rb_raw.glb textures/ redbull-raw.glb

Like usdz_to_glb.py, the output is in the page's car-local frame: metres, +X forward, +Y up,
Z across, ground at y = 0 (tyre contact patches), centred between the four wheels. On the way it

  * bakes the node transforms into the vertices (one mesh per source primitive)
  * poses animated parts (the Valkyrie's doors load open; they are closed from their own animation)
  * squares the car up from its wheel centres and scales it to the real car (CARS[...]["scale_to"])
  * attaches the separate texture files by material name (base colour, normal, and an
    occlusion/roughness/metal map packed from the AO, roughness and metallic maps)
  * gives each wheel's rotating parts (tyre, rim, brake disc) a "__wheelFL/FR/RL/RR" material,
    so the optimizer keeps every wheel as its own mesh, and prints the hub centres and spin axes
    (WHEELS in index.html)
  * gives the rear wing's moving parts a "__wing" material and prints the hinge (WING_HINGE)

Needs: numpy, scipy, pygltflib, pillow
"""
import io
import json
import os
import re
import sys

import numpy as np
import pygltflib as G
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

CARS = {
    # Aston Martin Valkyrie: separate meshes per part, wheels grouped as Tires/Tires_F_L/...
    "valkyrie": {
        "scale_to": ("width", 1.92),   # body width without mirrors is ~1.92 m; tyre sizes then match the real car
        "wheel_rule": "nodes",
        "wheel_node": r"/Tires_[FB]_[LR]/",
        "tex_style": "per_material",
        # the carbon rear wing blade between the rear fenders (its centre mount stays put)
        "wing": {"mesh": r"/polySurface41$", "box": [-2.13, -1.80, 0.67, 0.84, 0.62]},
    },
    # Red Bull RB16B-style F1 car: one mesh with a single texture atlas
    "redbull": {
        "scale_to": ("width", 2.0),    # F1 maximum width 2000 mm
        "wheel_rule": "geometry",
        "tex_style": "atlas",
        "atlas": "F1 Car_Formula 1 Car_",
        # the rear wing's upper flap (the DRS flap), between the endplates
        "wing": {"mesh": r"", "box": [-2.26, -2.10, 1.09, 1.18, 0.497]},
    },
}

name, src, tex_dir, dst = sys.argv[1:5]
CFG = CARS[name]

# ---------------------------------------------------------------- read + flatten the scene
g = G.GLTF2().load(src)
blob = g.binary_blob()


def read(i):
    a = g.accessors[i]
    bv = g.bufferViews[a.bufferView]
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a.componentType]
    n = {"VEC4": 4, "VEC3": 3, "VEC2": 2, "SCALAR": 1}[a.type]
    r = np.frombuffer(blob, dtype=dt, count=a.count * n, offset=(bv.byteOffset or 0) + (a.byteOffset or 0))
    return (r.reshape(-1, n) if n > 1 else r).copy()


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def local(n, rot=None):
    M = np.eye(4)
    R = qmat(rot if rot is not None else n.rotation) if (rot is not None or n.rotation) else np.eye(3)
    S = np.diag(n.scale) if n.scale else np.eye(3)
    M[:3, :3] = R @ S
    if n.translation:
        M[:3, 3] = n.translation
    return M


# Animated rotations: pick the keyframe that sits each animated part lowest (doors shut)
pose = {}
for an in g.animations or []:
    for ch in an.channels:
        if ch.target.path != "rotation":
            continue
        keys = read(an.samplers[ch.sampler].output)
        if len(keys) > 1:
            pose[ch.target.node] = keys


def subtree_points(i, M):
    n = g.nodes[i]
    M = M @ local(n)
    pts = []
    if n.mesh is not None:
        for p in g.meshes[n.mesh].primitives:
            V = read(p.attributes.POSITION)[::7].astype(np.float64)
            pts.append(V @ M[:3, :3].T + M[:3, 3])
    for c in n.children or []:
        pts += subtree_points(c, M)
    return pts


def world_of(target):
    def find(i, M):
        n = g.nodes[i]
        if i == target:
            return M
        M2 = M @ local(n)
        for c in n.children or []:
            r = find(c, M2)
            if r is not None:
                return r
        return None
    for r in g.scenes[g.scene or 0].nodes:
        m = find(r, np.eye(4))
        if m is not None:
            return m


chosen = {}
for ni, keys in pose.items():
    P = world_of(ni)
    best, bh = None, 1e9
    for k in keys:
        M = P @ local(g.nodes[ni], k)
        pts = [subtree_points(c, M) for c in g.nodes[ni].children or []]
        pts = np.concatenate([q for sub in pts for q in sub]) if pts else None
        h = pts[:, 1].max() if pts is not None else 0
        if h < bh - 1e-9:
            best, bh = k, h
    chosen[ni] = best
    print("posed node", g.nodes[ni].name, "->", np.round(best, 3).tolist(), file=sys.stderr)

prims = []


def walk(i, P, path):
    n = g.nodes[i]
    M = P @ local(n, chosen.get(i))
    path = path + "/" + (n.name or "")
    if n.mesh is not None:
        for p in g.meshes[n.mesh].primitives:
            V = read(p.attributes.POSITION).astype(np.float64) @ M[:3, :3].T + M[:3, 3]
            Ni = np.linalg.inv(M[:3, :3]).T
            N = read(p.attributes.NORMAL).astype(np.float64) @ Ni.T
            N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
            UV = read(p.attributes.TEXCOORD_0) if p.attributes.TEXCOORD_0 is not None else np.zeros((len(V), 2))
            I = read(p.indices).astype(np.int64).reshape(-1, 3)
            if np.linalg.det(M[:3, :3]) < 0:
                I = I[:, ::-1]
            prims.append(dict(path=path, mat=g.materials[p.material].name, V=V, N=N, UV=UV, I=I))
    for c in n.children or []:
        walk(c, M, path)


for r in g.scenes[g.scene or 0].nodes:
    walk(r, np.eye(4), "")

# source (Y up, nose at +Z) -> car frame (+X forward): X = z, Y = y, Z = -x
R = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], dtype=np.float64)
for p in prims:
    p["V"] = p["V"] @ R.T
    p["N"] = p["N"] @ R.T

# ---------------------------------------------------------------- wheels
def wheel_key(c):
    return ("F" if c[0] > 0 else "R") + ("L" if c[2] > 0 else "R")


def components(V, I):
    n = len(V)
    A = coo_matrix((np.ones(I.size), (np.repeat(I[:, 0], 3), I.ravel())), shape=(n, n))
    return connected_components(A + A.T, directed=False)[1]


wheel_tris = {}   # prim index -> per-triangle wheel key ('' = static)
if CFG["wheel_rule"] == "nodes":
    # Each wheel's parts sit under one node. Only parts that are round and centred on the axle
    # spin (tyre, rim, disc, centre cap); off-centre ones (caliper, upright) stay put. The model's
    # part names can't be trusted for this: its "brake_disc" is the caliper.
    groups = {}
    for k, p in enumerate(prims):
        m = re.search(CFG["wheel_node"], p["path"])
        if m:
            groups.setdefault(m.group(0), []).append(k)
    for ks in groups.values():
        box = {k: (prims[k]["V"].min(0), prims[k]["V"].max(0)) for k in ks}
        tyre = max(ks, key=lambda k: (box[k][1] - box[k][0])[1])
        tc = (box[tyre][0] + box[tyre][1]) / 2
        r = (box[tyre][1] - box[tyre][0])[1] / 2
        for k in ks:
            lo_, hi_ = box[k]
            c, e = (lo_ + hi_) / 2, hi_ - lo_
            if np.hypot(c[0] - tc[0], c[1] - tc[1]) < 0.04 * r and abs(e[0] - e[1]) < 0.05 * max(e[0], e[1]):
                wheel_tris[k] = np.full(len(prims[k]["I"]), wheel_key(tc))
else:
    # Single-mesh car: find each wheel as the cluster of mesh pieces (connected components) around
    # a hub. Tyre, rim and spokes are separate pieces that lie inside the tyre's cylinder;
    # suspension arms reach into it but extend well beyond, so whole pieces are tested.
    p = prims[0]
    V, I = p["V"], p["I"]
    lab = components(V, I)
    ncomp = lab.max() + 1
    lo = np.full((ncomp, 3), 1e9); hi = np.full((ncomp, 3), -1e9)
    np.minimum.at(lo, lab, V); np.maximum.at(hi, lab, V)
    # tyres: the biggest pieces near each corner whose side view is round (x extent == y extent)
    ext = hi - lo
    ctr = (lo + hi) / 2
    cnt = np.bincount(lab)
    round_ = (np.abs(ext[:, 0] - ext[:, 1]) < 0.12 * ext[:, 1]) & (ext[:, 1] > 0.25 * (V[:, 1].max() - V[:, 1].min()))
    hubs = {}
    for key in ("FL", "FR", "RL", "RR"):
        sx = 1 if key[0] == "F" else -1
        sz = 1 if key[1] == "L" else -1
        cand = np.flatnonzero(round_ & (np.sign(ctr[:, 0]) == sx) & (np.sign(ctr[:, 2]) == sz))
        tyre = cand[np.argmax(ext[cand, 1] * 1000 + cnt[cand] * 1e-6)]
        hubs[key] = dict(c=ctr[tyre].copy(), r=ext[tyre, 1] / 2, tyre=tyre, zlo=lo[tyre, 2], zhi=hi[tyre, 2])
    tri_key = np.full(len(I), "", dtype=object)
    for key, h in hubs.items():
        c, r = h["c"], h["r"]
        # every vertex of the piece inside the tyre's cylinder (rim and disc may sit a little
        # inboard of the tread); pieces reaching outside it (suspension arms) stay put
        rad = np.zeros(ncomp)
        np.maximum.at(rad, lab, np.hypot(V[:, 0] - c[0], V[:, 1] - c[1]))
        sel = (rad <= r * 1.02) & (lo[:, 2] >= h["zlo"] - 0.25 * r) & (hi[:, 2] <= h["zhi"] + 0.25 * r)
        tri_key[sel[lab[I[:, 0]]]] = key
        print("wheel", key, "pieces", int(sel.sum()), file=sys.stderr)
    wheel_tris[0] = tri_key

# ---------------------------------------------------------------- square up, scale, place
def wheel_centres():
    out = {}
    for k, keys in wheel_tris.items():
        p = prims[k]
        for key in ("FL", "FR", "RL", "RR"):
            m = keys == key
            if not m.any():
                continue
            out.setdefault(key, []).append(p["V"][p["I"][m].ravel()])
    res = {}
    for key, pts in out.items():
        P = np.concatenate(pts)
        res[key] = dict(c=(P.min(0) + P.max(0)) / 2, bottom=P[:, 1].min(), r=(P.max(0) - P.min(0))[1] / 2)
    return res


wc = wheel_centres()
assert len(wc) == 4, f"expected four wheels, found {sorted(wc)}"
front = (wc["FL"]["c"] + wc["FR"]["c"]) / 2
rear = (wc["RL"]["c"] + wc["RR"]["c"]) / 2
yaw = np.arctan2(front[2] - rear[2], front[0] - rear[0])
c_, s_ = np.cos(-yaw), np.sin(-yaw)
Ry = np.array([[c_, 0, -s_], [0, 1, 0], [s_, 0, c_]])
for p in prims:
    p["V"] = p["V"] @ Ry.T
    p["N"] = p["N"] @ Ry.T
print("squared up: yaw correction %.2f deg" % np.degrees(-yaw), file=sys.stderr)

allP = np.concatenate([p["V"] for p in prims])
kind, real = CFG["scale_to"]
lo, hi = np.percentile(allP, 0.05, axis=0), np.percentile(allP, 99.95, axis=0)
size = {"width": hi[2] - lo[2], "length": hi[0] - lo[0]}[kind]
scale = real / size
wc = wheel_centres()
ground = np.mean([w["bottom"] for w in wc.values()])
cx = np.mean([w["c"][0] for w in wc.values()])
cz = np.mean([w["c"][2] for w in wc.values()])
off = np.array([cx, ground, cz])
for p in prims:
    p["V"] = (p["V"] - off) * scale
wc = wheel_centres()
print("scale %.4f  size %s" % (scale, np.round((hi - lo) * scale, 3).tolist()), file=sys.stderr)

# ---------------------------------------------------------------- moving wing
# Mesh pieces (connected components) lying wholly inside the wing box get a "__wing" material;
# the page pivots them about a spanwise hinge at the wing's leading edge.
wing_tris = {}
hinge = None
if CFG.get("wing"):
    x0, x1, y0, y1, zmax = CFG["wing"]["box"]
    pts = []
    for k, p in enumerate(prims):
        if not re.search(CFG["wing"]["mesh"], p["path"]):
            continue
        V, I = p["V"], p["I"]
        lab = components(V, I)
        nc = lab.max() + 1
        lo_ = np.full((nc, 3), 1e9); hi_ = np.full((nc, 3), -1e9)
        np.minimum.at(lo_, lab, V); np.maximum.at(hi_, lab, V)
        inside = ((lo_[:, 0] > x0) & (hi_[:, 0] < x1) & (lo_[:, 1] > y0) & (hi_[:, 1] < y1)
                  & (np.maximum(np.abs(lo_[:, 2]), np.abs(hi_[:, 2])) < zmax))
        tri = inside[lab[I[:, 0]]]
        free = wheel_tris[k] == "" if k in wheel_tris else np.ones(len(I), bool)
        tri &= free
        if tri.any():
            wing_tris[k] = tri
            pts.append(V[I[tri].ravel()])
    P = np.concatenate(pts)
    lead = P[P[:, 0] > P[:, 0].max() - 0.02]
    hinge = {"origin": [round(float(P[:, 0].max()), 4), round(float(lead[:, 1].mean()), 4), 0.0], "axis": [0, 0, 1]}
    print("wing pieces", sum(int(t.sum()) for t in wing_tris.values()), "triangles", file=sys.stderr)

# ---------------------------------------------------------------- textures
out = G.GLTF2(asset=G.Asset(generator="fbx_car_to_glb.py"))
buf = bytearray()


def add_view(data, target=None):
    while len(buf) % 4:
        buf.append(0)
    o = len(buf)
    buf.extend(data)
    bv = G.BufferView(buffer=0, byteOffset=o, byteLength=len(data))
    if target:
        bv.target = target
    out.bufferViews.append(bv)
    return len(out.bufferViews) - 1


def add_acc(arr, ctype, typ, target, minmax=False):
    acc = G.Accessor(bufferView=add_view(arr.tobytes(), target), componentType=ctype, count=len(arr), type=typ)
    if minmax:
        acc.min = arr.min(axis=0).tolist()
        acc.max = arr.max(axis=0).tolist()
    out.accessors.append(acc)
    return len(out.accessors) - 1


files = {f.lower(): os.path.join(tex_dir, f) for f in os.listdir(tex_dir)}


def tex_file(prefix, kind):
    for ext in (".png", ".jpg", ".jpeg", ".tga.png"):
        f = files.get((prefix + kind + ext).lower())
        if f:
            return f
    # the Red Bull metallic map is named differently
    for k, f in files.items():
        if k.replace(" ", "_").startswith(prefix.replace(" ", "_").lower()) and kind.lower() in k:
            return f
    return None


tex_cache = {}
MAXTEX = 2048


def add_image(key, im, fmt="JPEG"):
    if key in tex_cache:
        return tex_cache[key]
    if max(im.size) > MAXTEX:
        im.thumbnail((MAXTEX, MAXTEX))
    b = io.BytesIO()
    if fmt == "PNG":
        im.save(b, "PNG", optimize=True)
    else:
        im.save(b, "JPEG", quality=90)
    out.images.append(G.Image(bufferView=add_view(b.getvalue()), mimeType="image/png" if fmt == "PNG" else "image/jpeg"))
    if not out.samplers:
        out.samplers.append(G.Sampler(wrapS=10497, wrapT=10497))
    out.textures.append(G.Texture(source=len(out.images) - 1, sampler=0))
    tex_cache[key] = len(out.textures) - 1
    return tex_cache[key]


def gray(path, size):
    im = Image.open(path).convert("L")
    return im.resize(size, Image.BILINEAR) if im.size != size else im


mat_out = {}


def material(src_name):
    if src_name in mat_out:
        return mat_out[src_name]
    prefix = CFG["atlas"] if CFG["tex_style"] == "atlas" else src_name + "_"
    pbr = G.PbrMetallicRoughness(baseColorFactor=[1, 1, 1, 1], metallicFactor=1, roughnessFactor=1)
    m = G.Material(name=src_name, pbrMetallicRoughness=pbr, doubleSided=True)
    fb = tex_file(prefix, "BaseColor")
    if fb:
        base = Image.open(fb)
        op = tex_file(prefix, "Opacity")
        if op:
            rgba = base.convert("RGB")
            if max(rgba.size) > MAXTEX:
                rgba.thumbnail((MAXTEX, MAXTEX))
            a = gray(op, rgba.size)
            rgba.putalpha(a)
            pbr.baseColorTexture = G.TextureInfo(index=add_image(fb + "+a", rgba, "PNG"))
            amin = np.asarray(a).min()
            m.alphaMode = "BLEND" if amin > 8 else "MASK"   # glass is see-through everywhere; decals are cut-outs
            if m.alphaMode == "MASK":
                m.alphaCutoff = 0.5
        else:
            pbr.baseColorTexture = G.TextureInfo(index=add_image(fb, base.convert("RGB")))
    else:
        pbr.baseColorFactor = [0.6, 0.6, 0.6, 1]
    fn = tex_file(prefix, "Normal")
    if fn:
        m.normalTexture = G.NormalMaterialTexture(index=add_image(fn, Image.open(fn).convert("RGB")))
    fr, fm, fa = tex_file(prefix, "Roughness"), tex_file(prefix, "Metallic"), tex_file(prefix, "AmbientOcclusion")
    if fr or fm:
        ref = Image.open(fr or fm)
        size = ref.size
        if max(size) > MAXTEX:
            k = MAXTEX / max(size)
            size = (int(size[0] * k), int(size[1] * k))
        r = gray(fr, size) if fr else Image.new("L", size, 160)
        mt = gray(fm, size) if fm else Image.new("L", size, 0)
        ao = gray(fa, size) if fa else Image.new("L", size, 255)
        orm = Image.merge("RGB", (ao, r, mt))
        t = add_image((fr, fm, fa), orm)
        pbr.metallicRoughnessTexture = G.TextureInfo(index=t)
        if fa:
            m.occlusionTexture = G.OcclusionTextureInfo(index=t)
    else:
        pbr.metallicFactor, pbr.roughnessFactor = 0.1, 0.6
    fe = tex_file(prefix, "Emissive")
    if fe and np.asarray(Image.open(fe).convert("L")).max() > 16:
        m.emissiveTexture = G.TextureInfo(index=add_image(fe, Image.open(fe).convert("RGB")))
        m.emissiveFactor = [1, 1, 1]
    out.materials.append(m)
    mat_out[src_name] = len(out.materials) - 1
    return mat_out[src_name]


def variant(mi, suffix):
    key = (mi, suffix)
    if key in mat_out:
        return mat_out[key]
    base = out.materials[mi]
    m = G.Material(**{k: v for k, v in base.__dict__.items() if not k.startswith("_")})
    m.name = base.name + suffix
    m.pbrMetallicRoughness = G.PbrMetallicRoughness(**{k: v for k, v in base.pbrMetallicRoughness.__dict__.items() if not k.startswith("_")})
    # nudge a factor so the optimizer can't merge it back into the base material
    m.pbrMetallicRoughness.roughnessFactor = (m.pbrMetallicRoughness.roughnessFactor or 1) * (0.9999 - 0.0001 * len(mat_out))
    out.materials.append(m)
    mat_out[key] = len(out.materials) - 1
    return mat_out[key]


# ---------------------------------------------------------------- write
node_ids = []


def emit(p, tri_sel, mat_index):
    I = p["I"][tri_sel]
    if not len(I):
        return
    used, inv = np.unique(I.ravel(), return_inverse=True)
    P = p["V"][used].astype(np.float32)
    N = p["N"][used].astype(np.float32)
    UV = p["UV"][used].astype(np.float32)
    a_p = add_acc(P, G.FLOAT, G.VEC3, G.ARRAY_BUFFER, True)
    a_n = add_acc(N, G.FLOAT, G.VEC3, G.ARRAY_BUFFER)
    a_t = add_acc(UV, G.FLOAT, G.VEC2, G.ARRAY_BUFFER)
    a_i = add_acc(inv.astype(np.uint32), G.UNSIGNED_INT, G.SCALAR, G.ELEMENT_ARRAY_BUFFER)
    out.meshes.append(G.Mesh(primitives=[G.Primitive(attributes=G.Attributes(POSITION=a_p, NORMAL=a_n, TEXCOORD_0=a_t), indices=a_i, material=mat_index)]))
    out.nodes.append(G.Node(mesh=len(out.meshes) - 1, name=p["path"].split("/")[-1]))
    node_ids.append(len(out.nodes) - 1)


for k, p in enumerate(prims):
    mi = material(p["mat"])
    keys = wheel_tris.get(k, np.full(len(p["I"]), "", dtype=object))
    wing = wing_tris.get(k, np.zeros(len(p["I"]), bool))
    emit(p, (keys == "") & ~wing, mi)
    if wing.any():
        emit(p, wing, variant(mi, "__wing"))
    for key in ("FL", "FR", "RL", "RR"):
        if (keys == key).any():
            emit(p, keys == key, variant(mi, "__wheel" + key))

out.scenes.append(G.Scene(nodes=node_ids))
out.scene = 0
out.buffers.append(G.Buffer(byteLength=len(buf)))
out.set_binary_blob(bytes(buf))
out.save_binary(dst)

# hub centre + spin axis from the rotating parts: the axis is the direction of least spread of
# the wheel (a flat, round object), the centre is the middle of its bounding box
wheels = {}
for key, w in sorted(wheel_centres().items()):
    pts = []
    for k, keys in wheel_tris.items():
        m = keys == key
        if m.any():
            pts.append(prims[k]["V"][prims[k]["I"][m].ravel()])
    P = np.unique(np.concatenate(pts), axis=0)
    c0 = (P.min(0) + P.max(0)) / 2
    _, _, vt = np.linalg.svd(P - P.mean(0), full_matrices=False)
    a = vt[-1] if vt[-1][2] > 0 else -vt[-1]
    if abs(a[2]) < 0.9:
        a = np.array([0, 0, 1.0])
    # the tyre touches the road (y = 0), so the hub height is the rolling radius
    c = c0
    r = float(c[1])
    wheels[key] = {"c": [round(float(v), 4) for v in c], "axis": [round(float(v), 5) for v in a], "r": round(r, 3)}
print(json.dumps({"wheels": wheels, "hinge": hinge}))
print("meshes", len(out.meshes), "materials", len(out.materials), "images", len(out.images), "bytes", len(buf), file=sys.stderr)
