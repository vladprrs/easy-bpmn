// AuroraField — a luminous teal "current" field rendered on a transparent WebGL
// canvas BEHIND the bpmn SVG. It paints a slow flowing aurora (fbm caustics) plus
// soft pools of light under live / failed / settled nodes, tracked through pan &
// zoom via the diagram's viewbox. The glass nodes sit on top and let it bleed
// through — that is what reads as liquid glass on a light field.
//
// Luminosity-on-pale, not neon: normal alpha-blend of a teal hue over the pale
// canvas pools colour rather than blowing out to white. Degrades to Canvas-2D
// radial pools where WebGL is unavailable, and freezes time under reduced-motion
// (it still tracks pan/zoom — no information lives only in animation).

type Kind = "live" | "hot" | "settle";
export interface Hotspot {
  id: string;
  kind: Kind;
  weight?: number;
}

const MAX_SPOTS = 24;
const RENDER_SCALE = 0.66; // the field is soft; render at 2/3 res for cheap fill
const KIND: Record<Kind, { color: [number, number, number]; intensity: number; radius: number }> = {
  live: { color: [0.13, 0.83, 0.72], intensity: 0.4, radius: 2.0 },
  hot: { color: [0.95, 0.31, 0.26], intensity: 0.5, radius: 1.72 },
  settle: { color: [0.16, 0.72, 0.46], intensity: 0.24, radius: 1.85 },
};
// Pulse style handed to the shader per spot: 0 = steady (a settled circuit holds, no
// breathing), 1 = gentle breathing (live current), 2 = sharp (hot / failure).
const PULSE: Record<Kind, number> = { settle: 0, live: 1, hot: 2 };

const VERT = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_ambient;
uniform int u_count;
uniform vec4 u_spots[${MAX_SPOTS}];   // xy = px, z = radius px, w = intensity
uniform vec3 u_spotcol[${MAX_SPOTS}];
uniform float u_spotpulse[${MAX_SPOTS}]; // 0 = steady, 1 = live breathe, 2 = hot sharp

