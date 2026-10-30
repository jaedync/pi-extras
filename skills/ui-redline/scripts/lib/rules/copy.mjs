import { at, textElements } from "./util.mjs";

// Typographic symbols below U+2300 (©, ®, ™, arrows, ‼) are punctuation, not emoji.
const EMOJI = /\p{Extended_Pictographic}/gu;
const emojiIn = (text) => (text.match(EMOJI) ?? []).filter((c) => c.codePointAt(0) >= 0x2300);
const HYPE = /\b(supercharg\w*|seamless(ly)?|unlock\w*|unleash\w*|magic(al)?|revolutioni[sz]\w*|game[- ]chang\w*|effortless(ly)?|next[- ]gen(eration)?|cutting[- ]edge|skyrocket\w*|blazing(ly)?[- ]fast|ai[- ]powered|10x)\b/gi;
const CLAIMS = [
	/\b(trusted|loved|used|chosen) by\b/i,
	/\b\d[\d,.]*\s?[km]?\+\s+(teams|users|customers|companies|developers|businesses|people|creators)\b/i,
	/\b\d+x\s+(faster|more|better|cheaper|quicker)\b/i,
	/[★⭐]{3,}/u,
	/\b(#1|number one|world'?s (best|leading))\b/i,
];
const GREETING = /^(welcome( back)?|hey|hi|hello|good (morning|afternoon|evening))\b/i;
const PLACEHOLDER = /\[(x|n|name|value|number|date)\]|\b123,?456\b|lorem ipsum|\b(john|jane) doe\b|(?<![\d,.])\$?0{1,3},000\b/i;
const LABEL_TAGS = new Set(["button", "label", "h1", "h2", "h3", "h4", "h5", "h6", "th", "summary", "legend", "dt"]);

const prose = (elements) => textElements(elements).filter((el) => !el.inCode);

export const copyRules = [
	{
		id: "emoji",
		category: "icons",
		severity: "high",
		title: "Emoji used as an icon or as decoration",
		fix: "Replace each with a line icon from the project's icon set (or lucide) at one size and stroke, or remove it. Keep emoji only in user content.",
		run: ({ elements }) => prose(elements).flatMap((el) => {
			const found = emojiIn(el.text);
			return found.length ? [at(el, found.join(" "))] : [];
		}),
	},
	{
		id: "exclamation",
		category: "copy",
		severity: "medium",
		title: "Exclamation mark in interface text",
		fix: "State it plainly. Interface text does not shout.",
		run: ({ elements }) => prose(elements).filter((el) => /!(?!=)/.test(el.text)).map((el) => at(el, "")),
	},
	{
		id: "hype-words",
		category: "copy",
		severity: "medium",
		title: "Hype words",
		fix: "Say what the product does, for whom, with the product's own nouns.",
		run: ({ elements }) => prose(elements).flatMap((el) => {
			const words = [...new Set((el.text.match(HYPE) ?? []).map((w) => w.toLowerCase()))];
			return words.length ? [at(el, words.join(", "))] : [];
		}),
	},
	{
		id: "unverified-claims",
		category: "copy",
		severity: "medium",
		title: "Claim that needs a source",
		fix: "Ask the user if it is true. If it is, make it quiet and specific (a number with its source). If not, remove it.",
		run: ({ elements }) => prose(elements).filter((el) => CLAIMS.some((re) => re.test(el.text))).map((el) => at(el, "")),
	},
	{
		id: "greeting",
		category: "copy",
		severity: "medium",
		title: "Greeting as a headline",
		fix: "Name the context instead: the page, the period or the object (for example `October 2026`).",
		run: ({ elements }) => prose(elements).filter((el) => (/^h[1-3]$/.test(el.tag) || el.font.size >= 24) && GREETING.test(el.text)).map((el) => at(el, "")),
	},
	{
		id: "trailing-period",
		category: "copy",
		severity: "low",
		title: "Period at the end of a short label",
		fix: "Remove the period from labels, buttons and headings. Keep periods in paragraphs of more than one sentence.",
		defaults: { maxWords: 6 },
		run: ({ elements }, o) => prose(elements)
			.filter((el) => (LABEL_TAGS.has(el.tag) || el.interactive) && /[^.]\.$/.test(el.text) && el.text.split(/\s+/).length <= o.maxWords)
			.map((el) => at(el, "")),
	},
	{
		id: "placeholder-data",
		category: "copy",
		severity: "medium",
		title: "Placeholder or fake-looking data",
		fix: "Use plausible data that fits the product: real-looking names, amounts and dates.",
		run: ({ elements }) => prose(elements).filter((el) => PLACEHOLDER.test(el.text)).map((el) => at(el, "")),
	},
];
