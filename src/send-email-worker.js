#!/usr/bin/env node
// This script runs in a standalone Node.js process (NOT inside Electron).
// It uses Node's OpenSSL (not Electron's BoringSSL), which correctly handles
// antivirus SSL-inspection certificates that BoringSSL rejects.

const nodemailer = require('nodemailer');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const { config, mailOptions } = JSON.parse(input);
    const transport = nodemailer.createTransport(config);
    const sent = await transport.sendMail(mailOptions);
    process.stdout.write(JSON.stringify({ ok: true, messageId: sent.messageId }));
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
});
