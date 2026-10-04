# GT3 Aero Lab

An interactive virtual wind tunnel built with Three.js. It shows how race-car aerodynamics work on three cars you can switch between: the McLaren 720S GT3 EVO, a Red Bull Racing Formula 1 car and the Aston Martin Valkyrie.

Serve the folder and open `index.html`, for example with `python3 -m http.server` and then http://localhost:8000. There's no build step, and Three.js r128 loads from a CDN. If you open the file directly from disk, the browser blocks loading the `.glb`, so the page shows its simplified stand-in car instead.

## What it shows

- **Three cars**: pick one under *Car* at the top of the panel, or open the page with `#car=redbull` / `#car=valkyrie`. Each has its own model, airflow shape, aero numbers, moving wing, spinning wheels and feature notes.
  - McLaren 720S LMGT3 EVO (`mclaren-720s-gt3-evo.glb`): a GT3 car, downforce split between the wing and the floor.
  - Red Bull Racing F1 (`redbull-f1.glb`): a 2019–21-era Formula 1 car, with about twice the GT3 car's downforce. The wing slider moves the upper rear-wing flap, as DRS does.
  - Aston Martin Valkyrie (`aston-martin-valkyrie.glb`): a road hypercar that makes most of its downforce with venturi tunnels under the floor. The wing slider pivots its rear blade.
- **Detailed 3D cars**: drag to orbit, use the camera presets, or use the view-heading slider for a full 360° turn.
- **Airflow**: by default, *CFD glow*: luminous white-blue tubes around the splitter, underfloor, sidepods, roof and rear wing. They spiral through the trailing vortices off the wing tips, diffuser edges and dive planes, and writhe in the turbulent wake. *Clean tubes* gives a few thick white smoke tubes like a tunnel smoke wand, and *Dense rake* a full grid of thin glowing lines. You can also turn on fast tracer particles and velocity-vector slices. The smoke is white by default, or you can colour it by pressure (blue = suction, red = high pressure).
- **Pressure zones**: a heat map painted on the body that updates in real time. It's off by default so the livery shows.
- **Controls**: speed (0–300 km/h), yaw (0–20°) and rear wing angle. The wing really tilts on the model, like the real car: the main plane, endplates and bracket plates swing about the pivot bolts on the swan necks, and the slot bolts move with them. The swan necks and their bolts stay fixed. The tilt is drawn at 2× so small changes show. The model's own wheels (tyre, rim, centre-lock, brake disc) roll exactly with the rolling road beneath them, with no slip (the scene runs in slow motion: about 4.7 turns a second at 250 km/h) about their real cambered axles, with a light motion blur near top speed. Their axles are measured from the brake discs so they run true to about 2 mm; the brake calipers stay fixed. The tyres were sculpted with a loaded flat spot, so the build re-rounds them; otherwise the flat spot would travel round and look like a wobble.
- **Cinema**: hides the overlays and moves the camera to a low ¾-front angle under dramatic key and rim lighting.
- **Forces**: downforce arrows on each axle, plus drag and side-force arrows. Live numbers show downforce, drag, C<sub>L</sub>, C<sub>D</sub>, L/D, aero balance, drag power and dynamic pressure, plus a downforce/drag vs speed chart.
- **Feature inspector**: click a part (splitter, dive planes, louvres, diffuser, wing) to fly the camera to it and read how it works.

## Use it as a website background

Open the page with `#bg` (for example `index.html#bg`, or `index.html#bg&car=valkyrie` for another car) and it shows only the car, the glowing airflow and the dark studio, filling the window with a slow camera orbit and no UI. See [EMBED.md](EMBED.md) for the copy-paste `<iframe>` snippet.

## Model notes

This is a teaching model, not CFD. Forces use `F = ½ρv²A·C` with coefficients tuned to typical figures for each kind of car at the 7° reference wing: GT3 C<sub>L</sub> ≈ −1.18, C<sub>D</sub> ≈ 0.365, A = 1.95 m²; F1 C<sub>L</sub> ≈ −3.2, C<sub>D</sub> ≈ 0.86, A = 1.5 m²; Valkyrie C<sub>L</sub> ≈ −2.2, C<sub>D</sub> ≈ 0.42, A = 1.75 m² (about 1,100 kg of downforce at 240 km/h). Yaw and wing-angle sensitivities are simplified. The flow field is an analytic approximation. It is built around a signed-distance field baked from the real car mesh (`car-sdf.js`, 4 cm voxels, about 1.6 cm mean surface error), with circulation models for the rear wing and trailing vortices at the wing tips, diffuser edges and dive planes. Each smoke tube aims at a target point a few centimetres off the bodywork (bonnet, A-pillars, roof, wing mirrors, sidepods, rear wing). Its start point at the inlet is found by tracing forwards and correcting by the miss, so the tubes skim the real surfaces and spread across the car instead of bunching up.

