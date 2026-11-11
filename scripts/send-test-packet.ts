/** Dev helper: send N dummy packets to the capture port. Args: [size] [count] [host] [isRaceOn] */
import dgram from "node:dgram";
import { PORT } from "../src/config.js";
const size = Number(process.argv[2] ?? 324);
const count = Number(process.argv[3] ?? 10);
const host = process.argv[4] ?? "127.0.0.1";
const s = dgram.createSocket("udp4");
let sent = 0;
const buf = Buffer.alloc(size);
buf.writeInt32LE(Number(process.argv[5] ?? 1), 0); // IsRaceOn
const iv = setInterval(() => {
  s.send(buf, PORT, host);
  if (++sent >= count) { clearInterval(iv); setTimeout(() => s.close(), 50); }
}, 10);
