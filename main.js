// index.js
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// ========== filter log berisik (tetap) ==========
const originalLog = console.log;
console.log = function (...args) {
  const shouldFilter = args.some(
    (arg) =>
      typeof arg === "string" &&
      (arg.includes("Closing session") ||
        arg.includes("stale open session") ||
        arg.includes("connected to WA") ||
        arg.includes("not logged in"))
  );
  if (shouldFilter) return;
  originalLog.apply(console, args);
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// ========== Konfigurasi ==========
const config = {
  usePairingCode: true,
  customPairingCode: "NSTRCODE",
  ownerNumber: "6281386547582@s.whatsapp.net",
  targetGroupName: "Bot test realme", // grup tujuan auto-share

  // ✅ Auto-share 24/7 setiap 60 menit (mode: image)
  autoShare: {
    enabled: true,
    intervalMinutes: 60,
    mode: "image",
    imageDir: "auto_images",
    captionsFile: "auto_captions.txt",
    fallbackCaption: "Promo terbaru! Cek detail di chat ya ✨",
    sendOnStart: true, // ⬅️ ubah ke true
  },
};

// ========== MULAI: kode login kamu (tidak diubah alurnya) ==========
async function startLogin() {
  const { state, saveCreds } = await useMultiFileAuthState("session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: !config.usePairingCode,
    auth: state,
    logger: P({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  if (config.usePairingCode && !sock.authState.creds.registered) {
    try {
      const phoneNumber = await question(
        "Masukkan nomor HP (cth: 6281234567890): "
      );
      const code = await sock.requestPairingCode(
        phoneNumber,
        config.customPairingCode
      );
      console.log(`✅ Kode Pairing: ${code}`);
    } catch (err) {
      console.error("❌ Gagal pairing:", err);
      process.exit(1);
    }
  }

  // ====== ✨ Tambahan fitur share manual & auto-share ======
  // helper stream → buffer
  async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  // cari grup by nama
  async function findGroupJidByName(name) {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups);
    const match = list.find(
      (g) => (g.subject || "").toLowerCase() === name.toLowerCase()
    );
    return match?.id || null;
  }

  // cache 2 menit
  async function ensureTargetGroupJid() {
    if (
      ensureTargetGroupJid.cache &&
      ensureTargetGroupJid.cache.expires > Date.now()
    ) {
      return ensureTargetGroupJid.cache.jid;
    }
    const jid = await findGroupJidByName(config.targetGroupName);
    ensureTargetGroupJid.cache = { jid, expires: Date.now() + 120000 };
    return jid;
  }

  // ambil teks dari berbagai tipe message
  function getTextMessage(msg) {
    const m = msg.message || {};
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    return "";
  }

  // === Perintah manual ===
  async function handleShareText(raw) {
    const text = raw.replace(/^\.share\s+/i, "").trim();
    if (!text)
      throw new Error("Format salah. Contoh: .share Promo hari ini ...");
    const groupJid = await ensureTargetGroupJid();
    if (!groupJid)
      throw new Error(
        `Grup "${config.targetGroupName}" tidak ditemukan. Pastikan bot sudah jadi member grup itu.`
      );
    await sock.sendMessage(groupJid, { text });
    return groupJid;
  }

  async function handleShareImage(msg) {
    const m = msg.message?.imageMessage;
    if (!m) throw new Error("Kirim gambar dengan caption .shareimg <teks>");
    const stream = await downloadContentFromMessage(m, "image");
    const buffer = await streamToBuffer(stream);
    const caption = (m.caption || "").replace(/^\.shareimg\s*/i, "").trim();
    const groupJid = await ensureTargetGroupJid();
    if (!groupJid)
      throw new Error(`Grup "${config.targetGroupName}" tidak ditemukan.`);
    await sock.sendMessage(groupJid, { image: buffer, caption });
    return groupJid;
  }

  async function handleShareVideo(msg) {
    const m = msg.message?.videoMessage;
    if (!m) throw new Error("Kirim video dengan caption .sharevid <teks>");
    const stream = await downloadContentFromMessage(m, "video");
    const buffer = await streamToBuffer(stream);
    const caption = (m.caption || "").replace(/^\.sharevid\s*/i, "").trim();
    const groupJid = await ensureTargetGroupJid();
    if (!groupJid)
      throw new Error(`Grup "${config.targetGroupName}" tidak ditemukan.`);
    await sock.sendMessage(groupJid, { video: buffer, caption });
    return groupJid;
  }

  // === Auto-share setiap 1 jam (mode image) ===
  let autoTimer = null;
  let autoIndex = 0;

  function listImages(dir) {
    try {
      const abs = path.resolve(process.cwd(), dir);
      if (!fs.existsSync(abs)) return [];
      const allow = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
      return fs
        .readdirSync(abs, { withFileTypes: true })
        .filter(
          (d) => d.isFile() && allow.has(path.extname(d.name).toLowerCase())
        )
        .map((d) => path.join(abs, d.name))
        .sort();
    } catch {
      return [];
    }
  }

  function readCaptions(file) {
    try {
      const abs = path.resolve(process.cwd(), file);
      if (!fs.existsSync(abs)) return [];
      // Normalisasi newline
      const raw = fs.readFileSync(abs, "utf8").replace(/\r/g, "");
      // Pisah caption jika ada:
      // - 2+ baris kosong (>=3 newline berturut-turut), ATAU
      // - satu baris berisi --- (tiga tanda minus) sebagai pemisah manual
      return raw
        .split(/\n-{3,}\n|\n{3,}/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function getNextImagePayload() {
    const images = listImages(config.autoShare.imageDir);
    if (images.length === 0) {
      return null; // tidak ada gambar
    }
    const idx = autoIndex % images.length;
    const filePath = images[idx];
    const captions = readCaptions(config.autoShare.captionsFile);
    const caption = captions[idx] || config.autoShare.fallbackCaption || "";
    autoIndex++;
    return { filePath, caption };
  }

  async function doAutoShareTick() {
    try {
      const groupJid = await ensureTargetGroupJid();
      if (!groupJid) {
        console.log(
          `⚠️ Grup "${config.targetGroupName}" belum ditemukan. Lewati tick.`
        );
        return;
      }

      if (config.autoShare.mode === "image") {
        const payload = getNextImagePayload();
        if (!payload) {
          console.log(
            "⚠️ Tidak ada gambar di folder auto_images/. Lewati tick."
          );
          return;
        }
        const buffer = fs.readFileSync(payload.filePath);
        await sock.sendMessage(groupJid, {
          image: buffer,
          caption: payload.caption,
        });
        console.log(
          `🖼️ Auto-share image terkirim: ${path.basename(payload.filePath)}`
        );
      } else {
        // fallback ke text jika suatu saat kamu ganti mode
        const text = config.autoShare.fallbackCaption || "Update setiap jam.";
        await sock.sendMessage(groupJid, { text });
        console.log(`⏰ Auto-share text terkirim`);
      }
    } catch (e) {
      console.log("⚠️ Gagal auto-share:", e?.message || e);
    }
  }

  function startAutoShare() {
    if (!config.autoShare.enabled) return;
    if (autoTimer) return; // cegah dobel saat reconnect
    const intervalMs =
      Math.max(1, Number(config.autoShare.intervalMinutes)) * 60 * 1000;

    if (config.autoShare.sendOnStart) {
      setTimeout(() => doAutoShareTick(), 5000);
    }
    autoTimer = setInterval(() => doAutoShareTick(), intervalMs);

    console.log(
      `🗓️ Auto-share (mode=${config.autoShare.mode}) aktif setiap ${config.autoShare.intervalMinutes} menit.`
    );
  }

  // listener pesan: hanya dari owner
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || from;
    const isFromOwner =
      sender === config.ownerNumber || from === config.ownerNumber;
    if (!isFromOwner) return;

    try {
      const txt = getTextMessage(msg);

      if (/^\.share\s+/i.test(txt)) {
        const gid = await handleShareText(txt);
        await sock.sendMessage(config.ownerNumber, {
          text: `✅ Terkirim ke "${config.targetGroupName}" (${gid})`,
        });
        return;
      }

      if (/^\.shareimg/i.test(txt) && msg.message?.imageMessage) {
        const gid = await handleShareImage(msg);
        await sock.sendMessage(config.ownerNumber, {
          text: `✅ Gambar terkirim ke "${config.targetGroupName}" (${gid})`,
        });
        return;
      }

      if (/^\.sharevid/i.test(txt) && msg.message?.videoMessage) {
        const gid = await handleShareVideo(msg);
        await sock.sendMessage(config.ownerNumber, {
          text: `✅ Video terkirim ke "${config.targetGroupName}" (${gid})`,
        });
        return;
      }
    } catch (err) {
      await sock.sendMessage(config.ownerNumber, { text: `❌ ${err.message}` });
    }
  });

  // ====== (lanjutan) kode login kamu (tetap) ======
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      console.log(
        "🔌 Koneksi terputus.",
        shouldReconnect ? "Menyambung ulang..." : "Tidak reconnect."
      );
      if (shouldReconnect) startLogin();
    } else if (connection === "open") {
      console.log("🤖 Bot terkoneksi!");
      // 🔔 mulai auto-share ketika terkoneksi
      startAutoShare();
    }
  });
}

startLogin().catch((err) => {
  console.error("❌ Error fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  rl.close();
  process.exit();
});
