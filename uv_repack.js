/*
 * UV Repack
 * Adds a "Repack UV" entry to the texture list context menu (right click a texture).
 * It compacts every UV island that uses the texture into a tight layout and moves the
 * matching texture pixels along, so the model keeps looking the exact same.
 *
 * Options (in the confirmation dialog):
 *  - Spacing (px)     : empty pixel space kept between islands.
 *  - Resolution (%)   : optional downscale of the texture pixels (100% = untouched).
 *  - Output size      : the PNG size. Sizes smaller than the current one are listed
 *                       when, once the islands are repacked 1:1 (no resampling), they
 *                       fit inside them. The list also takes the Resolution into
 *                       account, so a reduced resolution unlocks smaller sizes.
 *  - Remove pixels outside the UVs : inside each island, clear the pixels that no
 *                       face covers (e.g. the corners around triangles or rotated
 *                       mesh faces). Pixels outside every island are always dropped.
 *
 * Animated (flipbook) textures are supported: every frame is repacked with the same
 * layout, frames stay stacked vertically, and the output sizes keep the frame aspect
 * ratio so Blockbench still detects the animation.
 *
 * Several textures sharing the same layout (same frame size, e.g. a texture and its
 * variants or emissive map) can be selected and repacked together: islands come from
 * every face using any of them, and the same layout is applied to all of them.
 *
 * Author: MaxenceBailly
 */

