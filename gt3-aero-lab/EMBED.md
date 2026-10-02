# GT3 Aero background

A full-window, animated McLaren 720S GT3 EVO in a dark virtual wind tunnel: the
detailed car, glowing CFD-style airflow, wake smoke, spinning wheels and a slow camera
orbit. No buttons, panels or text.

## Files

| File | What it is |
|---|---|
| `index.html` | The scene. Open it with `#bg` for background mode. Without `#bg` it is the full interactive aero lab. |
| `mclaren-720s-gt3-evo.glb` | The 3D car (glTF binary, about 7 MB). Works in any glTF viewer or Three.js, Babylon.js, Blender and so on. |
| `car-sdf.js` | The car's shape for the airflow. Must sit next to `index.html`. |

## Put it on a site

1. Upload `index.html`, `mclaren-720s-gt3-evo.glb` and `car-sdf.js` to your site, for example in `/aero/`.
   It must be served over http(s); opening `index.html` straight from disk can't load the
   `.glb`, and you'd get the simplified stand-in car.
2. Add this as the first thing inside `<body>` on the page that should have the background:

```html
<iframe src="/aero/index.html#bg" title="" aria-hidden="true" tabindex="-1"
  style="position:fixed; inset:0; width:100%; height:100%; border:0;
         z-index:-1; pointer-events:none;"></iframe>
```

3. Give the page's own content a transparent background so the scene shows through,
   and use light text on top; the scene is dark.

`pointer-events:none` lets every click and scroll go to your page, not the scene.

## Good to know

- The scene loads Three.js r128 and Google Fonts from public CDNs.
- It's WebGL: smooth on desktops and recent phones. People who set "reduce motion" on their
  device get a still camera.
- Check the 3D model's licence before publishing it on a public site.
