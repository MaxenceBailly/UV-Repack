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
 *
 * Author: MaxenceBailly
 */

(function () {
	const PLUGIN_ID = 'uv_repack';
	const ACTION_ID = 'repack_uvs';
	const MAX_REGIONS = 5000;
	const MIN_SIZE = 16;
	const RESOLUTION_STEPS = [100, 75, 50, 25, 12.5];

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
	 * Collect every face referencing `tex`. Box UV cubes that use the texture are
	 * flagged so they get frozen to per-face UV (their UVs are already stored on
	 * each face and would otherwise be recalculated from the box layout).
	 */
	function collectFaces(tex) {
		const faces = [];
		const cubes_to_convert = new Set();

		for (const element of Project.elements) {
			if (!element || !element.faces) continue;
			for (let key in element.faces) {
				const face = element.faces[key];
				if (!face || face.texture === null || face.texture === false) continue;
				let face_texture;
				try { face_texture = face.getTexture(); } catch (e) { continue; }
				if (face_texture !== tex) continue;
				const pts = getFaceUVPoints(face);
				if (!pts) continue;
				if (element.box_uv) cubes_to_convert.add(element);
				faces.push({ element, key, face, pts });
			}
		}
		return { faces, cubes_to_convert };
	}

	/**
	 * Build the unique pixel rectangles to pack. Faces covering the exact same
	 * rectangle (mirrored faces) are merged so pixels are copied only once.
	 */
	function buildRegions(faces, tex) {
		const W = tex.width;
		const H = tex.height;
		const uvW = tex.getUVWidth();
		const uvH = tex.getUVHeight();
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

		return { regions: Array.from(map.values()), W, H, uvW, uvH };
	}

	function analyze(tex) {
		const { faces, cubes_to_convert } = collectFaces(tex);
		if (!faces.length) return null;
		const built = buildRegions(faces, tex);
		return Object.assign({ faces, cubes_to_convert }, built);
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
	 * the real PNG sizes that can hold them.
	 */
	function computeSizeOptions(analysis, gap, resolution) {
		const { regions, W, H } = analysis;
		const rects = regions.map(r => scaleRect(r, resolution));
		const seen = new Set();
		const options = [];

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

	function repackTexture(tex, analysis, gap, size, resolution) {
		if (!analysis) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: 'No face in this model uses this texture.', icon: 'info' });
			return;
		}

		const { regions, W, H, uvW, uvH, faces, cubes_to_convert } = analysis;
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

		// Snapshot the current texture.
		const source = document.createElement('canvas');
		source.width = W;
		source.height = H;
		const sourceCtx = source.getContext('2d');
		const src_image = (tex.canvas && tex.canvas.width) ? tex.canvas : tex.img;
		sourceCtx.drawImage(src_image, 0, 0, W, H);

		// Build the new texture.
		const output = document.createElement('canvas');
		output.width = canvasW;
		output.height = canvasH;
		const outputCtx = output.getContext('2d');
		outputCtx.imageSmoothingEnabled = false;

		regions.forEach((region, i) => {
			const p = placed[i];
			const t = target_rects[i];
			outputCtx.drawImage(
				source,
				region.x, region.y, region.w, region.h,
				p.x, p.y, t.w, t.h
			);
		});

		// Apply UV + texture changes in a single undo step.
		const affected_elements = [];
		const seen = new Set();
		for (const item of faces) {
			if (!seen.has(item.element)) { seen.add(item.element); affected_elements.push(item.element); }
		}

		Undo.initEdit({ elements: affected_elements, textures: [tex], bitmap: true });

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

		tex.edit((canvas, painter) => {
			const ctx = painter.ctx;
			canvas.width = canvasW;
			canvas.height = canvasH;
			ctx.imageSmoothingEnabled = false;
			ctx.clearRect(0, 0, canvasW, canvasH);
			ctx.drawImage(output, 0, 0);
			tex.width = canvasW;
			tex.height = canvasH;
			if (size || resolution !== 1) tex.keep_size = true;
		}, { no_undo: true, no_undo_init: true, no_undo_finish: true });

		Undo.finishEdit('Repack UV');

		Canvas.updateAllUVs();
		Canvas.updateView({ elements: affected_elements, element_aspects: { uv: true }, textures: [tex] });
		Blockbench.dispatchEvent('update_texture', { texture: tex });

		Blockbench.showQuickMessage(
			'Repack UV done: ' + regions.length + ' island(s), ' + moved + ' changed, ' +
			canvasW + ' x ' + canvasH + '.',
			3000
		);
	}

	/* ------------------------------------------------------------------ *
	 *  Dialog
	 * ------------------------------------------------------------------ */

	function openDialog(tex) {
		if (!Project || !Project.elements || !Project.elements.length) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: 'No model open.', icon: 'info' });
			return;
		}
		if (!tex.width || !tex.height || !tex.img) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: 'The texture is not loaded.', icon: 'warning' });
			return;
		}
		if (tex.frameCount > 1) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: 'Animated (flipbook) textures are not supported.', icon: 'warning' });
			return;
		}
		if (tex.layers_enabled) {
			Blockbench.showMessageBox({
				title: 'Repack UV',
				message: 'Disable the texture layers first (right click > Disable layers), then try again.',
				icon: 'warning'
			});
			return;
		}

		const analysis = analyze(tex);
		if (!analysis) {
			Blockbench.showMessageBox({ title: 'Repack UV', message: 'No face in this model uses this texture.', icon: 'info' });
			return;
		}

		const { W, H, regions } = analysis;

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
			current.textContent = 'Keep current size (' + W + ' x ' + H + ')';
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
				text = 'Smallest size with this spacing/resolution: ' + smallest.w + ' x ' + smallest.h + '.';
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
				'Texture: ' + tex.name + ' (' + W + ' x ' + H + ') - ' + regions.length + ' UV island(s).',
				'',
				{ label: 'Spacing between islands (px)', node: gap_input },
				{ label: 'Resolution', node: resolution_select },
				{ label: 'Output size', node: size_select },
				info,
				'',
				'UVs and the texture are modified together in a single step, so you can undo with Ctrl+Z.'
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
					repackTexture(tex, analysis, gap, size, resolution);
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
		version: '1.2.0',
		variant: 'both',

		onload() {
			menu_item = {
				id: ACTION_ID,
				name: 'Repack UV',
				icon: 'grid_on',
				description: 'Compact this texture UVs and pixels',
				click(texture) {
					if (texture instanceof Texture) openDialog(texture);
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
