// Image → G-code for GRBL_ESP32 pen plotter
// - Vectorizes raster via Potrace WASM
// - Accepts SVG directly
// - Generates G-code using M67 E0 Q for pen servo and optional dwell
// - Streams over Web Serial

const els = {
    file: document.getElementById('file'),
    threshold: document.getElementById('threshold'),
    thVal: document.getElementById('thVal'),
    invert: document.getElementById('invert'),
    widthMM: document.getElementById('widthMM'),
    tolerance: document.getElementById('tolerance'),
    hatch: document.getElementById('hatch'),
    feed: document.getElementById('feed'),
    rapid: document.getElementById('rapid'),
    penUp: document.getElementById('penUp'),
    penDown: document.getElementById('penDown'),
    dwellUp: document.getElementById('dwellUp'),
    dwellDown: document.getElementById('dwellDown'),
    btnTrace: document.getElementById('btnTrace'),
    btnGcode: document.getElementById('btnGcode'),
    btnSave: document.getElementById('btnSave'),
    canvas: document.getElementById('canvas'),
    gcode: document.getElementById('gcode'),
    btnConnect: document.getElementById('btnConnect'),
    btnSend: document.getElementById('btnSend'),
    btnAbort: document.getElementById('btnAbort'),
    log: document.getElementById('log'),
    // quick controls
    btnSetZero: document.getElementById('btnSetZero'),
    btnGotoZero: document.getElementById('btnGotoZero'),
    btnPenUp: document.getElementById('btnPenUp'),
    btnPenDown: document.getElementById('btnPenDown'),
    jogStep: document.getElementById('jogStep'),
    jogFeed: document.getElementById('jogFeed'),
    btnJogXMinus: document.getElementById('btnJogXMinus'),
    btnJogXPlus: document.getElementById('btnJogXPlus'),
    btnJogYPlus: document.getElementById('btnJogYPlus'),
    btnJogYMinus: document.getElementById('btnJogYMinus'),
};

let potraceReady = false;
let paths = []; // world-space polyline paths [{pts:[{x,y}...]}]
let lastDims = { widthMM: 0, heightMM: 0 };
let serialPort = null;
let serialWriter = null;
let abortFlag = false;
let streaming = false; // guard against concurrent send

els.threshold.addEventListener('input', () => {
    els.thVal.textContent = els.threshold.value;
});

function resolvePotrace() {
    const P = (typeof Potrace !== 'undefined' && Potrace)
        || (typeof window !== 'undefined' && (window.potrace || window.Potrace || window.PotraceWasm || window.potraceWasm));
    return P || null;
}

(function initPotrace() {
    const P = resolvePotrace();
    if (P && P.ready && typeof P.ready.then === 'function') {
        P.ready.then(() => { potraceReady = true; log('Potrace ready'); });
    } else if (P) {
        potraceReady = true;
    } else {
        potraceReady = false; // will report a clear error at trace time if still missing
    }
})();

function requirePotrace() {
    const P = resolvePotrace();
    if (!P) throw new Error('Vectorizer library (potrace-wasm) did not load. Ensure internet access or bundle the script locally.');
    return P;
}

function log(msg) {
    const time = new Date().toLocaleTimeString();
    els.log.textContent += `[${time}] ${msg}\n`;
    els.log.scrollTop = els.log.scrollHeight;
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
}

