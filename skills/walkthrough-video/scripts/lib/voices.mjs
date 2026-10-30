/**
 * The Kokoro voices shipped with kokoro-v1.0.onnx. The model file is the list
 * of record; this copy lets the CLI refuse a typo before it starts Python.
 */

export const DEFAULT_VOICE = "am_michael";

export const VOICES = [
	"af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
	"am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
	"bf_alice", "bf_emma", "bf_isabella", "bf_lily",
	"bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

/** Throws with the full list so a wrong name is one line away from a right one. */
export function checkVoice(voice) {
	if (!VOICES.includes(voice)) {
		throw new Error(`Unknown voice "${voice}". Kokoro voices: ${VOICES.join(", ")}. The default is ${DEFAULT_VOICE}.`);
	}
	return voice;
}

/** American voices are en-us and British voices en-gb, as Kokoro's phonemizer expects. */
export function voiceLanguage(voice) {
	return voice.startsWith("b") ? "en-gb" : "en-us";
}
