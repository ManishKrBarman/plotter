# Image → G-code Web Tool (for GRBL_ESP32 Pen Plotter)

A lightweight, client‑side web app to convert images to G‑code and stream directly to your ESP32 (GRBL_ESP32) over Web Serial. Lives outside the firmware; no changes to the plotter build.

## Features
- Open PNG/JPG (raster) or SVG (vector)
- Raster images are traced with Potrace (WASM); SVGs are used directly
- Generate G‑code with M67 E0 Q servo commands (E0 is mapped in firmware to GPIO13 @50Hz)
- Adjustable size (mm), trace threshold, curve tolerance, optional hatch fill
- Send over Web Serial (Chrome/Edge on desktop) with simple ok‑synchronized streaming

## Requirements
- Browser: Chrome or Edge (desktop). Web Serial is not supported in Firefox/Safari.
- PNG/JPG tracing will try Potrace (WASM) from a CDN first, then fall back to a built‑in marching‑squares tracer if the CDN is blocked. The fallback works fully offline (vector quality may differ slightly).
- Firmware: GRBL_ESP32 with `USER_ANALOG_PIN_0` on GPIO13 at 50 Hz. Pen up/down uses:
  - Pen up: `M67 E0 Q5`
  - Pen down: `M67 E0 Q10`
  - Small dwell after moves (`G4 Sx`) is inserted to let the servo settle.

## Supported file types
- PNG, JPG/JPEG: converted to black/white using your threshold, then vectorized. Clean, high‑contrast art works best.
- SVG: vector paths are sampled to polylines for output.

## How to use (local)
1. Serve the folder as static files (some browsers block file:// fetches). Options:
   - Python: `python -m http.server 8000` in `tools/image2gcode_web` then open http://localhost:8000/
   - VS Code Live Server extension, or any static server.
2. In the page:
   - Upload an image (PNG/JPG/SVG)
   - Adjust Threshold/Invert (for rasters), Output width (mm), Tolerance, and optional Hatch spacing
   - Click "Trace → Paths"
   - Click "Generate G-code" (review/edit in the text area)
   - Click "Connect Serial" and choose your GRBL_ESP32 COM port
   - Click "Send to ESP32" to stream; "Abort" sends Ctrl‑X
   - If Potrace doesn’t load, the app uses the built‑in tracer automatically; no action needed (you can still optionally serve a local `potrace.min.js` for higher fidelity).

## G‑code assumptions
- Absolute coordinates (G90) and metric units (G21)
- Travel speed set with rapid F; drawing speed set with feed F
- Servo lift/lower via `M67 E0 Q{value}`; tweak the Pen up/down Q values to match your linkage
- A short dwell `G4 S{seconds}` after up/down gives time for servo movement

## Notes and tips
- If your pen is mirrored or offset, adjust your SVG or add a small post‑transform before tracing.
- For best results, prefer SVG line art. Rasters are fine but rely on thresholding.
- If Chrome doesn’t show your serial device, make sure no other program has the COM port open.

## Folder layout
- `index.html` — UI and layout
- `app.js` — image handling, tracing, G‑code generation, Web Serial streaming

This tool is intentionally independent from `Grbl_Esp32/` so it won’t affect firmware builds.
