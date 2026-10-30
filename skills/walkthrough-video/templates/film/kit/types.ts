/**
 * The types of a film project. The storyboard is the one source of timing:
 * shot lengths, event times and sound cues all come from it, so a change is
 * one value here, then `wv film build`.
 */

/** A CSS cubic-bezier as four numbers: [x1, y1, x2, y2]. */
export type Curve = [number, number, number, number];

export interface Shot {
	/** Unique id; the shot's section in the page has this id. */
	id: string;
	/** The scene module that draws it (a key of the scenes map in film.ts). */
	scene: string;
	/** Exactly one length: beats (with the storyboard's bpm), seconds or frames. */
	beats?: number;
	seconds?: number;
	frames?: number;
	/** What the shot shows, in one line, for the reviewer and the sheets. */
	what?: string;
	/** Planned still pictures: [from, to] in seconds from the shot start; to may be "end" (the shot's end). wv check lets these through. */
	holds?: [number, number | "end"][];
	/** The whole shot is a planned still. */
	still?: boolean;
	/** The shot may be digitally silent (wv check lets more than 1.5 s of silence through here only). */
	silence?: boolean;
	/** Captured footage for this shot: a file in assets/, trimmed from `from` seconds. */
	clip?: { src: string; from?: number };
	/**
	 * A value in the clip to follow (a HUD readout): the selector of a text in the clip's
	 * events.json samples ("b"), or { selector, match } with a regular expression on the text.
	 * wv film build gives advice when it stays within 1 % for over 1 s while the shot is on screen.
	 */
	follow?: string | { selector?: string; match?: string };
	/**
	 * What the shot is about, to measure its size on screen: a selector on the film page, or a
	 * box [x, y, w, h] in clip pixels (one box, or one per time in seconds from the shot start).
	 * wv film build and wv check --page advise when it is under 5 % of the frame width at its largest.
	 */
	subject?: string | { box: [number, number, number, number] } | { boxes: { t: number; box: [number, number, number, number] }[] };
	/** Any other value is a parameter for the scene: event times in seconds from the shot start, text, sizes. */
	[param: string]: unknown;
}

export interface Music {
	/**
	 * No music bed, and why: only when the owner asked for it. wv check then
	 * reports the quiet share and the loudness jump as notes, and the critique
	 * caps the score at 5 unless the reason says the owner accepted it.
	 */
	none?: string;
	/** A file in assets/ that wv sound fits to the film. */
	bed?: string;
	/** The shot where the bed's biggest lift lands (wv sound back-times the bed to it). */
	liftAtShot?: string;
	/** Bed level under the cues, dB. */
	db?: number;
	fadeIn?: number;
	fadeOut?: number;
}

export interface Storyboard {
	title?: string;
	fps?: number;
	width?: number;
	height?: number;
	/** Beats per minute: shot lengths in beats land cuts on the music. */
	bpm?: number;
	/** Seconds before the first beat. */
	offset?: number;
	/** Named curves for the scenes, in addition to the brand's springs. */
	ease?: Record<string, Curve>;
	shots: Shot[];
	/**
	 * The rhythm family: "montage" (27 to 38 cuts a minute), "one-take" (0 to 2 cuts),
	 * or { middle: "<the reason>" }. wv film build gives advice when it is missing,
	 * or when the planned pace sits between the families without a reason.
	 */
	family?: "montage" | "one-take" | { middle: string };
	/**
	 * The shot that shows the viewer doing the product's key action (an input and its
	 * effect), and the action in words. wv film build gives advice when it is missing, or
	 * when the shot's clip has no input event while the shot is on screen.
	 */
	proof?: { shot: string; action: string };
	music?: Music;
	/**
	 * Link brand/app.css (the app's own stylesheet from wv lift, without
	 * transitions), so a scene can paste the app's markup with its class names.
	 * Its global rules (html, body, *) apply to the film page too; film.css
	 * loads after it.
	 */
	appCss?: boolean;
	/** HyperFrames motion blur on the render. It can draw a ghost of a hidden shot on a cut frame: check the cuts. */
	motionBlur?: boolean;
}

/** A sound cue that a scene places on its picture event. wv sound reads them from out/film.json. */
export interface Cue {
	/** A family in assets/sfx/ (round robin over <name>-NN.wav), a take family, or one file, by "<name>" or "<name>.wav". */
	sound: string;
	/** Film time in seconds where the sound's onset lands. */
	t: number;
	shot: string;
	/** Peak level in dBFS after gain (default -18). */
	peak?: number;
}

/** The brand tokens that wv lift writes (brand/tokens.json); only the fields the kit reads. */
export interface Tokens {
	ground?: { color: string; var?: string; image?: string } | null;
	ink?: { color: string } | null;
	inkSecondary?: { color: string }[];
	surfaces?: { var: string; color: string }[];
	accent?: { color: string; var?: string } | null;
	fonts?: { family: string; role: string; weight: number; variation?: string }[];
	motion?: { springs: { value: string }[]; eases: { value: string }[]; keyframes: string[] };
	palette?: Record<string, string>;
}

/** The shot timing that wv film build computes (whole frames), as the page receives it. */
export interface ShotTiming {
	id: string;
	start: number;
	end: number;
	startFrame: number;
	endFrame: number;
}

export interface FilmData {
	storyboard: Storyboard;
	timing: { fps: number; width: number; height: number; duration: number; frames: number; shots: ShotTiming[] };
	tokens: Tokens;
}
