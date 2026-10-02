"""Bake a signed-distance field of the real car for the flow field.

The page's airflow needs to know how far any point is from the bodywork. A few smooth
lofts were too coarse (7 cm average error, up to ~0.5 m around the bonnet dip, cabin and
wing), which left the smoke floating. This voxelises the actual mesh instead:

  * every triangle is sampled densely and its points mark surface voxels
    (this keeps thin parts such as the rear wing and its mounts)
  * the body is made solid column by column between its lowest and highest surface,
    leaving out the wing assembly so air can still pass under the wing
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


tris, is_wing = [], []
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
T = np.concatenate(tris)
W = np.concatenate(is_wing)

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
keep = pts[:, 1] < 1.3          # drop the roof antenna; it's a wire, not an obstacle
pts, pw = pts[keep], pw[keep]


def vox(p):
    return (np.floor((p[:, 0] - X0) / VOX).astype(int),
            np.floor((p[:, 1] - Y0) / VOX).astype(int),
            np.floor((p[:, 2] - Z0) / VOX).astype(int))


occ = np.zeros((NX, NY, NZ), bool)
ix, iy, iz = vox(pts)
ok = (ix >= 0) & (ix < NX) & (iy >= 0) & (iy < NY) & (iz >= 0) & (iz < NZ)
occ[ix[ok], iy[ok], iz[ok]] = True

# solid body: fill each (x, z) column between its lowest and highest body surface
body = ok & ~pw
lo = np.full((NX, NZ), NY, int)
hi = np.full((NX, NZ), -1, int)
np.minimum.at(lo, (ix[body], iz[body]), iy[body])
np.maximum.at(hi, (ix[body], iz[body]), iy[body])
ys = np.arange(NY)[None, :, None]
occ |= (ys >= lo[:, None, :]) & (ys <= hi[:, None, :])

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
