// WebGL2 preview compositor. Each visible clip is one textured quad, drawn
// bottom track first with premultiplied alpha. Colour correction runs in the
// fragment shader with the same operator order as the export renderer
// (channel matrix -> clamp -> contrast about 0.5 -> clamp). Clips with
// effects are first drawn (cropped, colour-corrected) into a framebuffer at
// their fitted size, run through the effect passes and then placed.
// Transitions composite into a framebuffer: the stack so far is kept, the
// outgoing clip drawn over it, the incoming clip over a copy, and the two
// mixed (as the export renderer does).

import { api } from "../lib/ipc";
import type { ColorAdjust, EffectKind, TransitionKind } from "../lib/types";
import { EffectPipeline } from "./effects";
import { colorMatrix, contrastSlope, IDENTITY_COLOR, type Mat3 } from "./math";

export type LayerSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

export interface Layer {
  key: string;
  source: LayerSource;
  matrix: Mat3;
  /** Crop in source UV space: left, top, right, bottom fractions. */
  crop: [number, number, number, number];
  opacity: number;
  color: ColorAdjust;
  /** Active effects in order; needs `work` and `fxScale`. */
  effects?: EffectKind[];
  /** Size in canvas pixels of the clip at scale 1 (where effects run). */
  work?: [number, number];
  /** Canvas pixels per sequence pixel (scales effect radii). */
  fxScale?: number;
}

/** Two clips of one track mixed by a transition. */
export interface TransitionLayer {
  key: string;
  kind: TransitionKind;
  /** Progress 0..1 (frame - t0) / length. */
  p: number;
  /** Wipes: edge position 0..1 across the frame, floor(size * p) / size. */
  edge: number;
  /** Outgoing and incoming clip, null where one is not shown. */
  a: Layer | null;
  b: Layer | null;
}

export type DrawItem = Layer | TransitionLayer;
const isTransition = (l: DrawItem): l is TransitionLayer => "p" in l;

const VS = `#version 300 es
layout(location = 0) in vec2 a_uv;
uniform mat3 u_matrix;
uniform vec4 u_crop;
out vec2 v_uv;
void main() {
  vec3 p = u_matrix * vec3(a_uv, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = vec2(mix(u_crop.x, 1.0 - u_crop.z, a_uv.x), mix(u_crop.y, 1.0 - u_crop.w, a_uv.y));
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform mat3 u_color;
uniform float u_contrast;
uniform float u_opacity;
uniform float u_premul;
out vec4 outColor;
void main() {
  vec4 s = texture(u_tex, v_uv);
  vec3 rgb = clamp(u_color * s.rgb, 0.0, 1.0);
  rgb = clamp((rgb - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float a = s.a * u_opacity;
  outColor = u_premul > 0.5 ? vec4(rgb * a, a) : vec4(rgb, a);
}`;

const FULL_QUAD = new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]);
const NO_CROP: [number, number, number, number] = [0, 0, 0, 0];

