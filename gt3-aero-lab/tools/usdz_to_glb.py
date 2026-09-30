"""Convert the McLaren 720S LMGT3 EVO USDZ into a GLB for the aero lab.

Output frame (matches the page's car-local frame): metres, +X forward,
+Y up, Z across, ground at y = 0, car centred on x/z.

It also writes profiles.json: per-station outline measurements that the page's
flow field uses so the airflow follows this car's real shape.

Usage: python3 usdz_to_glb.py model.usdz out.glb profiles.json
Needs: pip install usd-core numpy pygltflib pillow
"""
import io
import json
import sys
import zipfile

import numpy as np
from PIL import Image
from pxr import Gf, Usd, UsdGeom, UsdShade
import pygltflib as G

src, out_glb, out_prof = sys.argv[1:4]
stage = Usd.Stage.Open(src)
mpu = UsdGeom.GetStageMetersPerUnit(stage)
zf = zipfile.ZipFile(src)

# USD (Y-up, front at +Z) -> car frame (+X forward): X = z, Y = y, Z = -x
R = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], dtype=np.float64)


def shader_inputs(mat):
    """Return (base_rgb, base_tex_path, metallic, roughness, opacity)."""
    surf = mat.ComputeSurfaceSource()[0]
    base, tex, metal, rough, opac = [0.8, 0.8, 0.8], None, 0.0, 0.5, 1.0
    if not surf:
        return base, tex, metal, rough, opac
    for inp in surf.GetInputs():
        n = inp.GetBaseName()
        src_ = inp.GetConnectedSource()
        if src_:
            if n == "diffuseColor":
                t = UsdShade.Shader(src_[0].GetPrim())
                f = t.GetInput("file")
                if f and f.Get():
                    tex = f.Get().path
                sc = t.GetInput("scale")
                if sc and sc.Get() is not None:
                    base = list(sc.Get())[:3]
                else:
                    base = [1, 1, 1]
            continue
        v = inp.Get()
        if v is None:
            continue
        if n == "diffuseColor":
            base = list(v)
        elif n == "metallic":
            metal = float(v)
        elif n == "roughness":
            rough = float(v)
        elif n == "opacity":
            opac = float(v)
    return base, tex, metal, rough, opac


gltf = G.GLTF2(asset=G.Asset(generator="usdz_to_glb.py"))
blob = bytearray()


def add_view(data, target=None):
    while len(blob) % 4:
        blob.append(0)
    off = len(blob)
    blob.extend(data)
    bv = G.BufferView(buffer=0, byteOffset=off, byteLength=len(data))
    if target:
        bv.target = target
    gltf.bufferViews.append(bv)
    return len(gltf.bufferViews) - 1


def add_acc(arr, ctype, typ, target, minmax=False):
    view = add_view(arr.tobytes(), target)
    acc = G.Accessor(bufferView=view, componentType=ctype, count=len(arr), type=typ)
    if minmax:
        acc.min = arr.min(axis=0).tolist()
        acc.max = arr.max(axis=0).tolist()
    gltf.accessors.append(acc)
    return len(gltf.accessors) - 1


mat_index, tex_index = {}, {}


def material_for(mat):
    key = str(mat.GetPath()) if mat else "__none__"
    if key in mat_index:
        return mat_index[key]
    base, tex, metal, rough, opac = shader_inputs(mat) if mat else ([.8, .8, .8], None, 0, .5, 1)
    pbr = G.PbrMetallicRoughness(baseColorFactor=[*base, opac], metallicFactor=metal, roughnessFactor=rough)
    if tex:
        if tex not in tex_index:
            raw = zf.read(tex)
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            if max(im.size) > 1024:
                im.thumbnail((1024, 1024))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=85)
            view = add_view(buf.getvalue())
            gltf.images.append(G.Image(bufferView=view, mimeType="image/jpeg"))
            if not gltf.samplers:
                gltf.samplers.append(G.Sampler(wrapS=10497, wrapT=10497))
            gltf.textures.append(G.Texture(source=len(gltf.images) - 1, sampler=0))
            tex_index[tex] = len(gltf.textures) - 1
        pbr.baseColorTexture = G.TextureInfo(index=tex_index[tex])
    m = G.Material(name=mat.GetPath().name if mat else "default", pbrMetallicRoughness=pbr, doubleSided=True)
    if opac < 0.99:
        m.alphaMode = "BLEND"
    gltf.materials.append(m)
    mat_index[key] = len(gltf.materials) - 1
    return mat_index[key]


