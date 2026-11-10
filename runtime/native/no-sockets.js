// Emscripten JS library (--js-library): deny all socket syscalls (PLAN.md §13 S3).
//
// libnet is not linked, so Java's networking already fails, but Emscripten's SOCKFS would
// turn a raw connect() into `new WebSocket(...)`. Overriding the syscalls here keeps that
// path out of the runtime entirely: each call fails with EACCES and SOCKFS is not pulled in.
// The CSP's connect-src 'self' remains as a second layer.

const EACCES = 2; // Emscripten (WASI) numbering

const SYSCALLS = [
  'socket', 'socketpair', 'connect', 'bind', 'listen', 'accept4', 'getsockname', 'getpeername',
  'getsockopt', 'setsockopt', 'shutdown', 'sendto', 'recvfrom', 'sendmsg', 'recvmsg',
];

const lib = {};
for (const name of SYSCALLS) {
  lib[`__syscall_${name}`] = () => -EACCES;
  // The built-in versions declare deps on $SOCKFS / $getSocketFromFD; clearing them keeps
  // SOCKFS (and its WebSocket client) out of the generated glue.
  lib[`__syscall_${name}__deps`] = [];
}
addToLibrary(lib);
