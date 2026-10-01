# GT3 Aero Lab

An interactive virtual wind tunnel for the McLaren 720S GT3 EVO, built with Three.js. It shows how GT3 aerodynamics work.

Serve the folder and open `index.html`, for example with `python3 -m http.server` and then http://localhost:8000. There's no build step, and Three.js r128 loads from a CDN. If you open the file directly from disk, the browser blocks loading the `.glb`, so the page shows its simplified stand-in car instead.

## What it shows

- **Detailed 3D car**: the McLaren 720S LMGT3 EVO model in `mclaren-720s-gt3-evo.glb`. Drag to orbit, use the camera presets, or use the view-heading slider for a full 360° turn.
- **Airflow**: by default, *CFD glow*: luminous white-blue tubes around the splitter, underfloor, sidepods, roof and rear wing. They spiral through the trailing vortices off the wing tips, diffuser edges and dive planes, and writhe in the turbulent wake. *Clean tubes* gives a few thick white smoke tubes like a tunnel smoke wand, and *Dense rake* a full grid of thin glowing lines. You can also turn on fast tracer particles and velocity-vector slices. The smoke is white by default, or you can colour it by pressure (blue = suction, red = high pressure).
- **Pressure zones**: a heat map painted on the body that updates in real time. It's off by default so the livery shows.
- **Controls**: speed (0–300 km/h), yaw (0–20°) and rear wing angle. The wheels get motion blur as speed rises.
- **Cinema**: hides the overlays and moves the camera to a low ¾-front angle under dramatic key and rim lighting.
- **Forces**: downforce arrows on each axle, plus drag and side-force arrows. Live numbers show downforce, drag, C<sub>L</sub>, C<sub>D</sub>, L/D, aero balance, drag power and dynamic pressure, plus a downforce/drag vs speed chart.
- **Feature inspector**: click a part (splitter, dive planes, louvres, diffuser, wing) to fly the camera to it and read how it works.

## Model notes

This is a teaching model, not CFD. Forces use `F = ½ρv²A·C` with coefficients tuned to typical GT3 figures (C<sub>L</sub> ≈ −1.18, C<sub>D</sub> ≈ 0.365 at 7° wing, A = 1.95 m²). Yaw and wing-angle sensitivities are simplified. The flow field is an analytic approximation built around a signed-distance model of the car's measured outline.

## Rebuilding the model

`mclaren-720s-gt3-evo.glb` was made from the supplied USDZ like this:

```sh
pip install usd-core numpy pygltflib pillow
python3 tools/usdz_to_glb.py McLaren_720S_LMGT3_EVO.usdz raw.glb profiles.json
npx @gltf-transform/cli@4 optimize raw.glb mclaren-720s-gt3-evo.glb \
  --compress quantize --texture-compress webp --texture-size 1024 \
  --simplify-ratio 0.5 --simplify-error 0.0005
```

The converter rotates the car to face +X, scales it to metres and puts it on the ground. It also writes `profiles.json`, the car's outline measured at 48 stations along its length. Those numbers are embedded in `index.html` as `MEASURED`, and the flow field uses them so the smoke follows this car's real shape.

## Slipangle link

To show a footer link to the Slipangle site, set `SLIPANGLE_URL` near the top of the script in `index.html`.