export const SCOPE_W = 256;
export const SCOPE_H = 144;

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private textures = new Map<string, WebGLTexture>();
  private loc: Record<string, WebGLUniformLocation | null>;
  private scopeFbo: WebGLFramebuffer | null = null;
  private scopeTex: WebGLTexture | null = null;
  readonly scopePixels = new Uint8Array(SCOPE_W * SCOPE_H * 4);
  private fx: EffectPipeline;
  private solids = new Map<string, WebGLTexture>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    onAsyncLoad: () => void = () => undefined,
  ) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.program = link(gl, VS, FS);
    this.loc = Object.fromEntries(
      ["u_matrix", "u_crop", "u_tex", "u_color", "u_contrast", "u_opacity", "u_premul"].map((n) => [n, gl.getUniformLocation(this.program, n)]),
    );
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.fx = new EffectPipeline(gl, VS, (v, f) => link(gl, v, f), (p) => api.textRead(p), onAsyncLoad);
  }

  private texture(key: string): WebGLTexture {
    let t = this.textures.get(key);
    if (!t) {
      const gl = this.gl;
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(key, t);
    }
    return t;
  }

  release(key: string) {
    const t = this.textures.get(key);
    if (t) {
      this.gl.deleteTexture(t);
      this.textures.delete(key);
    }
  }

  /** Main program state for drawing into `target`. */
  private bindMain(target: WebGLFramebuffer | null, width: number, height: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.loc.u_tex, 0);
  }

  private quad(matrix: Mat3, crop: [number, number, number, number], color: ColorAdjust, opacity: number, premul: boolean) {
    const gl = this.gl;
    gl.uniformMatrix3fv(this.loc.u_matrix, false, matrix);
    gl.uniform4fv(this.loc.u_crop, crop);
    gl.uniformMatrix3fv(this.loc.u_color, false, colorMatrix(color));
    gl.uniform1f(this.loc.u_contrast, contrastSlope(color));
    gl.uniform1f(this.loc.u_opacity, opacity);
    gl.uniform1f(this.loc.u_premul, premul ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draws one layer onto `target`, which the main program is bound to. */
  private drawLayer(l: Layer, target: WebGLFramebuffer | null, width: number, height: number, upload: boolean) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture(l.key));
    if (upload) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source);
      } catch {
        return; // frame not decodable yet
      }
    }
    if (!l.effects?.length || !l.work) {
      this.quad(l.matrix, l.crop, l.color, l.opacity, true);
      return;
    }
    // Crop and colour into a framebuffer at the fitted size, run the effects, then place.
    const [w, h] = l.work.map((v) => Math.max(1, Math.round(v)));
    const first = this.fx.acquire(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, first.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    this.quad(FULL_QUAD, l.crop, l.color, 1, false);
    const out = this.fx.apply(first, l.effects, l.fxScale ?? 1);
    this.bindMain(target, width, height);
    gl.bindTexture(gl.TEXTURE_2D, out.tex);
    this.quad(l.matrix, NO_CROP, IDENTITY_COLOR, l.opacity, true);
    this.fx.release(out);
  }

  private drawLayers(items: DrawItem[], target: WebGLFramebuffer | null, width: number, height: number, upload: boolean) {
    const gl = this.gl;
    // With transitions the frame is built in a framebuffer and drawn at the end.
    const acc = items.some(isTransition) ? this.fx.acquire(width, height) : null;
    const into = acc?.fbo ?? target;
    this.bindMain(into, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const it of items) {
      if (!isTransition(it)) {
        this.drawLayer(it, into, width, height, upload);
        continue;
      }
      // The incoming clip goes over a copy of the stack so far, the outgoing one over the stack.
      const cb = this.fx.acquire(width, height);
      this.copy(acc!.fbo, cb.fbo, width, height);
      this.bindMain(into, width, height);
      if (it.a) this.drawLayer(it.a, into, width, height, upload);
      this.bindMain(cb.fbo, width, height);
      if (it.b) this.drawLayer(it.b, cb.fbo, width, height, upload);
      this.mix(it, cb.tex, into, width, height);
      this.fx.release(cb);
    }
    if (acc) {
      this.bindMain(target, width, height);
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      this.quad(FULL_QUAD, NO_CROP, IDENTITY_COLOR, 1, false);
      this.fx.release(acc);
    }
  }

  private copy(from: WebGLFramebuffer, to: WebGLFramebuffer, width: number, height: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /** 1x1 texture of one colour. */
  private solid(name: "black" | "white"): WebGLTexture {
    let t = this.solids.get(name);
    if (!t) {
      const gl = this.gl;
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      const v = name === "white" ? 255 : 0;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([v, v, v, 255]));
      this.solids.set(name, t);
    }
    return t;
  }

  /** Mixes the incoming composite `cb` into the outgoing one in `target` (as render.rs). */
  private mix(t: TransitionLayer, cb: WebGLTexture, target: WebGLFramebuffer | null, width: number, height: number) {
    const gl = this.gl;
    this.bindMain(target, width, height);
    const layer = (tex: WebGLTexture, opacity: number) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.quad(FULL_QUAD, NO_CROP, IDENTITY_COLOR, opacity, true);
    };
    switch (t.kind) {
      case "dipBlack":
      case "dipWhite": {
        const colour = this.solid(t.kind === "dipBlack" ? "black" : "white");
        if (t.p < 0.5) {
          layer(colour, 2 * t.p);
        } else {
          layer(cb, 1);
          layer(colour, 2 - 2 * t.p);
        }
        break;
      }
      case "wipeLeft":
      case "wipeRight":
      case "wipeUp":
      case "wipeDown": {
        // Window coordinates count from the bottom left.
        const ex = Math.round(t.edge * width);
        const ey = Math.round(t.edge * height);
        const box = {
          wipeRight: [0, 0, ex, height],
          wipeLeft: [width - ex, 0, ex, height],
          wipeDown: [0, height - ey, width, ey],
          wipeUp: [0, 0, width, ey],
        }[t.kind];
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(box[0], box[1], box[2], box[3]);
        layer(cb, 1);
        gl.disable(gl.SCISSOR_TEST);
        break;
      }
      default:
        layer(cb, t.p);
    }
  }

  render(layers: DrawItem[]) {
    this.drawLayers(layers, null, this.canvas.width, this.canvas.height, true);
  }

  /** Renders `layers` and reads one pixel; x, y in 0..1 from the top left. */
  pick(layers: DrawItem[], x: number, y: number): [number, number, number] | null {
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    const gl = this.gl;
    this.render(layers);
    const px = new Uint8Array(4);
    gl.readPixels(Math.min(this.canvas.width - 1, Math.floor(x * this.canvas.width)), Math.min(this.canvas.height - 1, Math.floor((1 - y) * this.canvas.height)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0] / 255, px[1] / 255, px[2] / 255];
  }

  /** Renders the same frame into a small target and reads it back for scopes. */
  readScopes(layers: DrawItem[]): Uint8Array {
    const gl = this.gl;
    if (!this.scopeFbo) {
      this.scopeTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.scopeTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, SCOPE_W, SCOPE_H);
      this.scopeFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scopeTex, 0);
    }
    // Textures were uploaded by the preceding render() of this frame.
    this.drawLayers(layers, this.scopeFbo, SCOPE_W, SCOPE_H, false);
    gl.readPixels(0, 0, SCOPE_W, SCOPE_H, gl.RGBA, gl.UNSIGNED_BYTE, this.scopePixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.scopePixels;
  }

  dispose() {
    for (const t of [...this.textures.values(), ...this.solids.values()]) this.gl.deleteTexture(t);
    this.textures.clear();
    this.solids.clear();
    this.fx.dispose();
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
