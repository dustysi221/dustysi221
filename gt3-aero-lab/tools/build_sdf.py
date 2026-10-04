"""Bake a signed-distance field of the real car for the flow field.

The page's airflow needs to know how far any point is from the bodywork. A few smooth
lofts were too coarse (7 cm average error, up to ~0.5 m around the bonnet dip, cabin and
wing), which left the smoke floating. This voxelises the actual mesh instead:

  * every triangle is sampled densely and its points mark surface voxels
    (this keeps thin parts such as the rear wing and its mounts)
  * the body is made solid column by column, bridging only gaps up to 48 cm, so real
    open-air gaps (under the mirrors, under the rear wing) stay empty
  * a Euclidean distance transform turns that into signed distance (cm, int8)

Usage: python3 build_sdf.py raw_wing.glb car-sdf.js [car-id [WINGS [ENCLOSED]]]
  car-id  name for the car switcher: the file sets window.CAR_SDFS[car-id]
          (without it, window.CAR_SDF: the McLaren)
  WINGS   JSON list of boxes [xmin, xmax, ymin, ymax] holding wings: they are kept as thin
          surfaces and never filled solid, so air passes between them and the body
          (default [[-9, -1.75, 0.92, 9]]: the McLaren's rear wing and its mounts)
  ENCLOSED  1 = also fill spaces the body encloses on five sides or more (hollow shells taller
            than MAX_GAP: an F1 monocoque, a hypercar's cockpit), default 0
Needs: numpy, scipy, pygltflib
"""
import base64
import json
import sys

import numpy as np
import pygltflib as G
from scipy import ndimage

src, dst = sys.argv[1:3]
CAR_ID = sys.argv[3] if len(sys.argv) > 3 else None
WINGS = json.loads(sys.argv[4]) if len(sys.argv) > 4 else [[-9, -1.75, 0.92, 9]]
ENCLOSED = int(sys.argv[5]) if len(sys.argv) > 5 else 0
VOX = 0.04
X0, X1, Y0, Y1, Z0, Z1 = -3.0, 3.0, 0.0, 1.6, -1.4, 1.4
NX, NY, NZ = round((X1 - X0) / VOX), round((Y1 - Y0) / VOX), round((Z1 - Z0) / VOX)

g = G.GLTF2().load(src)
blob = g.binary_blob()


def read(i):
    a = g.accessors[i]
    bv = g.bufferViews[a.bufferView]
    dt = {5126: np.float32, 5125: np.uint32}[a.componentType]
    n = {"VEC3": 3, "VEC2": 2, "SCALAR": 1}[a.type]
    r = np.frombuffer(blob, dtype=dt, count=a.count * n, offset=bv.byteOffset + (a.byteOffset or 0))
    return r.reshape(-1, n) if n > 1 else r


tris, is_wing, is_tyre = [], [], []
for m in g.meshes:
    p = m.primitives[0]
    T = read(p.attributes.POSITION).astype(np.float64)[read(p.indices).reshape(-1, 3)]
    name = g.materials[p.material].name
    c = T.mean(1)
    # wings and their mounts: surface only, never filled solid underneath
    wing = np.full(len(T), "__wing" in name)
    for x0, x1, y0, y1 in WINGS:
        wing |= (c[:, 0] > x0) & (c[:, 0] < x1) & (c[:, 1] > y0) & (c[:, 1] < y1)
    tris.append(T)
    is_wing.append(wing)
    is_tyre.append(np.full(len(T), "110" in name or "__wheel" in name))   # tyre (McLaren) / wheel material
T = np.concatenate(tris)
W = np.concatenate(is_wing)
TY = np.concatenate(is_tyre)

# dense surface samples (~1.2 cm apart)
rng = np.random.default_rng(1)
a, b, c = T[:, 0], T[:, 1], T[:, 2]
area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
n = np.clip((area / 0.012 ** 2).astype(int), 1, 2000)
idx = np.repeat(np.arange(len(T)), n)
r1 = np.sqrt(rng.random(len(idx)))
r2 = rng.random(len(idx))
pts = (1 - r1)[:, None] * a[idx] + (r1 * (1 - r2))[:, None] * b[idx] + (r1 * r2)[:, None] * c[idx]
pw = W[idx]
pt = TY[idx]
keep = pts[:, 1] < 1.3          # drop the roof antenna; it's a wire, not an obstacle
pts, pw, pt = pts[keep], pw[keep], pt[keep]