(function () {
	const PLUGIN_ID = 'uv_repack';
	const ACTION_ID = 'repack_uvs';
	const MAX_REGIONS = 5000;
	const MIN_SIZE = 16;
	const RESOLUTION_STEPS = [100, 75, 50, 25, 12.5];

	// Number of flipbook frames stacked vertically in the texture (1 if not animated).
	function getFrameCount(tex) {
		const n = tex.frameCount;
		return (n > 1 && Number.isInteger(n)) ? n : 1;
	}

	function gcd(a, b) {
		while (b) { const t = b; b = a % b; a = t; }
		return a;
	}

	/* ------------------------------------------------------------------ *
	 *  UV helpers
	 * ------------------------------------------------------------------ */

	function getFaceUVPoints(face) {
		const uv = face.uv;
		if (!uv) return null;
		if (Array.isArray(uv)) {
			return [[uv[0], uv[1]], [uv[2], uv[3]]];
		}
		if (typeof uv === 'object') {
			const pts = [];
			for (let key in uv) {
				if (Array.isArray(uv[key])) pts.push([uv[key][0], uv[key][1]]);
			}
			return pts.length ? pts : null;
		}
		return null;
	}

	// UV outline of a face as an ordered polygon (used to clean pixels outside UVs).
	function getFaceUVPolygon(face) {
		const uv = face.uv;
		if (Array.isArray(uv)) {
			return [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
		}
		if (!uv || typeof uv !== 'object') return null;
		let keys = null;
		if (typeof face.getSortedVertices === 'function') {
			try { keys = face.getSortedVertices(); } catch (e) { keys = null; }
		}
		if (!keys || !keys.length) keys = Object.keys(uv);
		const poly = keys.filter(k => Array.isArray(uv[k])).map(k => [uv[k][0], uv[k][1]]);
		return poly.length >= 3 ? poly : null;
	}

	// Scale (around the UV space origin) + translate a face's UVs.
	function transformFaceUV(face, scaleU, scaleV, offsetU, offsetV) {
		const uv = face.uv;
		if (Array.isArray(uv)) {
			uv[0] = uv[0] * scaleU + offsetU;
			uv[1] = uv[1] * scaleV + offsetV;
			uv[2] = uv[2] * scaleU + offsetU;
			uv[3] = uv[3] * scaleV + offsetV;
		} else if (uv && typeof uv === 'object') {
			for (let key in uv) {
				if (Array.isArray(uv[key])) {
					uv[key][0] = uv[key][0] * scaleU + offsetU;
					uv[key][1] = uv[key][1] * scaleV + offsetV;
				}
			}
		}
	}

	/**
	 * Collect every face referencing one of `textures`. Box UV cubes that use them are
	 * flagged so they get frozen to per-face UV (their UVs are already stored on
	 * each face and would otherwise be recalculated from the box layout).
	 */
	function collectFaces(textures) {
		const faces = [];
		const cubes_to_convert = new Set();

		for (const element of Project.elements) {
			if (!element || !element.faces) continue;
			for (let key in element.faces) {
				const face = element.faces[key];
				if (!face || face.texture === null || face.texture === false) continue;
				let face_texture;
				try { face_texture = face.getTexture(); } catch (e) { continue; }
				if (!textures.includes(face_texture)) continue;
				const pts = getFaceUVPoints(face);
				if (!pts) continue;
				if (element.box_uv) cubes_to_convert.add(element);
				faces.push({ element, key, face, pts, poly: getFaceUVPolygon(face) });
			}
		}
		return { faces, cubes_to_convert };
	}

	/**
	 * Build the unique pixel rectangles to pack. Faces covering the exact same
	 * rectangle (mirrored faces) are merged so pixels are copied only once.
	 * For flipbooks, rectangles are expressed in the coordinates of a single frame.
	 */
	function buildRegions(faces, W, H, uvW, uvH) {
		const scaleX = W / uvW;
		const scaleY = H / uvH;

		const map = new Map();

		for (const item of faces) {
			let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
			for (const p of item.pts) {
				if (p[0] < minU) minU = p[0];
				if (p[0] > maxU) maxU = p[0];
				if (p[1] < minV) minV = p[1];
				if (p[1] > maxV) maxV = p[1];
			}

			let x = Math.floor(minU * scaleX);
			let y = Math.floor(minV * scaleY);
			let x2 = Math.ceil(maxU * scaleX);
			let y2 = Math.ceil(maxV * scaleY);

			x = Math.max(0, Math.min(W - 1, x));
			y = Math.max(0, Math.min(H - 1, y));
			x2 = Math.max(x + 1, Math.min(W, x2));
			y2 = Math.max(y + 1, Math.min(H, y2));

			const rect = { x, y, w: x2 - x, h: y2 - y };
			const key = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h;

			let region = map.get(key);
			if (!region) {
				region = Object.assign({ faces: [] }, rect);
				map.set(key, region);
			}
			region.faces.push(item);
		}

		return { regions: Array.from(map.values()) };
	}

	// Frame size + UV size of a texture, which define its layout.
	function getLayout(tex) {
		const frames = getFrameCount(tex);
		return {
			frames,
			W: tex.width,
			H: tex.height / frames,
			uvW: tex.getUVWidth(),
			uvH: tex.getUVHeight()
		};
	}

	/**
	 * Analyze a group of textures sharing the same layout (same frame size and UV
	 * size, e.g. a texture and its variants or emissive map). Islands are taken from
	 * every face using any of them, and the result is applied to all of them.
	 * Returns { error } if the layouts differ, or null if no face uses the textures.
	 */
	function analyze(textures) {
		const layouts = textures.map(getLayout);
		const ref = layouts[0];
		for (let i = 1; i < layouts.length; i++) {
			const l = layouts[i];
			if (l.W !== ref.W || l.H !== ref.H || l.uvW !== ref.uvW || l.uvH !== ref.uvH) {
				return {
					error: 'The selected textures do not share the same layout: ' +
						textures[0].name + ' is ' + ref.W + ' x ' + ref.H + ', ' +
						textures[i].name + ' is ' + l.W + ' x ' + l.H + ' (per frame).'
				};
			}
		}

		const { faces, cubes_to_convert } = collectFaces(textures);
		if (!faces.length) return null;
		const built = buildRegions(faces, ref.W, ref.H, ref.uvW, ref.uvH);
		return Object.assign({
			textures,
			frames: layouts.map(l => l.frames),
			animated: layouts.some(l => l.frames > 1),
			faces,
			cubes_to_convert,
			W: ref.W,
			H: ref.H,
			uvW: ref.uvW,
			uvH: ref.uvH
		}, built);
	}

	// Pixel size of an island after applying a scale factor k.
	function scaleRect(rect, k) {
		const x = Math.round(rect.x * k);
		const y = Math.round(rect.y * k);
		const x2 = Math.round((rect.x + rect.w) * k);
		const y2 = Math.round((rect.y + rect.h) * k);
		return { w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
	}

	/* ------------------------------------------------------------------ *
	 *  Rectangle packing (MaxRects, best-short-side-fit)
	 * ------------------------------------------------------------------ */

	function isContainedIn(a, b) {
		return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
	}

	function packRects(rects, binW, binH, gap) {
		const free = [{ x: 0, y: 0, w: binW, h: binH }];
		const placed = new Array(rects.length);

		const order = rects
			.map((r, i) => i)
			.sort((a, b) =>
				Math.max(rects[b].w, rects[b].h) - Math.max(rects[a].w, rects[a].h) ||
				rects[b].w * rects[b].h - rects[a].w * rects[a].h
			);

		for (const idx of order) {
			const source = rects[idx];
			const pw = source.w + gap;
			const ph = source.h + gap;

			let best = null;
			let bestScore = Infinity;

			for (let i = 0; i < free.length; i++) {
				const f = free[i];
				if (f.w >= pw && f.h >= ph) {
					const leftW = f.w - pw;
					const leftH = f.h - ph;
					const shortSide = Math.min(leftW, leftH);
					const longSide = Math.max(leftW, leftH);
					const score = shortSide * 100000 + longSide;
					if (score < bestScore) {
						bestScore = score;
						best = { x: f.x, y: f.y };
					}
				}
			}

			if (!best) return null;

			placed[idx] = { x: best.x, y: best.y, w: source.w, h: source.h };

			const px = best.x, py = best.y;
			const next = [];

			for (let i = 0; i < free.length; i++) {
				const f = free[i];
				const overlaps = !(f.x + f.w <= px || px + pw <= f.x || f.y + f.h <= py || py + ph <= f.y);
				if (!overlaps) {
					next.push(f);
					continue;
				}
				if (f.x < px) next.push({ x: f.x, y: f.y, w: px - f.x, h: f.h });
				if (px + pw < f.x + f.w) next.push({ x: px + pw, y: f.y, w: f.x + f.w - (px + pw), h: f.h });
				if (f.y < py) next.push({ x: f.x, y: f.y, w: f.w, h: py - f.y });
				if (py + ph < f.y + f.h) next.push({ x: f.x, y: py + ph, w: f.w, h: f.y + f.h - (py + ph) });
			}

			free.length = 0;
			for (let i = 0; i < next.length; i++) {
				let contained = false;
				for (let j = 0; j < next.length; j++) {
					if (i !== j && isContainedIn(next[i], next[j])) { contained = true; break; }
				}
				if (!contained) free.push(next[i]);
			}
		}

		return placed;
	}

	function measureBoundingBox(placed) {
		let w = 0, h = 0;
		for (const p of placed) {
			w = Math.max(w, p.x + p.w);
			h = Math.max(h, p.y + p.h);
		}
		return { w, h };
	}

	/**
	 * Return the selectable output sizes for the given spacing and resolution.
	 * Islands are measured at `resolution` (no further resampling), so this lists
	 * the real PNG sizes that can hold them. Sizes are per frame for flipbooks.
	 */
	function computeSizeOptions(analysis, gap, resolution) {
		const { regions, W, H, animated } = analysis;
		const rects = regions.map(r => scaleRect(r, resolution));
		const seen = new Set();
		const options = [];

		if (animated) {
			// Blockbench only detects flipbook frames when their aspect ratio matches the
			// UV space, so only sizes proportional to the current frame are offered.
			const g = gcd(W, H);
			const stepW = W / g, stepH = H / g;
			const fits = m => !!packRects(rects, stepW * m, stepH * m, gap);
			const add = (w, h, suffix) => {
				const key = w + 'x' + h;
				if (seen.has(key) || (w === W && h === H)) return;
				seen.add(key);
				options.push({ value: key, w, h, label: w + ' x ' + h + suffix });
			};

			if (fits(g)) {
				// Smallest proportional size (packing is close enough to monotonic).
				let lo = 1, hi = g;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (fits(mid)) hi = mid; else lo = mid + 1;
				}
				if (lo < g) add(stepW * lo, stepH * lo, '   (minimum)');

				// Halvings of the current frame size.
				for (let m = g / 2; Number.isInteger(m) && m >= lo; m /= 2) {
					if (Math.max(stepW * m, stepH * m) < MIN_SIZE) break;
					if (fits(m)) add(stepW * m, stepH * m, '');
				}
			}

			options.sort((a, b) => a.w * a.h - b.w * b.h);
			return options;
		}

		// Exact minimum: pack at the current size, then measure the used area.
		const packed_full = packRects(rects, W, H, gap);
		if (packed_full) {
			const box = measureBoundingBox(packed_full);
			if (box.w > 0 && box.h > 0 && (box.w < W || box.h < H) && packRects(rects, box.w, box.h, gap)) {
				const key = box.w + 'x' + box.h;
				seen.add(key);
				options.push({ value: key, w: box.w, h: box.h, label: box.w + ' x ' + box.h + '   (minimum)' });
			}
		}

		// Power-of-two squares that fit.
		const maxDim = Math.max(W, H);
		for (let S = MIN_SIZE; S <= maxDim; S *= 2) {
			const key = S + 'x' + S;
			if (seen.has(key)) continue;
			if (W === H && S === W) continue; // identical to "keep current"
			if (packRects(rects, S, S, gap)) {
				seen.add(key);
				options.push({ value: key, w: S, h: S, label: S + ' x ' + S });
			}
		}

		options.sort((a, b) => a.w * a.h - b.w * b.h);
		return options;
	}

	/* ------------------------------------------------------------------ *
	 *  Repack
	 * ------------------------------------------------------------------ */

	/* ------------------------------------------------------------------ *
	 *  Cleaning (pixels outside the UVs)
	 * ------------------------------------------------------------------ */

	const MASK_SUBSAMPLES = 4;

	function polygonArea(poly) {
		let a = 0;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
		}
		return a / 2;
	}

	function pointInPolygon(poly, x, y) {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
			if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	}

	// A pixel is kept when any of its sub-samples falls inside the polygon. Samples
	// never sit on pixel borders, so UV edges aligned on the pixel grid don't bleed.
	function pixelTouchesPolygon(poly, px, py) {
		for (let sy = 0; sy < MASK_SUBSAMPLES; sy++) {
			for (let sx = 0; sx < MASK_SUBSAMPLES; sx++) {
				const x = px + (sx + 0.5) / MASK_SUBSAMPLES;
				const y = py + (sy + 0.5) / MASK_SUBSAMPLES;
				if (pointInPolygon(poly, x, y)) return true;
			}
		}
		return false;
	}

	/**
	 * Mask (opaque = keep) of the pixels of a region actually covered by its faces.
	 * Degenerate faces (zero area, e.g. a flat cube face) keep the whole region.
	 */
	function buildRegionMask(region, scaleX, scaleY) {
		const { x, y, w, h } = region;
		const polys = [];
		let full = false;
		for (const item of region.faces) {
			if (!item.poly) { full = true; break; }
			const poly = item.poly.map(p => [p[0] * scaleX - x, p[1] * scaleY - y]);
			if (Math.abs(polygonArea(poly)) < 1e-6) { full = true; break; }
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of poly) {
				minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
				minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
			}
			polys.push({ poly, minX, minY, maxX, maxY });
		}

		const mask = document.createElement('canvas');
		mask.width = w;
		mask.height = h;
		const ctx = mask.getContext('2d');
		if (full) {
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, w, h);
			return mask;
		}

		const image = ctx.createImageData(w, h);
		const data = image.data;
		for (let py = 0; py < h; py++) {
			for (let px = 0; px < w; px++) {
				const keep = polys.some(p =>
					px + 1 > p.minX && px < p.maxX && py + 1 > p.minY && py < p.maxY &&
					pixelTouchesPolygon(p.poly, px, py)
				);
				if (keep) data[(py * w + px) * 4 + 3] = 255;
			}
		}
		ctx.putImageData(image, 0, 0);
		return mask;
	}

	// Copy every island of `tex` (all its frames) to its packed position. With
	// `masks`, pixels of an island that no face covers are left transparent.
	function buildPackedCanvas(tex, frames, regions, placed, target_rects, W, H, canvasW, canvasH, masks) {
		const source = document.createElement('canvas');
		source.width = W;
		source.height = H * frames;
		const sourceCtx = source.getContext('2d');
		const src_image = (tex.canvas && tex.canvas.width) ? tex.canvas : tex.img;
		sourceCtx.drawImage(src_image, 0, 0, W, H * frames);

		const output = document.createElement('canvas');
		output.width = canvasW;
		output.height = canvasH * frames;
		const outputCtx = output.getContext('2d');
		outputCtx.imageSmoothingEnabled = false;

		const island = masks ? document.createElement('canvas') : null;
		const islandCtx = island ? island.getContext('2d') : null;

		for (let f = 0; f < frames; f++) {
			regions.forEach((region, i) => {
				const p = placed[i];
				const t = target_rects[i];
				if (!masks) {
					outputCtx.drawImage(
						source,
						region.x, region.y + f * H, region.w, region.h,
						p.x, p.y + f * canvasH, t.w, t.h
					);
					return;
				}
				island.width = region.w;
				island.height = region.h;
				islandCtx.drawImage(source, region.x, region.y + f * H, region.w, region.h, 0, 0, region.w, region.h);
				islandCtx.globalCompositeOperation = 'destination-in';
				islandCtx.drawImage(masks[i], 0, 0);
				islandCtx.globalCompositeOperation = 'source-over';
				outputCtx.drawImage(island, 0, 0, region.w, region.h, p.x, p.y + f * canvasH, t.w, t.h);
			});
		}
		return output;
	}

	function repackTextures(analysis, gap, size, resolution, clean) {
		const { textures, frames, animated, regions, W, H, uvW, uvH, faces, cubes_to_convert } = analysis;
		if (regions.length > MAX_REGIONS) {
			throw new Error('Too many UV islands to process (' + regions.length + ').');
		}

		const canvasW = size ? size.w : W;
		const canvasH = size ? size.h : H;

		// Islands measured at the chosen resolution (1:1 unless downscaling).
		const target_rects = regions.map(r => scaleRect(r, resolution));
		const placed = packRects(target_rects, canvasW, canvasH, gap);
		if (!placed) {
			Blockbench.showMessageBox({
				title: 'Repack UV failed',
				message: 'Could not fit every island into ' + canvasW + ' x ' + canvasH + ' with ' + gap + 'px spacing.',
				icon: 'warning'
			});
			return;
		}

		// Build every new texture before touching anything, applying the same layout
		// to every texture and every frame.
		const masks = clean ? regions.map(r => buildRegionMask(r, W / uvW, H / uvH)) : null;
		const outputs = textures.map((tex, ti) =>
			buildPackedCanvas(tex, frames[ti], regions, placed, target_rects, W, H, canvasW, canvasH, masks)
		);

		// Apply UV + texture changes in a single undo step.
		const affected_elements = [];
		const seen = new Set();
		for (const item of faces) {
			if (!seen.has(item.element)) { seen.add(item.element); affected_elements.push(item.element); }
		}

		Undo.initEdit({ elements: affected_elements, textures: textures.slice(), bitmap: true });

		cubes_to_convert.forEach(cube => cube.setUVMode(false));

		let moved = 0;
		regions.forEach((region, i) => {
			const p = placed[i];
			const t = target_rects[i];
			// Map the source island rect onto its packed rect on the output texture.
			const scaleU = (t.w * uvW / canvasW) / (region.w * uvW / W);
			const scaleV = (t.h * uvH / canvasH) / (region.h * uvH / H);
			const offsetU = (p.x / canvasW) * uvW - (region.x / W) * uvW * scaleU;
			const offsetV = (p.y / canvasH) * uvH - (region.y / H) * uvH * scaleV;

			if (scaleU === 1 && scaleV === 1 && offsetU === 0 && offsetV === 0) return;
			moved++;
			region.faces.forEach(item => transformFaceUV(item.face, scaleU, scaleV, offsetU, offsetV));
		});

		textures.forEach((tex, ti) => {
			const output = outputs[ti];
			tex.edit((canvas, painter) => {
				const ctx = painter.ctx;
				canvas.width = output.width;
				canvas.height = output.height;
				ctx.imageSmoothingEnabled = false;
				ctx.clearRect(0, 0, output.width, output.height);
				ctx.drawImage(output, 0, 0);
				tex.width = output.width;
				tex.height = output.height;
				if (size || resolution !== 1) tex.keep_size = true;
			}, { no_undo: true, no_undo_init: true, no_undo_finish: true });
		});

		Undo.finishEdit('Repack UV');

		Canvas.updateAllUVs();
		Canvas.updateView({ elements: affected_elements, element_aspects: { uv: true }, textures: textures.slice() });
		textures.forEach(tex => Blockbench.dispatchEvent('update_texture', { texture: tex }));
		if (animated && typeof TextureAnimator !== 'undefined' && TextureAnimator.updateButton) {
			TextureAnimator.updateButton();
		}

		Blockbench.showQuickMessage(
			'Repack UV done: ' + textures.length + ' texture(s), ' + regions.length + ' island(s), ' +
			moved + ' changed, ' + canvasW + ' x ' + canvasH + (animated ? ' per frame' : '') + '.',
			3000
		);
	}

	/* ------------------------------------------------------------------ *
	 *  Dialog
	 * ------------------------------------------------------------------ */

	// Textures to repack: the whole texture selection if the clicked one is part of
	// it, otherwise only the clicked texture.
	function getTargetTextures(clicked) {
		const selected = Texture.all.filter(t => t.selected || t.multi_selected);
		if (selected.length > 1 && selected.includes(clicked)) return selected;
		return [clicked];
	}

	function checkTexture(tex) {
		if (!tex.width || !tex.height || !tex.img) {
			return tex.name + ' is not loaded.';
		}
		if (tex.frameCount > 1 && (!Number.isInteger(tex.frameCount) || tex.height % tex.frameCount !== 0)) {
			return 'The flipbook frames of ' + tex.name + ' have an invalid height.';
		}
		if (tex.layers_enabled) {
			return 'Disable the layers of ' + tex.name + ' first (right click > Disable layers), then try again.';
		}
		return null;
	}

	function openDialog(textures) {
		if (!Project || !Project.elements || !Project.elements.length) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: 'No model open.', icon: 'info' });
			return;
		}
		for (const tex of textures) {
			const problem = checkTexture(tex);
			if (problem) {
				Blockbench.showMessageBox({ title: 'Repack UV', message: problem, icon: 'warning' });
				return;
			}
		}

		const analysis = analyze(textures);
		if (!analysis) {
			Blockbench.showMessageBox({
				title: 'Repack UV',
				message: textures.length > 1 ? 'No face in this model uses these textures.' : 'No face in this model uses this texture.',
				icon: 'info'
			});
			return;
		}
		if (analysis.error) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: analysis.error, icon: 'warning' });
			return;
		}

		const { W, H, regions, animated } = analysis;
		const size_suffix = animated ? ' per frame' : '';
		const texture_label = textures.map((tex, i) =>
			tex.name + (analysis.frames[i] > 1 ? ' (' + analysis.frames[i] + ' frames)' : '')
		).join(', ');

		// --- controls ---
		const gap_input = document.createElement('input');
		gap_input.type = 'number';
		gap_input.min = '0';
		gap_input.step = '1';
		gap_input.value = '1';
		gap_input.style.width = '90px';

		const resolution_select = document.createElement('select');
		resolution_select.style.minWidth = '120px';
		RESOLUTION_STEPS.forEach(pct => {
			const opt = document.createElement('option');
			opt.value = String(pct);
			opt.textContent = pct + ' %';
			resolution_select.append(opt);
		});
		resolution_select.value = '100';

		const size_select = document.createElement('select');
		size_select.style.minWidth = '240px';

		const clean_input = document.createElement('input');
		clean_input.type = 'checkbox';
		clean_input.checked = false;

		const info = document.createElement('div');
		info.style.marginTop = '6px';
		info.style.opacity = '0.75';
		info.style.fontSize = '0.92em';

		const readGap = () => {
			const g = parseInt(gap_input.value, 10);
			return isNaN(g) ? 0 : Math.max(0, g);
		};
		const readResolution = () => parseFloat(resolution_select.value) / 100;

		const refresh = () => {
			const gap = readGap();
			const resolution = readResolution();
			const options = computeSizeOptions(analysis, gap, resolution);
			const previous = size_select.value;

			size_select.innerHTML = '';
			const current = document.createElement('option');
			current.value = 'current';
			current.textContent = 'Keep current size (' + W + ' x ' + H + size_suffix + ')';
			size_select.append(current);

			options.forEach(o => {
				const opt = document.createElement('option');
				opt.value = o.value;
				opt.textContent = o.label;
				size_select.append(opt);
			});

			if (Array.from(size_select.options).some(o => o.value === previous)) {
				size_select.value = previous;
			}

			// Sanity check on the current size with these settings.
			const rects = regions.map(r => scaleRect(r, resolution));
			const current_fits = !!packRects(rects, W, H, gap);

			let text = '';
			if (options.length) {
				const smallest = options[0];
				text = 'Smallest size with this spacing/resolution: ' + smallest.w + ' x ' + smallest.h + size_suffix + '.';
			} else {
				text = 'No smaller size works with this spacing/resolution (you can still keep the current size, or lower the resolution).';
			}
			if (!current_fits) {
				text += ' The current size does not fit either - reduce the spacing.';
			}
			info.textContent = text;
		};

		gap_input.addEventListener('input', refresh);
		resolution_select.addEventListener('change', refresh);

		const dialog = new Dialog({
			id: 'uv_repack_dialog',
			title: 'Repack UV',
			width: 580,
			lines: [
				(textures.length > 1 ? 'Textures: ' : 'Texture: ') + texture_label,
				W + ' x ' + H + size_suffix + ' - ' + regions.length + ' UV island(s).',
				'',
				{ label: 'Spacing between islands (px)', node: gap_input },
				{ label: 'Resolution', node: resolution_select },
				{ label: animated ? 'Output size (per frame)' : 'Output size', node: size_select },
				{ label: 'Remove pixels outside the UVs', node: clean_input },
				info,
				'',
				'UVs and textures are modified together in a single step, so you can undo with Ctrl+Z.'
			],
			buttons: ['dialog.confirm', 'dialog.cancel'],
			onConfirm() {
				const gap = readGap();
				const resolution = readResolution();
				const value = size_select.value;
				let size = null;
				if (value !== 'current') {
					const parts = value.split('x');
					size = { w: parseInt(parts[0], 10), h: parseInt(parts[1], 10) };
				}
				try {
					repackTextures(analysis, gap, size, resolution, clean_input.checked);
				} catch (e) {
					console.error(e);
					Blockbench.showMessageBox({
						title: 'Repack UV - error',
						message: e && e.message ? e.message : String(e),
						icon: 'error'
					});
				}
			}
		});

		refresh();
		dialog.show();
	}

	/* ------------------------------------------------------------------ *
	 *  Plugin registration
	 * ------------------------------------------------------------------ */

	let menu_item = null;

	Plugin.register(PLUGIN_ID, {
		title: 'UV Repack',
		icon: 'grid_on',
		author: 'MaxenceBailly',
		description: 'Compact the UVs of a texture (and its pixels) so the model stays identical. Right click a texture to use it.',
		version: '1.5.0',
		variant: 'both',

		onload() {
			menu_item = {
				id: ACTION_ID,
				name: 'Repack UV',
				icon: 'grid_on',
				description: 'Compact this texture UVs and pixels',
				click(texture) {
					if (texture instanceof Texture) openDialog(getTargetTextures(texture));
				}
			};

			if (Texture.prototype.menu instanceof Menu) {
				Texture.prototype.menu.addAction(menu_item, '#apply');
			}
		},

		onunload() {
			if (menu_item && Texture.prototype.menu instanceof Menu) {
				Texture.prototype.menu.removeAction(menu_item);
				menu_item = null;
			}
		}
	});
})();
