import { visibleWidth } from "@earendil-works/pi-tui";

export const REDUCED_FRAME = "●";
export const REST_GLYPH = "●";
export const END_GLYPH = "π";
export const BULLET_GLYPH = "●";
export const THOUGHT_GLYPH = "∴";
export const SUCCESS_GLYPH = "✓";
export const FAILURE_GLYPH = "✗";
export interface GlyphAnimation {
	readonly frames: readonly string[];
	readonly durationsMs: readonly number[];
	readonly pingPong?: boolean;
	readonly still?: number;
	readonly kind?: "frames" | "rate" | "fraction";
}
export interface GlyphContext { readonly reduced?: boolean; readonly rateElapsedMs?: number; readonly fraction?: number }
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const BITS = [[1,8],[2,16],[4,32],[64,128]];
type Point = readonly [number, number];
function braille(points: readonly Point[]): string {
	const cells = [0,0,0];
	for (const [x,y] of points) if (x >= 0 && x < 6 && y >= 0 && y < 4) cells[x >> 1]! |= BITS[y]![x & 1]!;
	return cells.map(bits => String.fromCharCode(0x2800 + bits)).join("");
}
const sinY = (x: number) => Math.max(0, Math.min(3, Math.round(1.5 + 1.5 * x)));
const ring = (r: number): Point[] => range(6).flatMap(x => range(4).filter(y => Math.abs(Math.hypot(x - 2.5,y - 1.5) - r) < .55).map(y => [x,y] as const));
const perimeter: readonly Point[] = [[1,0],[2,0],[3,0],[4,0],[5,1],[5,2],[4,3],[3,3],[2,3],[1,3],[0,2],[0,1]];
const scan = [...range(6), ...range(6).reverse().slice(1,-1)];
const rows: Point[] = range(24).map(i => [Math.floor(i/6)%2 ? 5-i%6 : i%6,Math.floor(i/6)]);
const snake = [...rows,...rows.slice().reverse()];
const animation = (frames: readonly string[], ms: number, still = 0, kind: GlyphAnimation["kind"] = "frames"): GlyphAnimation => ({frames,durationsMs:frames.map(()=>ms),still,kind});

