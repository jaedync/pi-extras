/**
 * Pinned downloads for voice provisioning. Every file is fetched by exact
 * version or commit and checked against its sha256 before use.
 */

export interface Asset {
	readonly url: string;
	readonly sha256: string;
	readonly bytes: number;
}

export const UV_VERSION = "0.12.17";
/** Oldest uv on PATH we trust for `venv --clear` and managed Python installs. */
export const UV_MIN_VERSION = [0, 8, 0] as const;
export const PYTHON_VERSION = "3.12";

// musl builds are static, so they run on old glibc hosts such as Ubuntu 20.04 under WSL.
const UV_TARGETS: Record<string, { target: string; sha256: string; bytes: number }> = {
	"darwin-arm64": { target: "aarch64-apple-darwin", sha256: "85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b", bytes: 16_929_004 },
	"darwin-x64": { target: "x86_64-apple-darwin", sha256: "8dcf05a8c809bb3c471d2b614788ba27a6e41298fc8c31ac84b5f4339fd468e5", bytes: 20_592_896 },
	"linux-x64": { target: "x86_64-unknown-linux-musl", sha256: "6401c4665d8fa2a9893e087c91f585430738e3170f5398a1141483efb4a93310", bytes: 22_632_353 },
	"linux-arm64": { target: "aarch64-unknown-linux-musl", sha256: "a6096da273d548cb9f277d237a01ac7344a39ef0f455c0e148e4dc9737c1596b", bytes: 21_082_371 },
};

export function uvAsset(platform: string, arch: string): (Asset & { dir: string }) | undefined {
	const entry = UV_TARGETS[`${platform}-${arch}`];
	if (!entry) return undefined;
	return {
		url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${entry.target}.tar.gz`,
		sha256: entry.sha256,
		bytes: entry.bytes,
		dir: `uv-${entry.target}`,
	};
}

/** manylinux_2_17 wheels: the Node addon needs glibc 2.32, these do not. */
export const CPU_PACKAGES = ["sherpa-onnx==1.13.8", "numpy>=1.26,<3"] as const;
export const MLX_PACKAGES = ["parakeet-mlx==0.5.2"] as const;

const SHERPA_MODELS = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export const VAD_MODEL: Asset & { file: string } = {
	url: `${SHERPA_MODELS}/silero_vad.onnx`,
	sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
	bytes: 643_854,
	file: "silero_vad.onnx",
};

export interface ArchiveModel extends Asset {
	/** Top-level directory inside the archive. */
	readonly dir: string;
}

export const SMALL_MODEL: ArchiveModel = {
	url: `${SHERPA_MODELS}/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2`,
	sha256: "f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b",
	bytes: 108_035_095,
	dir: "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8",
};

export const LARGE_MODEL: ArchiveModel = {
	url: `${SHERPA_MODELS}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
	sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
	bytes: 487_170_055,
	dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
};

export const MLX_REPO = "mlx-community/parakeet-tdt-0.6b-v3";
export const MLX_REVISION = "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15";
export const MLX_DIR = "parakeet-tdt-0.6b-v3-mlx";
const mlxUrl = (file: string) => `https://huggingface.co/${MLX_REPO}/resolve/${MLX_REVISION}/${file}`;

export const MLX_FILES: ReadonlyArray<Asset & { file: string }> = [
	{ file: "config.json", url: mlxUrl("config.json"), sha256: "f320f1292511f34ec47f513755fe20fd01dbfc09a925d42730e66059a6e1ef4c", bytes: 244_093 },
	{ file: "model.safetensors", url: mlxUrl("model.safetensors"), sha256: "05e01c7f396c298cf7d23f61da7b504adeab698f0aaeafd9c82d198625464592", bytes: 2_508_288_736 },
];