function parseSVGToPaths(svgText) {
    // Robust sampling of actual SVG geometry using SVGGeometryElement APIs
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) throw new Error('Invalid SVG');
    let w = Number(svg.getAttribute('width')) || 0;
    let h = Number(svg.getAttribute('height')) || 0;
    const viewBox = svg.getAttribute('viewBox');
    if ((!w || !h) && viewBox) {
        const [, , vw, vh] = viewBox.split(/\s+/).map(Number);
        w = vw; h = vh;
    }
    if (!w) w = 512; if (!h) h = 512;

    // Attach a temporary offscreen SVG to sample path lengths accurately
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '-99999px';
    container.style.top = '-99999px';
    document.body.appendChild(container);
    const tmpSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tmpSvg.setAttribute('width', String(w));
    tmpSvg.setAttribute('height', String(h));
    tmpSvg.setAttribute('viewBox', viewBox || `0 0 ${w} ${h}`);
    container.appendChild(tmpSvg);

    const out = [];
    const geoms = svg.querySelectorAll('path, polyline, polygon, line, rect, circle, ellipse');
    geoms.forEach(node => {
        // clone as same tag into tmpSvg
        const tag = node.tagName.toLowerCase();
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        // copy attributes
        for (const attr of node.getAttributeNames()) {
            el.setAttribute(attr, node.getAttribute(attr));
        }
        tmpSvg.appendChild(el);
        try {
            const total = (/** @type {any} */(el)).getTotalLength?.();
            if (!total || !isFinite(total) || total <= 0) {
                tmpSvg.removeChild(el);
                return;
            }
            const samples = Math.max(8, Math.min(1000, Math.ceil(total / 2))); // ~2px step
            const step = total / samples;
            const pts = [];
            for (let i = 0; i <= samples; i++) {
                const p = (/** @type {any} */(el)).getPointAtLength(i * step);
                pts.push({ x: p.x, y: p.y });
            }
            if (pts.length > 1) out.push({ pts: simplifyPolyline(pts, 1.0) });
        } catch (e) {
            // skip elements without geometry API support
        } finally {
            tmpSvg.removeChild(el);
        }
    });
    document.body.removeChild(container);
    return { paths: out, bbox: { w, h } };
}

// --- Local fallback tracer (marching squares) ---
function traceBitmapLocal(imageData, threshold, invert) {
    const W = imageData.width, H = imageData.height;
    const data = imageData.data;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            let inside = gray < threshold; // dark considered inside by default
            if (invert) inside = !inside;
            mask[y * W + x] = inside ? 1 : 0;
        }
    }
    // adjacency using half-grid coordinates (x2 = x*2)
    const adj = new Map(); // key -> Set(neighborKey)
    const edgeSet = new Set(); // 'ax,ay|bx,by' normalized
    function key(ix, iy) { return ix + "," + iy; }
    function addEdge(ax, ay, bx, by) {
        const a = key(ax, ay), b = key(bx, by);
        const norm = (a < b) ? (a + '|' + b) : (b + '|' + a);
        if (edgeSet.has(norm)) return;
        edgeSet.add(norm);
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a).add(b);
        adj.get(b).add(a);
    }
    // Iterate cells
    for (let y = 0; y < H - 1; y++) {
        for (let x = 0; x < W - 1; x++) {
            const tl = mask[y * W + x];
            const tr = mask[y * W + (x + 1)];
            const br = mask[(y + 1) * W + (x + 1)];
            const bl = mask[(y + 1) * W + x];
            const n = (tl << 3) | (tr << 2) | (br << 1) | bl;
            if (n === 0 || n === 15) continue;
            // midpoints in half-grid units
            const Lx = x * 2, Ly = y * 2 + 1;
            const Rx = (x + 1) * 2, Ry = y * 2 + 1;
            const Tx = x * 2 + 1, Ty = y * 2;
            const Bx = x * 2 + 1, By = (y + 1) * 2;
            switch (n) {
                case 1: // 0001 bl
                    addEdge(Lx, Ly, Bx, By); break;
                case 2: // 0010 br
                    addEdge(Bx, By, Rx, Ry); break;
                case 3: // 0011 bl+br
                    addEdge(Lx, Ly, Rx, Ry); break;
                case 4: // 0100 tr
                    addEdge(Tx, Ty, Rx, Ry); break;
                case 5: // 0101 tr+bl (two segments)
                    addEdge(Tx, Ty, Lx, Ly);
                    addEdge(Bx, By, Rx, Ry);
                    break;
                case 6: // 0110 tr+br
                    addEdge(Tx, Ty, Bx, By); break;
                case 7: // 0111 all but tl
                    addEdge(Lx, Ly, Tx, Ty); break;
                case 8: // 1000 tl
                    addEdge(Lx, Ly, Tx, Ty); break;
                case 9: // 1001 tl+bl
                    addEdge(Tx, Ty, Bx, By); break;
                case 10: // 1010 tl+br (two segments)
                    addEdge(Tx, Ty, Rx, Ry);
                    addEdge(Lx, Ly, Bx, By);
                    break;
                case 11: // 1011 tl+br+bl
                    addEdge(Rx, Ry, Bx, By); break;
                case 12: // 1100 tl+tr
                    addEdge(Lx, Ly, Rx, Ry); break;
                case 13: // 1101 tl+tr+bl
                    addEdge(Rx, Ry, Tx, Ty); break;
                case 14: // 1110 tr+br+tl
                    addEdge(Bx, By, Lx, Ly); break;
            }
        }
    }
    // Build polylines by walking edges
    const segmentsLeft = new Set(edgeSet);
    const getNeighbors = (k) => adj.get(k) || new Set();
    const result = [];
    function pickEdge() {
        const iter = segmentsLeft.values().next();
        if (iter.done) return null;
        const e = iter.value; // 'a|b'
        segmentsLeft.delete(e);
        const [a, b] = e.split('|');
        // remove adjacency for this edge so we don't traverse again
        if (adj.has(a)) adj.get(a).delete(b);
        if (adj.has(b)) adj.get(b).delete(a);
        return [a, b];
    }
    function removeEdge(a, b) {
        const norm = (a < b) ? (a + '|' + b) : (b + '|' + a);
        if (segmentsLeft.has(norm)) segmentsLeft.delete(norm);
        if (adj.has(a)) adj.get(a).delete(b);
        if (adj.has(b)) adj.get(b).delete(a);
    }
    while (true) {
        const e = pickEdge();
        if (!e) break;
        let [a, b] = e;
        const path = [a, b];
        // extend forward from b
        while (true) {
            const nbs = Array.from(getNeighbors(b));
            if (!nbs.length) break;
            const c = nbs[0];
            path.push(c);
            removeEdge(b, c);
            b = c;
        }
        // extend backward from a
        let start = path[0];
        let prev = path[1];
        while (true) {
            const nbs = Array.from(getNeighbors(start));
            if (!nbs.length) break;
            const c = nbs[0];
            path.unshift(c);
            removeEdge(c, start);
            start = c;
        }
        // convert to points
        const pts = path.map(k => {
            const [ix, iy] = k.split(',').map(Number);
            return { x: ix / 2, y: iy / 2 };
        });
        result.push({ pts });
    }
    return { paths: result, bbox: { w: W, h: H } };
}

