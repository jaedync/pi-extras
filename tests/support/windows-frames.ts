/** Synthetic Hyper-V console frames (RGB565, base64) as the windows_use host's `frame` method returns them. */
const rgb565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

/** `dark` draws a busy screen: black with a little white text, as Windows shows while restarting. */
export function hostFrame(options: { taskbar: boolean; dark?: boolean; width?: number; height?: number }): { width: number; height: number; data: string } {
	const width = options.width ?? 320;
	const height = options.height ?? 240;
	const data = Buffer.alloc(width * height * 2);
	const band = height - Math.round(height * 0.058);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const v = ((x * 73 + y * 151) ^ (x * y)) % 200;
			const text = y > height * 0.45 && y < height * 0.5 && x > width * 0.3 && x < width * 0.7 && v % 3 === 0;
			const pixel = options.dark ? (text ? rgb565(255, 255, 255) : 0)
				: options.taskbar && y >= band ? rgb565(239, 239, 239) : rgb565(v, (v * 3) % 256, (v * 7) % 256);
			data.writeUInt16LE(pixel, (y * width + x) * 2);
		}
	}
	return { width, height, data: data.toString("base64") };
}
