// WebGL2 preview compositor. Each visible clip is one textured quad, drawn
// bottom track first with premultiplied alpha. Colour correction runs in the
// fragment shader with the same operator order as the export renderer
// (channel matrix -> clamp -> contrast about 0.5 -> clamp).

import type { ColorAdjust } from "../lib/types";
import { colorMatrix, contrastSlope, type Mat3 } from "./math";

export type LayerSource = HTMLVideoElement | HTMLImageElement;

export interface Layer {
  key: string;
  source: LayerSource;
  matrix: Mat3;
  /** Crop in source UV space: left, top, right, bottom fractions. */
  crop: [number, number, number, number];
  opacity: number;
  color: ColorAdjust;
}

const VS = `#version 300 es
in vec2 a_uv;
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
out vec4 outColor;
void main() {
  vec4 s = texture(u_tex, v_uv);
  vec3 rgb = clamp(u_color * s.rgb, 0.0, 1.0);
  rgb = clamp((rgb - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float a = s.a * u_opacity;
  outColor = vec4(rgb * a, a);
}`;

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

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.program = link(gl, VS, FS);
    this.loc = Object.fromEntries(
      ["u_matrix", "u_crop", "u_tex", "u_color", "u_contrast", "u_opacity"].map((n) => [n, gl.getUniformLocation(this.program, n)]),
    );
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(this.program, "a_uv");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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

  private drawLayers(layers: Layer[], width: number, height: number, upload: boolean) {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.loc.u_tex, 0);
    for (const l of layers) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture(l.key));
      if (upload) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source);
        } catch {
          continue; // frame not decodable yet
        }
      }
      gl.uniformMatrix3fv(this.loc.u_matrix, false, l.matrix);
      gl.uniform4fv(this.loc.u_crop, l.crop);
      gl.uniformMatrix3fv(this.loc.u_color, false, colorMatrix(l.color));
      gl.uniform1f(this.loc.u_contrast, contrastSlope(l.color));
      gl.uniform1f(this.loc.u_opacity, l.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  render(layers: Layer[]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.drawLayers(layers, this.canvas.width, this.canvas.height, true);
  }

  /** Renders the same frame into a small target and reads it back for scopes. */
  readScopes(layers: Layer[]): Uint8Array {
    const gl = this.gl;
    if (!this.scopeFbo) {
      this.scopeTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.scopeTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, SCOPE_W, SCOPE_H);
      this.scopeFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scopeTex, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeFbo);
    // Textures were uploaded by the preceding render() of this frame.
    this.drawLayers(layers, SCOPE_W, SCOPE_H, false);
    gl.readPixels(0, 0, SCOPE_W, SCOPE_H, gl.RGBA, gl.UNSIGNED_BYTE, this.scopePixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.scopePixels;
  }

  dispose() {
    for (const t of this.textures.values()) this.gl.deleteTexture(t);
    this.textures.clear();
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