function rasterToVectorPaths(img) {
    const P = resolvePotrace();
    const threshold = +els.threshold.value;
    const invert = els.invert.checked;
    const ctx = els.canvas.getContext('2d', { willReadFrequently: true });
    const W = els.canvas.width, H = els.canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Fit image to canvas
    const r = Math.min(W / img.width, H / img.height);
    const w = Math.round(img.width * r); const h = Math.round(img.height * r);
    const x0 = (W - w) / 2, y0 = (H - h) / 2;
    ctx.drawImage(img, x0, y0, w, h);
    const imageData = ctx.getImageData(0, 0, W, H);
    if (P) {
        // Trace using Potrace; some builds expose trace(imageData, opts) directly
        let svg;
        if (typeof P.posterize === 'function') {
            const bmp = P.posterize(imageData, { thresholds: [threshold], invert });
            svg = P.trace(bmp, { turnPolicy: 'black', turdSize: 2, optTolerance: 0.4 });
        } else if (typeof P.trace === 'function') {
            svg = P.trace(imageData, { threshold, invert });
        } else {
            // Potrace present but API unexpected; fall back
            const { paths, bbox } = traceBitmapLocal(imageData, threshold, invert);
            return { vecPaths: paths, bbox };
        }
        // Extract polylines from SVG
        const { paths: vecPaths, bbox } = parseSVGToPaths(svg);
        return { vecPaths, bbox };
    } else {
        // Fallback: local contour tracer
        const { paths, bbox } = traceBitmapLocal(imageData, threshold, invert);
        return { vecPaths: paths, bbox };
    }
}

function simplifyPolyline(points, tolerancePx) {
    // Ramer–Douglas–Peucker simplification
    if (points.length < 3) return points;
    const sqTol = tolerancePx * tolerancePx;
    function getSqSegDist(p, p1, p2) {
        let x = p1.x, y = p1.y;
        let dx = p2.x - x, dy = p2.y - y;
        if (dx !== 0 || dy !== 0) {
            const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
            if (t > 1) { x = p2.x; y = p2.y; }
            else if (t > 0) { x += dx * t; y += dy * t; }
        }
        dx = p.x - x; dy = p.y - y;
        return dx * dx + dy * dy;
    }
    function simplifyDP(points, first, last, sqTolerance, simplified) {
        let maxSqDist = sqTolerance;
        let index = -1;
        for (let i = first + 1; i < last; i++) {
            const sqDist = getSqSegDist(points[i], points[first], points[last]);
            if (sqDist > maxSqDist) { index = i; maxSqDist = sqDist; }
        }
        if (maxSqDist > sqTolerance) {
            if (index - first > 1) simplifyDP(points, first, index, sqTolerance, simplified);
            simplified.push(points[index]);
            if (last - index > 1) simplifyDP(points, index, last, sqTolerance, simplified);
        }
    }
    const last = points.length - 1;
    const simplified = [points[0]];
    simplifyDP(points, 0, last, sqTol, simplified);
    simplified.push(points[last]);
    return simplified;
}

