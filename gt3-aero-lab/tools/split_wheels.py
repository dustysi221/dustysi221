"""Separate the rotating parts of each wheel so the page can spin them.

Hub centre and spin axis come from the brake disc (see below), so the wheels run true.

Runs after split_wing.py (meshes not yet joined). For each wheel it takes the meshes that are
centred on that wheel's axle (tyre, rim, rim face / centre-lock, brake disc) and gives them a
copy of their material named "<name>__wheel<FL|FR|RL|RR>", so the optimizer keeps every wheel
as its own mesh. Off-centre parts such as the brake calipers keep their material and stay put.

It prints each wheel's hub centre and spin axis (from the brake disc) as JSON for index.html
(WHEELS).

Usage: python3 split_wheels.py raw_wing.glb raw_ww.glb
"""
import json
import sys

import numpy as np
import pygltflib as G

src, dst = sys.argv[1:3]
g = G.GLTF2().load(src)
blob = g.binary_blob()


def read(i):
    a = g.accessors[i]
    bv = g.bufferViews[a.bufferView]
    dt = {5126: np.float32, 5125: np.uint32}[a.componentType]
    n = {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[a.type]
    r = np.frombuffer(blob, dtype=dt, count=a.count * n, offset=bv.byteOffset + (a.byteOffset or 0))
    return r.reshape(-1, n) if n > 1 else r


meshes = []
for mi, m in enumerate(g.meshes):
    p = m.primitives[0]
    P = read(p.attributes.POSITION).astype(np.float64)
    meshes.append((mi, g.materials[p.material].name, P))

# the tyres locate the wheels
wheels = {}
for mi, name, P in meshes:
    if "110" not in name:
        continue
    c = (P.min(0) + P.max(0)) / 2
    key = ("F" if c[0] > 0 else "R") + ("L" if c[2] > 0 else "R")
    # spin axis = direction of least spread of the tyre (it is a flat ring)
    Q = P - P.mean(0)
    _, _, vt = np.linalg.svd(Q, full_matrices=False)
    axis = vt[-1]
    if axis[2] < 0:
        axis = -axis                       # point outward-left consistently (+Z)
    wheels[key] = {"mesh": mi, "c": c, "axis": axis, "r": float((P.max(0) - P.min(0))[1] / 2)}
assert len(wheels) == 4, "expected four tyres"

# rotating parts: meshes centred on a hub (within 2 cm in x and y) and no wider than the tyre
assign = {}
for mi, name, P in meshes:
    c = (P.min(0) + P.max(0)) / 2
    ext = P.max(0) - P.min(0)
    for key, w in wheels.items():
        if (abs(c[0] - w["c"][0]) < 0.02 and abs(c[1] - w["c"][1]) < 0.02
                and abs(c[2] - w["c"][2]) < 0.2 and max(ext[0], ext[1]) <= 2 * w["r"] + 0.02):
            assign[mi] = key

for mi, key in assign.items():
    p = g.meshes[mi].primitives[0]
    base = g.materials[p.material]
    m = G.Material(**{k: v for k, v in base.__dict__.items() if not k.startswith("_")})
    m.name = base.name + "__wheel" + key
    pbr = base.pbrMetallicRoughness
    m.pbrMetallicRoughness = G.PbrMetallicRoughness(**{k: v for k, v in pbr.__dict__.items() if not k.startswith("_")})
    m.pbrMetallicRoughness.roughnessFactor = (pbr.roughnessFactor or 0.5) * (0.9998 - 0.0001 * "FL FR RL RR".split().index(key))
    g.materials.append(m)
    p.material = len(g.materials) - 1

# Refine each hub from its brake disc: a thin, perfectly flat ring, so its plane normal is the
# true spin axis and its centroid the true hub. The tyre's bounding box sits ~6 mm off (the tread
# is not centred on the box), and spinning about that point made the wheels wobble.
for key, w in wheels.items():
    for mi, k in assign.items():
        name = g.materials[g.meshes[mi].primitives[0].material].name
        if k == key and "108" in name:
            P = next(P for m2, _, P in meshes if m2 == mi)
            c = P.mean(0)
            _, _, vt = np.linalg.svd(P - c, full_matrices=False)
            a = vt[-1] if vt[-1][2] > 0 else -vt[-1]
            w["c"], w["axis"] = c, a

# Re-round the tyres. The model's tyres are sculpted "loaded": a ~13-15 mm flat contact patch
# and a slight sidewall bulge at the bottom. That is right for a parked car, but once the tyre
# spins the flat spot travels round and the wheel looks like it wobbles. Every vertex in the
# squashed bottom sector takes its (radius, axial) position from the matching vertex on the
# undeformed top of the same tyre, keeping its own angle, so the tyre turns perfectly true.
from scipy.spatial import cKDTree

buf = bytearray(blob)


def rotate(P, c, a, t):
    d = P - c
    return c + d * np.cos(t) + np.cross(a, d) * np.sin(t) + np.outer(d @ a, a) * (1 - np.cos(t))


for key, w in wheels.items():
    mi = w["mesh"]
    acc_i = g.meshes[mi].primitives[0].attributes.POSITION
    P = next(P for m2, _, P in meshes if m2 == mi).copy()
    c, a = np.asarray(w["c"]), np.asarray(w["axis"])
    d = P - c
    h = d @ a
    radial = d - np.outer(h, a)
    r = np.linalg.norm(radial, axis=1)
    down = np.array([0.0, -1.0, 0.0])
    down = down - (down @ a) * a
    down /= np.linalg.norm(down)
    cos_down = (radial @ down) / np.maximum(r, 1e-9)
    bottom = cos_down > np.cos(np.radians(75))
    top = cos_down < -np.cos(np.radians(75))
    tree = cKDTree(P[top])
    _, nn = tree.query(rotate(P[bottom], c, a, np.pi))
    ref = P[top][nn] - c
    ref_h = ref @ a
    ref_r = np.linalg.norm(ref - np.outer(ref_h, a), axis=1)
    unit = radial[bottom] / np.maximum(r[bottom], 1e-9)[:, None]
    P[bottom] = c + unit * ref_r[:, None] + np.outer(ref_h, a)
    acc = g.accessors[acc_i]
    bv = g.bufferViews[acc.bufferView]
    off = bv.byteOffset + (acc.byteOffset or 0)
    buf[off:off + P.size * 4] = P.astype(np.float32).tobytes()
    acc.min = P.min(0).astype(float).tolist()
    acc.max = P.max(0).astype(float).tolist()
    print("re-rounded tyre", key, "bottom vertices", int(bottom.sum()), file=sys.stderr)
g.set_binary_blob(bytes(buf))

g.save_binary(dst)
out = {k: {"c": [round(float(v), 4) for v in w["c"]], "axis": [round(float(v), 5) for v in w["axis"]], "r": round(w["r"], 3)}
       for k, w in sorted(wheels.items())}
print(json.dumps(out))
print("rotating meshes per wheel:", {k: sum(1 for v in assign.values() if v == k) for k in sorted(wheels)}, file=sys.stderr)