meshes = []  # (positions, normals, uvs, indices, material)
xcache = UsdGeom.XformCache(Usd.TimeCode.Default())
for prim in stage.Traverse():
    if not prim.IsA(UsdGeom.Mesh):
        continue
    if UsdGeom.Imageable(prim).ComputeVisibility() == UsdGeom.Tokens.invisible:
        continue
    mesh = UsdGeom.Mesh(prim)
    pts = np.array(mesh.GetPointsAttr().Get(), dtype=np.float64)
    counts = np.array(mesh.GetFaceVertexCountsAttr().Get())
    fvi = np.array(mesh.GetFaceVertexIndicesAttr().Get())
    if len(pts) == 0 or len(counts) == 0:
        continue
    M = np.array(xcache.GetLocalToWorldTransform(prim), dtype=np.float64)  # row-vector convention
    wp = (np.c_[pts, np.ones(len(pts))] @ M)[:, :3] * mpu
    nmat = np.linalg.inv(M[:3, :3]).T

    # triangulate (fan) in face-vertex space
    starts = np.r_[0, np.cumsum(counts)[:-1]]
    tri_fv = []
    for s, c in zip(starts, counts):
        for k in range(1, c - 1):
            tri_fv.append((s, s + k, s + k + 1))
    tri_fv = np.array(tri_fv, dtype=np.int64)
    if mesh.GetOrientationAttr().Get() == UsdGeom.Tokens.leftHanded:
        tri_fv = tri_fv[:, [0, 2, 1]]
    if np.linalg.det(M[:3, :3]) < 0:
        tri_fv = tri_fv[:, [0, 2, 1]]
    fv = tri_fv.reshape(-1)

    P = wp[fvi[fv]]

    # normals
    nrm = mesh.GetNormalsAttr().Get()
    ninterp = mesh.GetNormalsInterpolation()
    pv = UsdGeom.PrimvarsAPI(prim)
    if pv.HasPrimvar("normals"):
        pn = pv.GetPrimvar("normals")
        nrm = pn.ComputeFlattened()
        ninterp = pn.GetInterpolation()
    if nrm is not None and len(nrm):
        nrm = np.array(nrm, dtype=np.float64) @ nmat.T
        if ninterp == "faceVarying":
            N = nrm[fv]
        elif ninterp in ("vertex", "varying"):
            N = nrm[fvi[fv]]
        else:
            N = None
    else:
        N = None
    if N is None:
        a, b, c = P[0::3], P[1::3], P[2::3]
        fn = np.cross(b - a, c - a)
        N = np.repeat(fn, 3, axis=0)
    N = N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12)

    # uvs
    UV = None
    for name in ("st0", "st", "UVMap", "uv"):
        if pv.HasPrimvar(name):
            p = pv.GetPrimvar(name)
            vals = p.ComputeFlattened()
            if vals is None:
                continue
            vals = np.array(vals, dtype=np.float64)
            it = p.GetInterpolation()
            if it == "faceVarying":
                UV = vals[fv]
            elif it in ("vertex", "varying"):
                UV = vals[fvi[fv]]
            break
    if UV is None:
        UV = np.zeros((len(P), 2))
    UV = UV.copy()
    UV[:, 1] = 1.0 - UV[:, 1]

    P = P @ R.T
    N = N @ R.T
    mat = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
    meshes.append([P, N, UV, mat])

# place: ground at y=0 (from wheels = lowest 1% of points), centre x/z
allP = np.concatenate([m[0] for m in meshes])
ground = np.percentile(allP[:, 1], 0.2)
cx = (np.percentile(allP[:, 0], 0.1) + np.percentile(allP[:, 0], 99.9)) / 2
cz = (np.percentile(allP[:, 2], 0.1) + np.percentile(allP[:, 2], 99.9)) / 2
off = np.array([cx, ground, cz])