function scaleToMM(vecPaths, bbox) {
    const widthMM = +els.widthMM.value;
    const tolMM = +els.tolerance.value;
    const sx = widthMM / bbox.w;
    const sy = widthMM / bbox.w; // preserve aspect ratio
    const scale = sx; // same as sy
    const out = [];
    const minLenMM = 0.5; // drop tiny specks/noise
    for (const p of vecPaths) {
        if (!p.pts || p.pts.length < 2) continue;
        const ptsMM = p.pts.map(q => ({ x: q.x * scale, y: q.y * scale }));
        const simp = simplifyPolyline(ptsMM, tolMM);
        // filter very short paths
        let len = 0;
        for (let i = 1; i < simp.length; i++) {
            const dx = simp[i].x - simp[i - 1].x;
            const dy = simp[i].y - simp[i - 1].y;
            len += Math.hypot(dx, dy);
        }
        if (len >= minLenMM) out.push({ pts: simp });
    }
    const heightMM = bbox.h * scale;
    return { paths: out, widthMM, heightMM };
}

function generateHatch(width, height, spacing) {
    const lines = [];
    if (spacing <= 0) return lines;
    for (let y = 0; y <= height; y += spacing) {
        lines.push({ pts: [{ x: 0, y }, { x: width, y }] });
    }
    return lines;
}

function toGcode(mmPaths, hatchPaths) {
    const feed = +els.feed.value;
    const rapid = +els.rapid.value;
    const up = +els.penUp.value;
    const down = +els.penDown.value;
    const dUp = +els.dwellUp.value;
    const dDown = +els.dwellDown.value;
    const all = [...mmPaths, ...hatchPaths];
    const lines = [];
    lines.push('G90'); // absolute
    lines.push('G21'); // mm
    lines.push(`F${feed.toFixed(2)}`);
    lines.push(`M67 E0 Q${up.toFixed(3)}`);
    lines.push(`G4 S${dUp.toFixed(3)}`);
    let cx = 0, cy = 0;
    for (const p of all) {
        if (!p.pts || p.pts.length === 0) continue;
        const start = p.pts[0];
        // travel
        lines.push(`G0 F${rapid.toFixed(2)} X${start.x.toFixed(3)} Y${start.y.toFixed(3)}`);
        // pen down
        lines.push(`M67 E0 Q${down.toFixed(3)}`);
        lines.push(`G4 S${dDown.toFixed(3)}`);
        // draw
        lines.push(`F${feed.toFixed(2)}`);
        for (let i = 1; i < p.pts.length; i++) {
            const pt = p.pts[i];
            lines.push(`G1 X${pt.x.toFixed(3)} Y${pt.y.toFixed(3)}`);
            cx = pt.x; cy = pt.y;
        }
        // pen up
        lines.push(`M67 E0 Q${up.toFixed(3)}`);
        lines.push(`G4 S${dUp.toFixed(3)}`);
    }
    lines.push('M2');
    return lines.join('\n');
}

function drawPreview(mmPaths, width, height) {
    const ctx = els.canvas.getContext('2d');
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    // Fit into canvas with margin
    const margin = 10;
    const sx = (els.canvas.width - margin * 2) / width;
    const sy = (els.canvas.height - margin * 2) / height;
    const scale = Math.min(sx, sy);
    ctx.save();
    ctx.translate(margin, margin);
    ctx.scale(scale, scale);
    ctx.lineWidth = 0.5 / scale;
    ctx.strokeStyle = '#111';
    for (const p of mmPaths) {
        if (!p.pts || p.pts.length === 0) continue;
        ctx.beginPath();
        ctx.moveTo(p.pts[0].x, p.pts[0].y);
        for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i].x, p.pts[i].y);
        ctx.stroke();
    }
    ctx.restore();
}

