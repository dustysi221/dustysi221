"""Split the adjustable rear-wing assembly into its own meshes.

Runs on the GLB written by usdz_to_glb.py (meshes not yet joined). On the real car the
wing (main plane + endplates) hangs from the swan-neck mounts by a bracket plate on each
side. The plate pivots on one bolt and is locked by a second bolt in a slot. Here:

  moves  : main plane + endplates (+ their decals), both bracket plates, the slot bolts
  fixed  : swan necks, their end cheeks and bolts, the pivot bolt shafts

Moving parts get a copy of their material named "<name>__wing", so the optimizer keeps
them as separate meshes and the page can hang them on the hinge. The hinge axis (through
both pivot bolts) is printed as JSON for index.html (WING_HINGE).

Usage: python3 split_wing.py raw.glb raw_wing.glb
"""
import json
import sys

import numpy as np
import pygltflib as G

src, dst = sys.argv[1:3]
g = G.GLTF2().load(src)
blob = bytearray(g.binary_blob())


def read(i):
    a = g.accessors[i]
    bv = g.bufferViews[a.bufferView]
    dt = {5126: np.float32, 5125: np.uint32}[a.componentType]
    n = {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[a.type]
    r = np.frombuffer(bytes(blob), dtype=dt, count=a.count * n, offset=bv.byteOffset + (a.byteOffset or 0))
    return r.reshape(-1, n) if n > 1 else r


def components(P, I):
    """Label triangles by connected component (vertices joined by position)."""
    _, inv = np.unique(np.round(P, 4), axis=0, return_inverse=True)
    inv = inv.ravel()
    parent = np.arange(inv.max() + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for t in I:
        a, b, c = (find(x) for x in inv[t])
        parent[b] = a
        parent[c] = a
    return np.array([find(inv[t[0]]) for t in I])


def mesh_by_material(name, min_tris=0, max_tris=10**9):
    out = []
    for mi, m in enumerate(g.meshes):
        p = m.primitives[0]
        n = g.accessors[p.indices].count // 3
        if g.materials[p.material].name == name and min_tris <= n <= max_tris:
            out.append(mi)
    return out


WING_X1, WING_Y0 = -1.80, 0.80
move = {}      # mesh index -> boolean mask over triangles
pivots = []

# 1. wing element + endplates: the small mat_94 mesh behind the tail
for mi in mesh_by_material("mat_94", max_tris=5000):
    p = g.meshes[mi].primitives[0]
    I = read(p.indices).reshape(-1, 3)
    c = read(p.attributes.POSITION)[I].mean(1)
    move[mi] = (c[:, 0] < WING_X1) & (c[:, 1] > WING_Y0)

# 2. mounts (mat_60): per side, find the pivot bolt head (mat_16) and the bracket plate
def busiest(name):
    """The mesh of this material with the most triangles in the mount zone."""
    best, n_best = None, 0
    for mi in mesh_by_material(name):
        p = g.meshes[mi].primitives[0]
        c = read(p.attributes.POSITION)[read(p.indices).reshape(-1, 3)].mean(1)
        n = int(((c[:, 0] < WING_X1) & (c[:, 1] > 1.0)).sum())
        if n > n_best:
            best, n_best = mi, n
    return best


hw_i, neck_i = busiest("mat_16_001"), busiest("mat_60_001")
assert hw_i is not None and neck_i is not None, "expected mat_16_001 (hardware) and mat_60_001 (mounts)"
HP = read(g.meshes[hw_i].primitives[0].attributes.POSITION)
HI = read(g.meshes[hw_i].primitives[0].indices).reshape(-1, 3)
NP = read(g.meshes[neck_i].primitives[0].attributes.POSITION)
NI = read(g.meshes[neck_i].primitives[0].indices).reshape(-1, 3)
hmask = np.zeros(len(HI), bool)
nmask = np.zeros(len(NI), bool)
hc, nc = HP[HI].mean(1), NP[NI].mean(1)

wing_tris = read(g.meshes[next(iter(move))].primitives[0].indices).reshape(-1, 3)
wing_P = read(g.meshes[next(iter(move))].primitives[0].attributes.POSITION)
wing_z = wing_P[wing_tris[move[next(iter(move))]]].reshape(-1, 3)[:, 2]
z_lo, z_hi = wing_z.min(), wing_z.max()

for side_sel in (nc[:, 2] > (z_lo + z_hi) / 2, nc[:, 2] <= (z_lo + z_hi) / 2):
    zone = (nc[:, 0] < WING_X1) & (nc[:, 1] > 1.0) & side_sel
    if not zone.any():
        continue
    idx = np.where(zone)[0]
    lab = components(NP, NI[idx])
    comps = []
    for L in np.unique(lab):
        t = idx[lab == L]
        Q = NP[NI[t].ravel()]
        comps.append((t, Q.min(0), Q.max(0)))
    zc = np.median(nc[idx, 2])
    # bolt heads on this side
    hz = (hc[:, 0] < WING_X1) & (hc[:, 1] > 1.0) & (np.abs(hc[:, 2] - zc) < 0.05)
    hidx = np.where(hz)[0]
    hlab = components(HP, HI[hidx])
    heads = []
    for L in np.unique(hlab):
        t = hidx[hlab == L]
        heads.append((t, HP[HI[t].ravel()].mean(0)))
    # the bracket plate is the small component that reaches lowest (it sits on the wing)
    small = [c for c in comps if len(c[0]) < 300]
    plate = min(small, key=lambda c: c[1][1])
    pmin, pmax = plate[1], plate[2]
    # pivot bolt: a narrow shaft component whose x lies inside the plate, near its rear
    shafts = [c for c in small if (c[2][0] - c[1][0]) < 0.03 and c[1][1] < pmax[1]]
    shaft = min(shafts, key=lambda c: (c[1][0] + c[2][0]) / 2)
    px = (shaft[1][0] + shaft[2][0]) / 2
    # the pivot bolt head on the plate gives the hinge height
    on_plate = [h for h in heads if pmin[0] - 0.01 <= h[1][0] <= pmax[0] + 0.01 and h[1][1] <= pmax[1]]
    pivot_head = min(on_plate, key=lambda h: abs(h[1][0] - px))
    pivots.append([float(px), float(pivot_head[1][1]), float(zc)])
    for t, mn, mx in comps:
        if len(t) >= 300:
            continue                       # swan neck body
        if mn[1] > pmin[1] + 0.02 and (mx[0] - mn[0]) > 0.12:
            continue                       # neck end cheeks (sit above the plate)
        if t is shaft[0]:
            continue                       # pivot shaft stays on the neck
        nmask[t] = True
    for t, ctr in heads:
        if ctr[1] <= pmax[1] and abs(ctr[0] - px) > 0.02 and pmin[0] - 0.01 <= ctr[0] <= pmax[0] + 0.01:
            hmask[t] = True                # slot bolt on the plate
move[hw_i] = move.get(hw_i, np.zeros(len(HI), bool)) | hmask
move[neck_i] = nmask

# endplate decals (mat_16 quads on the endplates, beyond the plate zone)
for mi in [m for m in mesh_by_material("mat_16_001") if m != hw_i]:
    p = g.meshes[mi].primitives[0]
    I = read(p.indices).reshape(-1, 3)
    c = read(p.attributes.POSITION)[I].mean(1)
    move[mi] = move.get(mi, np.zeros(len(I), bool)) | ((c[:, 0] < WING_X1) & (c[:, 1] > WING_Y0))


def add_index_accessor(tris):
    data = tris.astype(np.uint32).ravel().tobytes()
    while len(blob) % 4:
        blob.append(0)
    off = len(blob)
    blob.extend(data)
    g.bufferViews.append(G.BufferView(buffer=0, byteOffset=off, byteLength=len(data), target=G.ELEMENT_ARRAY_BUFFER))
    g.accessors.append(G.Accessor(bufferView=len(g.bufferViews) - 1, componentType=G.UNSIGNED_INT, count=tris.size, type=G.SCALAR))
    return len(g.accessors) - 1


wing_mats = {}
moved = 0
for mi, mask in move.items():
    if not mask.any():
        continue
    p = g.meshes[mi].primitives[0]
    I = read(p.indices).reshape(-1, 3)
    keep, mv = I[~mask], I[mask]
    moved += len(mv)
    if mi not in wing_mats:
        base = g.materials[p.material]
        m = G.Material(**{k: v for k, v in base.__dict__.items() if not k.startswith("_")})
        m.name = base.name + "__wing"
        pbr = base.pbrMetallicRoughness
        m.pbrMetallicRoughness = G.PbrMetallicRoughness(**{k: v for k, v in pbr.__dict__.items() if not k.startswith("_")})
        m.pbrMetallicRoughness.roughnessFactor = (pbr.roughnessFactor or 0.5) * 0.9999   # keep dedup from merging it back
        g.materials.append(m)
        wing_mats[mi] = len(g.materials) - 1
    attrs = G.Attributes(**{k: v for k, v in p.attributes.__dict__.items() if not k.startswith("_")})
    if len(keep):
        p.indices = add_index_accessor(keep)
        g.meshes.append(G.Mesh(primitives=[G.Primitive(attributes=attrs, indices=add_index_accessor(mv), material=wing_mats[mi])]))
        g.nodes.append(G.Node(mesh=len(g.meshes) - 1))
        g.scenes[0].nodes.append(len(g.nodes) - 1)
    else:
        p.material = wing_mats[mi]

g.buffers[0].byteLength = len(blob)
g.set_binary_blob(bytes(blob))
g.save_binary(dst)

a, b = np.array(pivots[0]), np.array(pivots[1])
axis = (a - b) / np.linalg.norm(a - b)
print(json.dumps({"origin": [round(v, 4) for v in b], "axis": [round(v, 5) for v in axis], "movedTris": int(moved)}))