float hash(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  vec3 teal = vec3(0.075, 0.608, 0.525);
  vec3 tealHi = vec3(0.34, 0.80, 0.72);

  vec2 q = uv * vec2(u_res.x / u_res.y, 1.0) * 2.3;
  float t = u_time * 0.045;
  float n = fbm(q + vec2(t, -t * 0.55) + fbm(q * 0.6 - t * 0.3));
  float band = smoothstep(0.3, 0.96, n);
  // Idle field is PLAIN PALE: with u_ambient ~0 nothing glows at rest — luminosity
  // lives only in the spot pools below.
  float ambA = u_ambient > 0.001 ? (0.3 + 0.7 * band) * u_ambient : 0.0;

  vec3 colAcc = mix(teal, tealHi, band) * ambA;
  float aAcc = ambA;

  for(int i = 0; i < ${MAX_SPOTS}; i++){
    if(i >= u_count) break;
    vec4 s = u_spots[i];
    float d = distance(frag, s.xy);
    float fall = exp(-pow(d / max(s.z, 1.0), 2.0));
    // Pulse per kind: live breathes gently, hot/failure pulses sharply, a settled
    // circuit holds steady so success reads as SETTLED, not still-running.
    float style = u_spotpulse[i];
    float pulse = 1.0;
    if (style > 1.5) {
      float w = 0.5 + 0.5 * sin(u_time * 2.6 + float(i));
      pulse = 0.72 + 0.34 * w * w * w;
    } else if (style > 0.5) {
      pulse = 0.85 + 0.15 * sin(u_time * 1.4 + float(i) * 1.3);
    }
    float g = fall * s.w * pulse;
    colAcc += u_spotcol[i] * g;
    aAcc += g;
  }

  vec3 outc = aAcc > 0.001 ? colAcc / aAcc : teal;
  // Cap alpha low: a soft luminous floor, never a neon wash — node strokes + labels
  // stay readable over a lit pool.
  float outa = clamp(aAcc, 0.0, 0.5);
  gl_FragColor = vec4(outc, outa);
}`;

export class AuroraField {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private viewer: any = null;
  private eventBus: any = null;
  private spec: Hotspot[] = [];
  private raf = 0;
  private start = 0;
  private now = 0;
  private reduced = false;
  private disposed = false;
  // One-shot "exhale" on settle: the live pools fade out to the plain pale calm.
  private fading = false;
  private intensityMul = 1;
  private ro?: ResizeObserver;
  private reducedMq: MediaQueryList | null = null;
  private onVisibility = () => this.pump();
  // React live to an OS reduced-motion toggle (no reload). Turning it ON cancels any
  // running loop, then settles on one static frame; OFF lets pump() spin back up.
  private onReducedChange = (e: MediaQueryListEvent) => {
    this.reduced = e.matches;
    if (this.reduced) {
      this.fading = false;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.pump();
  };

  // GL handles
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.reducedMq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null : null;
    this.reduced = !!this.reducedMq?.matches;
    this.initGL() || this.init2D();
    this.resize();
    if ("ResizeObserver" in window) {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
    // Pause on tab-hide (handled in pump/loop via document.hidden); resume on
    // visibility AND window focus (a window-level blur on a still-visible tab does
    // not fire visibilitychange) to cut GPU/battery on long on-call sessions.
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onVisibility);
    this.reducedMq?.addEventListener?.("change", this.onReducedChange);
    this.pump();
  }

  attach(viewer: any) {
    this.viewer = viewer;
    // Re-render on pan/zoom via the canvas event instead of a perpetual rAF poll.
    try {
      this.eventBus = viewer.get("eventBus");
      this.eventBus?.on("canvas.viewbox.changed", this.onViewboxChanged);
    } catch {
      this.eventBus = null;
    }
    this.pump();
  }
  detach() {
    try {
      this.eventBus?.off("canvas.viewbox.changed", this.onViewboxChanged);
    } catch {
      /* gone */
    }
    this.eventBus = null;
    this.viewer = null;
    this.spec = [];
    this.renderOnce(); // clear the field to plain pale
  }
  setHotspots(spec: Hotspot[]) {
    this.spec = spec.slice(0, MAX_SPOTS);
    // A fresh live pool cancels an in-flight exhale; an empty one (the settled
    // circuit) lets the breath finish, then we rest on plain pale.
    if (spec.length && this.fading) {
      this.fading = false;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.pump();
  }

  /** The field exhales: the pools lit right now fade out over `durationMs` to the
   *  plain pale calm — the closing breath of the "circuit settles on success" beat.
   *  Snapshots the current pools so it reads even after the spec is cleared to []. A
   *  no-op under reduced motion (the field simply rests plain). */
  exhale(durationMs = 1150) {
    if (this.reduced || this.disposed || document.hidden) return;
    const snap = this.spec.slice();
    if (!snap.length) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.fading = true;
    const t0 = performance.now();
    if (!this.start) this.start = t0;
    const loop = (ts: number) => {
      this.raf = 0;
      if (this.disposed || document.hidden || !this.fading) {
        this.fading = false;
        return;
      }
      const p = Math.min(1, (ts - t0) / durationMs);
      this.intensityMul = Math.pow(1 - p, 3); // ease-out: a quick release, a long quiet tail
      this.now = (ts - this.start) / 1000;
      const keep = this.spec;
      this.spec = snap; // render the snapshotted pools, fading
      this.render();
      this.spec = keep;
      this.intensityMul = 1;
      if (p < 1) {
        this.raf = requestAnimationFrame(loop);
      } else {
        this.fading = false;
        this.pump(); // resume normal: the real (empty) spec → plain pale
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    this.fading = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    try {
      this.eventBus?.off("canvas.viewbox.changed", this.onViewboxChanged);
    } catch {
      /* gone */
    }
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onVisibility);
    this.reducedMq?.removeEventListener?.("change", this.onReducedChange);
    const ext = this.gl?.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }

  // ---- lifecycle ----------------------------------------------------------
  // Sustain a rAF loop ONLY when there's motion to show (live current or a hot /
  // failure pulse), the tab is visible, and reduced-motion is off. A settled circuit,
  // a hidden tab, and reduced-motion all fall back to event-driven single renders
  // (on a hotspot change or a pan/zoom 'canvas.viewbox.changed') — no perpetual poll.
  private pump() {
    if (this.disposed || document.hidden) return;
    if (this.reduced || !this.hasAnimatedSpots()) {
      this.renderOnce();
      return;
    }
    if (this.raf) return;
    const loop = (ts: number) => {
      this.raf = 0;
      if (this.disposed || document.hidden) return;
      if (!this.start) this.start = ts;
      this.now = (ts - this.start) / 1000;
      this.render();
      if (this.hasAnimatedSpots()) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** A single repaint on the next frame (no sustained loop). */
  private renderOnce() {
    if (this.disposed || this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private hasAnimatedSpots(): boolean {
    for (const s of this.spec) if (s.kind === "live" || s.kind === "hot") return true;
    return false;
  }

  /** Pan/zoom moved the field — repaint once when no animation loop is running. */
  private onViewboxChanged = () => {
    if (!this.raf) this.renderOnce();
  };

  // ---- geometry -----------------------------------------------------------
  private viewbox(): any {
    try {
      return this.viewer?.get("canvas")?.viewbox();
    } catch {
      return null;
    }
  }

  /** Resolve hotspot specs to backing-pixel light pools using the live viewbox. */
  private spots(): { x: number; y: number; r: number; w: number; c: [number, number, number]; p: number }[] {
    const vb = this.viewbox();
    if (!vb || !this.viewer) return [];
    let registry: any;
    try {
      registry = this.viewer.get("elementRegistry");
    } catch {
      return [];
    }
    const q = (this.canvas.width || 1) / (this.canvas.clientWidth || 1); // backing px per CSS px
    const out: { x: number; y: number; r: number; w: number; c: [number, number, number]; p: number }[] = [];
    for (const s of this.spec) {
      const el = registry.get(s.id);
      if (!el || el.x == null) continue;
      const cx = (el.x + el.width / 2 - vb.x) * vb.scale * q;
      const cy = (el.y + el.height / 2 - vb.y) * vb.scale * q;
      const k = KIND[s.kind];
      const r = Math.max(el.width, el.height) * vb.scale * q * k.radius;
      out.push({ x: cx, y: this.canvas.height - cy, r, w: k.intensity * (s.weight ?? 1) * this.intensityMul, c: k.color, p: PULSE[s.kind] });
      if (out.length >= MAX_SPOTS) break;
    }
    return out;
  }

  // ---- WebGL --------------------------------------------------------------
  private initGL(): boolean {
    const gl = (this.canvas.getContext("webgl", { premultipliedAlpha: false, alpha: true, antialias: false }) ||
      this.canvas.getContext("experimental-webgl", { premultipliedAlpha: false, alpha: true })) as WebGLRenderingContext | null;
    if (!gl) return false;
    const prog = link(gl, VERT, FRAG);
    if (!prog) return false;
    this.gl = gl;
    this.prog = prog;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ["u_res", "u_time", "u_ambient", "u_count", "u_spots", "u_spotcol", "u_spotpulse"]) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }

  private render() {
    if (this.gl) this.renderGL();
    else if (this.ctx2d) this.render2D();
  }

  private renderGL() {
    const gl = this.gl!;
    gl.useProgram(this.prog);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const spots = this.spots();
    const flat = new Float32Array(MAX_SPOTS * 4);
    const cols = new Float32Array(MAX_SPOTS * 3);
    const puls = new Float32Array(MAX_SPOTS);
    spots.forEach((s, i) => {
      flat[i * 4] = s.x;
      flat[i * 4 + 1] = s.y;
      flat[i * 4 + 2] = s.r;
      flat[i * 4 + 3] = s.w;
      cols[i * 3] = s.c[0];
      cols[i * 3 + 1] = s.c[1];
      cols[i * 3 + 2] = s.c[2];
      puls[i] = s.p;
    });
    gl.uniform2f(this.u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.u_time, this.now);
    gl.uniform1f(this.u.u_ambient, 0.0); // idle field is plain pale — only spots glow
    gl.uniform1i(this.u.u_count, spots.length);
    if (this.u.u_spots) gl.uniform4fv(this.u.u_spots, flat);
    if (this.u.u_spotcol) gl.uniform3fv(this.u.u_spotcol, cols);
    if (this.u.u_spotpulse) gl.uniform1fv(this.u.u_spotpulse, puls);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- Canvas-2D fallback -------------------------------------------------
  private init2D() {
    this.ctx2d = this.canvas.getContext("2d");
  }

  private render2D() {
    const ctx = this.ctx2d!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    // Idle field is plain pale — no ambient wash; only the spot pools below glow.
    for (const s of this.spots()) {
      const y = H - s.y; // 2d origin is top-left
      const grad = ctx.createRadialGradient(s.x, y, 0, s.x, y, s.r);
      const [r, g, b] = s.c.map((v) => Math.round(v * 255));
      grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(0.5, 0.42 * s.w + 0.06)})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private resize() {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * RENDER_SCALE));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * RENDER_SCALE));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.pump();
  }
}

function link(gl: WebGLRenderingContext, vsrc: string, fsrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
  return p;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("aurora shader:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}
