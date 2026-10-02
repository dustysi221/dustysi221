"""Bake a signed-distance field of the real car for the flow field.

The page's airflow needs to know how far any point is from the bodywork. A few smooth
lofts were too coarse (7 cm average error, up to ~0.5 m around the bonnet dip, cabin and
wing), which left the smoke floating. This voxelises the actual mesh instead:

  * every triangle is sampled densely and its points mark surface voxels
    (this keeps thin parts such as the rear wing and its mounts)
  * the body is made solid column by column, bridging only gaps up to 48 cm, so real
    open-air gaps (under the mirrors, under the rear wing) stay empty
  * a Euclidean distance transform turns that into signed distance (cm, int8)

Usage: python3 build_sdf.py raw_wing.glb car-sdf.js
Needs: numpy, scipy, pygltflib
"""
import base64
import json
import sys

import numpy as np
import pygltflib as G
from scipy import ndimage

src, dst = sys.argv[1:3]
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
    # the wing assembly and its mounts: surface only, never filled solid underneath
    wing = np.full(len(T), "__wing" in name)
    wing |= (c[:, 0] < -1.75) & (c[:, 1] > 0.92)
    tris.append(T)
    is_wing.append(wing)
    is_tyre.append(np.full(len(T), "110" in name))   # tyre material
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
    f.write("window.CAR_SDF = " + json.dumps(payload) + ";\n")
print("grid", NX, NY, NZ, "solid voxels", int(occ.sum()), "bytes", len(payload["data"]))