els.btnTrace.addEventListener('click', async () => {
    try {
        if (!els.file.files[0]) return alert('Choose an image first');
        const file = els.file.files[0];
        // SVG path
        if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
            const text = await file.text();
            const { paths: vecPaths, bbox } = parseSVGToPaths(text);
            const scaled = scaleToMM(vecPaths, bbox);
            paths = scaled.paths;
            lastDims = { widthMM: scaled.widthMM, heightMM: scaled.heightMM };
            drawPreview(paths, scaled.widthMM, scaled.heightMM);
            log(`SVG parsed: ${paths.length} paths, size ~ ${scaled.widthMM.toFixed(1)}x${scaled.heightMM.toFixed(1)} mm`);
            return;
        }
        // Raster path
        const P = resolvePotrace();
        if (P && !potraceReady) return alert('Please wait, tracing initializing...');
        const dataURL = await readFileAsDataURL(file);
        const img = new Image();
        img.onload = () => {
            const { vecPaths, bbox } = rasterToVectorPaths(img);
            const scaled = scaleToMM(vecPaths, bbox);
            paths = scaled.paths;
            lastDims = { widthMM: scaled.widthMM, heightMM: scaled.heightMM };
            drawPreview(paths, scaled.widthMM, scaled.heightMM);
            log(`Raster traced: ${paths.length} paths, size ~ ${scaled.widthMM.toFixed(1)}x${scaled.heightMM.toFixed(1)} mm`);
        };
        img.src = dataURL;
    } catch (err) {
        console.error(err);
        alert('Trace failed: ' + err.message);
    }
});

els.btnGcode.addEventListener('click', () => {
    if (!paths.length) return alert('Trace first');
    const hatchSpacing = +els.hatch.value;
    const widthMM = +els.widthMM.value;
    const heightMM = lastDims.heightMM || widthMM;
    const hatch = generateHatch(widthMM, heightMM, hatchSpacing);
    const g = toGcode(paths, hatch);
    els.gcode.value = g;
    log(`G-code generated (${g.split(/\n/).length} lines)`);
});

els.btnSave.addEventListener('click', () => {
    const blob = new Blob([els.gcode.value || ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plot.gcode';
    a.click();
    URL.revokeObjectURL(a.href);
});

// --- Web Serial ---
async function connectSerial() {
    try {
        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: 115200 });
        const encoder = new TextEncoderStream();
        encoder.readable.pipeTo(serialPort.writable);
        serialWriter = encoder.writable.getWriter();
        // reset log
        log('Serial connected');
    } catch (err) {
        alert('Serial connect failed: ' + err.message);
    }
}

async function sendGcode() {
    if (!serialWriter) return alert('Connect Serial first');
    if (!els.gcode.value) return alert('No G-code to send');
    if (streaming) return alert('Already streaming');
    abortFlag = false;
    const lines = els.gcode.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Simple streaming with 'ok' wait
    const reader = serialPort.readable
        .pipeThrough(new TextDecoderStream())
        .getReader();
    const queue = [...lines];
    log('Streaming G-code...');
    // Wake up GRBL
    await serialWriter.write("\r\n");
    streaming = true;
    // Progress tracking UI
    const total = queue.length;
    let done = 0;
    const bar = document.getElementById('progressBar');
    const lblProgress = document.getElementById('lblProgress');
    const lblState = document.getElementById('lblState');
    const lblPos = document.getElementById('lblPos');
    const lblFeed = document.getElementById('lblFeed');
    function setProgress() {
        const pct = total ? Math.round((done / total) * 100) : 0;
        if (bar) bar.style.width = pct + '%';
        if (lblProgress) lblProgress.textContent = `${done}/${total}`;
    }
    setProgress();

    function parseStatusLine(line) {
        if (!line || line[0] !== '<') return;
        // Typical: <Run|MPos:1.000,2.000,0.000|FS:1200,0>
        const m = line.match(/^<([^|>]+)[|>]/);
        const state = m ? m[1] : '-';
        const mpos = line.match(/MPos:([\-0-9.]+),([\-0-9.]+)(?:,([\-0-9.]+))?/);
        const fs = line.match(/FS:([\-0-9.]+)/);
        if (lblState) lblState.textContent = state;
        if (lblPos && mpos) lblPos.textContent = `X${(+mpos[1]).toFixed(3)} Y${(+mpos[2]).toFixed(3)}`;
        if (lblFeed && fs) lblFeed.textContent = fs[1];
    }

    function waitForOk() {
        return new Promise(async (resolve) => {
            while (true) {
                const { value } = await reader.read();
                if (!value) continue;
                const s = value.toString();
                const lines = s.split(/\r?\n/);
                for (const lineRaw of lines) {
                    const line = lineRaw.trim();
                    if (!line) continue;
                    log(line);
                    parseStatusLine(line);
                    if (line.includes('ok') || line.includes('error')) {
                        resolve();
                        return;
                    }
                }
            }
        });
    }
    while (queue.length && !abortFlag) {
        const l = queue.shift();
        // query status to refresh UI frequently (no 'ok' returned for '?')
        try { await serialWriter.write('?' + '\n'); } catch (e) { /* ignore */ }
        await serialWriter.write(l + '\n');
        await waitForOk();
        done++;
        setProgress();
    }
    streaming = false;
    log(abortFlag ? 'Aborted' : 'Done');
}

