# GT3 Aero Lab

An interactive virtual wind tunnel for the McLaren 720S GT3 EVO, built with Three.js. It shows how GT3 aerodynamics work.

Open `index.html` in a browser. It is a single file with no build step. Three.js r128 loads from a CDN.

## What it shows

- **Stylised 3D car**: body, cabin, front splitter, dive planes, fender louvres, underfloor diffuser, and a swan-neck rear wing. Drag to orbit, use the camera presets, or use the view-heading slider for a full 360° turn.
- **Airflow**: animated smoke particles, streamlines with moving pulses, and velocity-vector slices. All are coloured by pressure (blue = suction, red = high pressure).
- **Pressure zones**: a heat map painted on the body that updates in real time.
- **Controls**: speed (0–300 km/h), yaw (0–20°) and rear wing angle.
- **Forces**: downforce arrows on each axle, plus drag and side-force arrows. Live numbers show downforce, drag, C<sub>L</sub>, C<sub>D</sub>, L/D, aero balance, drag power and dynamic pressure, plus a downforce/drag vs speed chart.
- **Feature inspector**: click a part (splitter, dive planes, louvres, diffuser, wing) to fly the camera to it and read how it works.

## Model notes

This is a teaching model, not CFD. Forces use `F = ½ρv²A·C` with coefficients tuned to typical GT3 figures (C<sub>L</sub> ≈ −1.18, C<sub>D</sub> ≈ 0.365 at 7° wing, A = 1.95 m²). Yaw and wing-angle sensitivities are simplified. The flow field is an analytic approximation built around a signed-distance model of the car.

## Slipangle link

To show a footer link to the Slipangle site, set `SLIPANGLE_URL` near the top of the script in `index.html`.
