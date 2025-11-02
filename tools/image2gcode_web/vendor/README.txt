Optional local Potrace bundle

If you prefer Potrace vectorization for PNG/JPG and want to avoid CDN/CORS issues, download potrace.min.js from the potrace-wasm package and place it in this folder as:

  vendor/potrace.min.js

Then, in index.html, uncomment the line:

  <!-- <script src="./vendor/potrace.min.js"></script> -->

This loads Potrace locally (works offline). The app also includes a built-in fallback tracer, so this step is optional.