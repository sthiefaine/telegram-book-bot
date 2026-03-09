const nodemailer = require("nodemailer");
const path = require("path");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter = null;

function getTransporter() {
  if (!SMTP_USER || !SMTP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
  }
  return transporter;
}

/**
 * Send a book file by email.
 * For Kindle: use subject "convert" so Amazon auto-converts the file.
 */
async function sendBookByEmail(filePath, filename, toEmail, { subject, body } = {}) {
  const t = getTransporter();
  if (!t) throw new Error("SMTP non configure (SMTP_USER / SMTP_PASSWORD manquants)");

  await t.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: subject || `Votre livre : ${filename}`,
    text: body || `Voici votre livre en piece jointe : ${filename}`,
    attachments: [{ filename, path: filePath }],
  });
}

async function sendToKindle(filePath, filename, kindleEmail) {
  return sendBookByEmail(filePath, filename, kindleEmail, {
    subject: "convert",
    body: "Livre envoye via Formation Civique Book Bot",
  });
}

function isConfigured() {
  return !!(SMTP_USER && SMTP_PASSWORD);
}

module.exports = { sendBookByEmail, sendToKindle, isConfigured };