## Rebuilding the model

`mclaren-720s-gt3-evo.glb` was made from the supplied USDZ like this:

```sh
pip install usd-core numpy pygltflib pillow
python3 tools/usdz_to_glb.py McLaren_720S_LMGT3_EVO.usdz raw.glb profiles.json
python3 tools/split_wing.py raw.glb raw_wing.glb      # prints the hinge axis used as WING_HINGE
python3 tools/split_wheels.py raw_wing.glb raw_ww.glb    # prints hub centres and axles used as WHEELS (needs scipy)
python3 tools/build_sdf.py raw_wing.glb car-sdf.js     # distance field of the real car for the airflow (needs scipy)
npx @gltf-transform/cli@4 optimize raw_ww.glb mclaren-720s-gt3-evo.glb \
  --compress quantize --texture-compress webp --texture-size 1024 \
  --simplify-ratio 0.5 --simplify-error 0.0005
```

`split_wheels.py` does the same for each wheel's rotating parts (`__wheelFL` etc.). `split_wing.py` gives the moving wing parts their own `__wing` materials, so the optimizer keeps them as separate meshes, and measures the hinge axis through both pivot bolts. The converter squares the car up using its wheels (the source model sits about 3° yawed), rotates it to face +X, scales it to metres and puts it on the ground. It also writes `profiles.json`, the car's outline measured at 48 stations along its length. Those numbers are embedded in `index.html` as `MEASURED`, and the flow field uses them so the smoke follows this car's real shape.

### The Red Bull and the Valkyrie

Both came from Sketchfab as FBX files with separate textures. They were converted like this:

```sh
npm i fbx2gltf                               # FBX2glTF converter
FBX2glTF --binary --input "Red Bull Final.fbx" --output rb_raw
FBX2glTF --binary --input "Aston Martin Valkyrie.fbx" --output am_raw
python3 tools/fbx_car_to_glb.py redbull rb_raw.glb rb/textures redbull-raw.glb      # prints WHEELS and the wing hinge
python3 tools/fbx_car_to_glb.py valkyrie am_raw.glb am/textures valkyrie-raw.glb
npx @gltf-transform/cli@4 optimize redbull-raw.glb redbull-f1.glb --compress quantize --texture-compress webp \
  --texture-size 2048 --simplify-ratio 0.5 --simplify-error 0.0005
npx @gltf-transform/cli@4 optimize valkyrie-raw.glb aston-martin-valkyrie.glb --compress quantize --texture-compress webp \
  --texture-size 1024 --simplify-ratio 0.5 --simplify-error 0.0005
python3 tools/build_sdf.py redbull-raw.glb car-sdf-redbull.js redbull '[[-9,-1.7,0.7,9],[2.1,9,-1,0.38]]' 1
python3 tools/build_sdf.py valkyrie-raw.glb car-sdf-valkyrie.js valkyrie '[[-9,-1.85,0.66,9]]' 1
python3 tools/measure_profile.py redbull-raw.glb redbull-profile.json 0.75     # the car's "measured" outline
python3 tools/measure_profile.py valkyrie-raw.glb valkyrie-profile.json 1.2
```

`fbx_car_to_glb.py` bakes the scene into the page's frame (the Valkyrie's doors come in open, so it closes them from the model's own door animation), scales each car to its real width, attaches the textures, tags the spinning wheel parts and the moving wing, and prints their hubs and hinge. The numbers go into `CARS` in `index.html`. For these hollow bodies `build_sdf.py` also fills spaces the body surrounds on five sides or more, so the F1 monocoque counts as solid while the Valkyrie's venturi tunnels and the gap between the F1 nose and front wheels stay open.

## Slipangle link

To show a footer link to the Slipangle site, set `SLIPANGLE_URL` near the top of the script in `index.html`.