function abortSend() {
    abortFlag = true;
    if (serialWriter) {
        serialWriter.write('\x18'); // Ctrl-X reset
    }
}

els.btnConnect.addEventListener('click', connectSerial);
els.btnSend.addEventListener('click', sendGcode);
els.btnAbort.addEventListener('click', abortSend);

// ---- Quick controls ----
function getPenValues() {
    return {
        up: +els.penUp.value || 5,
        down: +els.penDown.value || 10,
        dwellUp: +els.dwellUp.value || 0.15,
        dwellDown: +els.dwellDown.value || 0.2,
    };
}

async function sendSeq(cmds) {
    if (!serialWriter) return alert('Connect Serial first');
    if (streaming) return alert('Busy streaming');
    const reader = serialPort.readable
        .pipeThrough(new TextDecoderStream())
        .getReader();
    function waitForOk() {
        return new Promise(async (resolve) => {
            while (true) {
                const { value } = await reader.read();
                if (!value) continue;
                const s = value.toString();
                if (s.trim()) log(s.trim());
                if (s.includes('ok') || s.includes('error')) { resolve(); break; }
            }
        });
    }
    // wake
    await serialWriter.write("\r\n");
    for (const c of cmds) {
        await serialWriter.write(c + "\n");
        await waitForOk();
    }
}

els.btnSetZero?.addEventListener('click', async () => {
    try { await sendSeq(['G92 X0 Y0']); log('Zero set (X0 Y0)'); } catch (e) { /* logged in sendSeq */ }
});

els.btnGotoZero?.addEventListener('click', async () => {
    const rapid = +els.rapid.value || 3000;
    try { await sendSeq(['G90', `G0 X0 Y0 F${rapid}`]); } catch (e) { }
});

els.btnPenUp?.addEventListener('click', async () => {
    const { up, dwellUp } = getPenValues();
    try { await sendSeq([`M67 E0 Q${up.toFixed(3)}`, `G4 S${dwellUp.toFixed(3)}`]); } catch (e) { }
});

els.btnPenDown?.addEventListener('click', async () => {
    const { down, dwellDown } = getPenValues();
    try { await sendSeq([`M67 E0 Q${down.toFixed(3)}`, `G4 S${dwellDown.toFixed(3)}`]); } catch (e) { }
});

async function jog(dx, dy) {
    if (!serialWriter) return alert('Connect Serial first');
    if (streaming) return alert('Busy streaming');
    const step = +els.jogStep.value || 1;
    const feed = +els.jogFeed.value || 2000;
    const x = (dx * step).toFixed(3);
    const y = (dy * step).toFixed(3);
    const cmds = ['G91', `G0 X${dx ? x : 0} Y${dy ? y : 0} F${feed}`, 'G90'];
    try { await sendSeq(cmds); } catch (e) { }
}

els.btnJogXMinus?.addEventListener('click', () => jog(-1, 0));
els.btnJogXPlus?.addEventListener('click', () => jog(1, 0));
els.btnJogYPlus?.addEventListener('click', () => jog(0, 1));
els.btnJogYMinus?.addEventListener('click', () => jog(0, -1));
