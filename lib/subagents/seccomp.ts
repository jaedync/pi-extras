/**
 * The seccomp filter of a read-only shell (sandbox.ts). A read-only mount
 * does not stop connect() to a Unix socket, and sockets in the home folder
 * and /run drive other programs that write: a terminal multiplexer, the
 * agent broker, the user D-Bus, container engines. So the shell can't make a
 * Unix socket at all (socketpair, for pipes between its own processes, stays),
 * nor an io_uring, which could make one past the filter. Built by hand, as
 * classic BPF, so no library is needed.
 */
const AF_UNIX = 1;
const EACCES = 13;
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO = 0x00050000;
/** x32 system calls on x86_64 have this bit; the filter refuses them all. */
const X32_BIT = 0x40000000;
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const RET_K = 0x06;
/** Offsets in struct seccomp_data: nr, arch, and the low word of args[0] (little-endian). */
const NR = 0, ARCH = 4, ARG0 = 16;

/** The audit architecture and the system call numbers, per Node `process.arch`. */
const ARCHES: Readonly<Record<string, { audit: number; socket: number; ioUringSetup: number }>> = {
	x64: { audit: 0xc000003e, socket: 41, ioUringSetup: 425 },
	arm64: { audit: 0xc00000b7, socket: 198, ioUringSetup: 425 },
};

const op = (code: number, jt: number, jf: number, k: number): Buffer => {
	const out = Buffer.alloc(8);
	out.writeUInt16LE(code, 0);
	out.writeUInt8(jt, 2);
	out.writeUInt8(jf, 3);
	out.writeUInt32LE(k >>> 0, 4);
	return out;
};

/** The filter program for `arch`, or undefined for an architecture it does not know. Another architecture's calls are refused. */
export function unixSocketFilter(arch: string = process.arch): Buffer | undefined {
	const known = ARCHES[arch];
	if (!known) return undefined;
	// Jump offsets count the instructions skipped: ALLOW is at 8, DENY at 9.
	return Buffer.concat([
		op(LD_W_ABS, 0, 0, ARCH),
		op(JEQ_K, 0, 7, known.audit),
		op(LD_W_ABS, 0, 0, NR),
		op(JGE_K, 5, 0, X32_BIT),
		op(JEQ_K, 1, 0, known.socket),
		op(JEQ_K, 3, 2, known.ioUringSetup),
		op(LD_W_ABS, 0, 0, ARG0),
		op(JEQ_K, 1, 0, AF_UNIX),
		op(RET_K, 0, 0, RET_ALLOW),
		op(RET_K, 0, 0, RET_ERRNO | EACCES),
	]);
}
