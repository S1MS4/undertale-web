import type { DataWin } from '../data/DataWin.ts';

const VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in vec4 aColor;
uniform vec2 uView;
out vec2 vUv;
out vec4 vColor;
void main() {
	vUv = aUv;
	vColor = aColor;
	gl_Position = vec4(aPos.x / uView.x * 2.0 - 1.0, 1.0 - aPos.y / uView.y * 2.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
	outColor = texture(uTex, vUv) * vColor;
}`;

const FLOATS_PER_VERTEX = 8; // x, y, u, v, r, g, b, a
const MAX_QUADS = 4096;

/** A texture: a decoded texture page, the 1x1 white texture, or a render target (surface). */
export interface Page {
	texture: WebGLTexture;
	width: number;
	height: number;
	/** Render targets are stored bottom-up, so their v coordinates are flipped when drawn. */
	flipY: boolean;
}

export interface Surface extends Page {
	framebuffer: WebGLFramebuffer;
}

export interface Point {
	x: number;
	y: number;
}

/** Maps game (room) coordinates to the current render target. */
interface Transform {
	scaleX: number;
	scaleY: number;
	offsetX: number;
	offsetY: number;
}

const IDENTITY: Transform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

/** An area of the render target, in its pixels. */
export interface Area {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * Batched textured quads on WebGL2, in GameMaker's pixel coordinates (origin top-left).
 * Colours are GameMaker colours: 0xBBGGRR.
 */
export class Renderer {
	width: number;
	height: number;
	readonly white: Page;
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly pngs: Uint8Array[];
	private readonly pages: (Page | undefined)[] = [];
	private readonly loading = new Map<number, Promise<void>>();
	private readonly vertices = new Float32Array(MAX_QUADS * 4 * FLOATS_PER_VERTEX);
	private readonly viewUniform: WebGLUniformLocation | null;
	private quads = 0;
	private bound: Page | null = null;
	private target: Surface | null = null;
	private transform: Transform = IDENTITY;
	private blending = true;
	/** While set, every quad drawn widens it to cover where the quad lands. */
	bounds: Area | null = null;

	constructor(canvas: HTMLCanvasElement, data: DataWin) {
		this.canvas = canvas;
		this.width = canvas.width = data.windowWidth;
		this.height = canvas.height = data.windowHeight;
		this.pngs = data.texturePages;

		const gl = canvas.getContext('webgl2', {
			alpha: false,
			antialias: false,
			premultipliedAlpha: false,
			preserveDrawingBuffer: true, // draw_getpixel and screenshots read the canvas back
		});
		if (!gl) throw new Error('WebGL2 is not available in this browser');
		this.gl = gl;

		const program = linkProgram(gl, VERTEX, FRAGMENT);
		gl.useProgram(program);
		this.viewUniform = gl.getUniformLocation(program, 'uView');
		gl.uniform2f(this.viewUniform, this.width, this.height);
		gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);

		gl.bindVertexArray(gl.createVertexArray());
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
		const stride = FLOATS_PER_VERTEX * 4;
		attribute(gl, program, 'aPos', 2, stride, 0);
		attribute(gl, program, 'aUv', 2, stride, 8);
		attribute(gl, program, 'aColor', 4, stride, 16);

		const indices = new Uint16Array(MAX_QUADS * 6);
		for (let q = 0; q < MAX_QUADS; q++) {
			indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
		}
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		this.white = this.upload(new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1));
	}

	/** Decodes and uploads texture pages ahead of use. Pages also load on first draw, skipping that draw. */
	loadPages(indices: Iterable<number>): Promise<void> {
		return Promise.all([...indices].map((i) => this.loadPage(i))).then(() => undefined);
	}

	/** Changes the canvas resolution (it follows the window's shape). */
	resize(width: number, height: number): void {
		if (width === this.width && height === this.height) return;
		this.flush();
		this.width = this.canvas.width = width;
		this.height = this.canvas.height = height;
		if (!this.target) this.bindTarget(null);
	}

	/** Starts drawing a frame to the canvas. */
	begin(clearColor = 0): void {
		this.setTarget(null);
		this.clear(clearColor, 1);
	}

	end(): void {
		this.flush();
	}

	clear(color: number, alpha: number): void {
		this.flush();
		const gl = this.gl;
		gl.clearColor((color & 0xff) / 255, ((color >> 8) & 0xff) / 255, ((color >> 16) & 0xff) / 255, alpha);
		gl.clear(gl.COLOR_BUFFER_BIT);
	}

	/** Room-to-target mapping for a view: (x - viewX) * portW / viewW + portX. */
	setView(viewX: number, viewY: number, viewW: number, viewH: number, portX: number, portY: number, portW: number, portH: number): void {
		this.flush();
		const scaleX = viewW ? portW / viewW : 1;
		const scaleY = viewH ? portH / viewH : 1;
		this.transform = { scaleX, scaleY, offsetX: portX - viewX * scaleX, offsetY: portY - viewY * scaleY };
	}

	resetView(): void {
		this.flush();
		this.transform = IDENTITY;
	}

	setBlending(enabled: boolean): void {
		if (enabled === this.blending) return;
		this.flush();
		this.blending = enabled;
		if (enabled) this.gl.enable(this.gl.BLEND);
		else this.gl.disable(this.gl.BLEND);
	}

	createSurface(width: number, height: number): Surface {
		const gl = this.gl;
		this.flush();
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		setNearest(gl);
		const framebuffer = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		this.bound = null;
		this.bindTarget(this.target);
		return { texture, framebuffer, width, height, flipY: true };
	}

	/** Makes a surface drawable by page index, like a texture page (for sprites made from surfaces). */
	registerPage(page: Page): number {
		const index = Math.max(this.pngs.length, this.pages.length);
		this.pages[index] = page;
		return index;
	}

	freeSurface(surface: Surface): void {
		if (this.target === surface) this.setTarget(null);
		this.flush();
		this.gl.deleteFramebuffer(surface.framebuffer);
		this.gl.deleteTexture(surface.texture);
	}

	/** Draws into `surface`, or the canvas when null. */
	setTarget(surface: Surface | null): void {
		this.flush();
		this.target = surface;
		this.bindTarget(surface);
	}

	getTarget(): Surface | null {
		return this.target;
	}

	drawRegion(
		pageIndex: number,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
		color: number,
		alpha: number,
	): void {
		const page = this.page(pageIndex);
		if (page) this.drawPage(page, sx, sy, sw, sh, dx, dy, dw, dh, color, alpha);
	}

	/** Axis-aligned textured rectangle. */
	drawPage(page: Page, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, color: number, alpha: number): void {
		this.quad(page, sx, sy, sw, sh, [
			{ x: dx, y: dy },
			{ x: dx + dw, y: dy },
			{ x: dx, y: dy + dh },
			{ x: dx + dw, y: dy + dh },
		], [color, color, color, color], alpha);
	}

	/**
	 * Textured quad with arbitrary corners (top-left, top-right, bottom-left, bottom-right),
	 * one colour per corner. Returns false if the page isn't loaded yet.
	 */
	quad(page: Page | number, sx: number, sy: number, sw: number, sh: number, corners: Point[], colors: number[], alpha: number): boolean {
		const p = typeof page === 'number' ? this.page(page) : page;
		if (!p) return false;
		let v0 = sy / p.height;
		let v1 = (sy + sh) / p.height;
		if (p.flipY) {
			v0 = 1 - v0;
			v1 = 1 - v1;
		}
		this.emit(p, sx / p.width, v0, (sx + sw) / p.width, v1, corners, colors, alpha);
		return true;
	}

	/** Untextured shapes. */
	fillRect(x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
		this.fillQuad([{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }], [color, color, color, color], alpha);
	}

	fillQuad(corners: Point[], colors: number[], alpha: number): void {
		this.emit(this.white, 0, 0, 1, 1, corners, colors, alpha);
	}

	fillTriangle(a: Point, b: Point, c: Point, colors: number[], alpha: number): void {
		this.emit(this.white, 0, 0, 1, 1, [a, b, c, c], [colors[0], colors[1], colors[2], colors[2]], alpha);
	}

	/** Reads one pixel of the current target, as a GameMaker colour. */
	getPixel(x: number, y: number): number {
		this.flush();
		const gl = this.gl;
		const t = this.transform;
		const px = Math.floor(x * t.scaleX + t.offsetX);
		const height = this.target ? this.target.height : this.height;
		const py = Math.floor(y * t.scaleY + t.offsetY);
		const out = new Uint8Array(4);
		// GL rows count from the bottom.
		gl.readPixels(px, height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
		return out[0] | (out[1] << 8) | (out[2] << 16);
	}

	private page(index: number): Page | null {
		const page = this.pages[index];
		if (!page) {
			void this.loadPage(index);
			return null;
		}
		return page;
	}

	private bindTarget(surface: Surface | null): void {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, surface ? surface.framebuffer : null);
		const w = surface ? surface.width : this.width;
		const h = surface ? surface.height : this.height;
		gl.viewport(0, 0, w, h);
		// Game y = 0 lands on the top row in both cases; surfaces are sampled with flipY to match.
		gl.uniform2f(this.viewUniform, w, h);
	}

	private loadPage(index: number): Promise<void> {
		if (this.pages[index]) return Promise.resolve();
		let pending = this.loading.get(index);
		if (!pending) {
			pending = (async () => {
				const blob = new Blob([this.pngs[index].slice()], { type: 'image/png' });
				const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
				this.pages[index] = this.upload(bitmap);
				bitmap.close();
			})();
			this.loading.set(index, pending);
		}
		return pending;
	}

	private upload(source: ImageBitmap | ImageData): Page {
		const gl = this.gl;
		this.flush();
		this.bound = null;
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
		setNearest(gl);
		return { texture, width: source.width, height: source.height, flipY: false };
	}

	private emit(page: Page, u0: number, v0: number, u1: number, v1: number, corners: Point[], colors: number[], alpha: number): void {
		if (page !== this.bound) {
			this.flush();
			this.bound = page;
			this.gl.bindTexture(this.gl.TEXTURE_2D, page.texture);
		}
		if (this.quads === MAX_QUADS) this.flush();

		const t = this.transform;
		const uvs = [u0, v0, u1, v0, u0, v1, u1, v1];
		const v = this.vertices;
		let o = this.quads * 4 * FLOATS_PER_VERTEX;
		for (let k = 0; k < 4; k++) {
			const c = colors[k];
			const x = corners[k].x * t.scaleX + t.offsetX;
			const y = corners[k].y * t.scaleY + t.offsetY;
			if (this.bounds) {
				const b = this.bounds;
				b.left = Math.min(b.left, x);
				b.top = Math.min(b.top, y);
				b.right = Math.max(b.right, x);
				b.bottom = Math.max(b.bottom, y);
			}
			v[o++] = x;
			v[o++] = y;
			v[o++] = uvs[k * 2];
			v[o++] = uvs[k * 2 + 1];
			v[o++] = (c & 0xff) / 255;
			v[o++] = ((c >> 8) & 0xff) / 255;
			v[o++] = ((c >> 16) & 0xff) / 255;
			v[o++] = alpha;
		}
		this.quads++;
	}

	private flush(): void {
		if (this.quads === 0) return;
		const gl = this.gl;
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices.subarray(0, this.quads * 4 * FLOATS_PER_VERTEX));
		gl.drawElements(gl.TRIANGLES, this.quads * 6, gl.UNSIGNED_SHORT, 0);
		this.quads = 0;
	}
}

function setNearest(gl: WebGL2RenderingContext): void {
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function linkProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
	const program = gl.createProgram();
	for (const [type, source] of [
		[gl.VERTEX_SHADER, vertexSource],
		[gl.FRAGMENT_SHADER, fragmentSource],
	] as const) {
		const shader = gl.createShader(type);
		if (!shader) throw new Error('WebGL: could not create shader');
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			throw new Error(`WebGL shader: ${gl.getShaderInfoLog(shader)}`);
		}
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`WebGL program: ${gl.getProgramInfoLog(program)}`);
	}
	return program;
}

function attribute(
	gl: WebGL2RenderingContext,
	program: WebGLProgram,
	name: string,
	size: number,
	stride: number,
	offset: number,
): void {
	const location = gl.getAttribLocation(program, name);
	gl.enableVertexAttribArray(location);
	gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
}