def vox(p):
    return (np.floor((p[:, 0] - X0) / VOX).astype(int),
            np.floor((p[:, 1] - Y0) / VOX).astype(int),
            np.floor((p[:, 2] - Z0) / VOX).astype(int))


occ = np.zeros((NX, NY, NZ), bool)
ix, iy, iz = vox(pts)
ok = (ix >= 0) & (ix < NX) & (iy >= 0) & (iy < NY) & (iz >= 0) & (iz < NZ)
occ[ix[ok], iy[ok], iz[ok]] = True

# solid body: in each vertical column, bridge the gaps between body surfaces that are at most
# MAX_GAP tall (cabin, doors, floor to roof). Bigger gaps are open air and stay empty, such as
# the ~0.5 m under each wing mirror. The wing assembly is left out so air passes under it.
MAX_GAP = 12  # voxels = 48 cm (the gap under a mirror is ~52 cm)
body = np.zeros((NX, NY, NZ), bool)
sel = ok & ~pw
body[ix[sel], iy[sel], iz[sel]] = True
for i in range(NX):
    for k in range(NZ):
        ys = np.flatnonzero(body[i, :, k])
        if len(ys) < 2:
            continue
        gaps = np.diff(ys)
        for y0, gap in zip(ys[:-1], gaps):
            if 1 < gap <= MAX_GAP:
                occ[i, y0:y0 + gap, k] = True

# Hollow bodies taller than MAX_GAP (an F1 monocoque, a hypercar's cockpit and engine bay) need
# a real inside test. A point is inside when the body surrounds it: looking along the six axis
# directions it sees bodywork in at least five (the cockpit is open only upwards). Air in a
# channel (venturi tunnels, under the floor, between the nose and the front wheels) sees out
# along it in two or more directions and stays empty. Wings don't count as walls.
if ENCLOSED:
    seen = np.zeros(body.shape, np.int8)
    for ax in range(3):
        c = np.cumsum(body, axis=ax)
        total = np.take(c, [-1], axis=ax)
        seen += (c - body > 0)              # bodywork before this voxel along the axis
        seen += (total - c > 0)             # bodywork after it
    occ |= seen >= 5

# Ground clearance. The floor sits only ~3-4 cm off the road, inside the bottom 4 cm voxel layer,
# so it would merge with the road and seal the underside. Keep that layer open everywhere except
# under the tyres, so air can flow under the floor from the splitter to the diffuser.
tyre_cols = np.zeros((NX, NZ), bool)
tsel = ok & pt & (iy <= 1)
tyre_cols[ix[tsel], iz[tsel]] = True
tyre_cols = ndimage.binary_dilation(tyre_cols, iterations=1)
occ[:, 0, :] &= tyre_cols

d_out = ndimage.distance_transform_edt(~occ) * VOX
d_in = ndimage.distance_transform_edt(occ) * VOX
sdf = np.where(occ, -(d_in - VOX / 2), d_out - VOX / 2)
q = np.clip(np.round(sdf * 100), -127, 127).astype(np.int8)   # centimetres

payload = {
    "origin": [X0 + VOX / 2, Y0 + VOX / 2, Z0 + VOX / 2],
    "step": VOX,
    "dims": [NX, NY, NZ],
    "data": base64.b64encode(q.tobytes(order="C")).decode(),   # index = (ix*NY + iy)*NZ + iz
}
with open(dst, "w") as f:
    f.write("// Signed distance to the car (cm, int8), baked by tools/build_sdf.py\n")
    if CAR_ID:
        f.write("(window.CAR_SDFS = window.CAR_SDFS || {})[" + json.dumps(CAR_ID) + "] = " + json.dumps(payload) + ";\n")
    else:
        f.write("window.CAR_SDF = " + json.dumps(payload) + ";\n")
print("grid", NX, NY, NZ, "solid voxels", int(occ.sum()), "bytes", len(payload["data"]))
