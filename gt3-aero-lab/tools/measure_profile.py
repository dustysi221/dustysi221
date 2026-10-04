"""Measure a car GLB's outline at 48 stations along its length (the page's MEASURED profile).

usdz_to_glb.py does this for the McLaren as it converts. This does the same for any car GLB
already in the page's frame (fbx_car_to_glb.py output). Wheels ("__wheel" materials) are left out,
so an open-wheel car's outline is its body, not its tyres.

Usage: python3 measure_profile.py car.glb profile.json [BODY_YMAX]
  BODY_YMAX  ignore anything higher when measuring the body (the rear wing), default 1.02
"""
import json
import sys

import numpy as np
import pygltflib as G

src, dst = sys.argv[1:3]
BODY_YMAX = float(sys.argv[3]) if len(sys.argv) > 3 else 1.02
g = G.GLTF2().load(src)
blob = g.binary_blob()


def read(i):
    a = g.accessors[i]
    bv = g.bufferViews[a.bufferView]
    r = np.frombuffer(blob, dtype=np.float32, count=a.count * 3, offset=(bv.byteOffset or 0) + (a.byteOffset or 0))
    return r.reshape(-1, 3).astype(np.float64)


pts, wheel = [], []
for m in g.meshes:
    p = m.primitives[0]
    V = read(p.attributes.POSITION)
    pts.append(V)
    wheel.append(np.full(len(V), "__wheel" in g.materials[p.material].name))
V = np.concatenate(pts)
W = np.concatenate(wheel)
wc = {}
for name in ("FL", "FR", "RL", "RR"):
    sel = [read(m.primitives[0].attributes.POSITION) for m in g.meshes if g.materials[m.primitives[0].material].name.endswith("__wheel" + name)]
    if sel:
        q = np.concatenate(sel)
        wc[name] = (q.min(0) + q.max(0)) / 2

xmin, xmax = np.percentile(V[:, 0], 0.05), np.percentile(V[:, 0], 99.95)
ymax_all = np.percentile(V[:, 1], 99.9)
B = V[~W]
stations = 48
xs = np.linspace(xmax, xmin, stations)          # nose -> tail
half = (xmax - xmin) / (stations - 1) / 2 + 0.02
prof = {"xf": float(xmax), "xr": float(xmin), "w": [], "yb": [], "shoulder": [], "roof": [], "roofW": []}
for x in xs:
    sl = B[np.abs(B[:, 0] - x) < half]
    body = sl[sl[:, 1] < BODY_YMAX] if len(sl) else sl
    if len(body) < 20:
        prof["w"].append(0.3); prof["yb"].append(0.2); prof["shoulder"].append(0.25)
        prof["roof"].append(0.0); prof["roofW"].append(0.0)
        continue
    w = np.percentile(np.abs(body[:, 2]), 99.5)
    low = body[body[:, 1] > 0.02]
    yb = np.percentile(low[:, 1], 1) if len(low) else 0.1
    outer = body[np.abs(body[:, 2]) > 0.55 * w]
    shoulder = np.percentile(outer[:, 1], 99) if len(outer) > 10 else np.percentile(body[:, 1], 98)
    centre = sl[(np.abs(sl[:, 2]) < 0.25) & (sl[:, 1] < 1.35)]
    roof = np.percentile(centre[:, 1], 99.5) if len(centre) > 10 else 0
    upper = sl[(sl[:, 1] > shoulder + 0.05) & (sl[:, 1] < 1.35)]
    roofW = np.percentile(np.abs(upper[:, 2]), 97) if len(upper) > 10 else 0
    prof["w"].append(round(float(w), 3)); prof["yb"].append(round(float(yb), 3)); prof["shoulder"].append(round(float(shoulder), 3))
    prof["roof"].append(round(float(roof), 3)); prof["roofW"].append(round(float(roofW), 3))
prof["xf"], prof["xr"] = round(prof["xf"], 3), round(prof["xr"], 3)
prof["height"] = round(float(ymax_all), 3)
if len(wc) == 4:
    prof["axles"] = {"front": round(float((wc["FL"][0] + wc["FR"][0]) / 2), 3), "rear": round(float((wc["RL"][0] + wc["RR"][0]) / 2), 3)}
with open(dst, "w") as f:
    json.dump(prof, f, separators=(",", ":"))
print(json.dumps(prof, separators=(",", ":")))
