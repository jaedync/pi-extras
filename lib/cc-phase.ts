import { mixColors, stripTerminalSequences, truncateToWidth, visibleWidth, type Color } from "@earendil-works/pi-tui";
import { END_GLYPH, MODE_SPINNERS, SPINNER_SLOT_WIDTH, WAVE_TOKENS_PER_SECOND, piWave, slotGlyph, type GlyphAnimation } from "./band/glyph.ts";

export const SEP = ", ";
export const CHARS_PER_TOKEN = 4;
const RATE_SMOOTH_MS = 500;
export interface Verb { readonly present: string; readonly past: string }
export const DEFAULT_VERBS: readonly Verb[] = [
 "Proofing|Proofed", "Kneading|Kneaded", "Crimping|Crimped", "Docking|Docked", "Blind-baking|Blind-baked",
 "Glazing|Glazed", "Venting|Vented", "Fluting|Fluted", "Sifting|Sifted", "Zesting|Zested",
 "Caramelizing|Caramelized", "Lattice-weaving|Lattice-woven", "Par-baking|Par-baked", "Slicing|Sliced",
 "Approximating|Approximated", "Iterating|Iterated", "Converging|Converged", "Integrating|Integrated",
 "Circumscribing|Circumscribed", "Inscribing|Inscribed", "Squaring the circle|Squared the circle",
 "Summing the series|Summed the series", "Computing digits|Computed digits", "Irrationalizing|Irrationalized",
 "Transcending|Transcended", "Revolving|Revolved", "Orbiting|Orbited", "Spiraling|Spiraled", "Radiating|Radiated", "Rounding|Rounded",
].map(pair => { const [present,past] = pair.split("|"); return {present:present!,past:past!}; });
const valid = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export function parseVerbs(value: unknown): readonly Verb[] {
 if (value === "playful") return DEFAULT_VERBS;
 if (!Array.isArray(value)) return [];
 const verbs = value.slice(0,100).flatMap(item => {
  const pair = typeof item === "string" ? item.split("|") : [item?.present,item?.past];
  return pair.length === 2 && valid(pair[0]) && valid(pair[1]) ? [{present:pair[0].trim(),past:pair[1].trim()}] : [];
 });
 return verbs;
}
export const pickVerb = (verbs: readonly Verb[], random = Math.random): Verb => verbs[Math.min(verbs.length-1,Math.max(0,Math.floor(random()*verbs.length)))] ?? DEFAULT_VERBS[0]!;
export type RunPhase = "prep" | "api" | "first_token" | "think" | "text" | "tool" | "run";
export interface RunLine {
 readonly verb?: Verb; readonly phase: RunPhase; readonly elapsedMs: number; readonly phaseMs: number;
 readonly tokens: number; readonly clockMs: number; readonly reduced: boolean; readonly tools?: readonly string[];
 readonly pendingTool?: string; readonly thoughtMs?: number; readonly sinceThoughtMs?: number; readonly idleTokenMs?: number;
 readonly waveMs?: number; readonly tokensPerSecond?: number; readonly waitingOnPeers?: boolean;
}
export const seconds = (ms: number): string => `${Math.max(0,Math.floor(ms/1000))}s`;
export function thinkingLabel(ms: number): string {
 return ms >= 45000 ? "deep in thought" : ms >= 30000 ? "thinking some more" : ms >= 20000 ? "thinking more" : ms >= 10000 ? "still thinking" : "thinking";
}
const toolLabel = (name: string | undefined): string => stripTerminalSequences(name ?? "tool").replace(/[\x00-\x20\x7f-\x9f]+/g," ").trim() || "tool";
const graphemes = new Intl.Segmenter(undefined,{granularity:"grapheme"});
export function phaseTitle(model: RunLine): string {
 if(model.verb)return model.verb.present;
 const titles={prep:"Preparing",api:"Sending request",first_token:"Waiting for the model",think:thinkingLabel(model.phaseMs).replace("thinking some more","thinking more"),text:"Writing reply",tool:`Writing ${toolLabel(model.pendingTool)} call`,run:model.tools && model.tools.length>1?`Running ${model.tools.length} tools`:`Running ${toolLabel(model.tools?.[0])}`};
 const title=titles[model.phase];return title[0]!.toUpperCase()+title.slice(1);
}
export function phaseParts(model: RunLine): string[] {
 if(!model.verb){
  const direction=model.phase==="api"?"↑":model.tokens>0 && ["think","text","tool"].includes(model.phase)?`↓ ${Math.round(model.tokens).toLocaleString("en-US")} tokens`:undefined;
  return [seconds(model.elapsedMs),direction].filter((part):part is string=>!!part);
 }
 const detail = model.phase === "api" ? "sending request" : model.phase === "first_token" ? "waiting for first token"
  : model.phase === "tool" ? `writing ${toolLabel(model.pendingTool)} call`
  : model.phase === "run" ? (model.tools && model.tools.length > 1 ? `running ${model.tools.length} tools` : `running ${toolLabel(model.tools?.[0])}`) : undefined;
 const direction = model.phase === "api" ? "↑" : model.tokens > 0 && model.phase !== "run" ? `↓ ${Math.round(model.tokens).toLocaleString("en-US")} tokens` : undefined;
 const thought = model.phase === "think" ? thinkingLabel(model.phaseMs) : model.thoughtMs !== undefined && (model.sinceThoughtMs ?? Infinity) < 2000 ? `thought for ${seconds(model.thoughtMs)}` : undefined;
 return [detail, ...(detail || direction || thought || model.elapsedMs >= 16000 ? [seconds(model.elapsedMs)] : []), direction, thought].filter((part): part is string => !!part);
}
export function sweepAt(length: number, ms: number, sending: boolean): number {
 const step = Math.floor(ms/(sending ? 50 : 200)) % (length+6);
 return sending ? step-3 : length+3-step;
}
/** The source estimate advances in bounded 50ms steps rather than jumping with each chunk. */
export function smoothTokens(shown: number, target: number, elapsedMs: number): number {
 let next = shown;
 for(let i=0;i<Math.min(400,Math.floor(Math.max(0,elapsedMs)/50));i++) {
  const gap = target-next;
  if(gap<=0) return target;
  next=Math.min(target,next+(gap<18 ? 1 : gap<50 ? Math.max(2,Math.ceil(gap*.15)) : 13));
 }
 return next;
}
export interface LineTheme {
 fg(key: "accent" | "dim" | "warning" | "error", text: string): string;
 colors?: Readonly<Record<string,Color>>;
 style?(text: string, options: {fg?: Color; bold?: boolean}): string;
}
function runPainter(model: RunLine, theme: LineTheme): (text: string, highlight?: number) => string {
 const warning = model.phase === "think" ? Math.max(0,Math.min(1,(model.phaseMs-10000)/10000)) : 0;
 const waiting = !["run","prep","think"].includes(model.phase);
 const stalled = waiting ? Math.max(0,Math.min(1,((model.idleTokenMs ?? 0)-10000)/10000)) : 0;
 const intensity = Math.max(warning,stalled);
 const key = stalled > 0 ? "error" : warning > 0 ? "warning" : "accent";
 return (text,highlight=0) => {
  const accent=theme.colors?.accent, target=theme.colors?.[key];
  if(theme.style && accent && target) {
   const color = model.reduced ? (intensity>=1 ? target : accent) : mixColors(accent,target,intensity);
   const lighter = highlight && !model.reduced && theme.colors?.text ? mixColors(color,theme.colors.text,.45*highlight) : color;
   return theme.style(text,{fg:lighter,bold:warning>=1});
  }
  return theme.fg(model.reduced && intensity<1 ? "accent" : key,text);
 };
}
export function runAnimation(model: RunLine): GlyphAnimation {
 return MODE_SPINNERS[model.phase==="run" && model.waitingOnPeers ? "peer" : model.phase];
}
export function renderRunLine(model: RunLine, width: number, theme: LineTheme, override?: GlyphAnimation): string {
 if(width<=0) return "";
 const paint=runPainter(model,theme), word=[...graphemes.segment(phaseTitle(model))].map(part=>part.segment);
 const sweep=sweepAt(word.length,model.clockMs,model.phase==="api");
 const pulse=(Math.sin(model.clockMs/1000*Math.PI)+1)/2;
 const title=word.map((ch,i)=>paint(ch,model.reduced ? 0 : model.phase==="run" ? pulse : i>=sweep && i<sweep+3 ? 1 : 0)).join("");
 const parts=phaseParts(model);
 const animation=override ?? runAnimation(model);
 const slot=override ? visibleWidth(animation.frames[0]!) : SPINNER_SLOT_WIDTH;
 const glyph=slotGlyph(animation,model.clockMs,{reduced:model.reduced,rateElapsedMs:model.waveMs ?? 0},slot);
 return truncateToWidth(`${slot ? paint(glyph)+" " : ""}${title}${paint("…")}${parts.length ? theme.fg("dim",` (${parts.join(SEP)})`) : ""}`,width,"");
}
export interface StreamRate { readonly at: number; readonly chars: number; readonly rate: number; readonly waveMs: number }
export function streamRate(previous: StreamRate, at: number, chars: number): StreamRate {
 const elapsed=Math.max(0,at-previous.at);
 if(!elapsed)return previous;
 const target=Math.max(0,chars-previous.chars)/CHARS_PER_TOKEN*1000/elapsed;
 const rate=previous.rate+(target-previous.rate)*(1-Math.exp(-elapsed/RATE_SMOOTH_MS));
 return {at,chars,rate,waveMs:previous.waveMs+elapsed*(previous.rate+rate)/2/WAVE_TOKENS_PER_SECOND};
}
export function renderPiWave(elapsedMs: number, theme: LineTheme, width = SPINNER_SLOT_WIDTH): string {
 const frame=piWave(elapsedMs);
 if(frame.ended)return "";
 const cells=frame.cells.map(cell=>{
  const base=theme.colors?.background ?? theme.colors?.dim,accent=theme.colors?.accent,text=theme.colors?.text;
  if(theme.style&&base&&accent){
   const fade=mixColors(base,accent,cell.level);
   return theme.style(cell.glyph,{fg:text?mixColors(fade,text,.55*cell.crest):fade});
  }
  return theme.fg(cell.level<.5?"dim":"accent",cell.glyph);
 }).join("");
 const left=Math.max(0,Math.floor((SPINNER_SLOT_WIDTH-3)/2));
 return truncateToWidth(" ".repeat(left)+cells+" ".repeat(Math.max(0,SPINNER_SLOT_WIDTH-3-left)),width,"");
}
export interface EndLine { readonly past?: string; readonly elapsedMs: number; readonly doneAt: string; readonly stopped?: boolean }
export const END_ENTRY = "pi-extras.run-end";
export function parseEndLine(value: unknown): EndLine | undefined {
 if(!value || typeof value!=="object")return undefined;
 const model=value as EndLine;
 return (model.past===undefined || valid(model.past)) && valid(model.doneAt) && Number.isFinite(model.elapsedMs) && model.elapsedMs>=0 && (model.stopped===undefined || typeof model.stopped==="boolean") ? {...(model.past!==undefined?{past:model.past}:{}),elapsedMs:model.elapsedMs,doneAt:model.doneAt,...(model.stopped?{stopped:true}:{})} : undefined;
}
export function renderEndLine(model: EndLine,width:number,theme:LineTheme): string {
 return truncateToWidth(theme.fg("accent",END_GLYPH)+" "+theme.fg("dim",model.stopped ? `Stopped after ${seconds(model.elapsedMs)}` : model.past ? `${model.past} for ${seconds(model.elapsedMs)}${SEP}done ${model.doneAt}` : `Worked for ${seconds(model.elapsedMs)}${SEP}done ${model.doneAt}`),Math.max(0,width),"");
}