// Draft picks ported from the MS/MODES canvas in spinners.html. Each pick is one constant edit.
export const SONAR = animation([.7,1.6,2.5,3.2,-1,-1].map(r=>braille(r<0?[]:ring(r))),130,2);
export const IMPLODE = animation([3.2,2.5,1.6,.7,.7,-1,-1].map(r=>braille(r<0?[]:ring(r))),120,3);
export const HELIX = animation(range(16).map(t=>braille(range(6).flatMap(x=>{
	const p=x*.95-t*Math.PI/8;return [[x,sinY(Math.sin(p))],[x,sinY(-Math.sin(p))]] as Point[];
}))),75);
export const WAVE = animation(range(16).map(t=>braille(range(6).map(x=>[x,sinY(Math.sin(x*.9-t*Math.PI/8))]))),70,0,"rate");
export const SCANNER = animation(scan.map((x,i)=>{const d=i<6?-1:1;return braille(range(4).flatMap(y=>[[x,y],[x+d,y],...(y%2?[[x+2*d,y] as Point]:[])] as Point[]));}),60,2);
export const COMET = animation(range(12).map(t=>braille([0,1,2].map(k=>perimeter[(t-k+12)%12]!))),70);
export const TWIN_ORBIT = animation(range(12).map(t=>braille([0,1,6,7].map(k=>perimeter[(t-k+12)%12]!))),75);
export const SNAKE = animation(snake.map((_,t)=>braille(range(5).map(k=>snake[(t-k+snake.length)%snake.length]!))),50);
export const DRAIN = animation(range(25).map(t=>braille(range(24-t).map(i=>[Math.floor(i/4),3-i%4]))),140,0,"fraction");
export type SpinnerMode = "prep"|"api"|"first_token"|"slow_api"|"stalled"|"think"|"text"|"tool"|"run"|"peer"|"compaction"|"retry"|"branchSummary"|"fallback";
export const MODE_SPINNERS: Readonly<Record<SpinnerMode,GlyphAnimation>> = {
	prep:SONAR,api:SONAR,first_token:SONAR,slow_api:SONAR,stalled:SONAR,think:HELIX,text:WAVE,tool:SCANNER,run:COMET,peer:TWIN_ORBIT,
	compaction:IMPLODE,retry:DRAIN,branchSummary:SNAKE,fallback:COMET,
};
export const WAVE_TOKENS_PER_SECOND = 34;
export const HERO_ANIMATION = SONAR;
export const SPINNER_FRAMES = SONAR.frames;
export const SPINNER_FRAME_MS = SONAR.durationsMs;
export const SPINNER_PING_PONG = false;
export const COMPACTION_ANIMATION = IMPLODE;
export const RETRY_ANIMATION = DRAIN;
export const BRANCH_SUMMARY_ANIMATION = SNAKE;
export const STATUS_ANIMATION = COMET;
export const JOB_ANIMATION = animation([..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"],80);
export const JOB_STOPPING_ANIMATION = animation([..."◐◓◑◒"],250);
export const TOOL_ORBIT_ANIMATION = animation([..."⠁⠈⠐⠠⢀⡀⠄⠂"],150);
export const TOOL_TIMEOUT_FRAMES = ["○","◔","◑","◕","●"] as const;
export type ToolIndicatorMode = "blink"|"breath"|"timeout"|"orbit"|"still";
export const TOOL_KINDS = {shell:"timeout",peer:"orbit",web:"breath",other:"still"} as const;
export const TOOL_NAMES = {
 shell:["bash","shell","shell_job"],peer:["subagent","message","agent_request","agent_send"],
 web:["web_search","kagi_search","fetch_content","fetch","web_fetch","search"],
} as const;
const named = (name:string,names:readonly string[]) => names.some(key=>name===key||name.endsWith("."+key)||name.endsWith("__"+key));
export const isPeerTool = (name: string): boolean => named(name,TOOL_NAMES.peer);
export function isBlockingPeer(name: string, args: unknown): boolean {
 const options=args && typeof args==="object" ? args as {wait?:unknown;expectReply?:unknown} : undefined;
 return named(name,["agent_request"]) || isPeerTool(name) && (options?.wait===true || options?.expectReply===true);
}

interface Compiled { readonly frames: readonly string[]; readonly ends: readonly number[]; readonly cycle: number; readonly width: number }
const compiled = new WeakMap<GlyphAnimation,Compiled>();
function compile(value: GlyphAnimation): Compiled {
	const kept=compiled.get(value);if(kept)return kept;
	const {frames,durationsMs,pingPong}=value;
	if(!frames.length||frames.length!==durationsMs.length||durationsMs.some(ms=>!Number.isFinite(ms)||ms<=0))throw new RangeError("Each glyph frame needs one positive finite duration");
	const width=visibleWidth(frames[0]!);
	if(width>6||frames.some(frame=>visibleWidth(frame)!==width))throw new RangeError("Glyph frames must have equal cell width, between zero and six");
	const indices=range(frames.length),path=pingPong?[...indices,...indices.slice(1,-1).reverse()]:indices;
	let cycle=0;const ends=path.map(i=>(cycle+=durationsMs[i]!));
	const result={frames:path.map(i=>frames[i]!),ends,cycle,width};compiled.set(value,result);return result;
}
export function glyphAt(value: GlyphAnimation, ms: number, context: GlyphContext = {}): string {
	const {frames,ends,cycle}=compile(value);
	if(value.kind==="fraction"&&context.fraction!==undefined&&Number.isFinite(context.fraction))return value.frames[Math.round(Math.max(0,Math.min(1,context.fraction))*(value.frames.length-1))]!;
	if(context.reduced)return value.frames[value.still??0]??value.frames[0]!;
	const clock=value.kind==="rate"?context.rateElapsedMs??0:ms;
	const at=Math.max(0,Number.isFinite(clock)?clock:0)%cycle;
	return frames[ends.findIndex(end=>at<end)]!;
}
export const animationCycle = (value: GlyphAnimation): number => compile(value).cycle;
export const animationFrameMs = (value: GlyphAnimation): number => compile(value).cycle/compile(value).frames.length;
export const SPINNER_CYCLE_MS = animationCycle(HERO_ANIMATION);
export const SPINNER_SLOT_WIDTH = Math.max(...Object.values(MODE_SPINNERS).map(value=>compile(value).width));
export function slotGlyph(value: GlyphAnimation, ms: number, context: GlyphContext = {}, slot = SPINNER_SLOT_WIDTH): string {
	const frame=glyphAt(value,ms,context),pad=Math.max(0,slot-visibleWidth(frame)),left=Math.floor(pad/2);
	return " ".repeat(left)+frame+" ".repeat(pad-left);
}
export function spinnerGlyph(ms: number, reduced = false): string {return slotGlyph(HERO_ANIMATION,ms,{reduced});}
export function spinnerCadence(value: GlyphAnimation, reduced: boolean, _tokensPerSecond = 0, fraction = false): number {
	if(reduced&&!fraction)return 1000;
	// Rate changes advance the wave's phase, not its timer. All consumers stay on a 40ms grid.
	return Math.ceil(Math.min(200,Math.min(...value.durationsMs))/40)*40;
}
export function toolIndicator(elapsedMs: number, timeoutFraction?: number, mode: ToolIndicatorMode = "still"): {glyph:string;blend:number} {
	const ms=Math.max(0,Number.isFinite(elapsedMs)?elapsedMs:0),fraction=Math.max(0,Math.min(1,timeoutFraction??0));
	const result=mode==="blink"?{glyph:Math.floor(ms/500)%2?" ":BULLET_GLYPH,blend:1}
		:mode==="breath"?{glyph:BULLET_GLYPH,blend:(Math.sin(ms/1600*Math.PI*2)+1)/2}
		:mode==="timeout"?{glyph:timeoutFraction===undefined?BULLET_GLYPH:TOOL_TIMEOUT_FRAMES[Math.min(4,Math.floor(fraction*5))]!,blend:1}
		:mode==="orbit"?{glyph:glyphAt(TOOL_ORBIT_ANIMATION,ms),blend:1}:{glyph:BULLET_GLYPH,blend:1};
	if(visibleWidth(result.glyph)!==1)throw new RangeError("A tool indicator must occupy exactly one cell");return result;
}
export const PI_WAVE = { stepMs: 40, rampMs: 120, holdMs: 120 } as const;
export const PI_WAVE_MS = 2 * (5 * PI_WAVE.stepMs + PI_WAVE.rampMs) + PI_WAVE.holdMs;
const PI_DOTS: readonly Point[] = [...range(6).map(x=>[x,0] as const),...range(3).flatMap(y=>[[1,y+1],[4,y+1]] as Point[])];
export function piWave(elapsedMs: number): { cells: readonly {glyph:string;level:number;crest:number}[]; dots: number; ended: boolean } {
 const {stepMs,rampMs,holdMs}=PI_WAVE,outAt=5*stepMs+rampMs+holdMs;
 const clamp=(x:number)=>Math.max(0,Math.min(1,x));
 const at=Math.max(0,Number.isFinite(elapsedMs)?elapsedMs:0);
 const columns=range(6).map(x=>{const u=clamp((at-x*stepMs)/rampMs),v=clamp((at-outAt-x*stepMs)/rampMs);return {level:u*(1-v),crest:at<outAt?Math.sin(Math.PI*u):0};});
 const points=PI_DOTS.filter(([x])=>columns[x]!.level>.08),frame=braille(points);
 const cells=range(3).map(k=>({glyph:frame[k]!,level:(columns[k*2]!.level+columns[k*2+1]!.level)/2,crest:Math.max(columns[k*2]!.crest,columns[k*2+1]!.crest)}));
 return {cells,dots:points.length,ended:at>=PI_WAVE_MS};
}
export function toolKind(name: string, timeoutFraction?: number): ToolIndicatorMode {
	return named(name,TOOL_NAMES.shell)&&timeoutFraction!==undefined?TOOL_KINDS.shell:isPeerTool(name)?TOOL_KINDS.peer:named(name,TOOL_NAMES.web)?TOOL_KINDS.web:TOOL_KINDS.other;
}