node_ids = []
for P, N, UV, mat in meshes:
    P = P - off
    # weld identical vertices
    key = np.c_[np.round(P, 5), np.round(N, 3), np.round(UV, 4)]
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    first = np.zeros(len(uniq), dtype=np.int64)
    first[inv[::-1]] = np.arange(len(inv))[::-1]
    Pw = P[first].astype(np.float32)
    Nw = N[first].astype(np.float32)
    UVw = UV[first].astype(np.float32)
    idx = inv.astype(np.uint32)
    a_p = add_acc(Pw, G.FLOAT, G.VEC3, G.ARRAY_BUFFER, True)
    a_n = add_acc(Nw, G.FLOAT, G.VEC3, G.ARRAY_BUFFER)
    a_t = add_acc(UVw, G.FLOAT, G.VEC2, G.ARRAY_BUFFER)
    a_i = add_acc(idx, G.UNSIGNED_INT, G.SCALAR, G.ELEMENT_ARRAY_BUFFER)
    prim = G.Primitive(attributes=G.Attributes(POSITION=a_p, NORMAL=a_n, TEXCOORD_0=a_t), indices=a_i, material=material_for(mat))
    gltf.meshes.append(G.Mesh(primitives=[prim]))
    gltf.nodes.append(G.Node(mesh=len(gltf.meshes) - 1))
    node_ids.append(len(gltf.nodes) - 1)

gltf.scenes.append(G.Scene(nodes=node_ids))
gltf.scene = 0
gltf.buffers.append(G.Buffer(byteLength=len(blob)))
gltf.set_binary_blob(bytes(blob))
gltf.save_binary(out_glb)

# ---------- outline profiles for the flow field ----------
V = allP - off
xmin, xmax = np.percentile(V[:, 0], 0.05), np.percentile(V[:, 0], 99.95)
ymax_all = np.percentile(V[:, 1], 99.9)
stations = 48
xs = np.linspace(xmax, xmin, stations)          # nose -> tail
half = (xmax - xmin) / (stations - 1) / 2 + 0.02
prof = {"xf": float(xmax), "xr": float(xmin), "w": [], "yb": [], "shoulder": [], "roof": [], "roofW": []}
for x in xs:
    sl = V[np.abs(V[:, 0] - x) < half]
    # ignore rear wing & its mounts when measuring the body
    body = sl[sl[:, 1] < 1.02] if len(sl) else sl
    if len(body) < 20:
        prof["w"].append(0.3); prof["yb"].append(0.2); prof["shoulder"].append(0.25)
        prof["roof"].append(0.0); prof["roofW"].append(0.0)
        continue
    w = np.percentile(np.abs(body[:, 2]), 99.5)
    low = body[body[:, 1] > 0.02]
    yb = np.percentile(low[:, 1], 1) if len(low) else 0.1
    outer = body[np.abs(body[:, 2]) > 0.55]
    shoulder = np.percentile(outer[:, 1], 99) if len(outer) > 10 else np.percentile(body[:, 1], 98)
    centre = sl[(np.abs(sl[:, 2]) < 0.25) & (sl[:, 1] < 1.35)]
    roof = np.percentile(centre[:, 1], 99.5) if len(centre) > 10 else 0
    upper = sl[(sl[:, 1] > shoulder + 0.05) & (sl[:, 1] < 1.35)]
    roofW = np.percentile(np.abs(upper[:, 2]), 97) if len(upper) > 10 else 0
    prof["w"].append(float(w)); prof["yb"].append(float(yb)); prof["shoulder"].append(float(shoulder))
    prof["roof"].append(float(roof)); prof["roofW"].append(float(roofW))

prof["height"] = float(ymax_all)
with open(out_prof, "w") as f:
    json.dump(prof, f, indent=1)

tris = sum(gltf.accessors[p.indices].count for m in gltf.meshes for p in m.primitives) // 3
print(f"meshes {len(gltf.meshes)}  tris {tris}  materials {len(gltf.materials)}  textures {len(gltf.textures)}  bytes {len(blob)}")
print("length", xmax - xmin, "height", ymax_all, "offset", off)
